/**
 * Support token generation and verification for consent-gated session access.
 *
 * Phase 4.2 — Support Tooling (T3)
 *
 * WHY this module exists: When a support admin requests access to a user's
 * session, we must generate a short-lived token that:
 *   1. Is never stored in plaintext (only a SHA-256 hash lives in the DB)
 *   2. Is displayed once to the admin and immediately discardable
 *   3. Is URL-safe so it can be passed as a query parameter without encoding
 *   4. Is compared in constant time to prevent timing-oracle attacks
 *
 * SOC2 CC6.1: Logical access controls — tokens use cryptographic randomness,
 * hash-only persistence, and timing-safe comparison to eliminate credential-
 * leak and timing-side-channel attack vectors.
 */

import crypto from 'crypto';

/**
 * Generates a cryptographically random support access token.
 *
 * WHY base64url: Query parameters in the grant approval URL must not require
 * percent-encoding. base64url uses only `[A-Za-z0-9_-]`, eliminating the `+`
 * and `/` characters that require encoding in standard base64. This avoids
 * accidental truncation or corruption when the URL is copy-pasted.
 *
 * WHY 32 bytes: NIST SP 800-132 recommends ≥128 bits of entropy for access
 * tokens. 32 bytes = 256 bits, well above that floor.
 *
 * The raw token is NEVER persisted. Only the SHA-256 hash is stored in
 * `support_access_grants.token_hash`. The caller is responsible for
 * displaying `raw` exactly once and discarding it.
 *
 * @returns An object containing:
 *   - `raw`  — URL-safe base64 string (43 chars, no padding). Display once; do not log or persist.
 *   - `hash` — SHA-256 hex digest of `raw` (64 chars). Safe to store in the DB.
 *
 * @example
 * const { raw, hash } = generateSupportToken();
 * // Store hash in DB:
 * await supabase.rpc('admin_request_support_access', { token_hash: hash, ... });
 * // Show raw to admin once, then discard from server memory:
 * return NextResponse.json({ token: raw }); // one-time display
 */
export function generateSupportToken(): { raw: string; hash: string } {
  // WHY crypto.randomBytes: Node's crypto module draws from the OS CSPRNG
  // (getrandom / /dev/urandom). Never use Math.random() for security tokens.
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Verifies a raw support token against its expected SHA-256 hash.
 *
 * WHY timingSafeEqual instead of `===`:
 * A string equality check (`actualHash === expectedHash`) short-circuits on
 * the first differing character. An attacker who can make many verify()
 * calls and measure response time can learn how many leading characters of
 * their guess are correct, iteratively recovering the hash (timing oracle).
 * `crypto.timingSafeEqual` compares all bytes in constant time regardless of
 * where the first difference occurs, eliminating this information leak.
 *
 * WHY compare hash buffers, not raw inputs:
 * We compare SHA-256(raw) against the stored SHA-256(original). This means
 * the attacker gains no information about the stored raw token even if they
 * can observe timing — they only learn whether their raw input produces the
 * same hash, which requires preimage resistance to exploit.
 *
 * SOC2 CC6.1: Credential comparison uses timing-safe primitives to prevent
 * side-channel attacks on support access tokens.
 *
 * @param raw          - The raw token string received from the caller (e.g., from query param).
 * @param expectedHash - The SHA-256 hex hash stored in `support_access_grants.token_hash`.
 * @returns `true` if the raw token hashes to `expectedHash`; `false` otherwise.
 *          Returns `false` (never throws) for all invalid / empty inputs.
 *
 * @example
 * const { raw, hash } = generateSupportToken();
 * verifySupportToken(raw, hash);           // true
 * verifySupportToken('wrong-token', hash); // false
 * verifySupportToken('', '');              // false
 */
export function verifySupportToken(raw: string, expectedHash: string): boolean {
  // Guard: empty inputs are always invalid. Also prevents Buffer.from('')
  // producing a zero-length buffer which timingSafeEqual would reject with a
  // RangeError if lengths mismatch (we handle length explicitly below, but
  // fail fast here for clarity).
  if (!raw || !expectedHash) return false;

  let actualHash: string;
  try {
    actualHash = crypto.createHash('sha256').update(raw).digest('hex');
  } catch {
    // Defensive: update() is unlikely to throw for string inputs, but guard
    // against exotic runtime environments.
    return false;
  }

  // Both hashes are SHA-256 hex strings → always 64 hex chars → 32 bytes
  // when decoded. However, if `expectedHash` is malformed (not 64 hex chars),
  // the buffer lengths will differ and timingSafeEqual would throw a
  // RangeError. We catch that here and return false instead.
  const a = Buffer.from(actualHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');

  // WHY explicit length check before timingSafeEqual: Node docs state that
  // timingSafeEqual throws if buffers are not the same length. We must guard
  // against a caller passing a truncated or malformed expectedHash.
  if (a.length !== b.length) return false;

  // WHY a.length === 0 guard: timingSafeEqual with two empty buffers returns
  // true — that would let verify('', '') succeed. The early `!raw ||
  // !expectedHash` check above already handles this, but we add a length
  // guard for defense-in-depth.
  if (a.length === 0) return false;

  return crypto.timingSafeEqual(a, b);
}
