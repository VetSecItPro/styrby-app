-- ============================================================================
-- STYRBY DATABASE MIGRATION: Session Summaries
-- ============================================================================
-- Adds AI-generated session summaries feature.
--
-- This migration:
-- 1. Adds summary columns to the sessions table
-- 2. Creates a function to invoke the summary Edge Function via pg_net
-- 3. Adds a trigger to auto-generate summaries when sessions complete
--
-- Summary generation flow:
-- 1. Session status changes to 'stopped' or 'expired'
-- 2. Trigger fires and calls the generate-summary Edge Function via pg_net
-- 3. Edge Function fetches messages, calls OpenAI, stores summary
-- 4. summary and summary_generated_at columns are updated
--
-- Feature access:
-- - Summaries are only generated for Pro and Power tier users
-- - Free tier users see an upgrade prompt instead of the summary
-- ============================================================================


-- ============================================================================
-- ENABLE PG_NET EXTENSION
-- ============================================================================
-- pg_net allows database triggers to make HTTP requests to Edge Functions.
-- This is used to invoke the summary generation function asynchronously.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;


-- ============================================================================
-- ADD SUMMARY COLUMNS TO SESSIONS TABLE
-- ============================================================================
-- Note: The sessions table already has a summary column (see 001_initial_schema.sql)
-- so we only need to add the summary_generated_at timestamp column.

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS summary_generated_at TIMESTAMPTZ;

-- Add comment explaining the column purpose
COMMENT ON COLUMN sessions.summary_generated_at IS
  'When the AI-generated summary was created. NULL means no summary exists yet.';


-- ============================================================================
-- FUNCTION: Invoke Summary Generation Edge Function
-- ============================================================================
-- Called by the trigger when a session completes. Uses pg_net to make an
-- async HTTP request to the generate-summary Edge Function.
--
-- WHY pg_net: We don't want to block the session status update while waiting
-- for the AI to generate a summary. pg_net sends the request asynchronously
-- and returns immediately. The Edge Function handles the actual generation.
--
-- WHY check tier: Summary generation costs API tokens. We only generate
-- summaries for paying users to control costs.

CREATE OR REPLACE FUNCTION invoke_summary_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_tier TEXT;
  v_supabase_url TEXT;
  v_service_role_key TEXT;
BEGIN
  -- Only trigger on status change to terminal states
  IF NEW.status NOT IN ('stopped', 'expired') THEN
    RETURN NEW;
  END IF;

  -- Skip if status didn't actually change
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Skip if summary already exists (avoid duplicate generation)
  IF NEW.summary IS NOT NULL AND NEW.summary_generated_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Check user's subscription tier (only Pro and Power get summaries)
  SELECT COALESCE(s.tier, 'free') INTO v_user_tier
  FROM subscriptions s
  WHERE s.user_id = NEW.user_id;

  -- Default to 'free' if no subscription record exists
  IF v_user_tier IS NULL THEN
    v_user_tier := 'free';
  END IF;

  -- Skip summary generation for free tier users
  IF v_user_tier = 'free' THEN
    RETURN NEW;
  END IF;

  -- Get Edge Function URL components from environment
  -- WHY: Supabase Edge Functions are accessed via the project URL
  v_supabase_url := current_setting('app.settings.supabase_url', true);
  v_service_role_key := current_setting('app.settings.service_role_key', true);

  -- If settings not configured, log and skip
  IF v_supabase_url IS NULL OR v_service_role_key IS NULL THEN
    RAISE WARNING 'Summary generation skipped: app.settings.supabase_url or app.settings.service_role_key not configured';
    RETURN NEW;
  END IF;

  -- Invoke the Edge Function asynchronously via pg_net
  -- WHY async: Don't block the transaction. The Edge Function will update
  -- the session row when the summary is ready.
  PERFORM extensions.http_post(
    url := v_supabase_url || '/functions/v1/generate-summary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_role_key
    ),
    body := jsonb_build_object(
      'session_id', NEW.id,
      'user_id', NEW.user_id
    )
  );

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log the error but don't fail the transaction
    -- WHY: Summary generation is non-critical. We don't want a pg_net error
    -- to prevent users from completing their sessions.
    RAISE WARNING 'Summary generation failed: %', SQLERRM;
    RETURN NEW;
END;
$$;


-- ============================================================================
-- TRIGGER: Auto-generate summary on session completion
-- ============================================================================
-- Fires AFTER UPDATE because we need the final session state and don't want
-- to block the status update if summary generation fails.

CREATE TRIGGER tr_session_summary_generation
  AFTER UPDATE OF status ON sessions
  FOR EACH ROW
  WHEN (NEW.status IN ('stopped', 'expired') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION invoke_summary_generation();


-- ============================================================================
-- INDEX: Sessions needing summary generation
-- ============================================================================
-- Used by batch jobs that might retry failed summary generations.
-- Partial index only includes completed sessions without summaries.

CREATE INDEX IF NOT EXISTS idx_sessions_pending_summary
  ON sessions(user_id, updated_at DESC)
  WHERE status IN ('stopped', 'expired')
    AND summary IS NULL
    AND deleted_at IS NULL;


-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT EXECUTE ON FUNCTION invoke_summary_generation() TO service_role;


-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
