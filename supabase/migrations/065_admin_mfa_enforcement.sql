-- ============================================================================
-- Migration 065: Admin MFA Enforcement (H42 Layer 1)
-- ============================================================================
-- Date:    2026-04-28
-- Author:  Claude Code (claude-sonnet-4-6)
-- Branch:  feat/mfa-admin-enforcement-h42
--
-- Security references:
--   OWASP A07:2021  - Identification and Authentication Failures
--   SOC 2 CC6.1     - Logical access controls; privileged access requires
--                     phishing-resistant authentication factors
--   NIST SP 800-63B AAL2 - Multi-factor authentication for privileged accounts
--
-- Summary:
--   Adds `mfa_grace_until` column to `site_admins` with a configurable grace
--   window so existing admins are not immediately locked out. After the grace
--   period expires, `assertAdminMfa()` (application layer) enforces that the
--   admin has at least one active passkey OR a Supabase Auth TOTP factor.
--
--   The grace period is purely a migration affordance - it is NOT a persistent
--   feature. The STYRBY_ADMIN_MFA_GRACE_DAYS environment variable controls the
--   window (default 7 days). Once all admins have enrolled MFA the column
--   becomes permanently in the past and the grace branch is never taken.
--
-- WHY NOT enforce in Postgres:
--   MFA factor queries require the `auth.mfa_factors` / Supabase Admin API.
--   Calling the Admin API from inside a Postgres SECURITY DEFINER function is
--   not supported without pg_net and introduces a network dependency on every
--   admin RPC call. Enforcement in the application layer (assertAdminMfa) is
--   faster, testable, and does not block the Postgres execution path.
--
-- Rollback:
--   ALTER TABLE public.site_admins DROP COLUMN IF EXISTS mfa_grace_until;
-- ============================================================================

-- Add mfa_grace_until column
ALTER TABLE public.site_admins
  ADD COLUMN IF NOT EXISTS mfa_grace_until TIMESTAMPTZ;

-- WHY backfill existing rows with 7-day grace: Any admin already in the table
-- before this migration has no MFA enrolled (there was no requirement). A hard
-- cutover (NULL = blocked immediately) would lock them out of the admin console.
-- The 7-day window matches the default STYRBY_ADMIN_MFA_GRACE_DAYS value, giving
-- them time to enroll before the gate activates. SOC 2 CC6.1: documented
-- exception with a defined remediation deadline.
UPDATE public.site_admins
  SET mfa_grace_until = now() + INTERVAL '7 days'
  WHERE mfa_grace_until IS NULL;

-- Column documentation
COMMENT ON COLUMN public.site_admins.mfa_grace_until IS
  'Migration-only grace window for MFA enrollment. NULL = no grace (new admins '
  'added after the MFA policy is enforced). Non-null = admin was present before '
  'H42 and has until this timestamp to enroll a passkey or TOTP factor. After '
  'this timestamp, assertAdminMfa() rejects admin actions with ADMIN_MFA_REQUIRED '
  'unless a factor is enrolled. OWASP A07:2021 / SOC 2 CC6.1.';
