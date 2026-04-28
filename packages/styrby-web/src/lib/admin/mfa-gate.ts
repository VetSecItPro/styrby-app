/**
 * Admin MFA Gate — assertAdminMfa()
 *
 * Enforces that every admin who has passed the grace period has at least one
 * active MFA factor (passkey OR Supabase Auth TOTP) before they can perform
 * a privileged mutation.
 *
 * Security references:
 *   OWASP A07:2021  - Identification and Authentication Failures
 *   SOC 2 CC6.1     - Logical access controls; privileged access requires
 *                     phishing-resistant authentication factors
 *   NIST SP 800-63B AAL2 - Multi-factor authentication for privileged accounts
 *   NIST SP 800-53 AC-3  - Access enforcement; deny-by-default on error
 *
 * WHY application-layer (not Postgres-layer):
 *   MFA factor queries require the Supabase Auth Admin API
 *   (auth.admin.getUserById). Calling the Admin API from inside a Postgres
 *   SECURITY DEFINER function is not supported without pg_net and introduces
 *   a network dependency on every admin RPC call. Application-layer enforcement
 *   is faster, testable, and does not block the Postgres execution path.
 *
 * Call pattern in admin action/route handlers:
 *   import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';
 *
 *   // After isAdmin check (or equivalent):
 *   try {
 *     await assertAdminMfa(user.id);
 *   } catch (err) {
 *     if (err instanceof AdminMfaRequiredError) {
 *       return NextResponse.json({ error: err.code }, { status: err.statusCode });
 *     }
 *     throw err;
 *   }
 */

import { createAdminClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';

// ============================================================================
// Config
// ============================================================================

/**
 * Grace period in days for new admin MFA enforcement.
 *
 * WHY env-var: allows the grace period to be adjusted per-environment without
 * a code deployment. Staging can use 0 (immediate enforcement), production
 * uses 7 days for initial rollout.
 *
 * Used only when inserting NEW admins. Existing admins at migration time
 * received their grace window via the 065_admin_mfa_enforcement.sql backfill.
 */
export const ADMIN_MFA_GRACE_DAYS = (() => {
  const raw = process.env.STYRBY_ADMIN_MFA_GRACE_DAYS;
  if (!raw) return 7;
  const parsed = Number(raw);
  // WHY NaN / negative guard: a misconfigured value must not accidentally grant
  // infinite or negative grace. Default to 7 on bad input. NIST SP 800-53 AC-3.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
})();

// ============================================================================
// Error class
// ============================================================================

/**
 * Thrown by assertAdminMfa() when an admin is blocked from performing a
 * privileged action because they have not enrolled MFA after their grace window.
 *
 * Callers should catch this error and return a 403 JSON response:
 *   { error: 'ADMIN_MFA_REQUIRED' }
 *
 * WHY a typed error class (not a plain Error): callers can distinguish MFA
 * failures from unexpected errors using `instanceof AdminMfaRequiredError`,
 * which allows precise 403 responses without catching everything.
 */
export class AdminMfaRequiredError extends Error {
  /** HTTP status code to return to the client. */
  readonly statusCode = 403 as const;
  /**
   * Machine-readable error code. Clients should display a setup-MFA prompt
   * when they receive this code.
   */
  readonly code = 'ADMIN_MFA_REQUIRED' as const;

  constructor() {
    super(
      'Admin MFA is required. Enroll a passkey or TOTP factor at ' +
        '/dashboard/settings/account/passkeys before performing admin actions.'
    );
    this.name = 'AdminMfaRequiredError';
  }
}

// ============================================================================
// Internal types
// ============================================================================

/**
 * Aggregated MFA status for a single admin user.
 * Computed in parallel by queryAdminMfaStatus().
 */
interface AdminMfaStatus {
  /** True if the admin's grace period has not yet expired (mfa_grace_until > now). */
  inGrace: boolean;
  /** The raw mfa_grace_until timestamp, or null if no grace row. */
  graceUntil: string | null;
  /** True if the admin has at least one non-revoked passkey. */
  hasPasskey: boolean;
  /** True if the admin has a verified Supabase Auth TOTP factor. */
  hasTotp: boolean;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Queries the admin's MFA status in parallel:
 *   1. site_admins.mfa_grace_until — is the grace period still active?
 *   2. passkeys count — has the admin enrolled a passkey?
 *   3. auth.admin.getUserById TOTP check — has the admin verified a TOTP factor?
 *
 * WHY parallel queries: all three are independent. Serial would triple the p99
 * latency for every admin action — unacceptable for a hot path.
 *
 * WHY service-role client (createAdminClient):
 *   - site_admins is not accessible by the authenticated role via RLS.
 *   - passkeys may be scoped to service-role only (depends on RLS config).
 *   - auth.admin.getUserById requires service-role privilege.
 *   Using service-role here is safe because:
 *     a) assertAdminMfa is only called AFTER isAdmin() confirms admin status.
 *     b) We only read, never write, from this helper.
 *
 * @param userId - The admin user's UUID.
 * @returns Aggregated AdminMfaStatus.
 * @throws If any critical query (grace + passkeys) fails. TOTP failure is
 *   swallowed when a passkey is present (fail-open for TOTP API errors when
 *   passkey MFA is already satisfied). NIST SP 800-53 AC-3.
 */
