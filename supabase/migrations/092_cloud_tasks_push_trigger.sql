-- ============================================================================
-- Migration 092: Push notification trigger on cloud_tasks terminal transitions
-- ============================================================================
--
-- WHY this trigger exists:
--   The Power-tier "Cloud Monitoring" feature (per docstring on
--   packages/styrby-mobile/src/components/CloudTasks.tsx) promises live status
--   for long-running cloud agent tasks. PR-1 of #97 wired the screen to
--   Supabase Realtime so logged-in mobile users see status flips live; PR-2
--   added the dispatcher. This migration closes the loop by sending a push
--   notification when a task reaches a terminal state, so the user gets
--   notified even when the app is backgrounded.
--
--   The relay infrastructure (CLI side) updates cloud_tasks.status when a
--   task finishes. This trigger fires on those UPDATEs, calls the existing
--   send-push-notification edge function via pg_net, and the function
--   delivers via Expo Push (handling rate limits, quiet hours, per-type
--   prefs, invalid-token deactivation).
--
-- Pattern reuse:
--   This is a near-clone of migration 019's notify_push_for_message trigger
--   on session_messages, applied to cloud_tasks. The pg_net plumbing,
--   vault.decrypted_secrets lookup, hardcoded edge function URL (per 019's
--   header — Supabase managed Postgres denies ALTER DATABASE ... SET
--   app.supabase_url), and EXCEPTION-WHEN-OTHERS error handling all match.
--
-- Event type mapping:
--   cloud_tasks.status='completed' -> send-push-notification 'cloud_task_completed'
--   cloud_tasks.status='failed'    -> send-push-notification 'cloud_task_failed'
--   cloud_tasks.status='cancelled' -> NO push (user-initiated; they already know)
--
-- Preference reuse (no schema change):
--   - cloud_task_completed reuses push_session_complete (semantically same:
--     "agent finished a job"; same opt-in default = false)
--   - cloud_task_failed reuses push_session_errors (semantically same: agent
--     failure; default = true)
--   See send-push-notification/index.ts isTypeAllowed() switch for the wiring.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS notify_push_for_cloud_task ON public.cloud_tasks;
--   DROP FUNCTION IF EXISTS public.notify_push_for_cloud_task();
--
-- Risk class: SAFE — additive only (new trigger + new function, both with
-- robust EXCEPTION-WHEN-OTHERS so any pg_net hiccup degrades to a WARNING
-- and the cloud_tasks UPDATE itself proceeds).
-- ============================================================================

-- pg_net is already enabled (migration 017), so we don't re-create the extension.

-- ============================================================================
-- §1. Trigger function
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_push_for_cloud_task()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_event_type    TEXT;
  v_payload       JSONB;
  v_service_key   TEXT;
  v_edge_fn_url   TEXT;
