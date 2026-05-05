-- Migration 085: Tighten anon-callable SECURITY DEFINER functions (correct pattern).
--
-- WHY this exists in addition to 084:
--   Migration 084 attempted `REVOKE EXECUTE FROM anon` on 39 SECURITY DEFINER
--   functions. Discovery during verification (2026-05-05): the REVOKE was a
--   no-op for any function whose grant came via PUBLIC (the default for
--   public-schema functions), because `REVOKE FROM anon` does NOT remove
--   inherited PUBLIC grants. Only the ~3 functions with explicit anon grants
--   were actually tightened by 084.
--
--   This migration uses the canonical Postgres pattern:
--     REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC;
--     GRANT  EXECUTE ON FUNCTION ... TO authenticated, service_role;
--
--   Net effect: anon loses EXECUTE; authenticated + service_role keep it.
--   No application-level call site is affected — every RPC is invoked from
--   either an authenticated JWT client (uses authenticated role) or via
--   `createApiAdminClient()` (uses service_role).
--
-- Auditor verification of safety (2026-05-05):
--   - All 69 functions surveyed; every call site uses authenticated or service_role
--   - No RLS policy expression references any of these functions (pg_policy scan)
--   - Trigger functions fire from table-context — table-level grants gate
--
-- Backwards compatibility: 084's REVOKE-FROM-anon statements are still valid
--   (they removed any explicit anon grants that bypassed PUBLIC). 085 is
--   complementary, not a replacement. Both stay in the migration tree.
--
-- Rollback: see 085_rollback_tighten_anon_secdef.sql

