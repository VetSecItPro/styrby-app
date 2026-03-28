/**
 * Webhook Outbound Delivery & Retry Logic Tests
 *
 * WHY this file exists: The canonical delivery engine lives in
 * `supabase/functions/deliver-webhook/index.ts`, which runs under Deno and
 * cannot be imported directly by Vitest (Node/jsdom environment).  This test
 * file extracts and re-implements the pure, environment-agnostic business
 * logic — HMAC signing, SSRF URL validation, resolved-IP validation,
 * exponential backoff calculation — so that every rule can be verified with
 * fast, dependency-free unit tests.
 *
 * The "deliverWebhook" integration tests use a mocked `globalThis.fetch` to
 * exercise the full outbound HTTP path (headers, timeout, success/failure
 * branching) without making real network calls.
 *
 * Coverage targets
 * ───────────────────────────────────────────────────────
 * 1. HMAC-SHA256 signature generation
 * 2. Static URL validation (validateWebhookUrl)
 * 3. DNS-resolved IP validation (validateResolvedIp)
 * 4. Exponential backoff / retry timing (calculateNextRetryTime)
 * 5. Dead-letter behaviour (max retries exhausted)
 * 6. Outbound fetch — success path (2xx)
 * 7. Outbound fetch — non-2xx failure path
 * 8. Outbound fetch — timeout / AbortError path
 * 9. Event payload shape for all supported event types
 * 10. Failed delivery logging (error message capture)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Re-implemented pure functions (mirrors deliver-webhook/index.ts exactly)
// ============================================================================

/**
 * Constants — must stay in sync with deliver-webhook/index.ts.
 */
const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 60_000; // 1 minute
const HTTP_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_RESPONSE_BODY_LENGTH = 10_240; // 10 KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Webhook {
  id: string;
  user_id: string;
  url: string;
  secret: string;
  is_active: boolean;
}

interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
}

interface DeliveryResult {
  deliveryId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  duration_ms?: number;
}

// ---------------------------------------------------------------------------
// HMAC signature generation
// ---------------------------------------------------------------------------

/**
 * Generates an HMAC-SHA256 signature for a webhook payload.
 *
 * WHY: Recipients verify this signature to confirm the payload came from
 * Styrby and was not tampered with in transit.  The algorithm must be
 * identical to the edge function so that signatures produced here can be
 * verified in the same way by a real consumer.
 *
 * @param payload - The JSON payload string to sign
 * @param secret - The webhook's secret key
 * @returns Hex-encoded HMAC-SHA256 signature
 */
async function generateSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));

  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Static URL validation (mirrors validateWebhookUrl in the edge function)
// ---------------------------------------------------------------------------

/**
 * Validates that a webhook URL is safe to call (blocks SSRF attacks).
 *
 * WHY (FIX-027 / FIX-042): Without this check an attacker with a Styrby
 * account could register a webhook pointing at 169.254.169.254 (cloud
 * metadata), 10.x.x.x (VPC internal), or localhost to use our delivery
 * infrastructure as an SSRF proxy against our own systems.
 *
 * @param url - The webhook URL to validate
 * @returns true if URL is safe
 * @throws Error describing why the URL is blocked
 */
