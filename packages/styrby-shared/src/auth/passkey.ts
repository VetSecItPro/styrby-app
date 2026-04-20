/**
 * Passkey (WebAuthn L3 / FIDO2) Shared Helpers
 *
 * Platform-agnostic types and pure helpers used by styrby-web
 * (@simplewebauthn/browser) and styrby-mobile (expo-passkey).
 *
 * WHY shared: RP (Relying Party) ID derivation, challenge validation, and
 * PublicKeyCredential option assembly must match byte-for-byte on both
 * platforms. Anything else and the server-side verifier rejects the
 * assertion. Keeping these in one module eliminates drift.
 *
 * Standards:
 *   - W3C WebAuthn Level 3 (2024-03 Recommendation)
 *   - FIDO2 CTAP2.2 (2024-06)
 *   - NIST 800-63B AAL3 (phishing-resistant MFA)
 *
 * NO platform-specific imports. This module MUST be safe to bundle for
 * Node (Next.js server routes), Deno (Supabase edge functions), the
 * browser, and React Native / Hermes. Do not add imports that break
 * any of those runtimes.
 *
 * @module auth/passkey
 */

// ============================================================================
// Types
// ============================================================================

/**
 * A registered passkey credential as stored in the `passkeys` table
 * (migration 020). Shape mirrors the DB row for convenience on both
 * client and server.
 */
export interface PasskeyCredential {
  /** Opaque DB row id (uuid). */
  id: string;
  /** Owner user id (uuid). */
  userId: string;
  /** base64url(PublicKeyCredential.id) per WebAuthn L3 §5.8.3. */
  credentialId: string;
  /** base64url(CBOR(COSE_Key)). */
  publicKey: string;
  /** Signature counter. MUST be monotonically increasing per L3 §7.2 step 19. */
  counter: number;
  /** Transports hint (usb | nfc | ble | internal | hybrid). */
  transports: readonly AuthenticatorTransportHint[];
  /** Human label shown in settings. */
  deviceName: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last successful use timestamp (null if never used). */
  lastUsedAt: string | null;
  /** ISO-8601 soft-revocation timestamp (null => active). */
  revokedAt: string | null;
}

/**
 * Transport hints accepted by WebAuthn L3. We keep this as a string union
 * rather than pulling the DOM lib's `AuthenticatorTransport` type so the
 * module works in non-DOM runtimes (Deno edge, React Native).
 */
export type AuthenticatorTransportHint =
  | 'usb'
  | 'nfc'
  | 'ble'
  | 'internal'
  | 'hybrid';

/**
 * Client response from a successful navigator.credentials.create() call,
 * base64url-encoded and JSON-safe so it can be shipped over HTTPS to the
 * edge function for verification.
 *
 * Matches @simplewebauthn/types `RegistrationResponseJSON`.
 */
export interface PasskeyRegistrationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: readonly AuthenticatorTransportHint[];
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: 'platform' | 'cross-platform';
}

/**
 * Client response from a successful navigator.credentials.get() call.
 * Matches @simplewebauthn/types `AuthenticationResponseJSON`.
 */
export interface PasskeyAuthenticationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: 'platform' | 'cross-platform';
}

/**
 * Options for building a WebAuthn registration (credential creation) request.
 */
export interface BuildCreationOptionsInput {
  /** RP ID (effective domain) - MUST match the origin's registrable domain. */
  rpId: string;
  /** Human-readable RP name shown on the authenticator UI. */
  rpName: string;
  /** User id (base64url of random bytes; NOT the Supabase user id). */
  userId: string;
  /** User-visible handle (usually email). */
  userName: string;
  /** Display name in the authenticator UI. */
  userDisplayName: string;
  /** base64url-encoded random challenge from the server. */
  challenge: string;
  /** Existing credential ids to exclude (prevent double-registration). */
  excludeCredentials?: readonly string[];
  /** Timeout in ms. Default 60_000. */
  timeoutMs?: number;
}

/**
 * Options for building a WebAuthn authentication (credential get) request.
 */
