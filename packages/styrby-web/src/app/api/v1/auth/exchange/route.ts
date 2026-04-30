/**
 * POST /api/v1/auth/exchange
 *
 * Exchanges a valid Supabase Auth access token for a per-user `styrby_*` API
 * key. This is the bridge between the existing CLI auth bootstrap (which
 * mints a Supabase JWT via `supabase.auth.signInWithOtp` /
 * `signInWithOAuth`) and Strategy C (which uses `styrby_*` keys for every
 * `/api/v1/*` call).
 *
 * Flow:
 *   1. Caller authenticates with Supabase Auth (any method) and obtains
 *      an access_token.
 *   2. Caller POSTs here with `Authorization: Bearer <supabase_access_token>`.
 *   3. Server validates the JWT against Supabase, extracts user_id.
 *   4. Server mints a fresh `styrby_*` key for that user (bcrypt hash to
 *      api_keys; raw key returned ONCE).
 *   5. Caller persists both credentials. The Supabase JWT remains valid for
 *      Realtime subscriptions until Phase 5b replaces that surface; the
 *      styrby_* key authenticates every /api/v1/* call.
 *
 * @auth Bearer Supabase access token (NOT a styrby_* key — this is the
 *   bootstrap path that mints one). The token is validated server-side via
 *   `supabase.auth.getUser(jwt)` which honours signature + expiry + user
 *   existence.
 *
 * @rateLimit 10 requests per minute per IP (low — exchange should fire once
 *   per onboarding, not per user action).
 *
 * @body none — caller passes the JWT in the Authorization header.
 *
 * @returns 200 {
 *   styrby_api_key: string,  // Raw plaintext key — shown ONCE
 *   expires_at: string,      // ISO 8601 expiry (365-day default)
 *   user_id: string          // UUID of the authenticated user
 * }
 *
 * @error 401 { error: 'AUTH_FAILED' }     — Missing or invalid Supabase JWT
 * @error 429 { error: 'RATE_LIMITED' }    — IP cap exceeded
 * @error 500 { error: 'INTERNAL_ERROR' }  — Key minting failure (Sentry)
 *
 * @security OWASP A07:2021 — auth via Supabase JWT signature verification.
 * @security OWASP A02:2021 — bcrypt-hashed key storage; raw key never logged.
 * @security OWASP A05:2021 — explicit 365-day TTL; no non-expiring keys.
 * @security OWASP A01:2021 — generic 401 for all auth failures (no enumeration).
 * @security GDPR Art 6(1)(b) — lawful basis: contract performance.
 * @security SOC 2 CC6.1 — key bound to authenticated user_id from validated JWT.
 *
 * @module api/v1/auth/exchange
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { createAdminClient } from '@/lib/supabase/server';
import { hashApiKey } from '@/lib/api-keys';
import { generateApiKey } from '@styrby/shared';
import { AUTH_EXCHANGE_RATE_LIMIT, KEY_TTL_DAYS } from '@/lib/auth/api-config';
import { rateLimit } from '@/lib/rateLimit';

const ROUTE_ID = '/api/v1/auth/exchange';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handlePost(request: NextRequest): Promise<NextResponse> {
  // ── 1. IP-based rate limit ────────────────────────────────────────────────
  // WHY separate try/catch: a throw from rateLimit (Redis unreachable) is a
  // TRUE infrastructure failure that must surface as 500, not silently fall
  // through. Same pattern as /otp/send.
  let rateLimitResult: Awaited<ReturnType<typeof rateLimit>>;
  try {
    rateLimitResult = await rateLimit(request, AUTH_EXCHANGE_RATE_LIMIT, 'auth-exchange');
  } catch (rateLimitErr) {
    Sentry.captureException(rateLimitErr, {
      tags: { endpoint: ROUTE_ID },
      extra: { context: 'rateLimit infrastructure threw' },
    });
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  if (!rateLimitResult.allowed) {
    const retryAfter = rateLimitResult.retryAfter ?? 60;
    return NextResponse.json(
      { error: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  // ── 2. Extract + validate the Supabase JWT from Authorization header ──────
  const authHeader = request.headers.get('authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) {
    return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
  }
  const supabaseJwt = match[1].trim();
  if (supabaseJwt.length === 0) {
    return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
  }

  // WHY admin client + getUser(token): the admin client uses the service-role
  // key, but `getUser(jwt)` validates the supplied JWT against Supabase's auth
  // server (signature + expiry + user existence). If the JWT is fake / expired /
  // revoked, getUser returns an error and we 401.
  // OWASP A07:2021 — server-side JWT verification, no client-side trust.
  const supabase = createAdminClient();
  let userId: string;
  try {
    const { data, error } = await supabase.auth.getUser(supabaseJwt);
    if (error || !data?.user?.id) {
      // Generic 401 — no signal about which JWTs are valid (OWASP A07:2021).
      return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
    }
    userId = data.user.id;
  } catch {
    // Catch-all → 401 prevents leaking infra errors as auth signals.
    return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
  }

  // ── 3. Mint styrby_* API key (same pattern as /otp/verify, /oauth/callback) ──
  try {
    const { key: plaintextKey, prefix } = generateApiKey();
    const keyHash = await hashApiKey(plaintextKey);

    const expDate = new Date();
    expDate.setDate(expDate.getDate() + KEY_TTL_DAYS);
    const expiresAt = expDate.toISOString();

    const { error: insertError } = await supabase
      .from('api_keys')
      .insert({
        user_id: userId,
        // 'CLI Bootstrap Exchange' distinguishes this key from /otp and /oauth
        // mints in the user's API key listing UI.
        name: 'CLI Bootstrap Exchange',
        key_prefix: prefix,
        key_hash: keyHash,
        scopes: ['read', 'write'],
        expires_at: expiresAt,
      });

    if (insertError) {
      Sentry.captureException(new Error(`api_keys insert failed: ${insertError.message}`), {
        tags: { endpoint: ROUTE_ID, user_id: userId },
      });
      return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
    }

    // SECURITY: plaintextKey returned ONCE; never logged anywhere.
    return NextResponse.json(
      { styrby_api_key: plaintextKey, expires_at: expiresAt, user_id: userId },
      { status: 200 },
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { endpoint: ROUTE_ID, user_id: userId },
    });
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export const POST = handlePost;