function validateWebhookUrl(url: string): boolean {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('127.') ||
    hostname === '::1' ||
    hostname === '[::1]'
  ) {
    throw new Error('Webhook URL cannot target localhost');
  }

  const internalPatterns = [
    /\.internal$/i,
    /\.local$/i,
    /\.localdomain$/i,
    /^(metadata|kubernetes|kube-|internal-|priv-)/i,
  ];

  for (const pattern of internalPatterns) {
    if (pattern.test(hostname)) {
      throw new Error('Webhook URL cannot target internal hostnames');
    }
  }

  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);

    if (octets[0] === 10) throw new Error('Webhook URL cannot target private IP addresses (10.x.x.x)');
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      throw new Error('Webhook URL cannot target private IP addresses (172.16-31.x.x)');
    if (octets[0] === 192 && octets[1] === 168)
      throw new Error('Webhook URL cannot target private IP addresses (192.168.x.x)');
    if (octets[0] === 127) throw new Error('Webhook URL cannot target loopback addresses');
    if (octets[0] === 169 && octets[1] === 254)
      throw new Error('Webhook URL cannot target link-local or metadata addresses');
    if (octets.every((o) => o === 255)) throw new Error('Webhook URL cannot target broadcast addresses');
  }

  if (hostname.includes(':') || hostname.startsWith('[')) {
    const cleanIp = hostname.replace(/[\[\]]/g, '');
    if (cleanIp === '::1') throw new Error('Webhook URL cannot target IPv6 loopback');
    if (cleanIp.toLowerCase().startsWith('fe80:'))
      throw new Error('Webhook URL cannot target IPv6 link-local addresses');
    if (/^f[cd]/i.test(cleanIp)) throw new Error('Webhook URL cannot target IPv6 private addresses');
    if (cleanIp.toLowerCase().startsWith('::ffff:')) {
      try {
        validateWebhookUrl(`http://${cleanIp.slice(7)}/`);
      } catch {
        throw new Error('Webhook URL cannot target private IPv4-mapped IPv6 addresses');
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Resolved-IP validation (mirrors validateResolvedIp in the edge function)
// ---------------------------------------------------------------------------

/**
 * Validates that a resolved IP address is not private, loopback, or link-local.
 *
 * WHY (SEC-SSRF-001 / DNS rebinding): An attacker could register a short-TTL
 * public domain that passes `validateWebhookUrl()`, then swap its DNS to a
 * private IP before the actual `fetch()` call.  Resolving the hostname
 * explicitly and checking every returned IP closes this window.
 *
 * @param ip - A resolved IP address string (IPv4 or IPv6)
 * @throws Error if the IP is in a blocked range
 */
function validateResolvedIp(ip: string): void {
  const trimmed = ip.trim().toLowerCase();

  const ipv4Match = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets[0] === 10) throw new Error(`Resolved IP ${ip} is in private range 10.0.0.0/8`);
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      throw new Error(`Resolved IP ${ip} is in private range 172.16.0.0/12`);
    if (octets[0] === 192 && octets[1] === 168)
      throw new Error(`Resolved IP ${ip} is in private range 192.168.0.0/16`);
    if (octets[0] === 127) throw new Error(`Resolved IP ${ip} is a loopback address`);
    if (octets[0] === 169 && octets[1] === 254)
      throw new Error(`Resolved IP ${ip} is a link-local/metadata address`);
    if (octets.every((o) => o === 255)) throw new Error(`Resolved IP ${ip} is a broadcast address`);
    return;
  }

  if (trimmed === '::1') throw new Error(`Resolved IP ${ip} is IPv6 loopback`);
  if (trimmed.startsWith('fe80:')) throw new Error(`Resolved IP ${ip} is IPv6 link-local`);
  if (/^f[cd]/i.test(trimmed)) throw new Error(`Resolved IP ${ip} is in IPv6 unique-local range`);
  if (trimmed.startsWith('::ffff:')) {
    validateResolvedIp(trimmed.slice(7));
  }
}

// ---------------------------------------------------------------------------
// Exponential backoff
// ---------------------------------------------------------------------------

/**
 * Calculates the next retry time using exponential backoff.
 *
 * Schedule (mirrors the edge function):
 * - After attempt 1  → retry in 1 minute  (BASE × 2^0)
 * - After attempt 2  → retry in 2 minutes (BASE × 2^1)
 * - After attempt 3+ → no more retries    (returns null → dead-letter)
 *
 * @param attempts - Total attempts made so far (after the most recent failure)
 * @returns ISO timestamp for next retry, or null when max attempts are reached
 */
function calculateNextRetryTime(attempts: number): string | null {
  if (attempts >= MAX_ATTEMPTS) return null;

  const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempts - 1);
  return new Date(Date.now() + delayMs).toISOString();
}

// ---------------------------------------------------------------------------
// Outbound delivery (simplified, fetch-mockable version for unit tests)
// ---------------------------------------------------------------------------

/**
 * Delivers a webhook payload to the configured endpoint.
 *
 * This is the testable, fetch-mockable mirror of `deliverWebhook()` in the
 * edge function.  It validates the URL, signs the payload with HMAC-SHA256,
 * attaches the standard Styrby headers, and returns a structured result.
 *
 * @param webhook - Webhook configuration (url, secret)
 * @param delivery - Delivery record (id, event, payload)
 * @returns DeliveryResult indicating success/failure and HTTP status
 */
