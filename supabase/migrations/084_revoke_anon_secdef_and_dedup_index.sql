-- Migration 084: REVOKE EXECUTE on SECURITY DEFINER functions from anon + drop duplicate notifications index.
--
-- WHY (REVOKE pass):
--   Supabase advisors flagged 38 SECURITY DEFINER functions as anon-callable
--   (`anon_security_definer_function_executable` WARN). In Postgres, every
--   function in `public` schema gets an implicit `EXECUTE TO public` grant,
--   which includes the `anon` role. SECURITY DEFINER functions then run with
--   the function-owner's privileges regardless of the caller — so any
--   anon-callable SECURITY DEFINER function is a candidate authorization-
--   bypass primitive.
--
--   Audit (2026-05-05) verified that NONE of these 39 functions have a
--   legitimate anon call path:
--     - Every RPC call site (`grep -rn "\.rpc('<name>'"` across packages/)
--       uses either an authenticated JWT client OR service-role client
--       (`createApiAdminClient()`). Service role bypasses grant checks.
--     - No RLS policy expression references any of these functions
--       (`pg_policy WHERE polqual ILIKE '%<name>%'` returned 0 rows).
--     - Trigger functions fire from table-level INSERT/UPDATE/DELETE
--       context; the table-level grants are the actual gate, not function
--       EXECUTE.
--
--   So this is pure defense-in-depth: REVOKE EXECUTE FROM anon for all 39
--   functions. Authenticated callers and service-role callers continue to
--   work unchanged. Anon callers (which there shouldn't be any) get a clear
--   42501 permission denied instead of silently executing privileged code.
--
-- WHY (index dedup):
--   `idx_notifications_unread` and `idx_notifications_user_created` are
--   byte-identical: both `CREATE INDEX ... ON notifications USING btree
--   (user_id, created_at DESC) WHERE (read_at IS NULL)`. Postgres maintains
--   both on every INSERT/UPDATE/DELETE for zero benefit. Drop the
--   less-self-documenting one (`_user_created`) and keep
--   `idx_notifications_unread` because the name reflects the partial-index
--   intent.
--
-- Rollback: see 084_rollback_revoke_anon_secdef_and_dedup_index.sql

-- ============================================================================
-- PART 1: REVOKE EXECUTE FROM anon for SECURITY DEFINER functions
-- ============================================================================

-- Admin-tier RPCs (caller MUST already be a site admin to invoke meaningfully)
REVOKE EXECUTE ON FUNCTION public.search_users_by_email_for_admin(p_query text, p_limit integer, p_offset integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.resolve_user_emails_for_admin(p_user_ids uuid[]) FROM anon;
REVOKE EXECUTE ON FUNCTION public.verify_admin_audit_chain() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_accounts_pending_hard_delete() FROM anon;

-- User-tier RPCs (callable only by an authenticated user with their own JWT)
REVOKE EXECUTE ON FUNCTION public.get_daily_spending(p_user_id uuid, p_days integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_notification_suppression_rate(p_user_id uuid, p_days integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_spending_by_agent(p_user_id uuid, p_days integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_user_spending(p_user_id uuid, p_period text, p_agent_type agent_type) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_team_cost_by_agent(p_team_id uuid, p_start_date date, p_end_date date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_team_cost_summary_v2(p_team_id uuid, p_start_date date, p_end_date date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_team_members(p_team_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_user_teams() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_team_sso_policy(p_user_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_site_admin(p_user_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_team_member(_team_id uuid, _user_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.lookup_api_key(p_prefix text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.revoke_api_key(p_key_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_api_key_usage(p_key_id uuid, p_ip_address inet) FROM anon;
REVOKE EXECUTE ON FUNCTION public.user_accept_churn_save_offer(p_offer_id bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.user_approve_support_access(p_grant_id bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.user_revoke_support_access(p_grant_id bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.seed_default_context_templates(p_user_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.insert_session_message(p_session_id uuid, p_message_type text, p_content_encrypted text, p_encryption_nonce text, p_parent_message_id uuid, p_permission_granted boolean, p_metadata jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.queue_webhook_delivery(p_user_id uuid, p_event webhook_event, p_payload jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.trigger_budget_exceeded_webhook(p_user_id uuid, p_alert_id uuid, p_alert_name text, p_current_spend numeric, p_threshold numeric, p_period text, p_action text) FROM anon;

-- Trigger functions (fire from table-level INSERT/UPDATE/DELETE; not externally callable)
REVOKE EXECUTE ON FUNCTION public.handle_new_team() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_context_templates() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_push_for_message() FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_session_message_count() FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_session_cost_on_finalize() FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_agent_context_memory_updated_at() FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_agent_session_groups_updated_at() FROM anon;
REVOKE EXECUTE ON FUNCTION public.trigger_session_completed_webhook() FROM anon;
REVOKE EXECUTE ON FUNCTION public.trigger_session_started_webhook() FROM anon;
REVOKE EXECUTE ON FUNCTION public.trigger_permission_requested_webhook() FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_webhook_delivery_stats() FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_session_costs() FROM anon;
REVOKE EXECUTE ON FUNCTION public.invoke_summary_generation() FROM anon;
REVOKE EXECUTE ON FUNCTION public.refresh_daily_cost_summary() FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_team_active_seats() FROM anon;

-- ============================================================================
-- PART 2: Drop duplicate index on notifications
-- ============================================================================

-- idx_notifications_unread (KEEP) and idx_notifications_user_created (DROP)
-- are byte-identical:
--   CREATE INDEX ... ON notifications USING btree (user_id, created_at DESC)
--   WHERE (read_at IS NULL)
-- idx_notifications_user_all is a SEPARATE non-partial index — keep that too.
DROP INDEX IF EXISTS public.idx_notifications_user_created;

-- ============================================================================
-- POST-MIGRATION VALIDATION
-- ============================================================================

DO $$
DECLARE
  remaining_anon_callable INTEGER;
  notifications_dup_dropped INTEGER;
BEGIN
  -- Count remaining anon-callable SECURITY DEFINER fns in public.
  -- Should be 0 after this migration (all 39 listed above were revoked).
  SELECT COUNT(*) INTO remaining_anon_callable
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef = true
    AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF remaining_anon_callable > 0 THEN
    RAISE WARNING 'REVOKE pass left % SECURITY DEFINER functions still anon-executable (expected 0). Inspect: SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=''public'' AND p.prosecdef=true AND has_function_privilege(''anon'', p.oid, ''EXECUTE'');', remaining_anon_callable;
  END IF;

  -- Verify duplicate index dropped.
  SELECT COUNT(*) INTO notifications_dup_dropped
  FROM pg_indexes
  WHERE schemaname='public'
    AND tablename='notifications'
    AND indexname='idx_notifications_user_created';

  IF notifications_dup_dropped > 0 THEN
    RAISE EXCEPTION 'Index drop failed: idx_notifications_user_created still present';
  END IF;
END $$;
