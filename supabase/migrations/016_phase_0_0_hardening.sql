-- ============================================================================
-- Migration 016: Phase 0.0 Baseline Security Hardening
-- ============================================================================
-- Date:    2026-04-19
-- Author:  Claude Code (claude-sonnet-4-6)
-- Branch:  phase-0-0/baseline-health-audit
--
-- Issue refs:
--   Phase 0.0 DB audit — 5 findings addressed in this migration.
--
-- Audit standards cited:
--   SOC2 CC6.1  — Logical access controls / least privilege
--   SOC2 CC6.7  — Transmission / access path integrity
--   SOC2 CC7.2  — Monitoring of system components
--   NIST 800-53 SI-10  — Input validation / search-path injection hardening
--   OWASP ASVS 4.0 V3.5 — Sensitive data access controls
--
-- Summary of fixes:
--   Fix 1  mv_daily_cost_summary data leak — RLS wrapper view v_my_daily_costs
--   Fix 2  audit_action enum missing 'notification_sent'
--   Fix 3  Trigger functions missing SET search_path = public (3 functions)
--   Fix 4  offline_command_queue unbounded growth — cleanup function
--   Fix 5  COMMENT ON statements to document access intent
--
-- All fixes are idempotent (IF NOT EXISTS / CREATE OR REPLACE).
-- ROLLBACK instructions are in each section's -- ROLLBACK: comment.
-- ============================================================================


