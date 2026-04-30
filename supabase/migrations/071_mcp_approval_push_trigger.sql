-- ============================================================================
-- MIGRATION 071: Push Notification Trigger for MCP Approval Requests
-- ============================================================================
--
-- PURPOSE:
--   Closes the D-02 loop. Migration 069 added the mcp_approval_* audit_action
--   enum values; CLI Phase 4-step4 (PR #234) wires `styrby mcp serve` to
--   INSERT audit_log rows with action='mcp_approval_requested'; the mobile
--   D-02 build added the receiver-side screen, push-routing, and decision
--   writer. The missing piece is the trigger that actually fires a push
--   notification when the CLI inserts a request — without this, the entire
--   feature is dark (mobile is ready but never wakes up).
--
--   Migration 017 only fires on session_messages. This migration adds an
--   analogous trigger on audit_log scoped to mcp_approval_requested rows.
--
-- WHAT THIS ADDS:
--   1. Helper function: notify_push_for_mcp_approval()
--      - Reads audit_log row's user_id and metadata
--      - Checks notification_preferences.push_enabled
--      - Calls send-push-notification edge function via pg_net
--      - Payload matches the mobile receiver's NotificationDataSchema
--        (data.screen='mcp_approval', data.approvalId=<resource_id>,
--         data.action='mcp_approval')
--
--   2. Trigger: trigger_push_on_mcp_approval_request
--      - AFTER INSERT on audit_log
--      - WHEN action = 'mcp_approval_requested' (Postgres pre-evaluates
--        the WHEN clause before invoking the function — saves a function
--        call on every other audit_log INSERT)
--
-- WHY ONLY mcp_approval_requested (not _decided or _timeout):
--   - mcp_approval_decided is written BY the mobile app (the user's response).
--     Pushing to the same user about their own action is noise.
--   - mcp_approval_timeout is written by the CLI when no response arrives.
--     The user already saw the request and chose to ignore it; another
--     push is nagging.
--
-- WHY THIS WAS MISSED:
--   D-02 spec said "verify the trigger exists; if not, propose a migration
--   update". The implementer agent confirmed migration 017 was scoped to
--   session_messages only and surfaced the gap. This migration ships in the
--   same PR as the D-02 mobile build so the feature is functional end-to-end
--   on first deploy.
--
-- DEPENDENCIES:
--   - Migration 017 (sets up vault secret + app.supabase_url + pg_net)
--   - Migration 069 (mcp_approval_* enum values)
--   - send-push-notification edge function deployed
--   - audit_log table has user_id column (yes — initial schema)
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trigger_push_on_mcp_approval_request ON audit_log;
--   DROP FUNCTION IF EXISTS notify_push_for_mcp_approval();
--
-- SOC2 / GDPR:
--   - Quiet hours + push_enabled enforced at edge function level (same as 017)
--   - SECURITY DEFINER so RLS on notification_preferences doesn't block lookup
--   - Errors are caught and logged; a failed push never rolls back the audit
--     row — the audit log is the source-of-truth, push is delivery polish.
--
-- ============================================================================

-- ============================================================================
-- STEP 1: Trigger function
-- ============================================================================

CREATE OR REPLACE FUNCTION notify_push_for_mcp_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
-- WHY SECURITY DEFINER: same rationale as notify_push_for_message in
-- migration 017 — the trigger function reads notification_preferences
-- (RLS-locked) to decide whether to fire, and reads vault.decrypted_secrets
-- for the service role key. SECURITY DEFINER runs as the function owner
-- (postgres / supabase admin), bypassing RLS on the lookup tables. The
-- function never returns sensitive data to the trigger caller.
AS $$
DECLARE
  v_user_id        UUID;
  v_push_enabled   BOOLEAN;
  v_edge_fn_url    TEXT;
  v_service_key    TEXT;
  v_payload        JSONB;
  v_approval_id    TEXT;
  v_requested_action TEXT;
  v_risk           TEXT;
  v_machine_id     TEXT;
BEGIN
  -- ──────────────────────────────────────────────────────────────────────────
  -- Defensive guard. The trigger's WHEN clause already filters to
  -- action='mcp_approval_requested' but a future change could mistakenly
  -- attach this function to other actions. Re-check inside the body.
  -- ──────────────────────────────────────────────────────────────────────────
  IF NEW.action <> 'mcp_approval_requested' THEN
    RETURN NEW;
  END IF;

  -- ──────────────────────────────────────────────────────────────────────────
  -- Resolve the receiving user. audit_log.user_id is the session owner
  -- (same user who initiated the CLI command that needed approval).
  -- ──────────────────────────────────────────────────────────────────────────
  v_user_id := NEW.user_id;
  IF v_user_id IS NULL THEN
    RAISE WARNING '[notify_push_for_mcp_approval] audit_log row % has null user_id; skip.', NEW.id;
    RETURN NEW;
  END IF;

  -- ──────────────────────────────────────────────────────────────────────────
  -- Fast-path: skip immediately if push is disabled. Same pattern as
  -- migration 017. Default TRUE when no row exists (new user).
  -- ──────────────────────────────────────────────────────────────────────────
  SELECT COALESCE(np.push_enabled, TRUE)
    INTO v_push_enabled
    FROM notification_preferences np
   WHERE np.user_id = v_user_id;

  IF v_push_enabled = FALSE THEN
    RETURN NEW;
  END IF;

  -- ──────────────────────────────────────────────────────────────────────────
  -- Pull the metadata fields we expose to the receiver. The mobile
  -- screen reads metadata directly via supabase fetch — these are only
  -- for the push payload preview (notification title/body).
  --
  -- WHY ::TEXT casts: jsonb_build_object on NULL JSONB values produces SQL
  -- NULL, not the JSON null literal. Casting to TEXT first ensures a
  -- consistent string-or-null shape on the receiver side.
  -- ──────────────────────────────────────────────────────────────────────────
  v_approval_id      := NEW.resource_id::TEXT;
  v_requested_action := COALESCE(NEW.metadata->>'requested_action', '');
  v_risk             := COALESCE(NEW.metadata->>'risk', 'medium');
  v_machine_id       := COALESCE(NEW.metadata->>'machine_id', '');

  -- ──────────────────────────────────────────────────────────────────────────
  -- Build payload matching the mobile NotificationDataSchema in
  -- packages/styrby-mobile/src/hooks/useNotifications.ts. The mobile
  -- receiver routes off `screen` (preferred) or `data.action` (fallback).
  -- approvalId is the load-bearing routing key for the deep-link.
  -- ──────────────────────────────────────────────────────────────────────────
  v_payload := jsonb_build_object(
    'type',   'mcp_approval',
    'userId', v_user_id::TEXT,
    'data',   jsonb_build_object(
      -- Preferred routing field — directly matches NotificationScreen union.
      'screen',          'mcp_approval',
      -- Fallback type-based routing flag for older mobile builds that don't
      -- understand the screen field. Removable once min mobile version
      -- includes the screen-based router.
      'action',          'mcp_approval',
      -- Load-bearing — the screen needs this to fetch the audit_log row.
      'approvalId',      v_approval_id,
      -- Preview hints for the notification title/body. The mobile screen
      -- re-fetches the row, so these are display-only.
      'requestedAction', v_requested_action,
      'risk',            v_risk,
      'machineId',       v_machine_id
    )
  );

  -- ──────────────────────────────────────────────────────────────────────────
  -- Resolve edge function URL + service role key from vault.
  -- Identical pattern to migration 017 — see that migration's comment for
  -- the full rationale.
  -- ──────────────────────────────────────────────────────────────────────────
  BEGIN
    SELECT decrypted_secret
      INTO v_service_key
      FROM vault.decrypted_secrets
     WHERE name = 'supabase_functions_api_key'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[notify_push_for_mcp_approval] vault.decrypted_secrets not accessible: %', SQLERRM;
    RETURN NEW;
  END;

  IF v_service_key IS NULL THEN
    RAISE WARNING '[notify_push_for_mcp_approval] Secret "supabase_functions_api_key" not found in vault. Push skipped.';
    RETURN NEW;
  END IF;

  v_edge_fn_url := current_setting('app.supabase_url', TRUE)
                   || '/functions/v1/send-push-notification';

  IF v_edge_fn_url IS NULL OR v_edge_fn_url = '/functions/v1/send-push-notification' THEN
    RAISE WARNING '[notify_push_for_mcp_approval] app.supabase_url not set. Push skipped for approval %.', v_approval_id;
    RETURN NEW;
  END IF;

  -- ──────────────────────────────────────────────────────────────────────────
  -- Fire async HTTP request via pg_net. Same async-fire-and-forget pattern
  -- as migration 017. A failed push must never roll back the audit_log row.
  -- ──────────────────────────────────────────────────────────────────────────
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
  -- WHY catch-all: same rationale as 017. The audit_log INSERT is the primary
  -- data; the push is a delivery side-effect. Any failure here gets logged
  -- and we let the INSERT proceed.
  RAISE WARNING '[notify_push_for_mcp_approval] Unexpected error for audit row %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- STEP 2: Attach trigger to audit_log
-- ============================================================================

DROP TRIGGER IF EXISTS trigger_push_on_mcp_approval_request ON audit_log;

CREATE TRIGGER trigger_push_on_mcp_approval_request
  AFTER INSERT ON audit_log
  FOR EACH ROW
  -- WHY WHEN clause: audit_log handles many action types (settings_updated,
  -- session_group_created, etc.). The WHEN gate ensures Postgres only
  -- evaluates the function for the one action that should fire a push.
  -- This is a hot path — every CLI write to audit_log evaluates the WHEN —
  -- so the cheap pre-filter matters.
  WHEN (NEW.action = 'mcp_approval_requested')
  EXECUTE FUNCTION notify_push_for_mcp_approval();

-- ============================================================================
-- STEP 3: Comment on function for schema discoverability
-- ============================================================================

COMMENT ON FUNCTION notify_push_for_mcp_approval() IS
  'Fires after INSERT on audit_log when action=mcp_approval_requested. '
  'Calls the send-push-notification edge function via pg_net (async HTTP) '
  'with a payload that the mobile NotificationDataSchema routes to '
  '/mcp-approval/[approvalId]. Closes the D-02 loop (PR opened 2026-04-30). '
  'Mirrors migration 017''s pattern for session_messages.';

-- ============================================================================
-- END OF MIGRATION 071
-- ============================================================================
--
-- PRE-DEPLOY CHECK (do once per environment if migration 017 hasn't been run):
--
--   1. SELECT * FROM vault.decrypted_secrets WHERE name = 'supabase_functions_api_key';
--      Must return exactly one row.
--
--   2. SHOW app.supabase_url;
--      Must return the project URL (e.g. https://akmtmxunjhsgldjztdtt.supabase.co).
--
--   If either is missing, follow the post-deploy steps in migration 017
--   before relying on this trigger.
--
-- POST-DEPLOY VERIFICATION:
--
--   1. From the CLI, kick off `styrby mcp serve` and trigger an approval-
--      requiring tool call.
--   2. Watch SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;
--      The most recent row should be a 200 from the edge function.
--   3. Mobile device should receive a push within ~2 seconds with screen
--      data routing to /mcp-approval/<approvalId>.
--
-- ============================================================================