async function deliverWebhook(
  webhook: Webhook,
  delivery: WebhookDelivery
): Promise<DeliveryResult> {
  const startTime = Date.now();

  try {
    validateWebhookUrl(webhook.url);

    const payload = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await generateSignature(payload, webhook.secret);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Styrby-Signature': `sha256=${signature}`,
          'X-Styrby-Event': delivery.event,
          'X-Styrby-Delivery-Id': delivery.id,
          'X-Styrby-Timestamp': timestamp.toString(),
          'User-Agent': 'Styrby-Webhook/1.0',
        },
        body: payload,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;

      let responseBody: string | undefined;
      try {
        const text = await response.text();
        responseBody = text.slice(0, MAX_RESPONSE_BODY_LENGTH);
      } catch {
        responseBody = undefined;
      }

      const success = response.status >= 200 && response.status < 300;

      return {
        deliveryId: delivery.id,
        success,
        statusCode: response.status,
        duration_ms: duration,
        error: success
          ? undefined
          : `HTTP ${response.status}: ${responseBody?.slice(0, 200) || 'No response body'}`,
      };
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error) {
    const duration = Date.now() - startTime;

    // WHY: In jsdom (the test environment), DOMException is not always
    // instanceof Error, so we check the name property directly to detect
    // AbortError reliably across environments.
    const isAbortError =
      (error instanceof Error && error.name === 'AbortError') ||
      (error !== null &&
        typeof error === 'object' &&
        (error as { name?: string }).name === 'AbortError');

    if (isAbortError) {
      return {
        deliveryId: delivery.id,
        success: false,
        duration_ms: duration,
        error: `Request timed out after ${HTTP_TIMEOUT_MS}ms`,
      };
    }

    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : 'Unknown error occurred';

    return {
      deliveryId: delivery.id,
      success: false,
      duration_ms: duration,
      error: errorMessage,
    };
  }
}

// ============================================================================
// Test fixtures
// ============================================================================

/** A safe public webhook that passes all SSRF checks */
const SAFE_WEBHOOK: Webhook = {
  id: 'wh-uuid-001',
  user_id: 'user-uuid-123',
  url: 'https://hooks.example.com/styrby',
  secret: 'whsec_test_signing_secret_32chars_long',
  is_active: true,
};

/** A minimal delivery record for testing */
function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'del-uuid-001',
    webhook_id: 'wh-uuid-001',
    event: 'session.started',
    payload: {
      event: 'session.started',
      timestamp: '2026-03-27T12:00:00Z',
      data: { session_id: 'sess-abc', agent_type: 'claude' },
    },
    status: 'pending',
    attempts: 0,
    last_attempt_at: null,
    next_retry_at: null,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Webhook Delivery — HMAC Signature Generation', () => {
  /**
   * WHY: Recipients verify the X-Styrby-Signature header against the raw body
   * using their stored secret.  The HMAC must be deterministic: same payload +
   * same secret → same hex digest every time.
   */
  it('generates a 64-character hex HMAC-SHA256 signature', async () => {
    const sig = await generateSignature('{"event":"session.started"}', 'my-secret');
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });

  it('produces the same signature for identical payload and secret (deterministic)', async () => {
    const payload = '{"event":"budget.exceeded","amount":50}';
    const secret = 'shared-secret-key';
    const sig1 = await generateSignature(payload, secret);
    const sig2 = await generateSignature(payload, secret);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures when the payload changes', async () => {
    const secret = 'same-secret';
    const sig1 = await generateSignature('{"event":"session.started"}', secret);
    const sig2 = await generateSignature('{"event":"session.completed"}', secret);
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures when the secret changes', async () => {
    const payload = '{"event":"permission.requested"}';
    const sig1 = await generateSignature(payload, 'secret-a');
    const sig2 = await generateSignature(payload, 'secret-b');
    expect(sig1).not.toBe(sig2);
  });

  it('can sign an empty string without throwing', async () => {
    const sig = await generateSignature('', 'some-secret');
    expect(sig).toHaveLength(64);
  });

  it('can sign a large payload (1 MB) without error', async () => {
    const bigPayload = JSON.stringify({ data: 'x'.repeat(1_000_000) });
    const sig = await generateSignature(bigPayload, 'secret');
    expect(sig).toHaveLength(64);
  });
});

// ============================================================================

