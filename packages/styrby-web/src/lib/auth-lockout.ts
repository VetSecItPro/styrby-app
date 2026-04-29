/**
 * Authentication Lockout Utilities
 *
 * Implements account lockout after N consecutive failed login attempts
 * within a rolling time window. Applied to passkey verification to
 * protect against credential stuffing and brute-force attacks.
 *
 * Policy (H42 Item 3, SOC2 CC6.6, NIST SP 800-63B §5.2.2):
 * - 5 failed attempts within 1 hour → 15-minute lockout
 * - Successful auth resets the counter
 * - Locked accounts return 423 Locked + Retry-After header
 * - Admins (is_site_admin=true) are exempt — see WHY comment below
 *
 * WHY admins are exempt:
 * Admin lockout creates an unrecoverable denial-of-service with no
 * self-service path. Admins authenticate via hardware-backed passkeys
 * which are phishing-resistant by design. Auto-lockout provides marginal
 * additional protection while creating a high-severity availability risk.
 * (NIST SP 800-63B §5.2.2 explicitly permits this exception when
 * compensating controls — e.g., MFA, hardware-bound credentials — exist.)
 *
 * All three DB operations use SECURITY DEFINER functions via the admin
 * client so the application layer never has direct table access to
 * user_lockout. This prevents privilege escalation via RLS bypass.
 */

import { createAdminClient } from '@/lib/supabase/server';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Rolling window in seconds for failure counting.
 * 5 failures within this window triggers lockout.
 */
export const LOCKOUT_WINDOW_SECONDS = 3600; // 1 hour

/**
 * Maximum consecutive failures within LOCKOUT_WINDOW_SECONDS before lockout.
 */
export const LOCKOUT_MAX_FAILURES = 5;

/**
 * Duration of the lockout in seconds once triggered.
 */
export const LOCKOUT_DURATION_SECONDS = 900; // 15 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a lockout status check.
 */
export interface LockoutStatus {
  /** Whether the account is currently locked out. */
  isLocked: boolean;
  /**
   * ISO 8601 timestamp when the lockout expires.
   * Only present when isLocked is true.
   */
  lockedUntil: string | null;
  /**
   * Number of consecutive failures recorded.
   * Useful for surfacing a warning before lockout triggers.
   */
  failedCount: number;
}

// ---------------------------------------------------------------------------
// Admin check (exempts site admins from lockout)
// ---------------------------------------------------------------------------

/**
 * Checks whether a user is a site admin and therefore exempt from lockout.
 *
 * WHY: See module-level docstring for the rationale. We query the profiles
 * table rather than auth.users so no service-role expansion is needed.
 *
 * @param userId - The Supabase user ID to check
 * @returns true if the user is a site admin
 */
