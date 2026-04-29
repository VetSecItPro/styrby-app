/**
 * GET /api/v1/account
 *
 * Identity and status endpoint. Returns the current API-key-holder's account
 * details. Used by the CLI to populate "logged in as X, tier Y, MFA Z,
 * key expires Q" status displays. Replaces direct `auth.getUser()` calls in
 * `packages/styrby-cli/src/commands/privacy.ts:320` and `commands/cloud.ts:218`.
 *
 * Strictly READ-ONLY — no mutations, no idempotency key required, no body.
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 req/min/key (default — this is called sparingly by the CLI)
 *
 * @returns 200 {
 *   user_id: string,      // UUID of authenticated user
 *   email: string,        // User's email from auth.users
 *   tier: string,         // Subscription tier ('free' when no subscription)
 *   created_at: string,   // ISO 8601 — account creation timestamp
 *   mfa_enrolled: boolean,// Whether the user has registered at least one passkey
 *   key_expires_at: string | null  // ISO 8601 expiry of the CURRENT API key
 * }
 *
 * @error 401 { error: string }  — Missing or invalid API key (auth wrapper)
 * @error 404 { error: string }  — auth.users row missing (DB inconsistency)
 * @error 500 { error: string }  — Unexpected DB error (sanitized)
 *
 * @security OWASP A01:2021 — User identity sourced ONLY from auth context;
 *           no query-string or body parameter can affect whose data is returned.
 * @security OWASP A07:2021 — Authentication enforced by withApiAuthAndRateLimit.
 * @security GDPR Art. 6   — Lawful basis: consent (API key constitutes acceptance
 *           of ToS; processing is necessary for contract performance).
 * @security GDPR Art. 15  — Right of access: user is reading their OWN data,
 *           so no third-party privacy concern arises.
 * @security SOC 2 CC6.1   — Logical access: identity locked to authenticated subject;
 *           service-role client bypasses RLS but is constrained by userId from context.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import {
  withApiAuthAndRateLimit,
  type ApiAuthContext,
} from '@/middleware/api-auth';
import { createAdminClient } from '@/lib/supabase/server';

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/**
 * The exact 6-field identity response returned by GET /api/v1/account.
 *
 * WHY exactly 6 fields: we expose only what the CLI needs (display + UX
 * decision-making). Subscription IDs, Polar customer IDs, internal flags,
 * and raw DB row data are deliberately excluded to minimise PII surface area
 * and reduce coupling between the CLI and internal data models.
 */
