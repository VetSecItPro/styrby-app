/**
 * POST /api/v1/broadcast — Integration Tests
 *
 * Tests the server-side Supabase Realtime broadcast endpoint. This endpoint
 * is the fan-out relay the CLI daemon uses to push cost updates and budget
 * alerts to connected mobile devices without holding a persistent Realtime
 * WebSocket.
 *
 * WHY these tests exist:
 * 1. The channel-prefix authorization check (OWASP A01:2021) is a critical
 *    security control — any regression would allow cross-user event injection.
 * 2. The soft-failure path (delivered:false on non-'ok' send status) must NOT
 *    surface as a 500 — the CLI daemon treats delivered:false as non-critical.
 * 3. The concatenation-attack test (channel `user:${userId}-evil:`) validates
 *    that the colon delimiter in the prefix check is load-bearing.
 * 4. The payload size guard prevents the broadcast channel from being abused
 *    as a large-object relay.
 *
 * @security OWASP A01:2021 (Broken Access Control — cross-user channel prevention)
 * @security OWASP A07:2021 (Identification and Authentication Failures)
 * @security OWASP A03:2021 (Injection / Mass Assignment — Zod .strict() guard)
 * @security GDPR Art 6 (Lawful basis — only authenticated user's own channel)
 * @security SOC 2 CC6.1 (Logical Access Controls)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks — withApiAuthAndRateLimit bypass
// ============================================================================

/**
 * Default auth context injected by the mocked middleware.
 * WHY a fixed UUID: the channel-prefix tests use this UUID to construct valid
 * and invalid channel names, so tests must be deterministic.
 */
const AUTHED_USER_ID = 'aaaabbbb-cccc-dddd-eeee-111122223333';

const mockAuthContext = {
  userId: AUTHED_USER_ID,
  keyId: 'key-id-broadcast-test',
  scopes: ['write'],
  keyExpiresAt: null,
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuthAndRateLimit: vi.fn((handler: Function) => {
    return async (request: NextRequest) => handler(request, mockAuthContext);
  }),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

// ============================================================================
// Mocks — Sentry
// ============================================================================

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ============================================================================
// Mocks — Supabase admin client (Realtime channel)
// ============================================================================

/**
 * Mutable send status returned by the mock channel.send().
 * Tests override this to simulate 'ok', 'error', 'timed out', or throw.
 *
 * WHY a mutable variable (not a queue): each test resets in beforeEach.
 * The channel mock is simple — one send() per request, no queue needed.
 */
let mockSendStatus: string | null = 'ok';
let mockSendThrows = false;

/**
 * Creates a Supabase mock whose .channel().send() returns mockSendStatus
 * or throws if mockSendThrows is true.
 */
function createSupabaseMock() {
  return {
    channel: vi.fn((_channelName: string) => ({
      send: vi.fn(async (_message: unknown) => {
        if (mockSendThrows) {
          throw new Error('Realtime SDK internal error');
        }
        return mockSendStatus;
      }),
    })),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => createSupabaseMock()),
}));

// ============================================================================
// Import route handler AFTER mocks
// ============================================================================

import { POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const BASE_URL = 'http://localhost:3000/api/v1/broadcast';

/**
 * Valid channel for the authenticated user.
 * Must start with `user:${AUTHED_USER_ID}:`.
 */
const VALID_CHANNEL = `user:${AUTHED_USER_ID}:costs`;
const VALID_EVENT = 'cost_update';
const VALID_PAYLOAD = { session_id: 'sess-001', cost_usd: 0.05 };

/**
 * Minimal valid body for POST /api/v1/broadcast.
 */
const MINIMAL_VALID_BODY = {
  channel: VALID_CHANNEL,
  event: VALID_EVENT,
  payload: VALID_PAYLOAD,
};

/**
 * Creates a NextRequest for POST /api/v1/broadcast.
 *
 * @param body - JSON body to send
 * @param headers - Additional request headers
 * @returns A NextRequest with the POST method and JSON body
 */
function createRequest(
  body: unknown = MINIMAL_VALID_BODY,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer styrby_live_test_key',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/v1/broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendStatus = 'ok';
    mockSendThrows = false;
  });

  // --------------------------------------------------------------------------
  // 1. Auth middleware wiring
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    /**
     * WHY: Proves the route is wired to withApiAuthAndRateLimit. A refactor
     * that accidentally bypasses the wrapper would allow unauthenticated
     * Realtime broadcasts. OWASP A07:2021, SOC 2 CC6.1.
     */
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 },
        );
      });

      vi.resetModules();
      const { POST: freshPOST } = await import('../route');

      const response = await freshPOST(createRequest());
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Missing Authorization header');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Zod validation — 400 cases
  // --------------------------------------------------------------------------

  describe('validation', () => {
    /**
     * WHY: channel is required. Broadcasting without a channel name is a
     * nonsensical request. OWASP A03:2021.
     */
    it('returns 400 when channel is missing', async () => {
      const response = await POST(
        createRequest({ event: VALID_EVENT, payload: VALID_PAYLOAD }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when event is missing', async () => {
      const response = await POST(
        createRequest({ channel: VALID_CHANNEL, payload: VALID_PAYLOAD }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when payload is missing', async () => {
      const response = await POST(
        createRequest({ channel: VALID_CHANNEL, event: VALID_EVENT }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when channel exceeds 255 characters', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, channel: `user:${AUTHED_USER_ID}:${'x'.repeat(300)}` }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when event exceeds 64 characters', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, event: 'e'.repeat(65) }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * WHY .strict() test: callers must not inject unknown fields (e.g. `user_id`)
     * to attempt mass-assignment. Zod .strict() rejects them before any business
     * logic runs. OWASP A03:2021.
     */
    it('returns 400 when an unknown field is present (mass-assignment guard)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, user_id: 'attacker-uuid' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * WHY: injecting `user_id` specifically (not just an unknown field) must be
     * rejected. This is the most dangerous mass-assignment vector on this endpoint.
     * OWASP A03:2021.
     */
    it('returns 400 when user_id is injected (user_id spoofing rejected by .strict())', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, user_id: 'ffffffff-0000-0000-0000-000000000000' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * WHY payload size guard: a payload over MAX_PAYLOAD_BYTES (64 KB) must be
     * rejected before reaching Realtime to prevent the broadcast channel from
     * being abused as a large-object relay. The guard is app-layer (not just
     * Realtime's own limit) so the error message is meaningful.
     */
    it('returns 400 when payload exceeds 64 KB', async () => {
      // Build a payload that serializes to > 64,000 bytes
      const bigPayload: Record<string, string> = {};
      for (let i = 0; i < 2000; i++) {
        bigPayload[`key_${i}`] = 'x'.repeat(40); // ~100 bytes per entry × 2000 = 200 KB
      }

      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, payload: bigPayload }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toMatch(/payload exceeds/i);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Channel-prefix authorization — 403 cases (OWASP A01:2021)
  // --------------------------------------------------------------------------

  describe('channel-prefix authorization (OWASP A01:2021)', () => {
    /**
     * WHY: Broadcasting to another user's channel is a broken access control
     * vulnerability. The server must reject any channel that does not start with
     * `user:${authenticatedUserId}:`. OWASP A01:2021, SOC 2 CC6.1.
     */
    it('returns 403 when channel is scoped to a different user', async () => {
      const otherUserId = 'zzzzzzzz-9999-9999-9999-000000000000';
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, channel: `user:${otherUserId}:alerts` }),
      );
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Channel must be scoped to authenticated user');
    });

    it('returns 403 when channel has no user: prefix at all', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, channel: 'garbage-channel-name' }),
      );
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Channel must be scoped to authenticated user');
    });

    it('returns 403 when channel is just user: with no userId segment', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, channel: 'user::alerts' }),
      );
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Channel must be scoped to authenticated user');
    });

    /**
     * CRITICAL: Concatenation-attack test — colon delimiter is load-bearing.
     * WHY: `user:${AUTHED_USER_ID}-evil:alerts` must be REJECTED because
     * `user:${AUTHED_USER_ID}-evil:` does NOT equal `user:${AUTHED_USER_ID}:`.
     * The colon after the userId is the delimiter; without it, a malicious actor
     * could construct `user:${victimId}-extra:` which would pass a naive
     * `channel.includes(userId)` check but not a strict `startsWith(prefix)`.
     * OWASP A01:2021 — broken access control via channel-name spoofing.
     */
    it('returns 403 when channel uses concatenation attack (userId + suffix without colon)', async () => {
      // channel = `user:${AUTHED_USER_ID}-evil:alerts`
      // The userId in the channel is `${AUTHED_USER_ID}-evil`, not `${AUTHED_USER_ID}`
      const attackChannel = `user:${AUTHED_USER_ID}-evil:alerts`;
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, channel: attackChannel }),
      );
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Channel must be scoped to authenticated user');
    });

    /**
     * WHY: The error message must NOT reveal the authenticated user's UUID.
     * An attacker who crafts a cross-user channel would otherwise see their own
     * UUID in the error, confirming the channel naming convention. OWASP A01:2021.
     */
    it('does not reveal the authenticated userId in the 403 error message', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, channel: 'user:wrong-user:alerts' }),
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      // The response must not contain the authenticated user's UUID
      expect(JSON.stringify(body)).not.toContain(AUTHED_USER_ID);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Happy path — 200 + delivered:true
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    /**
     * WHY: The primary happy path. Channel is valid, send() returns 'ok',
     * response must be 200 with { delivered: true } and application/json
     * Content-Type. The CLI daemon checks delivered:true to confirm delivery.
     */
    it('returns 200 with delivered:true when channel matches and send() returns ok', async () => {
      mockSendStatus = 'ok';

      const response = await POST(createRequest());
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);

      const body = await response.json();
      expect(body.delivered).toBe(true);
    });

    it('returns 200 with delivered:true for alerts channel (budget-actions.ts callsite)', async () => {
      mockSendStatus = 'ok';
      const alertsChannel = `user:${AUTHED_USER_ID}:alerts`;

      const response = await POST(
        createRequest({ channel: alertsChannel, event: 'budget_alert', payload: { threshold: 10 } }),
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.delivered).toBe(true);
    });

    it('response body contains only the delivered field (no leakage)', async () => {
      mockSendStatus = 'ok';

      const response = await POST(createRequest());
      const body = await response.json();

      expect(Object.keys(body)).toEqual(['delivered']);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Soft-failure path — 200 + delivered:false (not 500)
  // --------------------------------------------------------------------------

  describe('soft-failure (delivered:false)', () => {
    /**
     * WHY: send() returning 'timed out' is a Realtime infrastructure degradation,
     * not a code error. Must return 200 + delivered:false (NOT 500). The CLI daemon
     * treats delivered:false as non-critical — mobile catches up on next poll.
     * Sentry.captureMessage (warning) is called for observability.
     */
    it('returns 200 with delivered:false when send() returns "timed out"', async () => {
      mockSendStatus = 'timed out';

      const response = await POST(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.delivered).toBe(false);
    });

    it('calls Sentry.captureMessage (not captureException) on timed out send()', async () => {
      mockSendStatus = 'timed out';

      const Sentry = await import('@sentry/nextjs');
      await POST(createRequest());

      expect(Sentry.captureMessage).toHaveBeenCalledOnce();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    /**
     * WHY: send() returning 'error' is the other soft-failure status from
     * Supabase Realtime. Same handling as 'timed out' — 200 + delivered:false.
     */
    it('returns 200 with delivered:false when send() returns "error"', async () => {
      mockSendStatus = 'error';

      const response = await POST(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.delivered).toBe(false);
    });

    it('calls Sentry.captureMessage on error send() status', async () => {
      mockSendStatus = 'error';

      const Sentry = await import('@sentry/nextjs');
      await POST(createRequest());

      expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    });

    /**
     * WHY: The status is NOT 500 on soft failure. This is the most critical
     * behavioral assertion — a 500 would cause CLI retry storms. MUST be 200.
     */
    it('does NOT return 500 when send() returns non-ok status', async () => {
      mockSendStatus = 'timed out';

      const response = await POST(createRequest());
      expect(response.status).not.toBe(500);
      expect(response.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Unexpected error path — 500 + Sentry captureException
  // --------------------------------------------------------------------------

  describe('unexpected errors', () => {
    /**
     * WHY: supabase.channel().send() itself throwing (SDK bug, null ref, network
     * stack error) is an unexpected failure, not a Realtime soft failure. Must
     * capture in Sentry with full stack trace and return a sanitized 500.
     * OWASP A02:2021 — raw error not returned to caller.
     */
    it('returns 500 when supabase.channel().send() throws unexpectedly', async () => {
      mockSendThrows = true;

      const response = await POST(createRequest());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('calls Sentry.captureException (not captureMessage) when send() throws', async () => {
      mockSendThrows = true;

      const Sentry = await import('@sentry/nextjs');
      await POST(createRequest());

      expect(Sentry.captureException).toHaveBeenCalledOnce();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('does not reveal raw error details in 500 response body', async () => {
      mockSendThrows = true;

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      // The internal error message from the mock must not appear in the response
      expect(JSON.stringify(body)).not.toContain('Realtime SDK internal error');
    });
  });

  // --------------------------------------------------------------------------
  // 7. Rate limiting — 429
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    /**
     * WHY: Proves the route surfaces 429 + Retry-After when the rate-limiter
     * inside withApiAuthAndRateLimit denies the request. The 60 req/min cap is
     * more aggressive than other endpoints — this test confirms it's wired.
     * OWASP A07:2021 (flood protection), SOC 2 CC6.1.
     */
    it('returns 429 with Retry-After header when rate limit is exceeded', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Rate limit exceeded. Retry after 60 seconds', code: 'RATE_LIMITED' },
          { status: 429, headers: { 'Retry-After': '60' } },
        );
      });

      vi.resetModules();
      const { POST: freshPOST } = await import('../route');

      const response = await freshPOST(createRequest());
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');

      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 8. Content-Type on all responses
  // --------------------------------------------------------------------------

  describe('response headers', () => {
    it('sets Content-Type: application/json on 200 + delivered:true', async () => {
      mockSendStatus = 'ok';

      const response = await POST(createRequest());
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });

    it('sets Content-Type: application/json on 200 + delivered:false (soft failure)', async () => {
      mockSendStatus = 'timed out';

      const response = await POST(createRequest());
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });

    it('sets Content-Type: application/json on 403', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, channel: 'garbage' }),
      );
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Supabase client routing
  // --------------------------------------------------------------------------

  describe('query safety', () => {
    /**
     * WHY: Confirms createAdminClient() is called per request. A regression
     * that uses a shared singleton client would risk cross-request state leakage
     * in concurrent serverless invocations. OWASP A02:2021.
     */
    it('creates a new admin client per request', async () => {
      mockSendStatus = 'ok';

      const { createAdminClient } = await import('@/lib/supabase/server');

      await POST(createRequest());

      expect(createAdminClient).toHaveBeenCalledOnce();
    });
  });
});
