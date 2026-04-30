/**
 * POST /api/v1/auth/oauth/callback
 *
 * Completes the server-side OAuth flow for CLI callers. The CLI's local
 * callback server receives the `code` and `state` from the OAuth provider's
 * redirect, then POSTs them here. This endpoint exchanges the code with
 * Supabase (PKCE), mints a styrby_* API key bound to the authenticated user,
 * and returns the key ONCE.
 *
 * Flow:
 *   1. CLI starts flow via POST /api/v1/auth/oauth/start → gets authorization_url
 *   2. User authenticates in browser → OAuth provider redirects to CLI callback server
 *   3. CLI callback server receives `code` and `state` → POSTs here
 *   4. Server calls supabase.auth.exchangeCodeForSession(code) — PKCE verifies code
 *   5. Server mints a styrby_* API key bound to the resolved user_id
 *   6. Returns { styrby_api_key, expires_at } — plaintext key returned ONCE
 *   7. CLI stores key via token-manager; server stores only the bcrypt hash
 *
 * State design:
 *   WHY passthrough-only state validation: Task 6 (/oauth/start) does NOT
 *   persist state server-side — it extracts Supabase's PKCE state from the
 *   authorization URL and forwards it to the CLI. The CLI stores it and echoes
 *   it back here. Supabase's PKCE code_verifier (managed in Supabase's own
 *   cookie/session) provides the binding between `code` and the original
 *   initiation — the `state` is an additional CSRF guard used CLIENT-side
 *   (RFC 6749 §10.12). We validate Zod shape on `state` but cannot validate
 *   its server-side existence because we never persisted it.
 *
 * Security:
 *   - IP-based rate limit (5/min) — one-shot callback; high rate = brute-force
 *   - Raw key NEVER logged, NEVER included in Sentry payloads
 *   - Zod .strict() — mass-assignment defense (OWASP A03:2021)
 *   - PKCE code_verifier is enforced by Supabase; we don't roll our own
 *   - 401 messages are GENERIC — no distinction between expired code, bad state,
 *     or user not found (prevents information leakage — OWASP A07:2021)
 *
 * @auth UNAUTHENTICATED — caller has no session or API key yet.
 *       This is a Category C endpoint (pre-auth).
 *
 * @rateLimit 5 requests per minute per IP
 *
 * @body {
 *   code: string,   // Authorization code from OAuth provider
 *   state: string   // State from /oauth/start response (RFC 6749 §10.12)
 * }
 *
 * @returns 200 {
 *   styrby_api_key: string,  // Raw plaintext key — shown ONCE to caller
 *   expires_at: string       // ISO 8601 expiration timestamp
 * }
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }  — Zod failure
 * @error 401 { error: 'AUTH_FAILED' }                        — exchange failure / invalid code
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }   — IP cap exceeded
 * @error 500 { error: 'INTERNAL_ERROR' }                     — minting failure / unexpected (Sentry)
 *
 * @security OWASP A07:2021 (Identification and Authentication Failures — token minting)
 * @security OWASP A02:2021 (Cryptographic Failures — bcrypt hash discipline, raw key never stored)
 * @security OWASP A05:2021 (Security Misconfiguration — explicit TTL; no non-expiring keys)
 * @security OWASP A03:2021 (Injection / Mass Assignment — Zod .strict())
 * @security GDPR Art 6 (Lawful basis — user authenticated before any key is minted)
 * @security SOC 2 CC6.1 (Logical Access Controls — key bound to auth user_id, bcrypt stored)
 *
 * @module api/v1/auth/oauth/callback
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase/server';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { hashApiKey } from '@/lib/api-keys';
import { generateApiKey } from '@styrby/shared';
import {
  OAUTH_CALLBACK_RATE_LIMIT,
  KEY_TTL_DAYS,
} from '@/lib/auth/api-config';

// ============================================================================
// Zod Schema
// ============================================================================

/**
 * Request body schema for POST /api/v1/auth/oauth/callback.
 *
 * WHY .strict(): rejects any field not listed (mass-assignment defense, OWASP A03:2021).
 * An attacker cannot inject Supabase-internal fields (e.g. access_token, user_id) to
 * bypass the exchange step.
 *
 * WHY max(2048) on both fields: standard URL-safe string length limit. OAuth
 * authorization codes are typically short (~100 chars); the generous ceiling
 * accommodates future IdP quirks without creating a denial-of-service vector.
 */
const OAuthCallbackSchema = z
  .object({
    /**
     * Authorization code issued by the OAuth provider.
     * Single-use; Supabase enforces this during exchange (PKCE).
     */
    code: z.string().min(1, 'code is required').max(2048, 'code exceeds maximum length'),

    /**
     * CSRF state token forwarded from the CLI's /oauth/start response.
     * The CLI validates this client-side (RFC 6749 §10.12). We Zod-validate
     * shape only; no server-side persistence to look up against (passthrough design).
     */
    state: z.string().min(1, 'state is required').max(2048, 'state exceeds maximum length'),
  })
  .strict();

type OAuthCallbackBody = z.infer<typeof OAuthCallbackSchema>;

// ============================================================================
// Handler
// ============================================================================

