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
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 502 { error: 'EDGE_FUNCTION_ERROR' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { Logger } from '@styrby/shared/logging';
import * as Sentry from '@sentry/nextjs';

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