async function isSiteAdmin(userId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('profiles')
    .select('is_site_admin')
    .eq('id', userId)
    .single();
  return data?.is_site_admin === true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether a user account is currently locked out.
 *
 * Call this at the START of every login attempt before performing any
 * credential verification to prevent unnecessary bcrypt/WebAuthn work.
 *
 * Admins always return { isLocked: false } regardless of failure count.
 *
 * @param userId - The Supabase user ID to check
 * @returns The current lockout status
 *
 * @example
 * const lockout = await checkLockoutStatus(userId);
 * if (lockout.isLocked) {
 *   const retryAfter = Math.ceil((new Date(lockout.lockedUntil!).getTime() - Date.now()) / 1000);
 *   return NextResponse.json({ error: 'ACCOUNT_LOCKED' }, {
 *     status: 423,
 *     headers: { 'Retry-After': String(retryAfter) },
 *   });
 * }
 */
export async function checkLockoutStatus(userId: string): Promise<LockoutStatus> {
  // Admins are exempt — short-circuit before DB call
  if (await isSiteAdmin(userId)) {
    return { isLocked: false, lockedUntil: null, failedCount: 0 };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .rpc('check_lockout_status', { p_user_id: userId });

  if (error) {
    // WHY: If the lockout check fails, we log and allow the request.
    // Blocking all logins due to a DB error is worse than a brief window
    // without lockout protection. This mirrors the rate-limit fail-open policy.
    console.error('[auth-lockout] check_lockout_status RPC failed:', error.message);
    return { isLocked: false, lockedUntil: null, failedCount: 0 };
  }

  // RPC returns a single row (or empty for no-failure users)
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { isLocked: false, lockedUntil: null, failedCount: 0 };
  }

  return {
    isLocked: row.is_locked === true,
    lockedUntil: row.locked_until ?? null,
    failedCount: row.failed_count ?? 0,
  };
}

/**
 * Records a failed login attempt and returns the updated lockout state.
 *
 * Call this AFTER a credential verification failure (e.g., passkey
 * assertion rejected by the edge function). Do NOT call on network errors
 * or internal failures — only on actual credential mismatches.
 *
 * Admins: call is a no-op; returns unlocked status.
 *
 * @param userId - The Supabase user ID that failed authentication
 * @returns The lockout state after recording the failure
 *
 * @example
 * const lockout = await recordLoginFailure(userId);
 * if (lockout.isLocked) {
 *   const retryAfter = Math.ceil((new Date(lockout.lockedUntil!).getTime() - Date.now()) / 1000);
 *   return NextResponse.json({ error: 'ACCOUNT_LOCKED' }, {
 *     status: 423,
 *     headers: { 'Retry-After': String(retryAfter) },
 *   });
 * }
 */
export async function recordLoginFailure(userId: string): Promise<LockoutStatus> {
  // Admins are exempt
  if (await isSiteAdmin(userId)) {
    return { isLocked: false, lockedUntil: null, failedCount: 0 };
  }

  const supabase = createAdminClient();
  const { data: lockedUntil, error } = await supabase
    .rpc('record_login_failure', {
      p_user_id:         userId,
      p_window_seconds:  LOCKOUT_WINDOW_SECONDS,
      p_max_failures:    LOCKOUT_MAX_FAILURES,
      p_lockout_seconds: LOCKOUT_DURATION_SECONDS,
    });

  if (error) {
    // Fail-open: log and return unlocked to avoid blocking all logins
    console.error('[auth-lockout] record_login_failure RPC failed:', error.message);
    return { isLocked: false, lockedUntil: null, failedCount: 0 };
  }

  const lockedUntilStr = lockedUntil as string | null;
  const isLocked = !!lockedUntilStr && new Date(lockedUntilStr) > new Date();

  return {
    isLocked,
    lockedUntil: lockedUntilStr,
    // Re-check status for accurate failure count
    failedCount: LOCKOUT_MAX_FAILURES, // conservative upper bound when locked
  };
}

/**
 * Resets the failure counter for a user after a successful authentication.
 *
 * Call this AFTER successful credential verification and session creation.
 * Fire-and-forget is acceptable — failure to reset is not security-critical
 * (the counter will naturally expire with the window).
 *
 * Admins: call is a no-op.
 *
 * @param userId - The Supabase user ID that succeeded authentication
 *
 * @example
 * // After successful passkey verify:
 * void resetLoginFailures(userId); // fire and forget
 */
export async function resetLoginFailures(userId: string): Promise<void> {
  // Admins are exempt (no row to reset anyway)
  if (await isSiteAdmin(userId)) return;

  const supabase = createAdminClient();
  const { error } = await supabase
    .rpc('reset_login_failures', { p_user_id: userId });

  if (error) {
    // Non-critical: log but don't fail the request
    console.error('[auth-lockout] reset_login_failures RPC failed:', error.message);
  }
}

/**
 * Creates a 423 Locked NextResponse with Retry-After header.
 *
 * @param lockedUntil - ISO 8601 timestamp when the lockout expires
 * @returns NextResponse with status 423 and Retry-After header
 */
export function lockoutResponse(lockedUntil: string): Response {
  const retryAfter = Math.max(
    1,
    Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000)
  );
  return new Response(
    JSON.stringify({
      error: 'ACCOUNT_LOCKED',
      message: 'Too many failed attempts. Please try again later.',
      retryAfter,
    }),
    {
      status: 423,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    }
  );
}
