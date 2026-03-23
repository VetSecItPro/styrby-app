/**
 * Web Push Unsubscribe Endpoint
 *
 * DELETE /api/push/unsubscribe
 *
 * Removes a Web Push subscription for the authenticated user. Deletes the
 * matching device_tokens row so the server stops sending push notifications
 * to this browser.
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 5 requests per minute per IP
 *
 * @body {
 *   endpoint: string
 * }
 *
 * @returns 200 { success: true }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 429 { error: 'RATE_LIMITED', message: string, retryAfter: number }
 * @error 500 { error: 'Failed to remove push subscription' }
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
 * Validates the unsubscribe request body.
 * Only the push endpoint URL is needed to identify the subscription to remove.
 */
const UnsubscribeSchema = z.object({
  /** The push service endpoint URL that identifies this subscription */
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
});

/**
 * Rate limit for push unsubscribe operations.
 * 5 requests per minute prevents abuse while allowing normal usage.
 */
const PUSH_RATE_LIMIT = { windowMs: 60_000, maxRequests: 5 } as const;

// ============================================================================
// DELETE /api/push/unsubscribe
// ============================================================================

/**
 * Handles DELETE requests to remove a Web Push subscription.
 *
 * @param request - The incoming HTTP request containing the endpoint to remove
 * @returns 200 on success, 4xx/5xx on failure
 *
 * @example
 * const response = await fetch('/api/push/unsubscribe', {
 *   method: 'DELETE',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ endpoint: subscription.endpoint }),
 * });
 */
export async function DELETE(request: NextRequest) {
  // Rate limit check
  const { allowed, retryAfter } = await rateLimit(
    request,
    PUSH_RATE_LIMIT,
    'push-unsubscribe'
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
    const parseResult = UnsubscribeSchema.safeParse(rawBody);

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

    // WHY: We match on both user_id and token (endpoint) to ensure users
    // can only delete their own subscriptions. RLS provides a second layer
    // of defense, but explicit filtering is the primary guard.
    const { error: deleteError } = await supabase
      .from('device_tokens')
      .delete()
      .eq('user_id', user.id)
      .eq('token', parseResult.data.endpoint);

    if (deleteError) {
      console.error(
        'Failed to remove push subscription:',
        deleteError.message
      );
      return NextResponse.json(
        { error: 'Failed to remove push subscription' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Push unsubscribe error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to remove push subscription' },
      { status: 500 }
    );
  }
}
