/**
 * Web Push Subscription Endpoint
 *
 * POST /api/push/subscribe
 *
 * Registers a Web Push subscription for the authenticated user. Stores the
 * subscription in the device_tokens table so the server can send push
 * notifications to this browser via the Web Push protocol.
 *
 * Uses UPSERT on the subscription endpoint to handle re-subscriptions
 * gracefully (e.g., when the browser refreshes the push subscription).
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 5 requests per minute per IP
 *
 * @body {
 *   endpoint: string,
 *   keys: { p256dh: string, auth: string },
 *   expirationTime?: number | null
 * }
 *
 * @returns 201 { success: true }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 429 { error: 'RATE_LIMITED', message: string, retryAfter: number }
 * @error 500 { error: 'Failed to save push subscription' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// ============================================================================
// Push Service Allowlist
// ============================================================================

/**
 * WHY: Without an allowlist, an attacker could supply an arbitrary URL as the
 * push endpoint, turning our server into an SSRF proxy that sends POST requests
 * to internal services or third-party targets. By restricting endpoints to known
 * push service hostnames, we ensure the server only contacts legitimate push
 * services operated by browser vendors.
 */
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
  'web.push.apple.com',
];

/**
 * Checks whether a hostname matches an allowed push service host.
 * Supports exact matches and subdomain matches (e.g., "foo.push.apple.com").
 *
 * @param hostname - The hostname to validate
 * @returns True if the hostname is an allowed push service
 */
function isAllowedPushHost(hostname: string): boolean {
  return ALLOWED_PUSH_HOSTS.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`)
  );
}

// ============================================================================
// Zod Schema
// ============================================================================

/**
 * Validates a Web Push PushSubscription object.
 *
 * WHY: The PushSubscription from the browser contains an endpoint URL and
 * encryption keys (p256dh for ECDH key exchange, auth for message
 * authentication). Both keys are required for the web-push library to
 * encrypt payloads before sending them to the push service.
 */
const PushSubscriptionSchema = z.object({
  /** The push service endpoint URL provided by the browser */
  endpoint: z
    .string()
    .url('Endpoint must be a valid URL')
    .max(2048, 'Endpoint URL is too long')
    .refine((url) => {
      try {
        const parsed = new URL(url);
        return isAllowedPushHost(parsed.hostname);
      } catch {
        return false;
      }
    }, 'Endpoint must be a recognized push service (FCM, Mozilla, Windows, or Apple)'),

  /** Encryption keys for Web Push payload encryption */
  keys: z.object({
    /** ECDH public key for Diffie-Hellman key exchange (base64url encoded) */
    p256dh: z.string().min(1, 'p256dh key is required'),
    /** Authentication secret for message authentication (base64url encoded) */
    auth: z.string().min(1, 'auth key is required'),
  }),

  /** Optional expiration time for the subscription (milliseconds since epoch) */
  expirationTime: z.number().nullable().optional(),
});

/**
 * Rate limit for push subscription operations.
 * 5 requests per minute prevents abuse while allowing normal usage.
 */
const PUSH_RATE_LIMIT = { windowMs: 60_000, maxRequests: 5 } as const;

// ============================================================================
// POST /api/push/subscribe
// ============================================================================

/**
 * Handles POST requests to register a Web Push subscription.
 *
 * @param request - The incoming HTTP request containing the PushSubscription JSON
 * @returns 201 on success, 4xx/5xx on failure
 *
 * @example
 * const response = await fetch('/api/push/subscribe', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify(pushSubscription.toJSON()),
 * });
 */
export async function POST(request: NextRequest) {
  // Rate limit check
  const { allowed, retryAfter } = await rateLimit(
    request,
    PUSH_RATE_LIMIT,
    'push-subscribe'
  );
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    // Authenticate user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse and validate request body
    const rawBody = await request.json();
    const parseResult = PushSubscriptionSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: parseResult.error.errors
            .map((e) => e.message)
            .join(', '),
        },
        { status: 400 }
      );
    }

    const subscription = parseResult.data;

    // WHY: We use the endpoint URL as the unique token identifier for web push
    // subscriptions. The endpoint is unique per browser instance and changes
    // when the subscription is refreshed, making it a reliable dedup key.
    const { error: upsertError } = await supabase
      .from('device_tokens')
      .upsert(
        {
          user_id: user.id,
          token: subscription.endpoint,
          platform: 'web',
          web_push_subscription: subscription,
          is_active: true,
        },
        { onConflict: 'user_id,token' }
      );

    if (upsertError) {
      console.error(
        'Failed to save push subscription:',
        upsertError.message
      );
      return NextResponse.json(
        { error: 'Failed to save push subscription' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Push subscribe error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to save push subscription' },
      { status: 500 }
    );
  }
}
