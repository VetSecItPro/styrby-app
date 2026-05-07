-- =============================================================================
-- 089: Short-circuit team_members_select_member for anon callers
-- =============================================================================
-- Date: 2026-05-07
-- Why: Companion fix to migration 088. The same shape of bug exists on the
--      `team_members` table:
--
--   Current USING:  is_team_member(team_id, ( SELECT auth.uid() AS uid))
--
-- For an authenticated caller this works. For anon (where auth.uid()=NULL),
-- Postgres calls is_team_member(team_id, NULL) — but is_team_member is
-- REVOKE'd from anon (per migrations 084-086 hardening), so the call raises
-- 42501 "permission denied for function is_team_member" and the entire
-- query fails. The intended security semantics for anon are "see zero
-- rows" — what we get instead is "query errors out."
--
-- This bug is currently latent — no logged-in user was hitting team_members
-- before today's P12 walkthrough. But it bites the moment any anon-pathed
-- request hits team_members (e.g., a JWT expires mid-request, a deep-link
-- entry, etc.). We caught the same shape on `sessions` today and fixed it
-- in 088; this migration applies the equivalent guard here.
--
-- Fix: add `auth.uid() IS NOT NULL` short-circuit before the is_team_member
-- call. Same security semantics (anon sees zero rows), no spurious 42501.
--
-- Risk: very low. Authenticated callers unaffected (auth.uid() non-null
-- adds a redundant true). Anon callers continue to see zero rows; only the
-- failure mode changes from "query errors" to "query returns empty."
--
-- Audit reference: this migration was discovered by a static sweep of all
-- public-schema RLS policies whose USING clauses reference is_team_member
-- / is_team_admin / has_team_role (the SECURITY DEFINER class hardened in
-- 084-086). Sessions and team_members were the only two with this shape;
-- both are now guarded.
-- =============================================================================

ALTER POLICY team_members_select_member ON public.team_members
  USING (
    (auth.uid() IS NOT NULL)
    AND is_team_member(team_id, (SELECT auth.uid()))
  );

COMMENT ON POLICY team_members_select_member ON public.team_members IS
  'Authenticated users see team_members rows for teams they belong to. '
  'Short-circuits to deny-all for anon callers so the is_team_member() '
  'call does not raise 42501 (REVOKE per migration 084-086).';

-- =============================================================================
-- Rollback:
-- =============================================================================
-- ALTER POLICY team_members_select_member ON public.team_members
--   USING (is_team_member(team_id, ( SELECT auth.uid() AS uid)));
