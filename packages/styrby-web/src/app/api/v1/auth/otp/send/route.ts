/**
 * POST /api/v1/auth/otp/send
 *
 * Sends a 6-digit OTP to the given email via Supabase Auth. The CLI's
 * onboarding flow (`packages/styrby-cli/src/onboarding/otpAuth.ts:sendOtp`)
 * previously called `supabase.auth.signInWithOtp` directly. After this endpoint
 * lands, the CLI POSTs the user's email here; the server proxies the OTP send.
 *
 * This endpoint is INTENTIONALLY unauthenticated — the caller has no key yet.
 * It is a Category C (pre-auth) endpoint.
 *
 * Email enumeration defense:
 *   WHY always return 200 + { ok: true }: If we returned different responses for
 *   "email exists" vs "email does not exist" (or Supabase rate-limited vs sent),
 *   an attacker could drive-by enumerate the entire user base. The response shape
 *   MUST be invariant regardless of whether Supabase accepted, rejected, or
 *   rate-limited the send (OWASP A01:2021 — broken access control / enumeration).
 *   Internal failures are forwarded to Sentry at info/warning level for
 *   observability without leaking anything to the caller.
 *
 * The ONLY non-200 responses allowed:
 *   400 — Zod input validation failure (email format, max length, unknown field)
 *   429 — IP rate limit exceeded (3/min/IP)
 *   500 — True infrastructure failure (rate-limiter throws, etc.) — sanitized
 *
 * @auth UNAUTHENTICATED — caller has no session or API key yet.
 *       This is a Category C endpoint (pre-auth).
 *
 * @rateLimit 3 requests per minute per IP (aggressive — each request triggers
 *            an actual email send + Supabase has its own per-email rate limits)
 *
 * @body { email: string }
 *
 * @returns 200 { ok: true } — ALWAYS on successful request processing
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }  — Zod failure
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }   — IP cap exceeded
 * @error 500 { error: 'INTERNAL_ERROR' }                     — infrastructure failure (Sentry)
 *
 * @security OWASP A07:2021 (Identification and Authentication Failures — OTP send initiation)
 * @security OWASP A01:2021 (Broken Access Control — enumeration defense via response invariance)
 * @security GDPR Art 6 (Lawful basis — user-initiated OTP send; consent by action)
 * @security GDPR Art 5(1)(c) (Data minimization — email not echoed in error responses; not logged to Sentry)
 * @security SOC 2 CC6.1 (Logical Access Controls — rate-limited pre-auth gate)
 *
 * @module api/v1/auth/otp/send
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase/server';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// ============================================================================
// Constants
// ============================================================================

/**
 * Rate limit: 3 requests per minute per IP.
 *
 * WHY 3/min (not 10 like oauth/start): each request to this endpoint triggers
 * an actual email send via Supabase. Supabase itself imposes per-email throttle
 * limits; if we allow high volume at the API layer we burn Supabase quota and
 * expose users to OTP-spam attacks. 3/min is deliberately aggressive because
 * a human re-requesting an OTP within a minute is a UX edge case, not the norm.
 * Any rate above 3/min from a single IP is a signal for automation/abuse
 * (OWASP A07:2021 — brute-force / DoS via email send).
 */
export const OTP_SEND_RATE_LIMIT = { windowMs: 60_000, maxRequests: 3 };

/**
 * RFC 5321 maximum email address length (local-part@domain).
 *
 * WHY 320: RFC 5321 §4.5.3.1.1 specifies the maximum path length as
 * 256 characters, but the SMTP max email address is commonly cited as 320
 * (64 local-part + 1 @ + 255 domain). This is the broadly accepted ceiling
 * for input validation. Rejecting longer values prevents resource-exhaustion
 * via oversized strings while being generous for all real-world addresses.
 */
export const MAX_EMAIL_LENGTH = 320;

// ============================================================================
// Zod Schema
// ============================================================================

/**
 * Request body schema for POST /api/v1/auth/otp/send.
 *
 * WHY .strict(): rejects any field not in the schema (mass-assignment defense,
 * OWASP A03:2021). An attacker cannot inject Supabase-internal fields (e.g.
 * `shouldCreateUser`, `data`, `captchaToken`) to manipulate the OTP send.
 *
 * WHY .email(): validates RFC 5322 email format. An input that passes Zod's
 * `.email()` check is structurally valid; we respond 400 for format failures.
 * This is INPUT validation only — not user-existence validation. The 400 for
 * malformed email does NOT reveal whether a valid email exists in the system.
 */
const OtpSendSchema = z
  .object({
    /**
     * Recipient email address.
     * Must be valid RFC 5322 format and at most MAX_EMAIL_LENGTH (320) chars.
     * WHY max(320): RFC 5321 email length limit; prevents oversized-string abuse.
     */
    email: z
      .string()
      .email('email must be a valid email address')
      .max(MAX_EMAIL_LENGTH, `email must not exceed ${MAX_EMAIL_LENGTH} characters`),
  })
  .strict();

type OtpSendBody = z.infer<typeof OtpSendSchema>;

// ============================================================================
// Handler
// ============================================================================

/**
 * POST /api/v1/auth/otp/send
 *
 * Unauthenticated OTP email dispatch. See module-level JSDoc for full spec.
 * Named `handlePost` per project conventions for pre-auth unauthenticated handlers.
 *
 * @param request - The incoming NextRequest from the CLI.
 * @returns 200 { ok: true } for all non-error outcomes (enumeration defense).
 */
