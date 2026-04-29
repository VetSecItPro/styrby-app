/**
 * Shared config + helpers for Strategy C v1/auth/* endpoints.
 *
 * WHY a separate file: Next.js 16 forbids non-HTTP-method exports from
 * route files. Tests + cross-route imports (e.g. otp/verify importing
 * hashEmail from otp/send) need a non-route home for these. This file is
 * that home.
 *
 * Cite: Strategy C Phase 2, OWASP A07:2021, SOC 2 CC6.1.
 */

// ============================================================================
// Rate Limit Configs
// ============================================================================

/**
 * Rate limit for POST /api/v1/auth/oauth/start: 10 requests per minute per IP.
 *
 * WHY 10/min: A human user needs at most 1-2 OAuth initiations per retry
 * cycle. 10/min is generous for retries (e.g. port conflict on callback
 * server) but aggressive enough to block automated state-flooding attacks,
 * which would force Supabase to generate thousands of PKCE code_verifiers
 * (server resource consumption).
 */
export const OAUTH_START_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

/**
 * Rate limit for POST /api/v1/auth/oauth/callback: 5 requests per minute per IP.
 *
 * WHY 5/min (not 10 like /oauth/start): the callback is a one-shot operation.
 * A single OAuth session produces exactly one code — retrying with the same
 * code will fail on the Supabase side (codes are single-use). High request
 * rates from a single IP indicate brute-force or enumeration, not legitimate
 * retries. We are more aggressive here than on /start because the stakes are
 * higher — a successful exchange grants a 365-day API key (OWASP A07:2021).
 */
export const OAUTH_CALLBACK_RATE_LIMIT = { windowMs: 60_000, maxRequests: 5 };

/**
 * Rate limit for POST /api/v1/auth/otp/send: 3 requests per minute per IP.
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
 * Rate limit for POST /api/v1/auth/otp/verify: 10 requests per minute per IP.
 *
 * WHY 10/min (more permissive than otp/send's 3/min): legitimate users may
 * retype a code after a misread or paste error. At 10/min, a single mistaken
 * entry can be corrected within the same OTP TTL window without triggering the
 * limit. Aggressive enough: brute-forcing a 6-digit OTP (10^6 combinations) at
 * 10/min takes ~16.7 hours per IP — well beyond Supabase's 5-15 min OTP TTL,
 * making exhaustive brute-force practically infeasible (OWASP A07:2021).
 */
export const OTP_VERIFY_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

// ============================================================================
// Key TTL
// ============================================================================

/**
 * Default API key lifetime in days (shared across oauth/callback and otp/verify).
 *
 * WHY 365 days: H42 Layer 5 standard from migrations/067_api_key_expires_at_ensure.sql.
 * Keys without expiry never rotate (security antipattern, SOC 2 CC6.1). 365 days
 * is practical for automation while ensuring eventual rotation. The CLI will surface
 * a renewal prompt when the key has <30 days remaining.
 *
 * WHY single source (not duplicated in each route): previously KEY_TTL_DAYS was
 * independently declared in both oauth/callback/route.ts and otp/verify/route.ts,
 * creating a drift risk. A single canonical value here ensures both routes always
 * agree on the expiry window (Task 9 duplicate-constant smell fix).
 */
export const KEY_TTL_DAYS = 365;

// ============================================================================
// OAuth Redirect Allowlist
// ============================================================================

/**
 * Allowlist of origins that redirect_to may point to for POST /api/v1/auth/oauth/start.
 *
 * WHY an allowlist: OWASP A01:2021 — without this, an attacker could call
 * this endpoint with `redirect_to: "https://attacker.com/steal-code"`,
 * craft a phishing link containing a real Supabase authorization URL that
 * redirects to their domain after the user authenticates, and steal the
 * authorization code. The authorization code alone is useless without
 * the PKCE code_verifier (Supabase PKCE mitigates the worst case), but
 * a naive exchange can still leak session data.
 *
 * Patterns:
 *   - `localhost` / `127.0.0.1` — CLI callback server
 *   - `styrbyapp.com` — production web app deep-link
 *   - `*.vercel.app` — Vercel preview deployments
 *   - `exp://` scheme — Expo Go deep-link during development
 */
