-- ============================================================================
-- Migration 019: Fix notify_push_for_message edge function URL resolution
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS:
--   Migration 017 resolved the edge function URL via
--     current_setting('app.supabase_url', TRUE)
--   which requires the GUC to be set via ALTER DATABASE postgres SET app.*.
--   Supabase managed Postgres denies that ALTER (error 42501 — permission
--   denied to set parameter) because the role lacks superuser. Result: the
--   trigger runs, finds v_edge_fn_url = '/functions/v1/send-push-notification'
--   (no prefix), hits the guard on line 216, and every push is silently
--   skipped with a WARNING.
--
-- THE FIX:
--   Hardcode the project's edge function URL. The project ref is stable for
--   the lifetime of the Supabase project; it cannot change. If the project
--   is ever migrated, this URL is updated in a follow-up migration — that is
--   a one-line audit-traceable change, exactly what we want.
--
-- Governing standards:
--   SOC2 CC7.2 (system operations) — push delivery must actually execute
--   to meet the "user is notified of agent activity" control claim.
-- ============================================================================

CREATE OR REPLACE FUNCTION notify_push_for_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id       UUID;
  v_push_enabled  BOOLEAN;
  v_event_type    TEXT;
  v_edge_fn_url   TEXT;
  v_service_key   TEXT;
  v_payload       JSONB;
  v_agent_type    TEXT;
BEGIN
  IF NEW.message_type NOT IN ('agent_response', 'permission_request') THEN
    RETURN NEW;
  END IF;

  SELECT s.user_id, s.agent_type
    INTO v_user_id, v_agent_type
    FROM sessions s
   WHERE s.id = NEW.session_id;

  IF v_user_id IS NULL THEN
    RAISE WARNING '[notify_push_for_message] Session % not found for message %', NEW.session_id, NEW.id;
    RETURN NEW;
  END IF;

  SELECT COALESCE(np.push_enabled, TRUE)
    INTO v_push_enabled
    FROM notification_preferences np
   WHERE np.user_id = v_user_id;

  IF v_push_enabled = FALSE THEN
    RETURN NEW;
  END IF;

  v_event_type := CASE NEW.message_type
    WHEN 'agent_response'     THEN 'session_completed'
    WHEN 'permission_request' THEN 'permission_request'
    ELSE 'session_completed'
  END;

  v_payload := jsonb_build_object(
    'type',   v_event_type,
    'userId', v_user_id::TEXT,
    'data',   jsonb_build_object(
      'sessionId', NEW.session_id::TEXT,
      'agentType', v_agent_type,
      'riskLevel', COALESCE(NEW.risk_level::TEXT, 'low'),
      'toolName',  NEW.tool_name
    )
  );

  BEGIN
    SELECT decrypted_secret
      INTO v_service_key
      FROM vault.decrypted_secrets
     WHERE name = 'supabase_functions_api_key'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[notify_push_for_message] vault.decrypted_secrets not accessible: %', SQLERRM;
    RETURN NEW;
  END;

  IF v_service_key IS NULL THEN
    RAISE WARNING '[notify_push_for_message] Secret "supabase_functions_api_key" not found in vault. Push skipped.';
    RETURN NEW;
  END IF;

  -- WHY hardcoded URL: See migration header. Supabase managed Postgres denies
  -- ALTER DATABASE ... SET app.supabase_url, so current_setting() always
  -- returned NULL/empty. Project ref akmtmxunjhsgldjztdtt is stable for the
  -- lifetime of the project.
  v_edge_fn_url := 'https://akmtmxunjhsgldjztdtt.supabase.co/functions/v1/send-push-notification';

  PERFORM net.http_post(
    url     := v_edge_fn_url,
    body    := v_payload::TEXT,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    )
  );

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_push_for_message] Unexpected error for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION notify_push_for_message() IS
  'Fires after INSERT on session_messages for agent_response and '
  'permission_request rows. Calls the send-push-notification edge function '
  'via pg_net (async HTTP) to deliver push notifications to the session owner. '
  'Edge function URL hardcoded (see migration 019) because Supabase managed '
  'Postgres denies ALTER DATABASE ... SET app.supabase_url. '
  'Respects push_enabled master switch from notification_preferences. '
  'Quiet hours and per-type prefs enforced by the edge function. '
  'Governing standards: SOC2 CC7.2 (push delivery logging), GDPR Art. 25 '
  '(privacy by design — preference enforcement at source).';

-- ============================================================================
-- END OF MIGRATION 019
-- ============================================================================
--
-- POST-DEPLOY VERIFICATION:
--
-- 1. Confirm the function body was replaced:
--      SELECT pg_get_functiondef('notify_push_for_message'::regproc);
--    Expected: contains 'https://akmtmxunjhsgldjztdtt.supabase.co/functions/v1/send-push-notification'
--
-- 2. Confirm vault secret is seeded (must be done ONCE, outside migrations):
--      SELECT name FROM vault.decrypted_secrets WHERE name = 'supabase_functions_api_key';
--    Expected: one row.
--
-- 3. Send a test agent_response message through the CLI and tail
--    the pg_net response table:
--      SELECT id, status_code, error_msg, created
--        FROM net._http_response
--       ORDER BY created DESC LIMIT 5;
--    Expected: status_code 200 from the edge function.
-- ============================================================================
