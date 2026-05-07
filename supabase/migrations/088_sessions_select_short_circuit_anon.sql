-- =============================================================================
-- 088: Short-circuit sessions_select_own_or_team for anon callers
-- =============================================================================
-- Date: 2026-05-07
-- Why: Migration 084-086 hardened the SECURITY DEFINER class by REVOKEing
--      EXECUTE on is_team_member() from anon. The RLS policy
--      `sessions_select_own_or_team` USING clause looks like:
--
--        (deleted_at IS NULL)
--        AND ( (user_id = auth.uid())
--              OR (team_id IS NOT NULL AND is_team_member(team_id, auth.uid())) )
--
-- For an authenticated caller the policy works as intended. But when the
-- caller's JWT is missing/expired/invalid, PostgREST runs the request as
-- `anon`. `auth.uid()` returns NULL. `user_id = NULL` evaluates to NULL
-- (not false), so the OR proceeds to call `is_team_member(team_id, NULL)`.
-- Because anon was REVOKE'd from is_team_member, Postgres raises
-- 42501 "permission denied for function is_team_member" and the WHOLE
-- query fails — including for rows the OR-left branch would have allowed.
--
-- Symptoms in the wild: the mobile dashboard's ActivityGraph blasts a red
-- console error on first launch / after token expiry, even though the
-- correct behaviour is "anon sees zero sessions" (which is also what the
-- existing security model intends).
--
-- Fix: add an explicit `auth.uid() IS NOT NULL` guard so the policy
-- short-circuits to false for anon callers without ever invoking the
-- REVOKE'd function. Same security semantics (anon still sees zero
-- sessions), no spurious 42501.
--
-- Risk: very low. Authenticated callers are unaffected — auth.uid() is
-- non-null for them, so the new clause adds a redundant true. Anon
-- callers continue to see zero rows; only the failure mode changes from
-- "query errors" to "query returns empty result set" (which is what
-- they'd have gotten anyway after the function call).
--
-- Rollback: see bottom of file (commented).
-- =============================================================================

ALTER POLICY sessions_select_own_or_team ON public.sessions
  USING (
    (deleted_at IS NULL)
    AND (auth.uid() IS NOT NULL)
    AND (
      (user_id = (SELECT auth.uid()))
      OR (team_id IS NOT NULL AND is_team_member(team_id, (SELECT auth.uid())))
    )
  );

COMMENT ON POLICY sessions_select_own_or_team ON public.sessions IS
  'Authenticated users see their own sessions plus team sessions where '
  'they are a member. Short-circuits to deny-all for anon callers so the '
  'is_team_member() call does not raise 42501 (REVOKE per migration 084-086).';

-- =============================================================================
-- Rollback (if ever needed):
-- =============================================================================
-- ALTER POLICY sessions_select_own_or_team ON public.sessions
--   USING (
--     (deleted_at IS NULL)
--     AND (
--       (user_id = (SELECT auth.uid()))
--       OR (team_id IS NOT NULL AND is_team_member(team_id, (SELECT auth.uid())))
--     )
--   );
