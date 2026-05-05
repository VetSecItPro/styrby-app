-- ============================================================================
-- Migration 074: security_invoker on cost views (WAVE-F-RLS-002)
-- ============================================================================
-- Postgres 15 introduced the WITH (security_invoker = true) view option.
-- Without it, views run with the *creator's* privileges (typically the
-- migration role / postgres superuser), which bypasses RLS on the underlying
-- tables. Both of the following views happen to be safe today by other
-- means:
--
--   * v_my_daily_costs (migration 016) — filters by auth.uid() inside the
--     SELECT, so even with creator privs the WHERE clause restricts rows
--     to the current user.
--
--   * v_team_cost_projection (migration 033) — only queryable by
--     service_role per the route layer (browser never SELECTs it directly).
--
-- They are nevertheless flagged by Supabase's RLS linter as defense-in-depth
-- gaps: a future change to either view (e.g. relaxing the auth.uid() filter,
-- or accidentally granting browser SELECT) would silently bypass RLS. The
-- security_invoker flag closes that gap permanently — the view runs with
-- the caller's privileges, so RLS on the underlying cost_records and
-- mv_team_cost_summary tables is enforced regardless of how the view is
-- invoked.
--
-- ALTER VIEW … SET is idempotent and safe to re-run.
-- ============================================================================

ALTER VIEW public.v_my_daily_costs        SET (security_invoker = true);
ALTER VIEW public.v_team_cost_projection  SET (security_invoker = true);
