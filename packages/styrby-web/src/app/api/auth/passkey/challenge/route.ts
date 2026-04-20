/**
 * POST /api/auth/passkey/challenge
 *
 * Thin proxy to the `verify-passkey` Supabase edge function for challenge
 * issuance. Accepts both `challenge-register` (enrollment) and
 * `challenge-login` (authentication) actions.
 *
 * WHY a proxy: The edge function requires the service role key for some
 * operations and lives at a Supabase URL. Exposing the service role key or
 * the raw Supabase endpoint to the browser is a security antipattern.
 * This proxy route keeps the edge-function URL and keys server-side and
 * lets the browser call a same-origin endpoint instead.
 *
 * WHY rate-limit here: The edge function has its own rate limiting, but a
 * per-IP limit at the Next.js layer (10/min) stops automated scanners from
 * burning Supabase function invocations before the edge function even runs.
 * (SOC2 CC6.6, OWASP API4)
 *
 * @auth Not required — challenge issuance is public by design.
 *       The `challenge-register` action DOES require a Supabase session
 *       (checked inside the edge function), but the proxy layer stays thin
 *       and forwards the Authorization header transparently.
 * @rateLimit 10 requests per minute per IP
 *
 * @body {
 *   action: 'challenge-register' | 'challenge-login',
 *   email?: string  // required for challenge-login
 * }
 *
 * @returns 200 { challenge: string, ... }  — edge function response forwarded verbatim
 *
 * @error 400 { error: 'INVALID_ACTION' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 502 { error: 'EDGE_FUNCTION_ERROR', message: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

/**
 * Tight rate-limit bucket for passkey challenge issuance.
 * WHY 10/min: Challenges expire quickly (~5 min) and a human user needs at
 * most one per attempt. 10/min is generous for retries but blocks automated
 * scanning of valid/invalid emails (account enumeration via timing).
 */
const PASSKEY_CHALLENGE_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

/**
 * The Supabase edge function URL for passkey operations.
 * Constructed from SUPABASE_URL which is server-side only (not NEXT_PUBLIC_).
 *
 * WHY not hardcoded: Preview deployments use different Supabase projects.
 * Environment-driven URL keeps staging isolated from production.
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
    PASSKEY_CHALLENGE_RATE_LIMIT,
    'passkey-challenge',
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
  if (action !== 'challenge-register' && action !== 'challenge-login') {
    return NextResponse.json(
      { error: 'INVALID_ACTION', message: "action must be 'challenge-register' or 'challenge-login'" },
      { status: 400 },
    );
  }

  // ── Forward to edge function ───────────────────────────────────────────────
  let edgeUrl: string;
  try {
    edgeUrl = getEdgeFunctionUrl();
  } catch (err) {
    console.error('[passkey/challenge] Missing SUPABASE_URL:', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  // Forward the Authorization header so the edge function can identify the
  // session for `challenge-register` (which requires auth).
  const forwardHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const authorization = request.headers.get('authorization');
  if (authorization) {
    forwardHeaders['Authorization'] = authorization;
  }
  // Also forward cookie-based auth for browser clients (Next.js SSR cookies).
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
    console.error('[passkey/challenge] Edge function unreachable:', err);
    return NextResponse.json(
      { error: 'EDGE_FUNCTION_ERROR', message: 'Passkey service temporarily unavailable' },
      { status: 502 },
    );
  }

  // Forward the response (status + body) to the browser unchanged.
  const responseBody = await edgeResponse.text();
  return new NextResponse(responseBody, {
    status: edgeResponse.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