BEGIN
  -- Only fire on terminal transitions FROM a non-terminal state. This prevents
  -- duplicate pushes if a downstream system writes status='completed' twice
  -- (idempotent UPDATEs are common in retry paths).
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Map terminal states to push event types. cancelled is a deliberate
  -- skip — the user issued the cancel from the UI, so re-notifying them is
  -- noise. Non-terminal transitions (queued -> running) also skip; we only
  -- push when the agent has stopped.
  v_event_type := CASE NEW.status
    WHEN 'completed' THEN 'cloud_task_completed'
    WHEN 'failed'    THEN 'cloud_task_failed'
    ELSE NULL
  END;

  IF v_event_type IS NULL THEN
    RETURN NEW;
  END IF;

  -- Build the edge function payload. Mirrors the shape send-push-notification
  -- expects (type/userId/data) and includes enough metadata for the mobile
  -- notification template to render a useful body without a follow-up DB hit.
  v_payload := jsonb_build_object(
    'type',   v_event_type,
    'userId', NEW.user_id::TEXT,
    'data',   jsonb_build_object(
      'taskId',    NEW.id::TEXT,
      'agentType', NEW.agent_type,
      'sessionId', NEW.session_id::TEXT,
      'costUsd',   NEW.cost_usd,
      -- Include first 80 chars of prompt so the body can preview it. The
      -- function defaults to a generic message if this is missing.
      'prompt',    LEFT(COALESCE(NEW.prompt, ''), 80)
    )
  );

  -- Look up the service role key from vault.decrypted_secrets. Same pattern
  -- as migration 019. If the secret is missing, log a warning and proceed —
  -- the cloud_tasks UPDATE shouldn't fail because of a push delivery issue.
  BEGIN
    SELECT decrypted_secret
      INTO v_service_key
      FROM vault.decrypted_secrets
     WHERE name = 'supabase_functions_api_key'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[notify_push_for_cloud_task] vault.decrypted_secrets not accessible: %', SQLERRM;
    RETURN NEW;
  END;

  IF v_service_key IS NULL THEN
    RAISE WARNING '[notify_push_for_cloud_task] Secret "supabase_functions_api_key" not found in vault. Push skipped for task %.', NEW.id;
    RETURN NEW;
  END IF;

  -- WHY hardcoded URL: See migration 019's header. Supabase managed Postgres
  -- denies ALTER DATABASE ... SET app.supabase_url, so current_setting()
  -- returned NULL/empty in earlier attempts. Project ref akmtmxunjhsgldjztdtt
  -- is stable for the lifetime of the project.
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
  -- Final safety net: any unexpected failure in the trigger logs a warning
  -- but does NOT abort the cloud_tasks UPDATE. A failed push is better than
  -- a failed status update — the realtime subscription still delivers the
  -- new status to any open mobile/web client.
  RAISE WARNING '[notify_push_for_cloud_task] Unexpected error for task %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_push_for_cloud_task() IS
  'Fires after UPDATE on cloud_tasks when status transitions to a terminal '
  'state (completed, failed). Calls send-push-notification edge function via '
  'pg_net to deliver a push to the task owner. cancelled status skips the '
  'push because the user issued the cancel themselves. Push delivery '
  'failures are logged as WARNINGs and never abort the UPDATE. '
  'Companion to migration 019 (sessions_messages push trigger).';

-- ============================================================================
-- §2. Trigger registration
-- ============================================================================

DROP TRIGGER IF EXISTS notify_push_for_cloud_task ON public.cloud_tasks;

CREATE TRIGGER notify_push_for_cloud_task
  AFTER UPDATE OF status ON public.cloud_tasks
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.notify_push_for_cloud_task();

COMMENT ON TRIGGER notify_push_for_cloud_task ON public.cloud_tasks IS
  'Sends a push to the task owner when cloud_tasks.status transitions. '
  'Filtered to UPDATE OF status with WHEN clause so unrelated column updates '
  '(e.g. updated_at, cost_usd) do not invoke the edge function unnecessarily.';

-- ============================================================================
-- POST-DEPLOY VERIFICATION
-- ============================================================================
--
-- 1. Confirm the trigger function exists:
--    SELECT proname FROM pg_proc WHERE proname = 'notify_push_for_cloud_task';
--    Expected: 1 row.
--
-- 2. Confirm the trigger is registered:
--    SELECT tgname, tgrelid::regclass
--      FROM pg_trigger
--     WHERE tgname = 'notify_push_for_cloud_task';
--    Expected: 1 row, tgrelid = public.cloud_tasks
--
-- 3. End-to-end smoke test (requires a real cloud_tasks row + device_token):
--    -- Insert a queued task as a test user, then transition status:
--    UPDATE public.cloud_tasks SET status = 'completed' WHERE id = '<task-id>';
--    -- Within ~5 seconds, expect a push notification on the device.
--    -- If no push arrives, check:
--    --   * supabase_functions_api_key exists in vault.decrypted_secrets
--    --   * notification_preferences.push_session_complete = true for the user
--    --   * device_tokens has an active row for the user
--    --   * pg_net._http_response shows a 200 from the edge function
--
-- 4. Rollback:
--    DROP TRIGGER IF EXISTS notify_push_for_cloud_task ON public.cloud_tasks;
--    DROP FUNCTION IF EXISTS public.notify_push_for_cloud_task();
-- ============================================================================
