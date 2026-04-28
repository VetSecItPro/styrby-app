/**
 * POST /api/auth/passkey/verify
 *
 * Thin proxy to the `verify-passkey` Supabase edge function for attestation
 * and assertion verification. Handles both `verify-register` (enrollment
 * completion) and `verify-login` (authentication completion) actions.
 *
 * WHY a proxy: Same rationale as /api/auth/passkey/challenge — keeps the
 * service role key and Supabase edge function URL off the browser.
 *
 * WHY rate-limit here: Verification carries the signed credential response.
 * 10/min per IP blocks brute-force and replay automation. (SOC2 CC6.6)
 *
 * WHY lockout here (verify-login only): We apply account lockout after 5
 * consecutive `verify-login` failures within 1 hour. This is the only
 * user-facing auth endpoint (passkey-based; no password). The lockout check
 * requires resolving the user from the email field before forwarding so we
 * can gate on a per-user basis rather than per-IP (which can be spoofed).
 * (H42 Item 3, SOC2 CC6.6, NIST SP 800-63B §5.2.2)
 *
 * @auth Not required at proxy layer — `verify-register` requires a valid
 *       Supabase session (enforced inside the edge function).
 * @rateLimit 10 requests per minute per IP
 *
 * @body {
 *   action: 'verify-register' | 'verify-login',
 *   response: PasskeyRegistrationResponse | PasskeyAuthenticationResponse,
 *   email?: string  // required for verify-login
 * }
 *
 * @returns 200 { success: true, session?: SupabaseSession }
 *
 * @error 400 { error: 'INVALID_ACTION' | 'INVALID_JSON' }
 * @error 422 { error: string }  — verification failed (bad signature, expired challenge, etc.)
 * @error 423 { error: 'ACCOUNT_LOCKED', retryAfter: number }  — too many failures
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 502 { error: 'EDGE_FUNCTION_ERROR' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { Logger } from '@styrby/shared/logging';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase/server';
import {
  checkLockoutStatus,
  recordLoginFailure,
  resetLoginFailures,
  lockoutResponse,
} from '@/lib/auth-lockout';

/**
 * Structured logger for passkey auth flow events.
 * WHY: Passkey verification failures are security-relevant events (SOC2 CC6.6).
 * Structured logs let the founder detect brute-force patterns or edge function
 * regressions without waiting for user-reported breakage.
 */
const authLog = new Logger({
  minLevel: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  sentry: {
    addBreadcrumb: (b) => Sentry.addBreadcrumb(b),
    captureException: (e, ctx) => Sentry.captureException(e, ctx) ?? '',
  },
});

/**
 * Tight rate-limit for passkey verification.
 * Matches the challenge rate limit so an attacker cannot receive more
 * challenges than they can verify.
 */
const PASSKEY_VERIFY_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

/**
 * The Supabase edge function URL for passkey operations.
 * Server-side only — never exposed to the browser.
 */
function getEdgeFunctionUrl(): string {
  const base = process.env.SUPABASE_URL;
  if (!base) {
    throw new Error('SUPABASE_URL is not configured');
  }
  return `${base}/functions/v1/verify-passkey`;
}

/**
 * Resolves a Supabase user_id from an email address using the admin client.
 *
 * WHY: The passkey verify request includes email for `verify-login` so the
 * edge function can look up the credential. We reuse it here to look up
 * user_id for per-user lockout checks before forwarding the credential.
 *
 * @param email - The email address supplied in the verify-login request body
 * @returns The Supabase user_id, or null if not found or lookup errors
 */
async function resolveUserIdByEmail(email: string): Promise<string | null> {
  const supabase = createAdminClient();

  // WHY search_users_by_email_for_admin instead of profiles query: profiles.id
  // mirrors auth.users.id but profiles has no email column (email lives in
  // auth.users). The search RPC (migration 064) queries auth.users directly
  // with a SECURITY DEFINER function, returning user_id for an exact match.
  // We pass limit=1 since we only need to check whether a lockout record exists.
  const { data, error } = await supabase
    .rpc('search_users_by_email_for_admin', {
      p_query: email,
      p_limit: 1,
      p_offset: 0,
    });

  if (error || !data?.length) {
    // WHY: Return null rather than throwing — lockout pre-check is fail-open.
    // An unknown email means there is no account to lock. The edge function
    // will handle the 404/422 for the actual credential check.
    return null;
  }

  // RPC returns rows with `id` (auth.users.id), `email`, tier, etc.
  // Find an exact case-insensitive match (RPC uses ILIKE which may be partial).
  const exactMatch = (data as Array<{ id: string; email: string }>).find(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  );
  return exactMatch?.id ?? null;
}

