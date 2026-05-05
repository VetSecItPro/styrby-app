-- Rollback for 086: re-add explicit GRANT EXECUTE TO anon for the 35 fns
-- whose explicit anon grants were stripped. Effective ONLY if 085's
-- PUBLIC grant has also been restored (otherwise the function will already
-- be unreachable to anon via PUBLIC).
-- WARNING: this rollback re-opens the anon-callable surface.
GRANT EXECUTE ON FUNCTION public.accept_team_invitation(p_invitation_id uuid, p_user_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.accept_team_invitation(p_invitation_token text) TO anon;
GRANT EXECUTE ON FUNCTION public.acquire_team_invite_lock(team_lock_key bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_consume_support_access(p_token_hash text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_idempotency_check(p_actor_id uuid, p_action text, p_target_user_id uuid, p_reason text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_idempotency_check_with_event(p_actor_id uuid, p_action text, p_target_user_id uuid, p_reason text, p_event_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_issue_credit(p_target_user_id uuid, p_amount_cents bigint, p_currency text, p_reason text, p_expires_at timestamp with time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_issue_refund(p_target_user_id uuid, p_amount_cents bigint, p_currency text, p_reason text, p_polar_event_id text, p_polar_refund_id text, p_polar_subscription_id text, p_polar_response_json jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_override_tier(p_target_user_id uuid, p_new_tier text, p_expires_at timestamp with time zone, p_reason text, p_ip inet, p_ua text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_pickup_grant_token(p_grant_id bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_record_password_reset(p_target_user_id uuid, p_reason text, p_ip inet, p_ua text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_request_support_access(p_ticket_id uuid, p_user_id uuid, p_session_id uuid, p_reason text, p_expires_in_hours integer, p_token_hash text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_credit(p_credit_id bigint, p_reason text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_send_churn_save_offer(p_target_user_id uuid, p_kind churn_offer_kind, p_reason text, p_polar_discount_code text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_stash_grant_token(p_grant_id bigint, p_raw_token text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_toggle_consent(p_target_user_id uuid, p_purpose consent_purpose, p_grant boolean, p_reason text, p_ip inet, p_ua text) TO anon;
GRANT EXECUTE ON FUNCTION public.apply_polar_subscription_with_override_check(p_user_id uuid, p_new_tier text, p_polar_subscription_id text, p_billing_cycle text, p_current_period_end timestamp with time zone, p_polar_event_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.audit_trigger_fn() TO anon;
GRANT EXECUTE ON FUNCTION public.auto_generate_webhook_secret() TO anon;
GRANT EXECUTE ON FUNCTION public.check_budget_hard_stop(p_user_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.check_machine_limit() TO anon;
GRANT EXECUTE ON FUNCTION public.check_team_limit() TO anon;
GRANT EXECUTE ON FUNCTION public.cleanup_old_sent_offline_commands() TO anon;
GRANT EXECUTE ON FUNCTION public.cleanup_support_grant_token_pickup() TO anon;
GRANT EXECUTE ON FUNCTION public.count_team_members_with_seat_lock(p_team_id uuid, p_team_lock_key bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.decrement_team_active_seats() TO anon;
GRANT EXECUTE ON FUNCTION public.delete_expired_sessions() TO anon;
GRANT EXECUTE ON FUNCTION public.ensure_single_default_context_template() TO anon;
GRANT EXECUTE ON FUNCTION public.estimate_notification_rate_for_threshold(p_user_id uuid, p_threshold integer, p_days integer) TO anon;
GRANT EXECUTE ON FUNCTION public.finalize_orphaned_pending_costs() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_dispatch_due_nps_prompts() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_expire_stale_referrals() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_mark_weekly_digest_batch() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_schedule_nps_prompts() TO anon;
GRANT EXECUTE ON FUNCTION public.generate_webhook_secret() TO anon;