export async function handlePost(request: NextRequest): Promise<NextResponse> {
  // ── 1. IP-based rate limit ─────────────────────────────────────────────────
  // WHY aggressive 3/min: each call triggers an email send + burns Supabase
  // quota. High rate from one IP = OTP-spam or email enumeration attempt.
  // The 'otp-send' prefix isolates this bucket from other endpoint buckets.
  const rateLimitResult = await rateLimit(request, OTP_SEND_RATE_LIMIT, 'otp-send');
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

  const parsed = OtpSendSchema.safeParse(rawBody);
  if (!parsed.success) {
    // WHY: report the field name but NOT the value attempted.
    // Echoing the submitted email in the error response would:
    // (a) create a content-reflection vector (OWASP A03:2021)
    // (b) confirm to an attacker that the email format was valid/invalid,
    //     which is fine for format failures but risks confusion with existence
    //     checks if we ever diverge. Keep the message focused on the field name.
    return NextResponse.json(
      {
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body.',
      },
      { status: 400 }
    );
  }

  const body: OtpSendBody = parsed.data;

  // ── 3. Send OTP via Supabase Auth ─────────────────────────────────────────
  // WHY createAdminClient() per-request: fresh instance prevents cross-request
  // state leakage in serverless environments where the module may be reused.
  // Admin client is used for consistency with other pre-auth endpoints; OTP send
  // itself does not require elevated privileges but `shouldCreateUser: true`
  // means this may auto-provision new users (existing CLI behaviour preserved).
  const supabase = createAdminClient();

  try {
    const { error: supabaseError } = await supabase.auth.signInWithOtp({
      email: body.email,
      options: {
        // WHY shouldCreateUser: true — mirrors the existing CLI behaviour in
        // packages/styrby-cli/src/onboarding/otpAuth.ts:sendOtp. First-time
        // users are auto-provisioned; no separate sign-up endpoint needed.
        // This is intentional: Styrby's onboarding is OTP-first.
        shouldCreateUser: true,
      },
    });

    if (supabaseError) {
      // WHY captureMessage (not captureException) at info level: Supabase OTP
      // errors are semi-expected (per-email rate limits, Supabase-internal
      // throttle, email not found in some configs). They are operational signals
      // not necessarily bugs. Capturing at info level keeps Sentry noise low
      // while preserving observability.
      //
      // WHY NOT include body.email in the Sentry payload: email is PII under
      // GDPR Art 5(1)(c) (data minimization). Instead, we hash it for correlation.
      // The raw email MUST NOT appear in any Sentry tag, extra, or message string.
      Sentry.captureMessage(`otp-send: signInWithOtp error (${supabaseError.message})`, {
        level: 'info',
        tags: {
          endpoint: '/api/v1/auth/otp/send',
          // WHY hash: correlating repeated failures for the same address without
          // storing PII in Sentry (GDPR Art 5(1)(c) data minimization).
          // We do not need the raw email — the hash is sufficient for correlation.
          email_hash: hashEmail(body.email),
        },
      });
      // WHY return 200 despite error: response invariance — caller must not be
      // able to distinguish "email exists" from "email does not exist" based on
      // Supabase's response. The only information the caller receives is that
      // the request was accepted (OWASP A01:2021 enumeration defense).
    }
  } catch (err) {
    // WHY catch-all without re-throwing: Supabase client can throw on network
    // errors, timeouts, or unexpected server responses. Same invariance applies —
    // we return 200 + { ok: true } regardless. Sentry captures the raw error
    // (which will NOT contain the email — it was only passed to Supabase, not
    // included in any thrown error message).
    Sentry.captureMessage(
      `otp-send: signInWithOtp threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      {
        level: 'warning',
        tags: {
          endpoint: '/api/v1/auth/otp/send',
          email_hash: hashEmail(body.email),
        },
      }
    );
    // WHY 200 (not 500): this is NOT an infrastructure failure — Supabase
    // responded (or timed out). The caller's request was valid; we just couldn't
    // complete the downstream send. The caller should not be able to distinguish
    // this from a successful send (enumeration defense, OWASP A01:2021).
  }

  // ── 4. Return invariant success response ──────────────────────────────────
  // WHY { ok: true } always (barring 400/429 above): enumeration defense.
  // An attacker watching responses cannot distinguish:
  //   - OTP sent successfully
  //   - Supabase rate-limited this email (user exists, too many attempts)
  //   - Supabase said email not found (or auto-provisioned)
  //   - Supabase threw an unexpected error
  // All of these look identical to the caller (OWASP A01:2021).
  return NextResponse.json({ ok: true }, { status: 200 });
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Produces a short, deterministic hash of an email address for Sentry tags.
 *
 * WHY hash (not raw email): GDPR Art 5(1)(c) data minimization — Sentry is a
 * third-party telemetry service. The raw email is PII; the hash is sufficient
 * for correlating repeated failures from the same address without exfiltrating
 * PII to Sentry's servers.
 *
 * WHY djb2 (not crypto hash): no Node crypto import needed; the hash is used
 * only for correlation tagging, not security. A fast non-crypto hash is
 * appropriate and keeps the bundle lightweight.
 *
 * @param email - Raw email string.
 * @returns Short hexadecimal string (8 chars).
 */
function hashEmail(email: string): string {
  // djb2 hash
  let hash = 5381;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 33) ^ email.charCodeAt(i);
  }
  // >>> 0 converts to unsigned 32-bit int; .toString(16) gives hex
  return (hash >>> 0).toString(16).slice(0, 8);
}

// ============================================================================
// Next.js route export
// ============================================================================

/**
 * Next.js route handler.
 * Re-exports handlePost under the framework's expected `POST` export name.
 * The named function `handlePost` is used internally for testability and
 * naming consistency across pre-auth Category C endpoints.
 */
export const POST = handlePost;