export async function POST(request: NextRequest) {
  // ── Rate limiting ──────────────────────────────────────────────────────────
  const { allowed, retryAfter } = await rateLimit(
    request,
    PASSKEY_VERIFY_RATE_LIMIT,
    'passkey-verify',
  );
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  // ── Parse & validate action ────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  const action = (body as Record<string, unknown>)?.action;
  if (action !== 'verify-register' && action !== 'verify-login') {
    return NextResponse.json(
      { error: 'INVALID_ACTION', message: "action must be 'verify-register' or 'verify-login'" },
      { status: 400 },
    );
  }

  // ── Lockout pre-check (verify-login only, H42 Item 3) ─────────────────────
  // WHY: Only verify-login maps to a real user account. verify-register is
  // gated by an existing authenticated session inside the edge function;
  // applying lockout there would create a confusing error surface.
  let resolvedUserId: string | null = null;

  if (action === 'verify-login') {
    const email = (body as Record<string, unknown>)?.email;
    if (typeof email === 'string' && email.length > 0) {
      resolvedUserId = await resolveUserIdByEmail(email);
    }

    if (resolvedUserId) {
      const lockout = await checkLockoutStatus(resolvedUserId);
      if (lockout.isLocked && lockout.lockedUntil) {
        authLog.warn('auth.passkey_login_blocked_lockout', {
          userId: resolvedUserId,
          lockedUntil: lockout.lockedUntil,
        });
        return lockoutResponse(lockout.lockedUntil) as NextResponse;
      }
    }
  }

  // ── Forward to edge function ───────────────────────────────────────────────
  let edgeUrl: string;
  try {
    edgeUrl = getEdgeFunctionUrl();
  } catch (err) {
    console.error('[passkey/verify] Missing SUPABASE_URL:', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  const forwardHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const authorization = request.headers.get('authorization');
  if (authorization) {
    forwardHeaders['Authorization'] = authorization;
  }
  const cookie = request.headers.get('cookie');
  if (cookie) {
    forwardHeaders['Cookie'] = cookie;
  }

  let edgeResponse: Response;
  try {
    edgeResponse = await fetch(edgeUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(body),
    });
  } catch (err) {
    authLog.error(
      'auth.passkey_edge_unreachable',
      { action: String(action) },
      err instanceof Error ? err : new Error(String(err)),
    );
    console.error('[passkey/verify] Edge function unreachable:', err);
    return NextResponse.json(
      { error: 'EDGE_FUNCTION_ERROR', message: 'Passkey service temporarily unavailable' },
      { status: 502 },
    );
  }

  const responseBody = await edgeResponse.text();

  // ── Lockout accounting (verify-login only) ─────────────────────────────────
  // WHY: Only update failure counts when we have a resolved user_id.
  // If we couldn't resolve the user (unknown email), there is no account
  // to lock — the edge function will return 404/422 on its own.
  if (action === 'verify-login' && resolvedUserId) {
    if (edgeResponse.status >= 400) {
      // Fire-and-forget: record failure and update lock if threshold reached.
      // We do NOT await here to avoid delaying the response.
      void recordLoginFailure(resolvedUserId).then((lockout) => {
        if (lockout.isLocked) {
          authLog.warn('auth.passkey_lockout_triggered', {
            userId: resolvedUserId,
            lockedUntil: lockout.lockedUntil,
          });
        }
      });
    } else {
      // Successful login — reset failure counter (fire-and-forget).
      void resetLoginFailures(resolvedUserId);
    }
  }

  if (edgeResponse.status >= 400) {
    authLog.warn('auth.passkey_verify_failed', {
      action: String(action),
      status: edgeResponse.status,
    });
  } else {
    authLog.info('auth.passkey_verify_success', { action: String(action) });
  }

  return new NextResponse(responseBody, {
    status: edgeResponse.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