export interface AccountResponse {
  /** UUID of the authenticated user. */
  user_id: string;
  /** User's email address from auth.users. Only PII field — it's the user's own. */
  email: string;
  /** Subscription tier. Defaults to 'free' when no subscription row exists. */
  tier: string;
  /** ISO 8601 timestamp of when the account was created. */
  created_at: string;
  /** True when the user has registered at least one WebAuthn passkey. */
  mfa_enrolled: boolean;
  /** ISO 8601 expiry of the CURRENT API key, or null if the key never expires. */
  key_expires_at: string | null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core GET handler for the account identity endpoint.
 *
 * Wrapped by withApiAuthAndRateLimit — never called directly from the route.
 * The wrapper enforces:
 *  1. IP-based pre-auth rate limit — blocks unauthenticated floods
 *  2. Per-key rate limit (100 req/min/key default)
 *  3. Required scopes: ['read']
 *
 * Query execution order:
 *  1. auth.admin.getUserById(userId) — email + created_at (service-role required)
 *  2. subscriptions LEFT JOIN — tier (defaults 'free')
 *  3. passkeys COUNT — mfa_enrolled boolean
 *  4. key_expires_at — already in authContext (set during API key authentication)
 *
 * @param _request - Authenticated NextRequest (unused — no query params needed)
 * @param context  - Auth context from withApiAuthAndRateLimit (userId, keyId, scopes, keyExpiresAt)
 * @returns 200 AccountResponse | 404 | 500
 *
 * @security OWASP A01:2021 — userId comes from auth context, never from request
 * @security SOC 2 CC6.1   — admin client usage bounded by userId from validated API key
 */
async function handleGet(_request: NextRequest, context: ApiAuthContext): Promise<NextResponse> {
  const { userId, keyExpiresAt } = context;

  // WHY per-request createAdminClient() (not module-level singleton):
  // Next.js App Router reuses module instances across requests in the same
  // worker. A module-level Supabase client would share connection state and
  // potentially leak auth context across concurrent requests. Creating a new
  // client per request guarantees isolation. SOC 2 CC6.1.
  const adminClient = createAdminClient();

  // -------------------------------------------------------------------------
  // Step 1: Fetch auth.users row — email + created_at
  // WHY auth.admin.getUserById (not a direct table query): auth.users lives in
  // the `auth` schema which is owned by Supabase Auth and not exposed via the
  // public PostgREST API. The Auth Admin SDK method is the canonical way to
  // read auth.users rows server-side with service-role credentials.
  // OWASP A01:2021 — we look up by userId from the auth context, never from input.
  // -------------------------------------------------------------------------
  const { data: authUserData, error: authUserError } = await adminClient.auth.admin.getUserById(userId);

  if (authUserError || !authUserData?.user) {
    // This should never happen with a valid styrby_* key (the key is bound to
    // a user_id that exists in auth.users at key-creation time). If we hit this,
    // it indicates a DB inconsistency that warrants investigation.
    Sentry.captureMessage(`GET /api/v1/account: auth.users row missing for userId=${userId}`, {
      level: 'warning',
      extra: { userId, error: authUserError?.message },
    });
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  const authUser = authUserData.user;

  // -------------------------------------------------------------------------
  // Step 2: Fetch subscription tier
  // WHY LEFT JOIN semantics via .maybeSingle(): a user may not have a
  // subscriptions row (e.g. just signed up, Polar webhook hasn't fired yet).
  // In that case we default to 'free'. Never reject the request — the CLI
  // should still display a usable status even on fresh accounts.
  // -------------------------------------------------------------------------
  let tier = 'free';

  try {
    const { data: subRow, error: subError } = await adminClient
      .from('subscriptions')
      .select('tier')
      .eq('user_id', userId)
      .maybeSingle();

    if (subError) {
      // WHY Sentry here but continue: a missing tier is not fatal. The CLI
      // can still operate; we just default to 'free' and alert for investigation.
      Sentry.captureException(new Error(`GET /api/v1/account: subscriptions query error: ${subError.message}`), {
        extra: { userId, route: '/api/v1/account' },
      });
    } else if (subRow?.tier) {
      tier = subRow.tier as string;
    }
  } catch (err) {
    Sentry.captureException(err, { extra: { userId, route: '/api/v1/account', step: 'subscriptions' } });
    return NextResponse.json({ error: 'Failed to fetch account details' }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Step 3: Check MFA enrollment (passkeys table)
  // WHY COUNT > 0 approach: we don't need the credentials themselves, just
  // whether any exist. Using .limit(1) + checking data.length avoids a full
  // table scan on users with many passkeys. SOC 2 CC6.6.
  // -------------------------------------------------------------------------
  let mfaEnrolled = false;

  try {
    const { data: passkeyRows, error: passkeyError } = await adminClient
      .from('passkeys')
      .select('id')
      .eq('user_id', userId)
      .limit(1);

    if (passkeyError) {
      Sentry.captureException(new Error(`GET /api/v1/account: passkeys query error: ${passkeyError.message}`), {
        extra: { userId, route: '/api/v1/account' },
      });
      return NextResponse.json({ error: 'Failed to fetch account details' }, { status: 500 });
    }

    mfaEnrolled = (passkeyRows?.length ?? 0) > 0;
  } catch (err) {
    Sentry.captureException(err, { extra: { userId, route: '/api/v1/account', step: 'passkeys' } });
    return NextResponse.json({ error: 'Failed to fetch account details' }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Step 4: key_expires_at — already available from auth context
  // WHY from context (not a fresh api_keys query): withApiAuthAndRateLimit
  // already looked up the api_keys row to authenticate the request. The
  // expires_at was attached to the context at that point. Re-querying by
  // keyId would be redundant and add latency. The context value is authoritative.
  // If context.keyExpiresAt is null, the key never expires — return null.
  // -------------------------------------------------------------------------
  const keyExpiresAtValue = keyExpiresAt ?? null;

  // -------------------------------------------------------------------------
  // Build the exact 6-field response
  // WHY explicit field enumeration (not spread): prevents accidental PII leakage
  // if the authUser or subRow objects gain new fields in the future.
  // OWASP A01:2021 — response shape is locked to the spec.
  // -------------------------------------------------------------------------
  const responseBody: AccountResponse = {
    user_id: userId,
    email: authUser.email ?? '',
    tier,
    created_at: authUser.created_at,
    mfa_enrolled: mfaEnrolled,
    key_expires_at: keyExpiresAtValue,
  };

  // WHY no-store: this response contains PII (email) and is user-specific.
  // CDN/proxy caching must be prevented. GDPR Art. 5 (data minimisation).
  return NextResponse.json(responseBody, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// Export — GET only, wrapped with auth + rate limit
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/account
 *
 * Required scopes: ['read'] — identity reads require at minimum the read scope.
 * WHY 'read' not 'write': this is strictly a read-only endpoint. API keys
 * scoped for read-only (e.g. dashboard integrations, monitoring) should be
 * able to call this endpoint. SOC 2 CC6.1 (least-privilege).
 */
export const GET = withApiAuthAndRateLimit(handleGet, ['read']);
