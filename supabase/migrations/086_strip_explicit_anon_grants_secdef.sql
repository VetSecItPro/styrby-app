-- Migration 086: Strip remaining explicit anon EXECUTE grants on SECURITY DEFINER fns.
--
-- WHY this exists alongside 084 + 085:
--   084: REVOKEd from anon (no-op for PUBLIC-granted fns) — closed ~3 fns.
--   085: REVOKEd from PUBLIC + GRANTed to authenticated/service_role —
--        closed 35 of the 70 still-anon-callable fns.
--   086: For the remaining 35 fns, an explicit `GRANT EXECUTE TO anon` from
--        an earlier migration BYPASSES the PUBLIC revoke. Strip those grants
--        directly. authenticated + service_role grants are unaffected.
--
-- After this migration, count of anon-callable SECURITY DEFINER fns in
-- public schema should be 0. Reverify with /db.
--
-- Rollback: see 086_rollback_strip_explicit_anon_grants.sql

REVOKE EXECUTE ON FUNCTION public.accept_team_invitation(p_invitation_id uuid, p_user_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.accept_team_invitation(p_invitation_token text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.acquire_team_invite_lock(team_lock_key bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_consume_support_access(p_token_hash text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_idempotency_check(p_actor_id uuid, p_action text, p_target_user_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_idempotency_check_with_event(p_actor_id uuid, p_action text, p_target_user_id uuid, p_reason text, p_event_id text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_issue_credit(p_target_user_id uuid, p_amount_cents bigint, p_currency text, p_reason text, p_expires_at timestamp with time zone) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_issue_refund(p_target_user_id uuid, p_amount_cents bigint, p_currency text, p_reason text, p_polar_event_id text, p_polar_refund_id text, p_polar_subscription_id text, p_polar_response_json jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_override_tier(p_target_user_id uuid, p_new_tier text, p_expires_at timestamp with time zone, p_reason text, p_ip inet, p_ua text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_pickup_grant_token(p_grant_id bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_record_password_reset(p_target_user_id uuid, p_reason text, p_ip inet, p_ua text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_request_support_access(p_ticket_id uuid, p_user_id uuid, p_session_id uuid, p_reason text, p_expires_in_hours integer, p_token_hash text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_revoke_credit(p_credit_id bigint, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_send_churn_save_offer(p_target_user_id uuid, p_kind churn_offer_kind, p_reason text, p_polar_discount_code text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_stash_grant_token(p_grant_id bigint, p_raw_token text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_toggle_consent(p_target_user_id uuid, p_purpose consent_purpose, p_grant boolean, p_reason text, p_ip inet, p_ua text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.apply_polar_subscription_with_override_check(p_user_id uuid, p_new_tier text, p_polar_subscription_id text, p_billing_cycle text, p_current_period_end timestamp with time zone, p_polar_event_id text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.audit_trigger_fn() FROM anon;
REVOKE EXECUTE ON FUNCTION public.auto_generate_webhook_secret() FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_budget_hard_stop(p_user_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_machine_limit() FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_team_limit() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_sent_offline_commands() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_support_grant_token_pickup() FROM anon;
REVOKE EXECUTE ON FUNCTION public.count_team_members_with_seat_lock(p_team_id uuid, p_team_lock_key bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.decrement_team_active_seats() FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_expired_sessions() FROM anon;
REVOKE EXECUTE ON FUNCTION public.ensure_single_default_context_template() FROM anon;
REVOKE EXECUTE ON FUNCTION public.estimate_notification_rate_for_threshold(p_user_id uuid, p_threshold integer, p_days integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.finalize_orphaned_pending_costs() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_dispatch_due_nps_prompts() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_expire_stale_referrals() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_mark_weekly_digest_batch() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_schedule_nps_prompts() FROM anon;
REVOKE EXECUTE ON FUNCTION public.generate_webhook_secret() FROM anon;

DO $$
DECLARE remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef=true
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF remaining > 0 THEN
    RAISE WARNING 'After 086, % SECURITY DEFINER functions in public are still anon-callable.', remaining;
  END IF;
END $$;
