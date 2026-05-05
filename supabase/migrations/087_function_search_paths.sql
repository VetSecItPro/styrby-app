-- Migration 087: SET search_path on 17 project-owned functions.
--
-- WHY: Supabase advisor `function_search_path_mutable` (WARN) flags any
-- function without an explicit `SET search_path` clause. The risk class:
-- SECURITY DEFINER functions (or functions called from elevated contexts)
-- inherit the caller's search_path at execute time. A malicious user with
-- CREATE privilege in any schema on the search_path can shadow built-in
-- functions/operators (e.g. define a malicious `=(text,text)` operator)
-- and hijack the function's behavior. Pinning `search_path = public, pg_temp`
-- removes the variable.
--
-- Filter: only project-owned functions (NOT extension-owned). Extension
-- functions like `gin_*`, `gtrgm_*`, `similarity*`, `set_limit`, `show_*`
-- come from `pg_trgm` and cannot be ALTERed by us.
--
-- Functions covered (17):
--   _is_billable_tier, check_lockout_status, decrement_team_active_seats,
--   fn_dispatch_due_nps_prompts, fn_expire_stale_referrals,
--   fn_mark_weekly_digest_batch, fn_referral_events_set_expires_at,
--   fn_referral_events_updated_at, fn_schedule_nps_prompts,
--   fn_team_invitations_seat_delta, increment_team_active_seats,
--   notify_push_for_message, record_login_failure, reset_login_failures,
--   resolve_session_retention_days, update_support_ticket_timestamp,
--   user_lockout_set_updated_at
--
-- No behavior change. The functions all reference public-schema objects;
-- pinning the path to `public, pg_temp` matches what was implicit before.
-- pg_temp is included so temp-table operations inside the function still
-- resolve correctly.
--
-- Rollback: see supabase/rollbacks/087_rollback_function_search_paths.sql

ALTER FUNCTION public._is_billable_tier(t text) SET search_path = public, pg_temp;
ALTER FUNCTION public.check_lockout_status(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.decrement_team_active_seats() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_dispatch_due_nps_prompts() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_expire_stale_referrals() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_mark_weekly_digest_batch() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_referral_events_set_expires_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_referral_events_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_schedule_nps_prompts() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_team_invitations_seat_delta() SET search_path = public, pg_temp;
ALTER FUNCTION public.increment_team_active_seats() SET search_path = public, pg_temp;
ALTER FUNCTION public.notify_push_for_message() SET search_path = public, pg_temp;
ALTER FUNCTION public.record_login_failure(p_user_id uuid, p_window_seconds integer, p_max_failures integer, p_lockout_seconds integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.reset_login_failures(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.resolve_session_retention_days(p_session_retention_override text, p_profile_retention_days smallint) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_support_ticket_timestamp() SET search_path = public, pg_temp;
ALTER FUNCTION public.user_lockout_set_updated_at() SET search_path = public, pg_temp;

-- ============================================================================
-- POST-MIGRATION VALIDATION
-- ============================================================================

DO $$
DECLARE
  remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (p.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(p.proconfig) AS c WHERE c LIKE 'search_path=%'
    ))
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');

  IF remaining > 0 THEN
    RAISE WARNING 'After 087, % project-owned functions still have mutable search_path.', remaining;
  END IF;
END $$;
