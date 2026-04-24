-- ============================================================================
-- Migration 046: Fix L1 (Latent) + Fix Z (Zombie) — two cleanup items from
-- the Phase 4.1 final integration review.
-- ============================================================================

-- ============================================================================
-- §1  Fix L1 — Restore EXECUTE on is_site_admin to authenticated
-- ============================================================================
--
-- Problem: Migration 042 (deprecate_profiles_is_admin) revoked EXECUTE on
--   public.is_site_admin(uuid) FROM authenticated on the theory that only
--   service-role callers existed at the time. That assumption held briefly,
--   but Phase 4.1 T6's server actions now call admin_* RPCs from a user-scoped
--   Supabase client (Fix P0) so that auth.uid() resolves inside the SECURITY
--   DEFINER function body. Those RPCs internally call is_site_admin(auth.uid())
--   — which requires the authenticated role to have EXECUTE on the function.
--
--   Additionally, the audit_select_site_admin RLS policy on admin_audit_log
--   (created in migration 040) calls is_site_admin() during SELECT evaluation
--   when a user-scoped client reads that table. The same EXECUTE requirement
--   applies there.
--
--   Without this grant, every admin mutation RPC and every audit-log query
--   issued from a user-scoped client will fail with:
--     ERROR 42501: permission denied for function is_site_admin
--
-- WHY the enumeration-probe concern (earlier T3.5 threat review) is acceptable:
--   is_site_admin returns a boolean only — no metadata is exposed. The DB-layer
--   least-privilege win from revoking EXECUTE was illusory because the caller
--   can always invoke the wrapping admin_* RPCs and observe 42501 vs success
--   as a side-channel — the same enumeration surface already existed. Returning
--   the EXECUTE grant does not increase the attack surface.
--
-- WHY REVOKE-then-GRANT (idempotent pattern):
--   Clears any partial state from prior runs before asserting the desired grant.
--   Safe to run multiple times without unintended side effects.
--
-- Governing standards:
--   SOC2 CC6.1 (least privilege): enumeration surface is bounded to a boolean
--     and matches the existing attack surface via the admin_* RPCs themselves.
--   OWASP ASVS V4.1.3 (role-based access): authenticated role correctly granted
--     EXECUTE on the authorization helper function it calls at runtime.
--   NIST SP 800-53 AC-6 (least privilege): authenticated and service_role only;
--     PUBLIC is intentionally excluded.

REVOKE EXECUTE ON FUNCTION public.is_site_admin(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.is_site_admin(uuid) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.is_site_admin(uuid) TO service_role;

-- ============================================================================
-- §2  Fix Z — Drop orphaned lock_and_read_subscription_override
-- ============================================================================
--
-- Problem: Migration 044 created lock_and_read_subscription_override(uuid).
--   Migration 045 replaced the entire override-expiry flow with the atomic
--   apply_polar_subscription_with_override_check() function before either
--   function reached production. lock_and_read_subscription_override was never
--   called in any production code path and has no callers in the codebase.
--
-- WHY drop it now:
--   Dead functions in public schema are an attack surface — they can be called
--   via direct DB access or future typos in application code. Removing orphaned
--   code reduces the schema footprint and avoids future confusion about which
--   function is the live one. SOC2 CC6.1 (minimal attack surface).
--
-- WHY IF EXISTS: safe to run against instances where 044 was not deployed or
--   where the function was already dropped manually. Idempotent migration.
--
-- OWASP ASVS V1.1.6 (software architecture): dead code must not accumulate
--   in production database schemas. NIST SP 800-53 CM-7 (least functionality).

DROP FUNCTION IF EXISTS public.lock_and_read_subscription_override(uuid);
