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
 * @error 403 { error: 'AAL2_REQUIRED' }   — User has MFA enrolled but session is aal1 (WAVE-E-008)
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
    // WAVE-B-002: failClosed=true. If Upstash is unreachable for this auth-
    // state-changing endpoint, we surface 503 instead of allowing the request
    // through unmetered. An attacker who can degrade the limiter must not be
    // able to flood key-minting calls.
    rateLimitResult = await rateLimit(
      request,
      AUTH_EXCHANGE_RATE_LIMIT,
      'auth-exchange',
      { failClosed: true },
    );
  } catch (rateLimitErr) {
    Sentry.captureException(rateLimitErr, {
      tags: { endpoint: ROUTE_ID },
      extra: { context: 'rateLimit infrastructure threw' },
    });
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  if (!rateLimitResult.allowed) {
    // WAVE-B-002: distinguish "you exceeded limits" (429) from
    // "limiter is down + we fail-closed" (503). Clients can retry the latter
    // without being held to the per-IP cap.
    if (rateLimitResult.infrastructureUnavailable) {
      return NextResponse.json(
        { error: 'RATE_LIMIT_UNAVAILABLE' },
        { status: 503, headers: { 'Retry-After': '30' } },
      );
    }
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
  // WHY captured separately: aal (authentication assurance level) lives on the
  // JWT claims, not on `data.user`. Decode the JWT body to read aal alongside
  // the validated user (signature is verified by getUser; we only read claims
  // AFTER verification succeeds, so this is not an unsafe parse).
  let jwtAal: string | null = null;
  try {
    const { data, error } = await supabase.auth.getUser(supabaseJwt);
    if (error || !data?.user?.id) {
      // Generic 401 — no signal about which JWTs are valid (OWASP A07:2021).
      return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
    }
    userId = data.user.id;

    // Decode JWT body for aal claim. Safe AFTER getUser() verified signature.
    try {
      const payloadB64 = supabaseJwt.split('.')[1] ?? '';
      const payloadJson = Buffer.from(payloadB64, 'base64').toString('utf8');
      const claims = JSON.parse(payloadJson) as { aal?: string };
      jwtAal = typeof claims.aal === 'string' ? claims.aal : null;
    } catch {
      jwtAal = null;
    }
  } catch {
    // Catch-all → 401 prevents leaking infra errors as auth signals.
    return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
  }

  // ── 2b. WAVE-E-008: aal2 enforcement when MFA is enrolled ─────────────────
  // WHY: minting a long-lived `styrby_*` key from a JWT is a high-value step.
  // Replay of a stolen aal1 JWT could mint up to ~600 keys/hr against the
  // current rate limit. If the user has elevated their session via MFA (aal2),
  // a stolen JWT alone is insufficient. Users WITHOUT MFA enrolled are not
  // forced into a UX cliff — we allow the exchange but emit an audit hint.
  //
  // Kill switch: EXCHANGE_REQUIRE_AAL2_IF_ENROLLED=false disables enforcement
  // (operator escape hatch if the MFA-listing API misbehaves in prod).
  const aal2EnforcementEnabled =
    (process.env.EXCHANGE_REQUIRE_AAL2_IF_ENROLLED ?? 'true').toLowerCase() !== 'false';
  if (aal2EnforcementEnabled) {
    let mfaFactorCount = 0;
    try {
      // WHY admin.mfa.listFactors with userId: getUser() returned the user but
      // the client-bound mfa.listFactors() requires a session-scoped client.
      // The admin auth API surfaces factors per-user without a session.
      const { data: factorsData, error: factorsError } = await supabase.auth.admin.mfa.listFactors({
        userId,
      });
      if (factorsError) {
        // WHY non-fatal: a factor-list lookup failure must not block onboarding.
        // Default to "no factors" (allow exchange + audit hint) rather than
        // failing closed and bricking every CLI sign-in if Supabase auth is
        // degraded. The audit_log row makes the degradation observable.
        Sentry.captureException(factorsError, {
          tags: { endpoint: ROUTE_ID, user_id: userId, context: 'mfa-listFactors' },
        });
      } else {
        // Verified factors are the ones that actually elevate AAL.
        const factors = factorsData?.factors ?? [];
        mfaFactorCount = factors.filter((f) => f.status === 'verified').length;
      }
    } catch (mfaErr) {
      Sentry.captureException(mfaErr, {
        tags: { endpoint: ROUTE_ID, user_id: userId, context: 'mfa-listFactors-throw' },
      });
    }

    if (mfaFactorCount > 0 && jwtAal !== 'aal2') {
      // User is MFA-enrolled but session is aal1 — REQUIRE re-auth.
      // 403 (not 401): the JWT is valid; the privilege level is insufficient.
      return NextResponse.json(
        {
          error: 'AAL2_REQUIRED',
          message: 'Re-authenticate with MFA before exchanging a JWT for an API key.',
        },
        { status: 403 },
      );
    }

    if (mfaFactorCount === 0) {
      // No MFA enrolled — allow the exchange, but flag for follow-up.
      console.warn(
        `[exchange] user ${userId} exchanged a JWT for an API key without MFA enrolled — recommend enrollment`,
      );
      // Audit row is best-effort (failure must not block the exchange).
      void supabase
        .from('audit_log')
        .insert({
          user_id: userId,
          action: 'security_event',
          resource_type: 'auth',
          resource_id: null,
          metadata: {
            event_subtype: 'exchange_without_mfa',
            recommendation: 'enroll_mfa',
            jwt_aal: jwtAal,
          },
        })
        .then(({ error: auditErr }) => {
          if (auditErr) {
            console.error(
              '[exchange] audit_log insert (exchange_without_mfa) failed (non-fatal):',
              auditErr.message,
            );
          }
        });
    }
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