describe('Webhook Delivery — Static URL Validation (validateWebhookUrl)', () => {
  it('accepts a valid public HTTPS URL', () => {
    expect(() => validateWebhookUrl('https://hooks.example.com/webhook')).not.toThrow();
  });

  it('blocks localhost by hostname', () => {
    expect(() => validateWebhookUrl('https://localhost/admin')).toThrow('localhost');
  });

  it('blocks 127.0.0.1 loopback', () => {
    expect(() => validateWebhookUrl('https://127.0.0.1/api')).toThrow();
  });

  it('blocks 127.x.x.x loopback range', () => {
    expect(() => validateWebhookUrl('https://127.0.0.2/api')).toThrow();
  });

  it('blocks 10.0.0.0/8 private range', () => {
    expect(() => validateWebhookUrl('https://10.10.10.10/internal')).toThrow('10.x.x.x');
  });

  it('blocks 172.16.x.x private range', () => {
    expect(() => validateWebhookUrl('https://172.16.0.1/vpc')).toThrow();
  });

  it('blocks 172.31.x.x private range (upper boundary)', () => {
    expect(() => validateWebhookUrl('https://172.31.255.255/vpc')).toThrow();
  });

  it('allows 172.32.0.0 (outside 172.16-31 range)', () => {
    // 172.32 is public — should not throw
    expect(() => validateWebhookUrl('https://172.32.0.1/api')).not.toThrow();
  });

  it('blocks 192.168.x.x private range', () => {
    expect(() => validateWebhookUrl('https://192.168.1.1/router')).toThrow('192.168');
  });

  it('blocks 169.254.169.254 AWS metadata service', () => {
    expect(() => validateWebhookUrl('https://169.254.169.254/latest/meta-data/')).toThrow('link-local');
  });

  it('blocks 255.255.255.255 broadcast address', () => {
    expect(() => validateWebhookUrl('https://255.255.255.255/')).toThrow('broadcast');
  });

  it('blocks *.internal hostnames', () => {
    expect(() => validateWebhookUrl('https://service.internal/api')).toThrow('internal hostnames');
  });

  it('blocks *.local hostnames', () => {
    expect(() => validateWebhookUrl('https://myserver.local/')).toThrow('internal hostnames');
  });

  it('blocks kubernetes metadata hostname prefix', () => {
    expect(() => validateWebhookUrl('https://kubernetes.default.svc/')).toThrow('internal hostnames');
  });

  it('blocks IPv6 loopback ::1', () => {
    // WHY: The URL parser preserves brackets ([::1] hostname), so the early
    // `hostname === '[::1]'` check fires before the dedicated IPv6 block.
    // The thrown message references "localhost" because [::1] is treated as
    // the IPv6 localhost alias in the static validation path.
    expect(() => validateWebhookUrl('https://[::1]/admin')).toThrow();
  });

  it('blocks IPv6 link-local fe80:: prefix', () => {
    expect(() => validateWebhookUrl('https://[fe80::1]/api')).toThrow('link-local');
  });

  it('blocks IPv6 unique-local fc00::/7 range', () => {
    expect(() => validateWebhookUrl('https://[fc00::1]/api')).toThrow('private');
  });
});

// ============================================================================

describe('Webhook Delivery — Resolved IP Validation (validateResolvedIp)', () => {
  /**
   * WHY (SEC-SSRF-001): DNS rebinding attacks swap a hostname's A record from a
   * public IP to a private one after the static URL check passes.  We resolve
   * DNS explicitly and validate every returned IP before calling fetch().
   */

  it('accepts a public IPv4 address', () => {
    expect(() => validateResolvedIp('93.184.216.34')).not.toThrow();
  });

  it('blocks 10.x.x.x private range', () => {
    expect(() => validateResolvedIp('10.0.0.1')).toThrow('private range 10.0.0.0/8');
  });

  it('blocks 172.16.x.x private range', () => {
    expect(() => validateResolvedIp('172.20.0.5')).toThrow('private range 172.16.0.0/12');
  });

  it('blocks 192.168.x.x private range', () => {
    expect(() => validateResolvedIp('192.168.0.1')).toThrow('private range 192.168.0.0/16');
  });

  it('blocks 127.0.0.1 loopback', () => {
    expect(() => validateResolvedIp('127.0.0.1')).toThrow('loopback');
  });

  it('blocks 169.254.169.254 link-local / cloud metadata', () => {
    expect(() => validateResolvedIp('169.254.169.254')).toThrow('link-local/metadata');
  });

  it('blocks IPv6 loopback ::1', () => {
    expect(() => validateResolvedIp('::1')).toThrow('IPv6 loopback');
  });

  it('blocks IPv6 link-local fe80:: prefix', () => {
    expect(() => validateResolvedIp('fe80::1')).toThrow('IPv6 link-local');
  });

  it('blocks IPv6 unique-local fc00::/7', () => {
    expect(() => validateResolvedIp('fc00::1')).toThrow('IPv6 unique-local');
  });

  it('blocks IPv4-mapped IPv6 ::ffff:10.0.0.1 (DNS rebinding via IPv6)', () => {
    // ::ffff:10.0.0.1 maps to the private 10.0.0.1 — must be blocked
    expect(() => validateResolvedIp('::ffff:10.0.0.1')).toThrow();
  });
});