export interface BuildRequestOptionsInput {
  /** RP ID (effective domain). */
  rpId: string;
  /** base64url-encoded random challenge from the server. */
  challenge: string;
  /** Optional allow-list of credential ids (empty => discoverable). */
  allowCredentials?: readonly string[];
  /** Timeout in ms. Default 60_000. */
  timeoutMs?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default WebAuthn ceremony timeout.
 * WHY 60s: matches the @simplewebauthn default and Apple's platform-auth
 * soft timeout. Too short == user can't approve in time; too long ==
 * stale challenges linger server-side.
 */
export const DEFAULT_PASSKEY_TIMEOUT_MS = 60_000;

/**
 * Length of the random challenge we issue server-side (bytes).
 * WHY 32: WebAuthn L3 §13.1 recommends >=16; we use 32 to match NIST
 * 800-63B §5.1.7 requirement of >=64 bits of entropy with a large margin.
 */
export const PASSKEY_CHALLENGE_BYTES = 32;

/**
 * Challenge freshness window (ms).
 * WHY 5min: a passkey ceremony including biometric prompt normally
 * completes in < 30s. 5 minutes covers slow-device edge cases while
 * staying well inside L3 §13.4.3's replay-resistance requirement.
 */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Derive the WebAuthn RP ID (effective domain) from an absolute URL.
 *
 * WHY: RP ID MUST be the origin's registrable domain or a suffix of it
 * (WebAuthn L3 §5.1.2). Hardcoding it would break local dev (localhost)
 * and preview deploys (*.vercel.app). We strip the scheme / port and
 * return the hostname, which is always a valid RP ID for its own origin.
 *
 * @param url - Absolute URL (e.g. 'https://styrby.com/login').
 * @returns Hostname suitable as rp.id (e.g. 'styrby.com').
 * @throws {TypeError} When `url` is not a valid absolute URL.
 *
 * @example
 * extractRpId('https://styrby.com/login')      // 'styrby.com'
 * extractRpId('http://localhost:3000')         // 'localhost'
 * extractRpId('https://preview-xyz.vercel.app')// 'preview-xyz.vercel.app'
 */
export function extractRpId(url: string): string {
  const parsed = new URL(url);
  // WHY lowercase: WebAuthn L3 §5.1.2 compares RP IDs case-insensitively,
  // but the stored challenge metadata must be canonical for server replay
  // checks. Normalizing here keeps downstream equality checks trivial.
  return parsed.hostname.toLowerCase();
}

/**
 * Build PublicKeyCredentialCreationOptions for registration.
 *
 * The result is JSON-safe (challenge + user.id are base64url strings).
 * Client adapters convert these to ArrayBuffers before calling
 * `navigator.credentials.create()` (on web) or `createPasskey()` (on mobile).
 *
 * Security defaults (DO NOT weaken without review):
 *   - residentKey: 'required'     -> discoverable credentials (no email step)
 *   - userVerification: 'required'-> biometric/PIN required (NIST AAL3)
 *   - attestation: 'none'         -> privacy-preserving; we don't need AAGUID
 *   - authenticatorAttachment: undefined -> let user pick platform vs roaming
 *
 * @param input - RP info, user info, challenge, exclude-list, timeout.
 * @returns WebAuthn creation options in JSON form.
 */
export function buildPublicKeyCredentialCreationOptions(
  input: BuildCreationOptionsInput,
): {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout: number;
  excludeCredentials: Array<{ type: 'public-key'; id: string }>;
  authenticatorSelection: {
    residentKey: 'required';
    userVerification: 'required';
  };
  attestation: 'none';
  extensions: { credProps: true };
} {
  return {
    rp: { id: input.rpId, name: input.rpName },
    user: {
      id: input.userId,
      name: input.userName,
      displayName: input.userDisplayName,
    },
    challenge: input.challenge,
    // WHY these algs: ES256 (-7) is universally supported; EdDSA (-8) and
    // RS256 (-257) cover Windows Hello + older FIDO2 keys. Order signals
    // preference per L3 §5.4.5.
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -8 },
      { type: 'public-key', alg: -257 },
    ],
    timeout: input.timeoutMs ?? DEFAULT_PASSKEY_TIMEOUT_MS,
    excludeCredentials: (input.excludeCredentials ?? []).map((id) => ({
      type: 'public-key',
      id,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    attestation: 'none',
    extensions: { credProps: true },
  };
}

/**
 * Build PublicKeyCredentialRequestOptions for authentication.
 *
 * @param input - RP id, challenge, optional allow-list, timeout.
 * @returns WebAuthn request options in JSON form.
 */
export function buildPublicKeyCredentialRequestOptions(
  input: BuildRequestOptionsInput,
): {
  rpId: string;
  challenge: string;
  timeout: number;
  userVerification: 'required';
  allowCredentials: Array<{ type: 'public-key'; id: string }>;
} {
  return {
    rpId: input.rpId,
    challenge: input.challenge,
    timeout: input.timeoutMs ?? DEFAULT_PASSKEY_TIMEOUT_MS,
    // WHY required (not preferred): we are using passkeys as a primary
    // factor, so we MUST have UV=true on the authenticator response per
    // NIST 800-63B AAL3. 'preferred' would silently degrade to AAL2.
    userVerification: 'required',
    allowCredentials: (input.allowCredentials ?? []).map((id) => ({
      type: 'public-key',
      id,
    })),
  };
}

/**
 * Validate that a stored signature counter would accept an incoming one.
 *
 * WebAuthn L3 §7.2 step 19: "If authData.signCount is nonzero or
 * storedSignCount is nonzero, and authData.signCount is less than or
 * equal to storedSignCount, it is a signal that the authenticator may
 * be cloned. Relying Parties SHOULD [...] fail the authentication."
 *
 * WHY both zero is allowed: some passkeys (notably Apple platform keys
 * and certain TPM-backed authenticators) deliberately return signCount=0
 * for every assertion. In that case the strict `<=` check would reject
 * every subsequent login. The spec explicitly permits skipping the check
 * when both values are zero, and that matches Apple/Google/MSFT behavior.
 *
 * @param storedCounter - Counter value previously persisted in `passkeys`.
 * @param incomingCounter - `authData.signCount` from the new assertion.
 * @returns `true` if the assertion is consistent with no cloning.
 *
 * @example
 * isCounterValid(5, 6)  // true  (normal increment)
 * isCounterValid(5, 5)  // false (replay / clone)
 * isCounterValid(5, 4)  // false (rollback / clone)
 * isCounterValid(0, 0)  // true  (Apple-style fixed-zero authenticator)
 */
export function isCounterValid(
  storedCounter: number,
  incomingCounter: number,
): boolean {
  if (storedCounter === 0 && incomingCounter === 0) return true;
  return incomingCounter > storedCounter;
}