/**
 * POST /api/v1/auth/oauth/callback
 *
 * Unauthenticated OAuth code exchange and API key minting.
 * See module-level JSDoc for full spec.
 *
 * @param request - The incoming NextRequest from the CLI.
 * @returns 200 { styrby_api_key, expires_at } on success.
 */
export async function POST(request: NextRequest) {
  // ── 1. IP-based rate limit ─────────────────────────────────────────────────
  // WHY: No API key available yet (pre-auth). 5/min is deliberately aggressive
  // because this is a one-shot callback — legitimate callers need at most 1-2
  // attempts per OAuth session. High request rate = brute-force signal.
  const rateLimitResult = await rateLimit(request, OAUTH_CALLBACK_RATE_LIMIT, 'oauth-callback');
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

  const parsed = OAuthCallbackSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body.',
      },
      { status: 400 }
    );
  }

  const body: OAuthCallbackBody = parsed.data;

  // ── 3. Exchange authorization code for Supabase session (PKCE) ────────────
  // WHY createAdminClient() per-request: fresh instance per invocation prevents
  // cross-request state leakage in serverless environments where the module may
  // be reused. createAdminClient() has `auth: { flowType: 'pkce' }` set at the
  // client layer (OWASP A07:2021 — code-interception defense).
  //
  // WHY exchangeCodeForSession (not signInWithOAuth): the OAuth provider has
  // already authenticated the user and issued a code. We exchange it for a
  // session. Supabase's PKCE verifier (stored server-side in Supabase's own
  // session) validates the code → session binding — we do not roll our own.
  const supabase = createAdminClient();

  let userId: string;
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(body.code);

    if (error || !data?.user?.id) {
      // WHY generic 401: do NOT distinguish "code expired" from "code already used"
      // from "state mismatch" from "user not found". Information leakage about which
      // failure mode allows an attacker to enumerate the exchange surface (OWASP A07:2021).
      return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
    }

    userId = data.user.id;
  } catch {
    // WHY catch-all without re-throwing: Supabase client throws on network
    // errors or unexpected server responses. We treat all thrown errors as
    // auth failure with a generic message (same information-leakage defense).
    return NextResponse.json({ error: 'AUTH_FAILED' }, { status: 401 });
  }

  // ── 4. Mint styrby_* API key ───────────────────────────────────────────────
  // WHY inline minting (no dedicated helper): there is no centralised mintApiKey
  // helper in this codebase — /api/keys mints inline using the same pattern.
  // We follow the established pattern: generateApiKey() → hashApiKey() → insert.
  // The raw key is returned ONCE; only the bcrypt hash is persisted (OWASP A02:2021).
  try {
    const { key: plaintextKey, prefix } = generateApiKey();

    // Hash before persisting — plaintext is NEVER stored (SOC 2 CC6.1, OWASP A02:2021)
    const keyHash = await hashApiKey(plaintextKey);

    // Compute TTL — 365-day default (H42 Layer 5 standard; OWASP A05:2021)
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + KEY_TTL_DAYS);
    const expiresAt = expDate.toISOString();

    // WHY admin client for insert: we don't have a user session cookie here
    // (caller is pre-auth). The admin client bypasses RLS for the insert.
    // The user_id constraint on api_keys ensures the key is bound to the
    // authenticated user even though we use the service role for the write.
    const adminClient = createAdminClient();
    const { error: insertError } = await adminClient
      .from('api_keys')
      .insert({
        user_id: userId,
        // WHY 'CLI OAuth Key': this key is auto-minted; no user-supplied name.
        // A descriptive default name helps users identify it in the key list.
        name: 'CLI OAuth Key',
        key_prefix: prefix,
        key_hash: keyHash,
        scopes: ['read', 'write'],
        expires_at: expiresAt,
      });

    if (insertError) {
      // WHY separate Sentry capture for DB errors vs. auth errors: DB failures
      // are operational (not expected), need alerting. Auth failures are user
      // errors, expected, no alert needed.
      Sentry.captureException(new Error(`api_keys insert failed: ${insertError.message}`), {
        tags: {
          endpoint: '/api/v1/auth/oauth/callback',
          // WHY user_id in tags: operationally necessary for correlation.
          // user_id is not a secret. Raw key MUST NOT appear here.
          user_id: userId,
        },
      });
      return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
    }

    // ── 5. Return minted key ─────────────────────────────────────────────────
    // WHY return 200 (not 201): we are not creating a standalone resource at a
    // stable URL — this is a token issuance endpoint. 201 implies Location header
    // semantics; that doesn't apply here.
    //
    // SECURITY: styrby_api_key (plaintext) is returned ONCE here and NEVER logged.
    // Do not add debug logging or Sentry context that would capture this value.
    return NextResponse.json(
      {
        styrby_api_key: plaintextKey,
        expires_at: expiresAt,
      },
      { status: 200 }
    );
  } catch (err) {
    // Unexpected error (e.g. bcrypt failure, generateApiKey throws)
    // WHY: do not include err.message in the Sentry context without scrubbing —
    // an error during minting may have a partially-constructed key in the
    // message. We capture the error object only, which Sentry will sanitize.
    Sentry.captureException(err, {
      tags: {
        endpoint: '/api/v1/auth/oauth/callback',
        user_id: userId,
      },
    });
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