// ============================================================================

describe('Webhook Delivery — Exponential Backoff (calculateNextRetryTime)', () => {
  /**
   * WHY: Without enforced backoff, a flapping consumer endpoint could receive
   * a flood of retries and mistake it for an attack.  The schedule is
   * intentionally gentle: 1 min → 2 min → dead-letter.
   */

  it('schedules retry ~1 minute after attempt 1', () => {
    const before = Date.now();
    const result = calculateNextRetryTime(1);
    const after = Date.now();

    expect(result).not.toBeNull();
    const retryTime = new Date(result!).getTime();
    // Should be within ±5 seconds of 60 000 ms from now
    expect(retryTime).toBeGreaterThanOrEqual(before + BASE_RETRY_DELAY_MS - 5000);
    expect(retryTime).toBeLessThanOrEqual(after + BASE_RETRY_DELAY_MS + 5000);
  });

  it('schedules retry ~2 minutes after attempt 2 (exponential doubling)', () => {
    const before = Date.now();
    const result = calculateNextRetryTime(2);
    const after = Date.now();

    expect(result).not.toBeNull();
    const retryTime = new Date(result!).getTime();
    const expectedDelay = BASE_RETRY_DELAY_MS * 2;
    expect(retryTime).toBeGreaterThanOrEqual(before + expectedDelay - 5000);
    expect(retryTime).toBeLessThanOrEqual(after + expectedDelay + 5000);
  });

  it('returns null after MAX_ATTEMPTS (3) — dead-letter behaviour', () => {
    /**
     * WHY: After 3 failed attempts the delivery is permanently failed and
     * written to the webhook_deliveries table with status='failed'.  No further
     * retries will be scheduled.  The result is null rather than a future
     * timestamp to signal this dead-letter state.
     */
    expect(calculateNextRetryTime(MAX_ATTEMPTS)).toBeNull();
  });

  it('returns null for attempts beyond MAX_ATTEMPTS', () => {
    expect(calculateNextRetryTime(MAX_ATTEMPTS + 1)).toBeNull();
    expect(calculateNextRetryTime(MAX_ATTEMPTS + 100)).toBeNull();
  });

  it('returns a valid ISO 8601 timestamp for attempt 1', () => {
    const result = calculateNextRetryTime(1);
    expect(result).not.toBeNull();
    expect(() => new Date(result!)).not.toThrow();
    expect(new Date(result!).toISOString()).toBe(result);
  });

  it('delay for attempt 2 is exactly double the delay for attempt 1', () => {
    const now = Date.now();
    const t1 = new Date(calculateNextRetryTime(1)!).getTime() - now;
    const t2 = new Date(calculateNextRetryTime(2)!).getTime() - now;
    // Allow ±200 ms clock drift between the two calls
    expect(t2 / t1).toBeCloseTo(2, 0);
  });
});

// ============================================================================

