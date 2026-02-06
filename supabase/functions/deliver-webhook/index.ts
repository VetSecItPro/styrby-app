/**
 * Webhook Delivery Edge Function
 *
 * Processes pending webhook deliveries with:
 * - HMAC-SHA256 payload signing
 * - SSRF-safe URL validation
 * - Exponential backoff retry logic
 * - Delivery status tracking
 *
 * Invoked by:
 * - Cron job for pending deliveries
 * - Direct call from application code
 *
 * @endpoint POST /functions/v1/deliver-webhook
 * @body { deliveryId?: string } - Process specific delivery or all pending
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';

// ============================================================================
// Types
// ============================================================================

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

interface Webhook {
  id: string;
  user_id: string;
  url: string;
  secret: string;
  is_active: boolean;
}

interface DeliveryResult {
  deliveryId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  duration_ms?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of retry attempts per delivery */
const MAX_ATTEMPTS = 3;

/** Base delay for exponential backoff (in milliseconds) */
const BASE_RETRY_DELAY_MS = 60_000; // 1 minute

/** HTTP timeout for webhook requests (milliseconds) */
const HTTP_TIMEOUT_MS = 30_000; // 30 seconds

/** Maximum response body to store for debugging */
const MAX_RESPONSE_BODY_LENGTH = 10_240; // 10KB

// ============================================================================
// URL Security Validation
// ============================================================================

/**
 * Validates that a webhook URL is safe to call (no SSRF attacks).
 *
 * Blocks:
 * - Private IPv4 ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
 * - Loopback: 127.x.x.x, localhost
 * - Link-local: 169.254.x.x
 * - Cloud metadata: 169.254.169.254
 * - IPv6 mapped IPv4 and private ranges
 * - Internal hostnames
 *
 * @param url - The webhook URL to validate
 * @returns true if URL is safe to call
 * @throws Error if URL is blocked
 */
function validateWebhookUrl(url: string): boolean {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and loopback
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('127.') ||
    hostname === '::1' ||
    hostname === '[::1]'
  ) {
    throw new Error('Webhook URL cannot target localhost');
  }

  // Block internal hostnames (common patterns)
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

  // Parse IPv4 addresses
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);

    // Block private ranges (RFC 1918)
    // 10.0.0.0 - 10.255.255.255
    if (octets[0] === 10) {
      throw new Error('Webhook URL cannot target private IP addresses (10.x.x.x)');
    }

    // 172.16.0.0 - 172.31.255.255
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
      throw new Error('Webhook URL cannot target private IP addresses (172.16-31.x.x)');
    }

    // 192.168.0.0 - 192.168.255.255
    if (octets[0] === 192 && octets[1] === 168) {
      throw new Error('Webhook URL cannot target private IP addresses (192.168.x.x)');
    }

    // Block loopback (127.0.0.0/8)
    if (octets[0] === 127) {
      throw new Error('Webhook URL cannot target loopback addresses');
    }

    // Block link-local (169.254.0.0/16) - includes cloud metadata
    if (octets[0] === 169 && octets[1] === 254) {
      throw new Error('Webhook URL cannot target link-local or metadata addresses');
    }

    // Block broadcast
    if (octets.every((o) => o === 255)) {
      throw new Error('Webhook URL cannot target broadcast addresses');
    }
  }

  // Block IPv6 private/reserved (simplified check)
  if (hostname.includes(':') || hostname.startsWith('[')) {
    const cleanIp = hostname.replace(/[\[\]]/g, '');

    // Block loopback
    if (cleanIp === '::1') {
      throw new Error('Webhook URL cannot target IPv6 loopback');
    }

    // Block link-local (fe80::/10)
    if (cleanIp.toLowerCase().startsWith('fe80:')) {
      throw new Error('Webhook URL cannot target IPv6 link-local addresses');
    }

    // Block unique local (fc00::/7)
    if (/^f[cd]/i.test(cleanIp)) {
      throw new Error('Webhook URL cannot target IPv6 private addresses');
    }

    // Block IPv4-mapped IPv6 (::ffff:x.x.x.x)
    if (cleanIp.toLowerCase().startsWith('::ffff:')) {
      // Re-validate the IPv4 portion
      const ipv4Part = cleanIp.slice(7);
      try {
        validateWebhookUrl(`http://${ipv4Part}/`);
      } catch {
        throw new Error('Webhook URL cannot target private IPv4-mapped IPv6 addresses');
      }
    }
  }

  return true;
}