-- ============================================================================
-- REVOKE FROM PUBLIC + GRANT TO authenticated, service_role
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.accept_team_invitation(p_invitation_token text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.accept_team_invitation(p_invitation_token text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.accept_team_invitation(p_invitation_id uuid, p_user_id uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.accept_team_invitation(p_invitation_id uuid, p_user_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.acquire_team_invite_lock(team_lock_key bigint) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.acquire_team_invite_lock(team_lock_key bigint) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_consume_support_access(p_token_hash text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_consume_support_access(p_token_hash text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_idempotency_check(p_actor_id uuid, p_action text, p_target_user_id uuid, p_reason text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_idempotency_check(p_actor_id uuid, p_action text, p_target_user_id uuid, p_reason text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_idempotency_check_with_event(p_actor_id uuid, p_action text, p_target_user_id uuid, p_reason text, p_event_id text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_idempotency_check_with_event(p_actor_id uuid, p_action text, p_target_user_id uuid, p_reason text, p_event_id text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_issue_credit(p_target_user_id uuid, p_amount_cents bigint, p_currency text, p_reason text, p_expires_at timestamp with time zone) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_issue_credit(p_target_user_id uuid, p_amount_cents bigint, p_currency text, p_reason text, p_expires_at timestamp with time zone) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_issue_refund(p_target_user_id uuid, p_amount_cents bigint, p_currency text, p_reason text, p_polar_event_id text, p_polar_refund_id text, p_polar_subscription_id text, p_polar_response_json jsonb) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_issue_refund(p_target_user_id uuid, p_amount_cents bigint, p_currency text, p_reason text, p_polar_event_id text, p_polar_refund_id text, p_polar_subscription_id text, p_polar_response_json jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_override_tier(p_target_user_id uuid, p_new_tier text, p_expires_at timestamp with time zone, p_reason text, p_ip inet, p_ua text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_override_tier(p_target_user_id uuid, p_new_tier text, p_expires_at timestamp with time zone, p_reason text, p_ip inet, p_ua text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_pickup_grant_token(p_grant_id bigint) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_pickup_grant_token(p_grant_id bigint) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_record_password_reset(p_target_user_id uuid, p_reason text, p_ip inet, p_ua text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_record_password_reset(p_target_user_id uuid, p_reason text, p_ip inet, p_ua text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_request_support_access(p_ticket_id uuid, p_user_id uuid, p_session_id uuid, p_reason text, p_expires_in_hours integer, p_token_hash text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_request_support_access(p_ticket_id uuid, p_user_id uuid, p_session_id uuid, p_reason text, p_expires_in_hours integer, p_token_hash text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_revoke_credit(p_credit_id bigint, p_reason text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_revoke_credit(p_credit_id bigint, p_reason text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_send_churn_save_offer(p_target_user_id uuid, p_kind churn_offer_kind, p_reason text, p_polar_discount_code text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_send_churn_save_offer(p_target_user_id uuid, p_kind churn_offer_kind, p_reason text, p_polar_discount_code text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_stash_grant_token(p_grant_id bigint, p_raw_token text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_stash_grant_token(p_grant_id bigint, p_raw_token text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_toggle_consent(p_target_user_id uuid, p_purpose consent_purpose, p_grant boolean, p_reason text, p_ip inet, p_ua text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.admin_toggle_consent(p_target_user_id uuid, p_purpose consent_purpose, p_grant boolean, p_reason text, p_ip inet, p_ua text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.apply_polar_subscription_with_override_check(p_user_id uuid, p_new_tier text, p_polar_subscription_id text, p_billing_cycle text, p_current_period_end timestamp with time zone, p_polar_event_id text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.apply_polar_subscription_with_override_check(p_user_id uuid, p_new_tier text, p_polar_subscription_id text, p_billing_cycle text, p_current_period_end timestamp with time zone, p_polar_event_id text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.audit_trigger_fn() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.audit_trigger_fn() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.auto_generate_webhook_secret() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.auto_generate_webhook_secret() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.auto_sso_enroll(p_user_id uuid, p_team_id uuid, p_hd_claim text, p_user_email text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.auto_sso_enroll(p_user_id uuid, p_team_id uuid, p_hd_claim text, p_user_email text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_budget_hard_stop(p_user_id uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.check_budget_hard_stop(p_user_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_machine_limit() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.check_machine_limit() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_team_limit() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.check_team_limit() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_sent_offline_commands() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.cleanup_old_sent_offline_commands() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.cleanup_support_grant_token_pickup() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.cleanup_support_grant_token_pickup() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.count_team_members_with_seat_lock(p_team_id uuid, p_team_lock_key bigint) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.count_team_members_with_seat_lock(p_team_id uuid, p_team_lock_key bigint) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.decrement_team_active_seats() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.decrement_team_active_seats() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.delete_expired_sessions() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.delete_expired_sessions() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.ensure_single_default_context_template() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.ensure_single_default_context_template() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.estimate_notification_rate_for_threshold(p_user_id uuid, p_threshold integer, p_days integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.estimate_notification_rate_for_threshold(p_user_id uuid, p_threshold integer, p_days integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.finalize_orphaned_pending_costs() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.finalize_orphaned_pending_costs() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_dispatch_due_nps_prompts() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_dispatch_due_nps_prompts() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_expire_stale_referrals() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_expire_stale_referrals() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_mark_weekly_digest_batch() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_mark_weekly_digest_batch() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_schedule_nps_prompts() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_schedule_nps_prompts() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.generate_webhook_secret() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.generate_webhook_secret() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_accounts_pending_hard_delete() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_accounts_pending_hard_delete() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_daily_spending(p_user_id uuid, p_days integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_daily_spending(p_user_id uuid, p_days integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_notification_suppression_rate(p_user_id uuid, p_days integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_notification_suppression_rate(p_user_id uuid, p_days integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_spending_by_agent(p_user_id uuid, p_days integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_spending_by_agent(p_user_id uuid, p_days integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_team_cost_by_agent(p_team_id uuid, p_start_date date, p_end_date date) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_team_cost_by_agent(p_team_id uuid, p_start_date date, p_end_date date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_team_cost_summary_v2(p_team_id uuid, p_start_date date, p_end_date date) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_team_cost_summary_v2(p_team_id uuid, p_start_date date, p_end_date date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_team_members(p_team_id uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_team_members(p_team_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_team_sso_policy(p_user_id uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_team_sso_policy(p_user_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_user_spending(p_user_id uuid, p_period text, p_agent_type agent_type) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_user_spending(p_user_id uuid, p_period text, p_agent_type agent_type) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_user_teams() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.get_user_teams() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.handle_new_team() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.handle_new_team() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_context_templates() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.handle_new_user_context_templates() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.increment_team_active_seats() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.increment_team_active_seats() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.insert_session_message(p_session_id uuid, p_message_type text, p_content_encrypted text, p_encryption_nonce text, p_parent_message_id uuid, p_permission_granted boolean, p_metadata jsonb) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.insert_session_message(p_session_id uuid, p_message_type text, p_content_encrypted text, p_encryption_nonce text, p_parent_message_id uuid, p_permission_granted boolean, p_metadata jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.invoke_summary_generation() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.invoke_summary_generation() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_team_member(_team_id uuid, _user_id uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.is_team_member(_team_id uuid, _user_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.notify_push_for_message() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.notify_push_for_message() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.queue_webhook_delivery(p_user_id uuid, p_event webhook_event, p_payload jsonb) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.queue_webhook_delivery(p_user_id uuid, p_event webhook_event, p_payload jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.refresh_daily_cost_summary() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.refresh_daily_cost_summary() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.revoke_api_key(p_key_id uuid, p_reason text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.revoke_api_key(p_key_id uuid, p_reason text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.seed_default_context_templates(p_user_id uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.seed_default_context_templates(p_user_id uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.set_agent_context_memory_updated_at() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.set_agent_context_memory_updated_at() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.set_agent_session_groups_updated_at() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.set_agent_session_groups_updated_at() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.trigger_budget_exceeded_webhook(p_user_id uuid, p_alert_id uuid, p_alert_name text, p_current_spend numeric, p_threshold numeric, p_period text, p_action text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.trigger_budget_exceeded_webhook(p_user_id uuid, p_alert_id uuid, p_alert_name text, p_current_spend numeric, p_threshold numeric, p_period text, p_action text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.trigger_permission_requested_webhook() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.trigger_permission_requested_webhook() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.trigger_session_completed_webhook() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.trigger_session_completed_webhook() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.trigger_session_started_webhook() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.trigger_session_started_webhook() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_api_key_usage(p_key_id uuid, p_ip_address inet) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.update_api_key_usage(p_key_id uuid, p_ip_address inet) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_session_cost_on_finalize() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.update_session_cost_on_finalize() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_session_costs() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.update_session_costs() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_session_message_count() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.update_session_message_count() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_webhook_delivery_stats() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.update_webhook_delivery_stats() TO authenticated, service_role;

-- ============================================================================
-- POST-MIGRATION VALIDATION
-- ============================================================================

DO $$
DECLARE
  remaining_anon_callable INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining_anon_callable
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef = true
    AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF remaining_anon_callable > 0 THEN
    RAISE WARNING 'After 085, % SECURITY DEFINER functions in public are still anon-callable. Possible new functions added since enumeration. Run /db drift to inspect.', remaining_anon_callable;
  END IF;
END $$;