describe('Webhook Delivery — Outbound HTTP Delivery (deliverWebhook)', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Success path ────────────────────────────────────────────────────────

  it('returns success=true for a 200 response', async () => {
    mockFetch.mockResolvedValue(
      new Response('OK', { status: 200 })
    );

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.deliveryId).toBe('del-uuid-001');
  });

  it('returns success=true for a 201 response (also 2xx)', async () => {
    mockFetch.mockResolvedValue(new Response('Created', { status: 201 }));

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(201);
  });

  it('records duration_ms for successful delivery', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.duration_ms).toBe('number');
  });

  // ── Non-2xx failure ─────────────────────────────────────────────────────

  it('returns success=false for a 500 response', async () => {
    mockFetch.mockResolvedValue(
      new Response('Internal Server Error', { status: 500 })
    );

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toContain('HTTP 500');
  });

  it('returns success=false for a 400 response and captures response body', async () => {
    mockFetch.mockResolvedValue(
      new Response('Bad Request', { status: 400 })
    );

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
    expect(result.error).toContain('Bad Request');
  });

  it('returns success=false for a 404 response', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
  });

  // ── Timeout / AbortError ────────────────────────────────────────────────

  it('returns a timeout error when fetch is aborted', async () => {
    /**
     * WHY: The delivery function uses AbortController with a 30-second
     * timeout. If the consumer is slow (or unresponsive), we must not hang
     * indefinitely.  The test simulates the AbortError that fetch throws
     * when the controller fires.
     */
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    mockFetch.mockRejectedValue(abortError);

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.error).toContain(HTTP_TIMEOUT_MS.toString());
  });

  // ── SSRF guard at delivery time ─────────────────────────────────────────

  it('returns success=false without calling fetch for a private IP URL', async () => {
    /**
     * WHY: validateWebhookUrl() is called at delivery time (not only at
     * registration) to catch any webhooks that may have been inserted
     * through a path that bypassed the registration-time SSRF check.
     */
    const ssrfWebhook: Webhook = {
      ...SAFE_WEBHOOK,
      url: 'https://10.0.0.1/steal-creds',
    };

    const result = await deliverWebhook(ssrfWebhook, makeDelivery());
    expect(result.success).toBe(false);
    expect(result.error).toContain('private');
    // fetch must never be called for a blocked URL
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Header assertions ───────────────────────────────────────────────────

  it('sends the correct Styrby-specific headers with each delivery', async () => {
    mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

    await deliverWebhook(SAFE_WEBHOOK, makeDelivery({ event: 'budget.exceeded' }));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Styrby-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['X-Styrby-Event']).toBe('budget.exceeded');
    expect(headers['X-Styrby-Delivery-Id']).toBe('del-uuid-001');
    expect(headers['X-Styrby-Timestamp']).toMatch(/^\d+$/);
    expect(headers['User-Agent']).toBe('Styrby-Webhook/1.0');
  });

  it('sends method POST with JSON body', async () => {
    mockFetch.mockResolvedValue(new Response('OK', { status: 200 }));

    const delivery = makeDelivery({
      payload: { event: 'session.started', data: { session_id: 'abc' } },
    });
    await deliverWebhook(SAFE_WEBHOOK, delivery);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe('POST');
    expect(typeof options.body).toBe('string');
    expect(JSON.parse(options.body as string)).toEqual(delivery.payload);
  });
});

// ============================================================================

// NOTE: "Event Payload Shape" tests were removed during code review.
// WHY: The tests constructed payload objects inline and then asserted properties
// of those same objects — making them tautological (impossible to fail).
// Payload shape validation should test a real payload-building function from
// the Edge Function when Deno test infrastructure is available.

// ============================================================================

describe('Webhook Delivery — Failed Delivery Logging', () => {
  /**
   * WHY: When a delivery fails, the error message stored in webhook_deliveries
   * must contain enough context for a developer to diagnose the problem without
   * having to replay the delivery.  These tests verify the error message format
   * for the most common failure scenarios.
   */
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('captures HTTP status code in error message for non-2xx responses', async () => {
    mockFetch.mockResolvedValue(new Response('Service Unavailable', { status: 503 }));

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.error).toMatch(/HTTP 503/);
  });

  it('captures response body snippet (up to 200 chars) in error message', async () => {
    const body = '{"error":"invalid_token","description":"The provided token has expired"}';
    mockFetch.mockResolvedValue(new Response(body, { status: 401 }));

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.error).toContain('invalid_token');
  });

  it('includes timeout duration in error message for AbortError', async () => {
    mockFetch.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.error).toContain('30000'); // HTTP_TIMEOUT_MS
    expect(result.error).toContain('timed out');
  });

  it('includes SSRF URL block reason in error when delivery bypasses registration check', async () => {
    const ssrfWebhook = { ...SAFE_WEBHOOK, url: 'https://192.168.100.1/internal' };
    const result = await deliverWebhook(ssrfWebhook, makeDelivery());
    // error field must name the blocked range so operators know why it failed
    expect(result.error).toContain('192.168');
  });

  it('records duration_ms even on failure', async () => {
    mockFetch.mockResolvedValue(new Response('Error', { status: 500 }));

    const result = await deliverWebhook(SAFE_WEBHOOK, makeDelivery());
    expect(result.success).toBe(false);
    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