// ============================================================================
// HMAC Signature Generation
// ============================================================================

/**
 * Generates an HMAC-SHA256 signature for a webhook payload.
 *
 * The signature is computed as: HMAC-SHA256(secret, payload)
 * and returned as a hex string.
 *
 * @param payload - The JSON payload string to sign
 * @param secret - The webhook's secret key
 * @returns Hex-encoded HMAC signature
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

  // Convert to hex string
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Webhook Delivery
// ============================================================================

/**
 * Delivers a webhook payload to the configured endpoint.
 *
 * Headers sent:
 * - X-Styrby-Signature: HMAC-SHA256 signature
 * - X-Styrby-Event: Event type (e.g., "session.started")
 * - X-Styrby-Delivery-Id: Unique delivery ID
 * - X-Styrby-Timestamp: Unix timestamp of delivery
 * - Content-Type: application/json
 *
 * @param webhook - The webhook configuration
 * @param delivery - The delivery record
 * @returns Delivery result with status and timing
 */
async function deliverWebhook(
  webhook: Webhook,
  delivery: WebhookDelivery
): Promise<DeliveryResult> {
  const startTime = Date.now();

  try {
    // Validate URL for SSRF
    validateWebhookUrl(webhook.url);

    // Prepare payload
    const payload = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);

    // Generate signature
    const signature = await generateSignature(payload, webhook.secret);

    // Create abort controller for timeout
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

      // Read response body for debugging (limited size)
      let responseBody: string | undefined;
      try {
        const text = await response.text();
        responseBody = text.slice(0, MAX_RESPONSE_BODY_LENGTH);
      } catch {
        responseBody = undefined;
      }

      // 2xx is success, anything else is failure
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
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';

    // Check for specific error types
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        deliveryId: delivery.id,
        success: false,
        duration_ms: duration,
        error: `Request timed out after ${HTTP_TIMEOUT_MS}ms`,
      };
    }

    return {
      deliveryId: delivery.id,
      success: false,
      duration_ms: duration,
      error: errorMessage,
    };
  }
}

/**
 * Calculates the next retry time using exponential backoff.
 *
 * Delays:
 * - Attempt 1 failed -> retry in 1 minute
 * - Attempt 2 failed -> retry in 2 minutes
 * - Attempt 3 failed -> no more retries
 *
 * @param attempts - Current number of attempts
 * @returns ISO timestamp for next retry, or null if max attempts reached
 */
