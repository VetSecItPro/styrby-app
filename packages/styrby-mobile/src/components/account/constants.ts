/**
 * Account Settings — Constants & Pure Validators
 *
 * Side-effect-free constants and pure helper functions used across the
 * Account sub-components. Pure functions live here (rather than in the
 * hook) so they can be unit-tested without React or Supabase.
 */

/**
 * SecureStore key for the haptic feedback preference.
 *
 * WHY here: account deletion and sign-out clear this key as part of local
 * data cleanup. Centralising the constant prevents drift between callers.
 */
export const HAPTIC_PREFERENCE_KEY = 'styrby_haptic_enabled';

/**
 * Client-side cooldown (ms) between password reset email requests.
 *
 * WHY: Supabase also rate-limits server-side, but the client guard gives
 * immediate feedback without a network round trip. Prevents accidental
 * double-taps from sending multiple emails.
 */
export const PASSWORD_RESET_COOLDOWN_MS = 60_000;

/**
 * Validates an email address using a pragmatic RFC 5322 subset regex.
 *
 * WHY pragmatic regex: full RFC 5322 is impractical to validate client-side.
 * This pattern (one+ non-whitespace/non-@, @, one+ non-whitespace/non-@,
 * dot, one+ non-whitespace/non-@) catches the obvious typos that account
 * for the vast majority of mistyped addresses. Server still validates.
 *
 * @param raw - The user-supplied email string (may have leading/trailing whitespace)
 * @returns true when the trimmed lowercased input passes the pragmatic regex
 *
 * @example
 *   isValidEmail(' Foo@Bar.com ') // true
 *   isValidEmail('not-an-email')  // false
 */
export function isValidEmail(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Returns the remaining cooldown in seconds (rounded up) given the timestamp
 * of the last password reset email and the current time.
 *
 * WHY pure: lets us unit-test the cooldown math without faking timers in the
 * hook.
 *
 * @param lastSentAt - Unix ms of the last reset email, or null if never sent
 * @param now - Current Unix ms (defaults to Date.now()); injectable for tests
 * @returns Seconds remaining (>0) when still cooling down; 0 when allowed
 */
export function passwordResetCooldownRemainingSec(
  lastSentAt: number | null,
  now: number = Date.now(),
): number {
  if (lastSentAt === null) return 0;
  const elapsed = now - lastSentAt;
  if (elapsed >= PASSWORD_RESET_COOLDOWN_MS) return 0;
  return Math.ceil((PASSWORD_RESET_COOLDOWN_MS - elapsed) / 1000);
}
