-- ============================================================================
-- STYRBY DATABASE MIGRATION: Session Summaries -> On-Demand Only
-- ============================================================================
-- Phase: shift summary generation from "auto-fired on session-end" to
-- "user-initiated only". The auto-fire trigger from migration 003
-- (tr_session_summary_generation -> invoke_summary_generation) was a no-op
-- in production because OPENAI_API_KEY was never set as a Supabase secret,
-- and product direction has since moved away from auto-summaries (cost
-- control + user-controlled latency + clearer Pro tier value-prop via the
-- explicit "Generate summary" button).
--
-- This migration:
--   1. DROPS the AFTER UPDATE trigger so terminal session-status changes
--      no longer call pg_net to invoke the Edge Function.
--   2. KEEPS the invoke_summary_generation() function in case any other
--      code path (cron, admin tool, future re-enablement) still calls it.
--      Dropping the function would be a breaking change for those callers
--      with no functional benefit; an unused function costs nothing.
--   3. Updates the column comment on sessions.summary_generated_at to
--      record the new on-demand contract.
--
-- Rollback: re-create the trigger from 003_session_summaries.sql (the
-- WHEN clause + EXECUTE FUNCTION definition is unchanged).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Drop the auto-fire trigger
-- ----------------------------------------------------------------------------
-- WHY DROP TRIGGER (not DISABLE): a disabled trigger is still part of the
-- schema and can be silently re-enabled by a stray ALTER TABLE; an explicit
-- DROP makes the intent unambiguous in pg_dump output and code review.

DROP TRIGGER IF EXISTS tr_session_summary_generation ON sessions;


-- ----------------------------------------------------------------------------
-- 2. Update column comment to reflect the new contract
-- ----------------------------------------------------------------------------
-- The column itself is unchanged; only the operational meaning shifts:
-- previously it was set automatically when a session ended; now it is set
-- only when the user explicitly clicks "Generate summary" in the UI (which
-- POSTs to /api/v1/sessions/[id]/summary and invokes the Edge Function).

COMMENT ON COLUMN sessions.summary_generated_at IS
  'When the AI-generated summary was created. NULL means no summary exists yet. '
  'As of migration 077 (2026-05) summaries are generated on-demand only — they '
  'are NOT auto-created on session completion. The user triggers generation via '
  'POST /api/v1/sessions/[id]/summary which invokes the generate-summary Edge '
  'Function. Pro+ tier required.';


-- ----------------------------------------------------------------------------
-- 3. NOTE on retained artifacts
-- ----------------------------------------------------------------------------
-- The following objects from migration 003 are intentionally retained:
--   - FUNCTION invoke_summary_generation()   (no callers, kept for rollback)
--   - INDEX idx_sessions_pending_summary     (still useful for batch reports)
--   - GRANT EXECUTE ... TO service_role      (no-op without callers)
-- Removing them is a separate cleanup pass once we are confident the on-demand
-- model is permanent.


-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
