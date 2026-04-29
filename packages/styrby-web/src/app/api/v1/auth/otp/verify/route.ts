/**
 * POST /api/v1/auth/otp/verify
 *
 * Verifies a 6-digit OTP (or longer magic-link token) submitted by the CLI,
 * mints a styrby_* API key bound to the authenticated user, and returns the
 * key ONCE. This is the second leg of the two-step OTP onboarding flow:
 *
 *   Step 1 — POST /api/v1/auth/otp/send   → OTP dispatched to user's email
 *   Step 2 — POST /api/v1/auth/otp/verify → OTP verified; styrby_* key minted
 *
 * After this endpoint lands, the CLI's `verifyOtp` call in
 * `packages/styrby-cli/src/onboarding/otpAuth.ts` will POST the email + code
 * here instead of calling `supabase.auth.verifyOtp` directly.
 *
 * Security design:
 *   - IP-based rate limit (10/min) — permissive enough for legitimate OTP retypes,
 *     aggressive enough to prevent brute-force (a 6-digit OTP at 10/min/IP
 *     would require ~16.7 hours for exhaustive attack; combined with Supabase's
 *     default 5-15 min OTP TTL, brute-force is practically infeasible).
 *   - Generic 401 message for ALL auth failure paths — no distinction between
 *     "wrong code", "expired code", "user not found". Information leakage about
 *     these distinctions enables enumeration / targeted brute-force (OWASP A07:2021).
 *   - Raw OTP NEVER logged — could be present in Sentry captures without discipline
 *   - Raw styrby_* key NEVER logged — returned in response body ONCE and discarded
 *     server-side; only bcrypt hash is stored (OWASP A02:2021 / SOC 2 CC6.1)
 *   - Email hashed (djb2) for Sentry tags — not raw PII (GDPR Art 5(1)(c))
 *   - Zod .strict() — mass-assignment defense (OWASP A03:2021)
 *
 * Why 200 not 201:
 *   This endpoint completes an existing OTP flow — it is not creating a resource
 *   at a stable URL. 201 implies a Location header; token issuance does not.
 *   Follows the same reasoning as /api/v1/auth/oauth/callback (Task 7).
 *
 * hashEmail import note:
 *   `hashEmail` is imported from the adjacent `../send/route` rather than
 *   duplicated here or extracted to a shared util. The function is already
 *   exported from Task 8's route and the two files are in the same OTP sub-tree.
 *   If a future endpoint outside `otp/` needs this helper, extract it then to
 *   `lib/auth/email-hash.ts` and update both importers.
 *
 * @auth UNAUTHENTICATED — caller has no session or API key yet.
 *       This is a Category C endpoint (pre-auth). No `withApiAuthAndRateLimit` wrapper.
 *
 * @rateLimit 10 requests per minute per IP
 *
 * @body {
 *   email: string,  // User email (RFC 5321 max 320 chars)
 *   otp: string     // 6-digit code or magic-link token (6-64 chars)
 * }
 *
 * @returns 200 {
 *   styrby_api_key: string,  // Raw plaintext key — shown ONCE to caller
 *   expires_at: string       // ISO 8601 expiration timestamp
 * }
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }  — Zod failure (OTP value NOT echoed)
 * @error 401 { error: 'AUTH_FAILED' }                        — verifyOtp failure / invalid code
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }   — IP cap exceeded
 * @error 500 { error: 'INTERNAL_ERROR' }                     — minting failure / infra error (Sentry)
 *
 * @security OWASP A07:2021 (Identification and Authentication Failures — OTP verification, token minting)
 * @security OWASP A02:2021 (Cryptographic Failures — bcrypt hash discipline, raw key never stored)
 * @security OWASP A05:2021 (Security Misconfiguration — explicit 365-day TTL; no non-expiring keys)
 * @security OWASP A01:2021 (Broken Access Control — generic 401, no failure-mode leakage)
 * @security GDPR Art 6 (Lawful basis — user authenticated before any key is minted)
 * @security GDPR Art 5(1)(c) (Data minimization — email hashed in Sentry; OTP never logged)
 * @security SOC 2 CC6.1 (Logical Access Controls — key bound to auth user_id, bcrypt stored)
 *
 * @module api/v1/auth/otp/verify
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase/server';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { hashApiKey } from '@/lib/api-keys';
import { generateApiKey } from '@styrby/shared';
// WHY import from send/route (not duplicated): hashEmail is already exported from the
// adjacent Task 8 route. Both live in the same otp/ sub-tree and serve the same
// GDPR Art 5(1)(c) purpose (Sentry tag correlation without PII leakage). If a future
// caller outside otp/ needs this helper, extract it to lib/auth/email-hash.ts then.
import { hashEmail } from '../send/route';

// ============================================================================
// Constants
// ============================================================================

/**
 * Rate limit: 10 requests per minute per IP.
 *
 * WHY 10/min (more permissive than otp/send's 3/min): legitimate users may
 * retype a code after a misread or paste error. At 10/min, a single mistaken
 * entry can be corrected within the same OTP TTL window without triggering the
 * limit. Aggressive enough: brute-forcing a 6-digit OTP (10^6 combinations) at
 * 10/min takes ~16.7 hours per IP — well beyond Supabase's 5-15 min OTP TTL,
 * making exhaustive brute-force practically infeasible (OWASP A07:2021).
 */