async function queryAdminMfaStatus(userId: string): Promise<AdminMfaStatus> {
  const adminClient = createAdminClient();

  // Run grace window + passkeys queries in parallel.
  // TOTP requires auth.admin.getUserById which is independent.
  const [graceResult, passkeysResult, authUserResult] = await Promise.all([
    // (1) Grace window: is mfa_grace_until in the future?
    adminClient
      .from('site_admins')
      .select('mfa_grace_until')
      .eq('user_id', userId)
      .maybeSingle(),

    // (2) Passkeys: count non-revoked passkeys for this user.
    // WHY maybeSingle() not count: count('exact') requires a head:true option
    // which returns no data. We select id and count client-side instead,
    // keeping the query simple and compatible with the RLS policy shape.
    adminClient
      .from('passkeys')
      .select('id')
      .eq('user_id', userId)
      .is('revoked_at', null),

    // (3) TOTP: fetch Auth user to inspect mfa_factors.
    // WHY Auth Admin API not a DB table: auth.mfa_factors is in the auth schema
    // and is not exposed via PostgREST by default. The Auth Admin API is the
    // correct, supported path. SOC 2 CC6.1.
    adminClient.auth.admin.getUserById(userId),
  ]);

  // ── Grace window ────────────────────────────────────────────────────────────
  if (graceResult.error) {
    // Propagate — callers catch and fail-closed. NIST SP 800-53 AC-3.
    throw graceResult.error;
  }
  const graceUntilStr = graceResult.data?.mfa_grace_until ?? null;
  const inGrace = graceUntilStr != null && new Date(graceUntilStr) > new Date();

  // ── Passkeys ────────────────────────────────────────────────────────────────
  if (passkeysResult.error) {
    // Propagate — callers catch and fail-closed.
    throw passkeysResult.error;
  }
  const hasPasskey = (passkeysResult.data ?? []).length > 0;

  // ── TOTP ────────────────────────────────────────────────────────────────────
  // WHY swallow Auth API errors when passkey is present:
  //   A transient Auth API error must not block an admin who has a valid passkey.
  //   The passkey factor alone satisfies NIST SP 800-63B AAL2. If the Auth API
  //   is down AND no passkey is present, we fail-closed (see assertAdminMfa).
  let hasTotp = false;
  if (!authUserResult.error && authUserResult.data?.user?.factors) {
    hasTotp = authUserResult.data.user.factors.some(
      (f) => f.factor_type === 'totp' && f.status === 'verified'
    );
  } else if (authUserResult.error && !hasPasskey) {
    // Auth API failed and no passkey — propagate so assertAdminMfa fails-closed.
    throw authUserResult.error;
  }
  // If Auth API failed but passkey IS present: hasTotp stays false, but
  // hasPasskey=true will allow the action. This is the correct fallback.

  return { inGrace, graceUntil: graceUntilStr, hasPasskey, hasTotp };
}

/**
 * Writes a grace-period audit event to audit_log.
 *
 * WHY audit_log (not admin_audit_log):
 *   admin_audit_log tracks mutations the admin performs on OTHER users.
 *   This event is about the admin's own authentication state — it belongs
 *   in the general audit_log. SOC 2 CC6.1: document privileged access with
 *   defined remediation deadlines.
 *
 * WHY non-throwing: a failure to write a grace audit event must not block
 * the admin action. The event is informational — the admin is still allowed
 * to act (they're in grace). Failure is captured in Sentry for ops visibility.
 *
 * @param userId - The admin user's UUID.
 * @param graceUntil - The ISO timestamp when the grace period expires.
 */
