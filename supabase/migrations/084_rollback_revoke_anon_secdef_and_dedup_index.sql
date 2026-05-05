-- Rollback for 084_revoke_anon_secdef_and_dedup_index.sql
--
-- Restores the implicit `EXECUTE TO public` (which includes anon) for the 39
-- SECURITY DEFINER functions, and recreates the duplicate notifications index.
--
-- WARNING: rolling back the REVOKE pass re-opens the anon-callable surface.
-- Only use this if a verified pre-auth call path is discovered for one of
-- the listed functions.
--
-- WARNING: recreating idx_notifications_user_created reintroduces the
-- duplicate-index write cost.

-- ============================================================================
-- PART 1: GRANT EXECUTE back to anon
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.search_users_by_email_for_admin(p_query text, p_limit integer, p_offset integer) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_user_emails_for_admin(p_user_ids uuid[]) TO anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_audit_chain() TO anon;
GRANT EXECUTE ON FUNCTION public.get_accounts_pending_hard_delete() TO anon;
GRANT EXECUTE ON FUNCTION public.get_daily_spending(p_user_id uuid, p_days integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_notification_suppression_rate(p_user_id uuid, p_days integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_spending_by_agent(p_user_id uuid, p_days integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_user_spending(p_user_id uuid, p_period text, p_agent_type agent_type) TO anon;
GRANT EXECUTE ON FUNCTION public.get_team_cost_by_agent(p_team_id uuid, p_start_date date, p_end_date date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_team_cost_summary_v2(p_team_id uuid, p_start_date date, p_end_date date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_team_members(p_team_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_user_teams() TO anon;
GRANT EXECUTE ON FUNCTION public.get_team_sso_policy(p_user_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.is_site_admin(p_user_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.is_team_member(_team_id uuid, _user_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.lookup_api_key(p_prefix text) TO anon;
GRANT EXECUTE ON FUNCTION public.revoke_api_key(p_key_id uuid, p_reason text) TO anon;
GRANT EXECUTE ON FUNCTION public.update_api_key_usage(p_key_id uuid, p_ip_address inet) TO anon;
GRANT EXECUTE ON FUNCTION public.user_accept_churn_save_offer(p_offer_id bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.user_approve_support_access(p_grant_id bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.user_revoke_support_access(p_grant_id bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.seed_default_context_templates(p_user_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.insert_session_message(p_session_id uuid, p_message_type text, p_content_encrypted text, p_encryption_nonce text, p_parent_message_id uuid, p_permission_granted boolean, p_metadata jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.queue_webhook_delivery(p_user_id uuid, p_event webhook_event, p_payload jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.trigger_budget_exceeded_webhook(p_user_id uuid, p_alert_id uuid, p_alert_name text, p_current_spend numeric, p_threshold numeric, p_period text, p_action text) TO anon;
GRANT EXECUTE ON FUNCTION public.handle_new_team() TO anon;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO anon;
GRANT EXECUTE ON FUNCTION public.handle_new_user_context_templates() TO anon;
GRANT EXECUTE ON FUNCTION public.notify_push_for_message() TO anon;
GRANT EXECUTE ON FUNCTION public.update_session_message_count() TO anon;
GRANT EXECUTE ON FUNCTION public.update_session_cost_on_finalize() TO anon;
GRANT EXECUTE ON FUNCTION public.set_agent_context_memory_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.set_agent_session_groups_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.trigger_session_completed_webhook() TO anon;
GRANT EXECUTE ON FUNCTION public.trigger_session_started_webhook() TO anon;
GRANT EXECUTE ON FUNCTION public.trigger_permission_requested_webhook() TO anon;
GRANT EXECUTE ON FUNCTION public.update_webhook_delivery_stats() TO anon;
GRANT EXECUTE ON FUNCTION public.update_session_costs() TO anon;
GRANT EXECUTE ON FUNCTION public.invoke_summary_generation() TO anon;
GRANT EXECUTE ON FUNCTION public.refresh_daily_cost_summary() TO anon;
GRANT EXECUTE ON FUNCTION public.increment_team_active_seats() TO anon;

-- ============================================================================
-- PART 2: Recreate the duplicate notifications index
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications USING btree (user_id, created_at DESC)
  WHERE (read_at IS NULL);
