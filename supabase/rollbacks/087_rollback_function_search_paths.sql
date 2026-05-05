-- Rollback for 087: reset search_path on the 17 functions back to empty
-- (which means "inherit from caller", the prior state).
-- WARNING: rolling back re-opens the search-path-hijack class of finding
-- on these functions. Only use if a verified incompatibility surfaces.

ALTER FUNCTION public._is_billable_tier(t text) RESET search_path;
ALTER FUNCTION public.check_lockout_status(p_user_id uuid) RESET search_path;
ALTER FUNCTION public.decrement_team_active_seats() RESET search_path;
ALTER FUNCTION public.fn_dispatch_due_nps_prompts() RESET search_path;
ALTER FUNCTION public.fn_expire_stale_referrals() RESET search_path;
ALTER FUNCTION public.fn_mark_weekly_digest_batch() RESET search_path;
ALTER FUNCTION public.fn_referral_events_set_expires_at() RESET search_path;
ALTER FUNCTION public.fn_referral_events_updated_at() RESET search_path;
ALTER FUNCTION public.fn_schedule_nps_prompts() RESET search_path;
ALTER FUNCTION public.fn_team_invitations_seat_delta() RESET search_path;
ALTER FUNCTION public.increment_team_active_seats() RESET search_path;
ALTER FUNCTION public.notify_push_for_message() RESET search_path;
ALTER FUNCTION public.record_login_failure(p_user_id uuid, p_window_seconds integer, p_max_failures integer, p_lockout_seconds integer) RESET search_path;
ALTER FUNCTION public.reset_login_failures(p_user_id uuid) RESET search_path;
ALTER FUNCTION public.resolve_session_retention_days(p_session_retention_override text, p_profile_retention_days smallint) RESET search_path;
ALTER FUNCTION public.update_support_ticket_timestamp() RESET search_path;
ALTER FUNCTION public.user_lockout_set_updated_at() RESET search_path;
