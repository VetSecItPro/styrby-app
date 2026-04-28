/**
 * Polar webhook HMAC-SHA256 signature verification.
 *
 * This module is the sole authority for verifying that inbound webhook
 * requests genuinely originated from Polar. It must be called BEFORE any
 * parsing, logging, or database access — a failed signature means we cannot
 * trust the payload at all and should reject immediately.
 *
 * Security design decisions:
 *
 * 1. TIMING-SAFE COMPARISON: `crypto.timingSafeEqual` prevents timing attacks
 *    where an attacker measures the response time to determine how many bytes
 *    of their guess match the expected signature. Naive string equality (`===`)
 *    short-circuits on the first differing character, leaking length information
 *    via response latency.
 *
 * 2. LENGTH PRE-CHECK: `timingSafeEqual` throws a `RangeError` when buffers
 *    differ in byte length. Without the pre-check, an attacker submitting a
 *    1-byte signature receives a 500 response (threw) rather than a 401. This
 *    leaks that the signature length was wrong — a distinct information channel
 *    from an incorrect-but-correct-length signature. We reject on length
 *    mismatch BEFORE the timing-safe compare, returning false with no branching
 *    on secret content.
 *
 * 3. NO BODY/SIGNATURE LOGGING: The raw request body and the computed expected
 *    signature must never appear in logs. The body contains sensitive billing
 *    data; the expected signature, if logged on failure, would help an attacker
 *    who has read access to the log pipeline craft a valid future signature.
 *    On failure, we log only "signature verification failed" + a timestamp.
 *
 * 4. SECRET READ AT CALL TIME: The webhook secret is read from process.env
 *    inside the functions (not module-level). This allows test code to stub
 *    env vars via vi.stubEnv() without module cache issues.
 *
 * 5. ENV-AWARE SECRET SELECTION: When `POLAR_ENV=sandbox`, the verifier
 *    reads `POLAR_SANDBOX_WEBHOOK_SECRET`; otherwise it reads
 *    `POLAR_WEBHOOK_SECRET`. This mirrors `getPolarServer()` in `polar.ts`
 *    so a single deploy can be pointed at either Polar environment by
 *    flipping a single env var. Default behavior (POLAR_ENV unset) preserves
 *    production: no migration risk to existing deploys.
 *
 * Governing standards:
 * - OWASP ASVS V3.5 (Token-Based Authentication)
 * - OWASP ASVS V8.3 (Sensitive Private Data)
 * - SOC2 CC7.2 (system operations — security event detection)
 * - HMAC security per RFC 2104
 *
 * @module lib/polar-webhook-signature
 */

import crypto from 'crypto';
// WHY no .js extension: same as polar-env.ts — webpack (moduleResolution: bundler)
// cannot resolve explicit .js extensions for TypeScript source files.
import { getEnv } from './env';

// ============================================================================
// Env-aware secret resolution
// ============================================================================

/**
 * Returns the active Polar webhook signing secret based on `POLAR_ENV`.
 *
 * - When `POLAR_ENV === 'sandbox'`: reads `POLAR_SANDBOX_WEBHOOK_SECRET`.
 * - Otherwise: reads `POLAR_WEBHOOK_SECRET` (production behavior, default).
 *
 * WHY env-aware (mirrors `getPolarServer()` in `polar.ts`): sandbox and
 * production are separate Polar accounts with separate signing secrets. A
 * sandbox-origin webhook signed with the sandbox secret would fail HMAC
 * verification against the prod secret (and vice versa) with no useful error,
 * just a 401. Selecting the secret by env keeps a single deploy capable of
 * serving either environment correctly when `POLAR_ENV` is set in the
 * deploy's env scope.
 *
 * WHY default-to-prod: `POLAR_ENV` is unset on the production Vercel scope.
 * Returning the prod secret on absence preserves existing behavior — no
 * production migration risk introduced by this function.
 *
 * @returns The active webhook secret string, or `undefined` if the resolved
 *   env var is missing/empty. Callers must treat undefined as "reject all
 *   requests" (see `verifyPolarSignature` for the safe rejection path).
 */
export function getPolarWebhookSecret(): string | undefined {
  const env = getEnv('POLAR_ENV');
  const isSandbox = env === 'sandbox';
  const varName = isSandbox ? 'POLAR_SANDBOX_WEBHOOK_SECRET' : 'POLAR_WEBHOOK_SECRET';
  return getEnv(varName);
}

// ============================================================================
// Core verification
// ============================================================================

/**
 * Verifies a Polar webhook HMAC-SHA256 signature against the raw request body.
 *
 * Performs a timing-safe comparison after a length pre-check. Both the
 * body and the computed expected signature are NEVER logged by this function,
 * regardless of the outcome.
 *
 * @param body - Raw request body string (must be read before any parsing).
 * @param signature - Value of the `polar-signature` or `x-polar-signature`
 *   header as provided by Polar.
 * @returns `true` if the signature is valid; `false` otherwise.
 *
 * @example
 * ```ts
 * const body = await request.text();
 * const sig = request.headers.get('polar-signature') ?? '';
 * if (!verifyPolarSignature(body, sig)) {
 *   return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
 * }
 * ```
 */