function calculateNextRetryTime(attempts: number): string | null {
  if (attempts >= MAX_ATTEMPTS) {
    return null;
  }

  // Exponential backoff: 1min, 2min, 4min
  const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempts - 1);
  const nextRetry = new Date(Date.now() + delayMs);

  return nextRetry.toISOString();
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Parse request body
    let deliveryId: string | undefined;
    let processAll = false;

    try {
      const body = await req.json();
      deliveryId = body.deliveryId;
      processAll = body.processAll === true;
    } catch {
      // Empty body or invalid JSON - process all pending
      processAll = true;
    }

    // Create Supabase admin client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch deliveries to process
    let deliveries: WebhookDelivery[] = [];

    if (deliveryId) {
      // Process specific delivery
      const { data, error } = await supabase
        .from('webhook_deliveries')
        .select('*')
        .eq('id', deliveryId)
        .single();

      if (error) {
        console.error('Failed to fetch delivery:', error);
        return new Response(JSON.stringify({ error: 'Delivery not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      deliveries = [data];
    } else if (processAll) {
      // Process all pending deliveries that are due for retry
      const { data, error } = await supabase
        .from('webhook_deliveries')
        .select('*')
        .eq('status', 'pending')
        .or(`next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`)
        .order('created_at', { ascending: true })
        .limit(100); // Process in batches

      if (error) {
        console.error('Failed to fetch pending deliveries:', error);
        return new Response(JSON.stringify({ error: 'Failed to fetch deliveries' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      deliveries = data || [];
    }

    if (deliveries.length === 0) {
      return new Response(JSON.stringify({ processed: 0, message: 'No deliveries to process' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch webhooks for all deliveries (batch query)
    const webhookIds = [...new Set(deliveries.map((d) => d.webhook_id))];
    const { data: webhooks, error: webhooksError } = await supabase
      .from('webhooks')
      .select('id, user_id, url, secret, is_active')
      .in('id', webhookIds);

    if (webhooksError) {
      console.error('Failed to fetch webhooks:', webhooksError);
      return new Response(JSON.stringify({ error: 'Failed to fetch webhooks' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const webhookMap = new Map(webhooks?.map((w) => [w.id, w]) || []);

    // Process deliveries
    const results: DeliveryResult[] = [];

    for (const delivery of deliveries) {
      const webhook = webhookMap.get(delivery.webhook_id);

      if (!webhook) {
        // Webhook deleted, mark delivery as failed
        await supabase
          .from('webhook_deliveries')
          .update({
            status: 'failed',
            error_message: 'Webhook no longer exists',
            completed_at: new Date().toISOString(),
          })
          .eq('id', delivery.id);

        results.push({
          deliveryId: delivery.id,
          success: false,
          error: 'Webhook no longer exists',
        });
        continue;
      }

      if (!webhook.is_active) {
        // Webhook disabled, mark delivery as failed
        await supabase
          .from('webhook_deliveries')
          .update({
            status: 'failed',
            error_message: 'Webhook is disabled',
            completed_at: new Date().toISOString(),
          })
          .eq('id', delivery.id);

        results.push({
          deliveryId: delivery.id,
          success: false,
          error: 'Webhook is disabled',
        });
        continue;
      }

      // Attempt delivery
      const newAttempts = delivery.attempts + 1;
      const result = await deliverWebhook(webhook, delivery);
      results.push(result);

      if (result.success) {
        // Mark as success
        await supabase
          .from('webhook_deliveries')
          .update({
            status: 'success',
            attempts: newAttempts,
            last_attempt_at: new Date().toISOString(),
            response_status: result.statusCode,
            duration_ms: result.duration_ms,
            completed_at: new Date().toISOString(),
            next_retry_at: null,
          })
          .eq('id', delivery.id);
      } else {
        // Check if we should retry
        const nextRetryAt = calculateNextRetryTime(newAttempts);
        const isFinalFailure = nextRetryAt === null;

        await supabase
          .from('webhook_deliveries')
          .update({
            status: isFinalFailure ? 'failed' : 'pending',
            attempts: newAttempts,
            last_attempt_at: new Date().toISOString(),
            next_retry_at: nextRetryAt,
            response_status: result.statusCode,
            duration_ms: result.duration_ms,
            error_message: result.error,
            completed_at: isFinalFailure ? new Date().toISOString() : null,
          })
          .eq('id', delivery.id);
      }

      console.log(
        `Delivery ${delivery.id}: ${result.success ? 'SUCCESS' : 'FAILED'} ` +
          `(attempt ${newAttempts}/${MAX_ATTEMPTS}, ${result.duration_ms}ms)`
      );
    }

    // Summary
    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.length - successCount;

    return new Response(
      JSON.stringify({
        processed: results.length,
        success: successCount,
        failed: failedCount,
        results,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Webhook delivery error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
});
