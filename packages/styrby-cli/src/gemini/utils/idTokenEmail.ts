/**
 * Gemini ID Token Email Decoder
 *
 * Pure helper that extracts the user's email from a Google OAuth `id_token`
 * (a standard JWT). Used so per-account Gemini Cloud project lookups can
 * scope to the active Google identity.
 *
 * WHY a dedicated helper: `runGemini.ts` previously inlined manual JWT
 * parsing inside a try/catch. Pulling it out lets us unit-test the (many)
 * failure modes of malformed tokens without booting the full Gemini stack.
 */

/**
 * Decode the `email` claim from a Google OAuth id_token JWT.
 *
 * The JWT is NOT verified — Google already issued it, and we only use the
 * email for local routing (project selection). Never trust this for auth.
 *
 * @param idToken - The raw `id_token` string (3 base64url segments, dot-separated)
 * @returns The decoded email if present, or `undefined` for any malformed
 *   token, missing claim, or decode failure. Never throws.
 *
 * @example
 *   const email = decodeEmailFromIdToken(vendorToken.oauth.id_token);
 *   if (email) logger.debug(`User: ${email}`);
 */
export function decodeEmailFromIdToken(idToken: string | undefined | null): string | undefined {
  if (!idToken || typeof idToken !== 'string') {
    return undefined;
  }
  try {
    const parts = idToken.split('.');
    // WHY: A valid JWT has exactly 3 parts (header.payload.signature).
    // Anything else is malformed and unsafe to decode.
    if (parts.length !== 3) {
      return undefined;
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload && typeof payload === 'object' && typeof payload.email === 'string') {
      return payload.email;
    }
    return undefined;
  } catch {
    // WHY: Any parse error (bad base64, bad JSON) just means "no email" —
    // never propagate to caller because email is best-effort enrichment.
    return undefined;
  }
}
