-- =============================================================================
-- 091: Make is_site_admin NULL-safe + callable by anon
-- =============================================================================
-- Date: 2026-05-07
-- Why: /db audit caught is_site_admin as the second instance of the bug
--      class fixed for is_team_member by migration 090. Same shape:
--
--   Function:
--     SELECT EXISTS(SELECT 1 FROM public.site_admins WHERE user_id = p_user_id)
--
--   ACL: REVOKE'd from anon (per migrations 084-086 hardening),
--        GRANT'd to authenticated + service_role
--
--   Called from 5 RLS USING clauses on:
--     - admin_audit_log         (currently empty — only is_site_admin policy)
--     - billing_credits         (currently empty — has self + admin policies)
--     - churn_save_offers       (currently empty — has self + admin policies)
--     - consent_flags           (currently empty — has self + admin policies)
--     - support_access_grants   (currently empty — has self + admin policies)
--
-- All 5 tables are currently empty so no production user has hit 42501 yet,
-- but the bug fires the moment any of them gets a row:
--   - admin_audit_log gets a row on every admin action
--   - billing_credits gets a row on every credit issued
--   - churn_save_offers gets a row on every churn-save offer made
--   - consent_flags writes on every consent toggle
--   - support_access_grants writes on every customer support session
--
-- Multiple permissive policies in Postgres = OR logic across rows. The
-- planner does NOT short-circuit OR around non-LEAKPROOF functions, same
-- as the AND-clause case (migration 090's lesson). So billing_credits
-- having `*_select_self` alongside `*_select_admin` does NOT save us — the
-- planner still calls is_site_admin during evaluation.
--
-- Same fix shape as migration 090:
-- 1. Wrap function body in NULL-safe CASE so anon's NULL p_user_id
--    returns false instantly without touching site_admins.
-- 2. GRANT EXECUTE TO anon. With the function safe to call, the planner's
--    unconditional evaluation succeeds.
--
-- Security trade-off acknowledged: anon can now call is_site_admin to
-- probe whether a given user_id is a site admin. Same trade-off shape as
-- 090 for is_team_member. Mitigations:
--   - Already exploitable by any authenticated user (function GRANT to
--     authenticated has been unrestricted since the function was created)
--   - Returns only a boolean, never row data
--   - Cannot be used for privilege escalation
--   - Rate-limited via Supabase per-IP API limits
--   - Site admins are a small fixed group; identities aren't secret
-- The "anon learns admin identities" residual is acceptable; the
-- alternative (admin tables 42501-cascading on first row) is broken.
--
-- LEAKPROOF was the originally-better marker but Supabase's managed
-- Postgres rejects: "only superuser can define a leakproof function."
--
-- Audit reference: /db full audit, 2026-05-07 evening, immediately after
-- /sec-ship --comprehensive caught the parallel is_team_member case.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_site_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_user_id IS NULL THEN false
    ELSE EXISTS(
      SELECT 1 FROM public.site_admins WHERE user_id = p_user_id
    )
  END;
$function$;

GRANT EXECUTE ON FUNCTION public.is_site_admin(uuid) TO anon;

COMMENT ON FUNCTION public.is_site_admin(uuid) IS
  'Returns true if p_user_id is a site admin. NULL-safe (returns false '
  'when p_user_id is NULL — covers anon callers where auth.uid() returns '
  'NULL). Callable by anon, authenticated, and service_role. Migration '
  '091 closed a latent 42501 cascade on 5 admin-RLS tables (admin_audit_log, '
  'billing_credits, churn_save_offers, consent_flags, support_access_grants). '
  'Companion fix to migration 090 for is_team_member.';

-- =============================================================================
-- Rollback:
-- =============================================================================
-- CREATE OR REPLACE FUNCTION public.is_site_admin(p_user_id uuid)
-- RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
-- AS $$ SELECT EXISTS(SELECT 1 FROM public.site_admins WHERE user_id = p_user_id); $$;
-- REVOKE EXECUTE ON FUNCTION public.is_site_admin(uuid) FROM anon;