export function verifyPolarSignature(body: string, signature: string): boolean {
  // WHY env-aware: getPolarWebhookSecret() returns the sandbox secret when
  // POLAR_ENV=sandbox, else the prod secret. Reading at call-time (not module
  // scope) lets vi.stubEnv() swap secrets between test cases without re-import.
  const secret = getPolarWebhookSecret();

  if (!secret) {
    // No secret configured for the active POLAR_ENV — treat as invalid.
    // This case should have been caught by validatePolarEnv() at startup.
    // Log the absence (not the value) and reject. The error message
    // includes which env's secret was missing so ops can locate the gap.
    const isSandbox = getEnv('POLAR_ENV') === 'sandbox';
    const which = isSandbox ? 'POLAR_SANDBOX_WEBHOOK_SECRET' : 'POLAR_WEBHOOK_SECRET';
    console.error(
      `polar-webhook-signature: ${which} is unset; rejecting all requests`
    );
    return false;
  }

  // Compute the expected HMAC-SHA256 digest of the raw body.
  // WHY hex encoding: Polar sends the signature as a hex string.
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  // WHY .toLowerCase() on the incoming signature: Polar currently delivers
  // lowercase hex, but RFC 2104 does not mandate case. Some providers (and
  // intermediary proxies) uppercase hex. Without normalization, an uppercase
  // signature would produce a different UTF-8 buffer than the lowercase
  // expected hash, causing a spurious 401 for a cryptographically valid
  // request. Normalizing to lowercase before comparison is free (negligible
  // CPU cost) and eliminates an entire class of provider-behavior bugs.
  //
  // WHY Buffer.from with 'utf8': we are comparing two hex-encoded strings as
  // strings (not decoded bytes). Both the incoming signature and the computed
  // expected hash are 64-character hex strings after normalization — comparing
  // their UTF-8 byte representations is correct and equivalent to string
  // equality, but uses crypto.timingSafeEqual to prevent timing attacks.
  const sigBuf = Buffer.from(signature.toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  // LENGTH PRE-CHECK: reject if byte lengths differ without comparing content.
  // WHY: timingSafeEqual throws RangeError on mismatched lengths, producing a
  // 500 instead of a 401 and leaking that the length was wrong (a distinct
  // signal from an incorrect-but-correct-length signature).
  // Returning false here gives no information about the expected length
  // because the expected hash is always exactly 64 hex characters (SHA-256).
  // An attacker already knows the hash length from the algorithm; the
  // pre-check does not leak new information.
  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }

  // TIMING-SAFE COMPARISON: compare byte-by-byte in constant time.
  // WHY crypto.timingSafeEqual (not ===): string equality short-circuits on
  // the first differing character. An attacker who measures response latency
  // across thousands of requests can infer how many leading characters match,
  // eventually constructing a valid signature character-by-character.
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// ============================================================================
// Throwing variant for use in route handlers
// ============================================================================

/**
 * Shape of the error object thrown when signature verification fails.
 * Using a typed error (rather than a plain Error) lets route handlers pattern-
 * match on the code without string-parsing the message.
 */
export class PolarSignatureError extends Error {
  /** HTTP status code the route handler should return. Always 401. */
  readonly statusCode = 401 as const;
  /** Machine-readable code for structured error responses. */
  readonly code = 'POLAR_SIGNATURE_INVALID' as const;

  constructor() {
    super('Polar webhook signature verification failed');
    this.name = 'PolarSignatureError';
  }
}

/**
 * Verifies a Polar webhook signature, throwing a `PolarSignatureError` if
 * invalid. Designed for use at the top of a route handler before any other
 * processing.
 *
 * On failure:
 * - Logs "signature verification failed" + ISO timestamp. NEVER logs the body,
 *   the provided signature, or the expected signature.
 * - Throws `PolarSignatureError` with `statusCode: 401`.
 *
 * WHY log timestamp on failure: correlates the rejected request with external
 * Polar delivery logs (Polar includes a timestamp in their webhook dashboard),
 * enabling ops to determine whether the rejection was due to a replay or a
 * genuine misconfiguration — without exposing any secret material.
 *
 * @param body - Raw request body string.
 * @param signature - Value of the `polar-signature` header.
 * @throws {PolarSignatureError} When the signature is invalid or secret is missing.
 *
 * @example
 * ```ts
 * const body = await request.text();
 * const sig = headersList.get('polar-signature') ?? '';
 * try {
 *   verifyPolarSignatureOrThrow(body, sig); // 401 thrown here if invalid
 * } catch (e) {
 *   if (e instanceof PolarSignatureError) {
 *     return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
 *   }
 *   throw e;
 * }
 * ```
 */
export function verifyPolarSignatureOrThrow(body: string, signature: string): void {
  const valid = verifyPolarSignature(body, signature);

  if (!valid) {
    // Log only the timestamp — no body, no signature, no expected hash.
    // WHY ISO string (not Date.now()): ISO is human-readable in log aggregation
    // tools and directly comparable to Polar's webhook delivery timestamps.
    console.error(
      `polar-webhook-signature: verification failed at ${new Date().toISOString()}`
    );
    throw new PolarSignatureError();
  }
}