export const OAUTH_ALLOWED_REDIRECT_ORIGINS: Array<string | RegExp> = [
  // CLI local callback server
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  // Production domain
  'https://styrbyapp.com',
  // Vercel preview deployments — dash-joined deployment alias format
  /^https:\/\/[a-zA-Z0-9-]+-vetsecitpro\.vercel\.app$/,
  /^https:\/\/styrby-[a-zA-Z0-9-]+\.vercel\.app$/,
  // Vercel preview deployments — dot-subdomain PR format (e.g. pr-123.styrby-web.vercel.app)
  // WHY second pattern: Vercel uses two distinct URL formats for preview deployments.
  // The dash-joined alias (above) covers deployment aliases; the dot-subdomain pattern
  // covers PR preview URLs like pr-123.styrby-web.vercel.app. Without this, legitimate
  // PR preview OAuth flows would be blocked with REDIRECT_NOT_ALLOWED (OWASP A01:2021).
  /^https:\/\/[a-zA-Z0-9-]+\.styrby-[a-zA-Z0-9-]+\.vercel\.app$/,
  // Expo Go / mobile dev (exp:// deep-link)
  /^exp:\/\//,
];

// ============================================================================
// OAuth Helpers
// ============================================================================

/**
 * Maximum length of the redirect_to URL in bytes.
 *
 * WHY 2048: Standard browser URL length limit. Longer URLs are almost
 * certainly injection attempts or misconfigured clients; reject them early
 * to prevent downstream surprises.
 */
export const MAX_REDIRECT_URL_LENGTH = 2048;

/**
 * Validates that a redirect_to URL's origin is in the allowlist.
 *
 * WHY a dedicated function (not inline): this is a security-critical check.
 * Isolating it makes unit testing trivial and keeps the handler readable.
 *
 * @param url - The parsed URL to check.
 * @returns true if the origin is allowed, false otherwise.
 */
export function isAllowedRedirectOrigin(url: URL): boolean {
  const origin = url.origin; // e.g. "http://localhost:3333"
  const href = url.href;     // for exp:// which has no "origin"

  for (const allowed of OAUTH_ALLOWED_REDIRECT_ORIGINS) {
    if (typeof allowed === 'string') {
      if (origin === allowed) return true;
    } else {
      // RegExp — test against origin first, then full href for non-http schemes
      if (allowed.test(origin) || allowed.test(href)) return true;
    }
  }
  return false;
}

/**
 * Extracts the `state` parameter from a Supabase authorization URL.
 *
 * WHY extract from URL (not from Supabase response): Supabase's
 * `signInWithOAuth` return value has `data.url` but does NOT expose
 * the state separately. We parse it from the URL query string.
 * The state is unguessable (Supabase generates it internally); we only
 * need to pluck and forward it so the CLI can validate CSRF on callback.
 *
 * @param authUrl - The full authorization URL from Supabase.
 * @returns The state string, or undefined if not present.
 */
export function extractStateFromAuthUrl(authUrl: string): string | undefined {
  try {
    const url = new URL(authUrl);
    return url.searchParams.get('state') ?? undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// OTP Helpers
// ============================================================================

/**
 * RFC 5321 maximum email address length (local-part@domain).
 *
 * WHY 320: RFC 5321 §4.5.3.1.1 specifies the maximum path length as
 * 256 characters, but the SMTP max email address is commonly cited as 320
 * (64 local-part + 1 @ + 255 domain). This is the broadly accepted ceiling
 * for input validation.
 */
export const MAX_EMAIL_LENGTH = 320;

// ============================================================================
// Email Hashing
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
 * WHY here (not in otp/send/route.ts): Next.js 16 forbids non-HTTP-method exports
 * from route files. otp/verify/route.ts previously imported hashEmail from
 * otp/send/route.ts — a cross-route import that now breaks. This file is the
 * canonical home for all shared auth helpers.
 *
 * @param email - Raw email string.
 * @returns Short hexadecimal string (8 chars).
 */
export function hashEmail(email: string): string {
  // WHY lowercase before hashing: email addresses are case-insensitive in the
  // domain part and effectively case-insensitive in practice for the local part.
  // Without normalization, 'User@Example.com' and 'user@example.com' produce
  // different hashes, breaking Sentry correlation across case variations of the
  // same address (e.g. client typo vs stored canonical form).
  // NOTE: we do NOT lowercase the email before passing it to signInWithOtp —
  // Supabase handles its own normalization; we only normalize for the hash.
  const normalized = email.toLowerCase();

  // djb2 hash over the normalized email
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 33) ^ normalized.charCodeAt(i);
  }
  // >>> 0 converts to unsigned 32-bit int; .toString(16) gives hex
  return (hash >>> 0).toString(16).slice(0, 8);
}