export const OTP_VERIFY_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

/**
 * Default API key lifetime in days.
 *
 * WHY 365 days: consistent with /oauth/callback (Task 7) and the H42 Layer 5
 * standard from migrations/067_api_key_expires_at_ensure.sql. Keys without
 * expiry never rotate (security antipattern, SOC 2 CC6.1). The CLI will surface
 * a renewal prompt when the key has <30 days remaining.
 */
export const KEY_TTL_DAYS = 365;

/**
 * RFC 5321 maximum email address length.
 * Consistent with otp/send (Task 8) — same input, same ceiling.
 */
const MAX_EMAIL_LENGTH = 320;

// ============================================================================
// Zod Schema
// ============================================================================

/**
 * Request body schema for POST /api/v1/auth/otp/verify.
 *
 * WHY .strict(): rejects any field not listed (mass-assignment defense,
 * OWASP A03:2021). An attacker cannot inject Supabase-internal fields
 * (e.g. user_id, access_token) to bypass the verification step.
 *
 * WHY otp max(64): most OTP codes are 6 digits, but Supabase magic-link tokens
 * are longer hex strings. 64 chars accommodates all Supabase token formats while
 * capping string length to prevent resource-exhaustion via oversized inputs.
 */
const OtpVerifySchema = z
  .object({
    /**
     * Recipient email address — must match the address that received the OTP.
     * WHY max(320): RFC 5321 email length limit (same ceiling as otp/send).
     */
    email: z
      .string()
      .email('email must be a valid email address')
      .max(MAX_EMAIL_LENGTH, `email must not exceed ${MAX_EMAIL_LENGTH} characters`),

    /**
     * The OTP code the user received (6-digit code or longer magic-link token).
     * WHY min(6): standard OTP codes are 6+ digits; shorter values are malformed.
     * WHY max(64): covers all Supabase token formats; prevents oversized-string abuse.
     */
    otp: z
      .string()
      .min(6, 'otp must be at least 6 characters')
      .max(64, 'otp must not exceed 64 characters'),
  })
  .strict();

type OtpVerifyBody = z.infer<typeof OtpVerifySchema>;

// ============================================================================
// Handler
// ============================================================================

/**
 * POST /api/v1/auth/otp/verify
 *
 * Unauthenticated OTP verification and API key minting.
 * See module-level JSDoc for full spec, security model, and error taxonomy.
 *
 * @param request - The incoming NextRequest from the CLI.
 * @returns 200 { styrby_api_key, expires_at } on success.
 */