async function writeGraceAuditEvent(userId: string, graceUntil: string | null): Promise<void> {
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('audit_log').insert({
    user_id: userId,
    event_type: 'admin_mfa_grace_action',
    metadata: {
      grace_until: graceUntil,
      note:
        'Admin performed an action during MFA grace period. ' +
        'OWASP A07:2021 / SOC 2 CC6.1: enroll MFA before grace expires.',
    },
  });

  if (error) {
    // Non-fatal: log to Sentry but do not block the admin action.
    Sentry.captureException(error, {
      tags: { component: 'writeGraceAuditEvent', user_id: userId },
      extra: { grace_until: graceUntil },
    });
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Asserts that the given admin user has an active MFA factor (passkey or TOTP),
 * or is still within their migration grace period.
 *
 * Call this AFTER confirming the user is an admin (isAdmin() check). It is NOT
 * a substitute for the admin check — it adds a second authentication-factor
 * requirement on top of the existing admin authorization check.
 *
 * Behavior:
 *   - In grace period → allow action, write grace audit event (non-blocking).
 *   - Has passkey OR verified TOTP → allow action.
 *   - No MFA after grace → throw AdminMfaRequiredError (403 ADMIN_MFA_REQUIRED).
 *   - DB error → throw AdminMfaRequiredError (fail-closed, NIST SP 800-53 AC-3).
 *
 * @param userId - The admin user's UUID (from Supabase Auth getUser).
 * @throws {AdminMfaRequiredError} When the admin must enroll MFA before acting.
 *
 * @example
 * const adminStatus = await isAdmin(user.id);
 * if (!adminStatus) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
 *
 * try {
 *   await assertAdminMfa(user.id);
 * } catch (err) {
 *   if (err instanceof AdminMfaRequiredError) {
 *     return NextResponse.json({ error: err.code }, { status: err.statusCode });
 *   }
 *   throw err;
 * }
 */
export async function assertAdminMfa(userId: string): Promise<void> {
  // WHY guard empty userId: a missing userId should never reach here (auth check
  // should have caught it), but fail-closed defensively. NIST SP 800-53 AC-3.
  if (!userId) {
    throw new AdminMfaRequiredError();
  }

  let status: AdminMfaStatus;
  try {
    status = await queryAdminMfaStatus(userId);
  } catch (err) {
    // Any DB error → fail-closed. Never grant access on uncertainty.
    // SOC 2 CC6.1, NIST SP 800-53 AC-3: deny by default on error.
    Sentry.captureException(err, {
      tags: { component: 'assertAdminMfa', user_id: userId },
      extra: {
        note: 'MFA status query failed. Failing closed (ADMIN_MFA_REQUIRED). NIST SP 800-53 AC-3.',
      },
    });
    throw new AdminMfaRequiredError();
  }

  // ── Grace period path ────────────────────────────────────────────────────────
  if (status.inGrace) {
    // Admin is within migration grace window — allow action but write audit event.
    // WHY allow in grace: see migration 065 header for the bootstrap rationale.
    // WHY write audit: SOC 2 CC6.1 requires documenting that a privileged action
    // was performed before the admin completed MFA enrollment.
    await writeGraceAuditEvent(userId, status.graceUntil);
    return;
  }

  // ── MFA satisfied path ───────────────────────────────────────────────────────
  if (status.hasPasskey || status.hasTotp) {
    // Admin has at least one active MFA factor — allow action.
    // WHY either factor is sufficient: both passkeys (FIDO2/WebAuthn) and
    // verified TOTP satisfy NIST SP 800-63B AAL2 for privileged accounts.
    return;
  }

  // ── Blocked path ─────────────────────────────────────────────────────────────
  // Grace expired, no MFA enrolled → block action.
  // WHY Sentry warning (not exception): this is expected behavior after grace
  // expires — it's a policy enforcement event, not an error. Ops should still
  // be aware so they can follow up with the admin. SOC 2 CC6.1.
  Sentry.captureMessage(
    'Admin MFA gate blocked action: no MFA enrolled after grace period expired.',
    {
      level: 'warning',
      tags: {
        component: 'assertAdminMfa',
        reason: 'no_mfa_after_grace',
        user_id: userId,
      },
    }
  );
  throw new AdminMfaRequiredError();
}