-- ============================================================================
-- FIX 1: mv_daily_cost_summary data leak — RLS wrapper view
-- ============================================================================
--
-- WHY: Materialized views in Postgres cannot have Row-Level Security policies
-- applied to them directly (Postgres limitation as of PG 15). Migration 010
-- grants SELECT on mv_daily_cost_summary to the `authenticated` role and
-- relies entirely on application-layer filtering (.eq('user_id', user.id))
-- to prevent cross-user data exposure. This is a single-layer control: any
-- client that bypasses the application filter — including a direct PostgREST
-- query with a crafted URL — can read all users' cost data.
--
-- Governing standard: SOC2 CC6.1 — "Logical access controls are implemented
-- that restrict access to information assets to authorized users."
--
-- Fix: Create a regular VIEW v_my_daily_costs that wraps the MV with an
-- embedded WHERE user_id = (SELECT auth.uid()) predicate. Regular views
-- evaluate this predicate in the security context of the calling user, so
-- the database enforces the row filter — not the application. Grant SELECT
-- on the view to `authenticated` and revoke SELECT on the raw MV from
-- `authenticated` to eliminate the unprotected access path.
--
-- APP-CODE UPDATE REQUIRED: All application queries that reference
-- mv_daily_cost_summary must be updated to reference v_my_daily_costs instead.
-- The orchestrator should dispatch a follow-up task to update:
--   - packages/styrby-web: any Supabase query using .from('mv_daily_cost_summary')
--   - packages/styrby-mobile: same
--   - supabase/functions/*: any edge function referencing the raw MV
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS v_my_daily_costs;
--   GRANT SELECT ON mv_daily_cost_summary TO authenticated;
-- ============================================================================

-- Create the RLS-enforced wrapper view.
-- WHY: We use CREATE OR REPLACE so this is idempotent on re-run.
CREATE OR REPLACE VIEW v_my_daily_costs AS
SELECT
  user_id,
  record_date,
  agent_type,
  model,
  record_count,
  total_input_tokens,
  total_output_tokens,
  total_cache_read_tokens,
  total_cost_usd
FROM mv_daily_cost_summary
-- WHY: (SELECT auth.uid()) is the Supabase-recommended form. Using a subselect
-- instead of auth.uid() directly allows Postgres to cache the auth.uid() lookup
-- across rows, which is a measurable performance win on large result sets.
WHERE user_id = (SELECT auth.uid());

-- Grant SELECT on the protected view to authenticated users.
GRANT SELECT ON v_my_daily_costs TO authenticated;

-- Revoke direct SELECT on the raw materialized view from authenticated users.
-- WHY: After this revoke, the only path for authenticated users to read cost
-- data is through the view, which enforces the user_id filter at the DB layer.
-- Service-role clients retain access (used by cron refresh and admin tooling).
-- The REVOKE is wrapped in DO/EXCEPTION so re-running on a DB where it was
-- already revoked does not fail the migration.
DO $$
BEGIN
  REVOKE SELECT ON mv_daily_cost_summary FROM authenticated;
EXCEPTION WHEN others THEN
  -- WHY: If the privilege was already revoked, pg raises an error.
  -- We treat that as a no-op to keep the migration idempotent.
  NULL;
END;
$$;


-- ============================================================================
-- FIX 2: audit_action enum missing 'notification_sent'
-- ============================================================================
--
-- WHY: The push-notification edge function records audit events when APNs/FCM
-- notifications are dispatched. Because 'notification_sent' does not exist in
-- the audit_action enum, the function falls back to logging 'settings_updated'
-- instead — a semantically incorrect value that contaminates audit trail
-- queries (e.g., "show all settings changes" now includes push-notification
-- events). This makes SOC2 CC7.2 monitoring queries unreliable.
--
-- Governing standard: SOC2 CC7.2 — "The entity monitors system components and
-- the operation of those components for anomalies that are indicative of
-- malicious acts, natural disasters, and errors affecting the entity's ability
-- to meet its objectives."
--
-- Technical note: ALTER TYPE ... ADD VALUE cannot run inside a transaction
-- block on Postgres versions < 12 and on Supabase (which wraps migrations in
-- transactions). We use IF NOT EXISTS so re-runs are safe; Supabase's migration
-- runner executes each migration file as a single transaction, but ADD VALUE
-- with IF NOT EXISTS is safe in PG 12+ (Supabase runs PG 15+).
--
-- ROLLBACK:
--   There is no DROP VALUE for Postgres enums. To revert, you would need to
--   recreate the enum without this value and migrate all tables that reference
--   it. Practically: leave the value in place (unused values are harmless).
--   The push-notification function should be updated to stop using
--   'settings_updated' as a fallback once this migration is applied.
-- ============================================================================

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'notification_sent';


-- ============================================================================
-- FIX 3: Trigger functions missing SET search_path = public
-- ============================================================================
--
-- WHY: PostgreSQL resolves unqualified object names (tables, functions) using
-- the current search_path. Without an explicit SET search_path = public, a
-- privileged trigger function could be hijacked via search_path injection: if
-- an attacker can create a schema and manipulate the session's search_path,
-- calls to NOW() or other functions resolve to attacker-controlled versions.
-- SECURITY DEFINER is added to update_session_cost_on_finalize so it runs
-- with the privileges of the function owner (postgres/service role) rather
-- than the invoking user, eliminating privilege-based side effects.
--
-- Governing standard: NIST 800-53 SI-10 — "The information system checks the
-- validity of information inputs." Search-path hardening prevents injection
-- of malicious schema objects into the name resolution chain.
--
-- Three functions are recreated:
--   1. update_session_cost_on_finalize()  — also adds SECURITY DEFINER
--   2. session_checkpoints_set_updated_at()
--   3. serialize_user_insert()            — from migration 008
--
-- ROLLBACK:
--   Recreate each function without SECURITY DEFINER / SET search_path.
--   For update_session_cost_on_finalize, remove SECURITY DEFINER.
--   The trigger associations are unchanged; only the function body changes.
-- ============================================================================

-- 3a. update_session_cost_on_finalize
-- WHY SECURITY DEFINER: This function writes to `sessions` (adjusting
-- total_cost_usd) triggered by cost_records UPDATE. Running as the invoker
-- means the update can fail if the invoker's RLS does not allow updates on
-- sessions. SECURITY DEFINER ensures the session totals are always updated
-- correctly regardless of the caller's RLS context.
CREATE OR REPLACE FUNCTION update_session_cost_on_finalize()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- WHY: Only act when a pending cost record is finalized (is_pending flips
  -- from TRUE to FALSE). This is the pattern used by the CLI to commit
  -- estimated costs once the actual model response is received.
  IF OLD.is_pending = TRUE AND NEW.is_pending = FALSE AND NEW.session_id IS NOT NULL THEN
    UPDATE sessions
    SET
      total_cost_usd      = total_cost_usd      + (NEW.cost_usd        - OLD.cost_usd),
      total_input_tokens  = total_input_tokens  + (NEW.input_tokens    - OLD.input_tokens),
      total_output_tokens = total_output_tokens + (NEW.output_tokens   - OLD.output_tokens),
      total_cache_tokens  = total_cache_tokens  + (
        COALESCE(NEW.cache_read_tokens, 0) - COALESCE(OLD.cache_read_tokens, 0)
      )
    WHERE id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$;


-- 3b. session_checkpoints_set_updated_at
-- WHY: This function was created in migration 015 without SET search_path.
-- Recreating it with the hardened signature is backward-compatible; the
-- existing trigger (session_checkpoints_updated_at) references the function
-- by name and will automatically use the updated definition.
CREATE OR REPLACE FUNCTION session_checkpoints_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- 3c. serialize_user_insert
-- WHY: This trigger function (from migration 008) uses pg_advisory_xact_lock
-- to serialize concurrent inserts per user, preventing race conditions on
-- tier-limit enforcement. Without SET search_path, a malicious schema could
-- shadow pg_advisory_xact_lock with a no-op, bypassing the serialization.
CREATE OR REPLACE FUNCTION serialize_user_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- WHY: hashtext produces a 32-bit int from user_id + table name.
  -- pg_advisory_xact_lock holds this lock until the transaction commits,
  -- preventing concurrent inserts from bypassing tier limit checks.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.user_id::text || TG_TABLE_NAME));
  RETURN NEW;
END;
$$;


-- ============================================================================
-- FIX 4: offline_command_queue unbounded growth
-- ============================================================================
--
-- WHY: The offline_command_queue accumulates rows as the mobile app queues
-- commands while offline and marks them 'sent' once delivered. Rows with
-- status = 'sent' have no further purpose but are never deleted, causing the
-- table to grow without bound. On a free-tier Supabase instance (500 MB
-- limit) this can cause storage exhaustion; on any tier it degrades query
-- performance on indexes that include all rows.
--
-- Governing standard: SOC2 CC7.2 operational monitoring — unbounded table
-- growth can cause availability incidents.
--
-- This function is SECURITY DEFINER so it can delete rows regardless of RLS
-- (which restricts deletions to the row owner). The cron schedule is managed
-- separately (pg_cron or Supabase scheduled functions); this migration only
-- registers the cleanup function.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS cleanup_old_sent_offline_commands();
--   (Remove associated pg_cron job if one was registered.)
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_old_sent_offline_commands()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  -- WHY: We only delete rows in 'sent' status older than 7 days.
  -- 'pending' and 'failed' rows are retained — 'pending' may still be
  -- deliverable; 'failed' rows are kept for diagnostic review.
  -- 7 days provides a comfortable window for debugging without letting
  -- the table grow indefinitely.
  DELETE FROM offline_command_queue
  WHERE status = 'sent'
    AND created_at < now() - INTERVAL '7 days';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- WHY: Return the count so callers (cron logs, monitoring) can track
  -- cleanup volume over time.
  RETURN v_deleted;
END;
$$;

-- Grant EXECUTE to service_role only (cron runs as service_role).
-- authenticated users should not be able to invoke bulk delete operations.
GRANT EXECUTE ON FUNCTION cleanup_old_sent_offline_commands() TO service_role;

-- NOTE: pg_cron scheduling is handled separately by the orchestrator.
-- Suggested schedule: daily at 02:00 CT (08:00 UTC).
-- Example:
--   SELECT cron.schedule(
--     'cleanup-sent-offline-commands',
--     '0 8 * * *',
--     'SELECT cleanup_old_sent_offline_commands()'
--   );


-- ============================================================================
-- FIX 5: COMMENT ON statements to document access intent
-- ============================================================================
--
-- WHY: Database-level comments make access intent explicit and machine-readable.
-- They appear in pg_description, are surfaced by Supabase Studio, and are
-- included in schema diffs — ensuring that future developers and auditors
-- understand why certain access patterns are intentional rather than
-- accidental oversights.
--
-- Governing standards:
--   SOC2 CC6.1 — Access controls should be documented and intentional.
--   OWASP ASVS V3.5 — Sensitive data access should be explicitly justified.
--
-- ROLLBACK:
--   COMMENT ON TABLE cost_records IS NULL;
--   COMMENT ON TABLE user_feedback IS NULL;
--   (NULL clears the comment without removing the table.)
-- ============================================================================

-- cost_records: clarify that writes bypass RLS via service-role
-- WHY: cost_records has a SELECT-only RLS policy for authenticated users.
-- All INSERT/UPDATE operations are performed by the Supabase Edge Function
-- using the service-role key (which bypasses RLS). This is intentional:
-- users should never write their own cost records, which would enable
-- cost manipulation. The comment prevents future developers from
-- "fixing" this by adding an INSERT policy for authenticated users.
COMMENT ON TABLE cost_records IS
  'INSERT/UPDATE via service-role only (Edge Function + CLI relay). '
  'SELECT is restricted via RLS to the owning user. '
  'Authenticated role intentionally has no INSERT/UPDATE access. '
  'Governing standard: SOC2 CC6.1.';

-- user_feedback: clarify that NULL user_id rows are intentional
-- WHY: The mobile and web apps allow anonymous product feedback submission
-- (user not logged in). These rows have user_id = NULL. The existing RLS
-- SELECT policy (feedback_select_own) uses user_id = auth.uid(), which
-- evaluates to FALSE for NULL user_id rows — so anonymous feedback is
-- not readable by any authenticated user. Admin reads of anonymous feedback
-- are performed via service-role. This is the intended design; the comment
-- prevents a developer from treating NULL user_id as a data integrity bug.
COMMENT ON TABLE user_feedback IS
  'Rows with NULL user_id represent anonymous product feedback. '
  'This is intentional: the app permits feedback submission without login. '
  'Anonymous rows are readable by admin via service-role only (RLS blocks them '
  'from authenticated SELECT policy). '
  'Governing standard: OWASP ASVS V3.5 / SOC2 CC6.1.';


-- ============================================================================
-- END OF MIGRATION 016
-- ============================================================================