export async function handlePost(request: NextRequest): Promise<NextResponse> {
  // ── 1. IP-based rate limit ─────────────────────────────────────────────────
  // WHY separate try/catch: a throw from rateLimit (e.g. Redis unreachable) is a
  // TRUE infrastructure failure. It must surface as 500 rather than silently
  // falling through, which would bypass the rate-limit gate entirely (OWASP A07:2021).
  let rateLimitResult: Awaited<ReturnType<typeof rateLimit>>;
  try {
    rateLimitResult = await rateLimit(request, OTP_VERIFY_RATE_LIMIT, 'otp-verify');
  } catch (rateLimitErr) {
    Sentry.captureException(rateLimitErr, {
      tags: { endpoint: '/api/v1/auth/otp/verify' },
      extra: { context: 'rateLimit infrastructure threw' },
    });
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult.retryAfter ?? 60);
  }

  // ── 2. Parse and validate request body ────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' },
      { status: 400 }
    );
  }

  const parsed = OtpVerifySchema.safeParse(rawBody);
  if (!parsed.success) {
    // WHY: report the field name / constraint but NOT the submitted value.
    // Echoing the OTP in the error response would:
    // (a) reflect the raw OTP in an HTTP response (attacker interception risk)
    // (b) create a content-reflection vector (OWASP A03:2021)
    // The message describes what was wrong without including the OTP string itself.
    return NextResponse.json(
      {
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body.',
      },
      { status: 400 }
    );
  }

  const body: OtpVerifyBody = parsed.data;

  // ── 3. Verify OTP via Supabase Auth ───────────────────────────────────────
  // WHY createAdminClient() per-request: fresh instance prevents cross-request
  // state leakage in serverless environments (PKCE-configured, per Task 6 pattern).
  // Admin client is used for consistency with other pre-auth Category C endpoints.
  //
  // WHY type: 'email': the CLI sends OTP via `signInWithOtp({ email })` which uses
  // Supabase's `email` type. Confirmed by inspecting otpAuth.ts:158 in the CLI.
  const supabase = createAdminClient();

  let userId: string;
  try {
    const { data, error } = await supabase.auth.verifyOtp({
      email: body.email,
      token: body.otp,
      type: 'email',
    });

    if (error || !data?.user?.id) {
      // WHY generic 401 "Authentication failed" for ALL verifyOtp failures:
      // Do NOT distinguish "OTP expired" / "wrong code" / "user not found".
      // These distinctions help an attacker enumerate the auth surface (OWASP A07:2021).
      // A brute-force attacker should receive no signal about which OTPs are valid.
      return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
    }

    userId = data.user.id;
  } catch {
    // WHY catch-all → 401 (not 500): Supabase client throws on network errors or
    // unexpected server responses. We treat these as auth failure rather than
    // infrastructure failure — from the caller's perspective, verification did not
    // succeed. Same generic message prevents information leakage (OWASP A07:2021).
    //
    // WHY no Sentry capture here: throws on verifyOtp may be normal under heavy
    // Supabase load (connection pool exhaustion, rate limits). Capturing every
    // throw at error level would flood Sentry with expected noise. If operational
    // visibility into these throws is needed in the future, add captureMessage at
    // 'warning' level with email_hash (not raw OTP) in the tags.
    return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
  }

  // ── 4. Mint styrby_* API key ───────────────────────────────────────────────
  // WHY inline minting (no dedicated helper): follows the pattern established in
  // /api/v1/auth/oauth/callback (Task 7) and /api/keys. All three mint inline
  // using generateApiKey() → hashApiKey() → insert.
  // The raw key is returned ONCE; only the bcrypt hash is persisted (OWASP A02:2021).
  try {
    const { key: plaintextKey, prefix } = generateApiKey();

    // Hash before persisting — plaintext is NEVER stored (SOC 2 CC6.1, OWASP A02:2021).
    // WHY hashApiKey in try block: bcrypt can throw; we want to capture that.
    const keyHash = await hashApiKey(plaintextKey);

    // Compute TTL — 365-day default (H42 Layer 5 standard; OWASP A05:2021).
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + KEY_TTL_DAYS);
    const expiresAt = expDate.toISOString();

    // WHY admin client for insert: caller is pre-auth; no user session cookie exists.
    // The admin client bypasses RLS for the insert. The user_id FK ensures the key
    // is bound to the authenticated user even though we use the service role.
    const adminClient = createAdminClient();
    const { error: insertError } = await adminClient
      .from('api_keys')
      .insert({
        user_id: userId,
        // WHY 'CLI OTP Key': auto-minted name describes the authentication method.
        // Helps users identify this key in the key management UI.
        name: 'CLI OTP Key',
        key_prefix: prefix,
        key_hash: keyHash,
        scopes: ['read', 'write'],
        expires_at: expiresAt,
      });

    if (insertError) {
      // WHY Sentry capture for DB errors (not auth errors): DB failures are
      // operational defects requiring alerting. Auth failures are expected user
      // inputs, not bugs.
      //
      // WHY email_hash in tags (not raw email): GDPR Art 5(1)(c) data minimization.
      // WHY user_id in tags: operationally necessary for correlation; not a secret.
      // WHY raw key NOT in tags: plaintext key must never appear in any log/telemetry.
      Sentry.captureException(new Error(`api_keys insert failed: ${insertError.message}`), {
        tags: {
          endpoint: '/api/v1/auth/otp/verify',
          user_id: userId,
          email_hash: hashEmail(body.email),
        },
      });
      return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
    }

    // ── 5. Return minted key ───────────────────────────────────────────────
    // SECURITY: styrby_api_key (plaintext) is returned ONCE and NEVER logged.
    // Do not add debug logging or Sentry context that would capture this value.
    // WHY 200 (not 201): completing an existing verification flow, not creating
    // a stable addressable resource. See module-level JSDoc for full rationale.
    return NextResponse.json(
      {
        styrby_api_key: plaintextKey,
        expires_at: expiresAt,
      },
      { status: 200 }
    );
  } catch (err) {
    // Unexpected error (bcrypt failure, generateApiKey throws, etc.)
    // WHY: capture the Error object only — an error during minting may contain
    // a partially-constructed key in its message. Sentry sanitizes the object.
    // WHY email_hash (not raw email): GDPR Art 5(1)(c) data minimization.
    // WHY user_id: operationally necessary for post-incident correlation.
    Sentry.captureException(err, {
      tags: {
        endpoint: '/api/v1/auth/otp/verify',
        user_id: userId,
        email_hash: hashEmail(body.email),
      },
    });
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

// ============================================================================
// Next.js route export
// ============================================================================

/**
 * Next.js route handler.
 * Re-exports handlePost under the framework's expected `POST` export name.
 * Named `handlePost` for testability and naming consistency across pre-auth
 * Category C endpoints.
 */
export const POST = handlePost;
