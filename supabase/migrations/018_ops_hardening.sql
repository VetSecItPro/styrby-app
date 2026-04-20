-- ============================================================================
-- Migration 018: Ops Hardening — Audit Triggers + pg_cron Schedules
-- ============================================================================
-- Date:    2026-04-20
-- Author:  Claude Code (claude-sonnet-4-6)
-- Branch:  ops/hardening-bundle-2026-04-20
--
-- Issue refs:
--   Phase 0.0 audit — audit_log DB triggers missing from core mutation tables
--   Live infra audit 2026-04-20 — mv_daily_cost_summary refresh unscheduled
--   Migration 016 — cleanup_old_sent_offline_commands() created but never wired
--
-- Audit standards cited:
--   SOC2 CC7.2  — "Monitor system components for anomalies indicative of
--                  malicious acts, errors, and natural disasters."
--
-- Summary of changes:
--   Part 1  Audit trigger function + triggers on profiles/subscriptions/api_keys
--   Part 2  pg_cron hourly refresh of mv_daily_cost_summary
--   Part 3  pg_cron daily cleanup of sent offline_command_queue rows
--
-- All changes are idempotent (CREATE OR REPLACE, IF EXISTS guards, cron
-- unschedule-before-schedule pattern).
-- ROLLBACK instructions are in each section's -- ROLLBACK: comment.
-- ============================================================================


-- ============================================================================
-- PART 1: Audit Log DB Triggers
-- ============================================================================
--
-- WHY: Phase 0.0 audit + live infra audit identified that mutations on core
-- tables (profiles, subscriptions, api_keys) were not automatically recorded
-- in audit_log. This means:
--   - Schema changes (e.g. role escalation via UPDATE profiles SET role='admin')
--     leave no DB-layer evidence — only application-layer logs, which can be
--     bypassed by direct PostgREST calls with a service-role token.
--   - SOC2 CC7.2 requires system-level monitoring. A DB trigger is the
--     tamper-resistant, always-on record that satisfies this requirement
--     regardless of which client path mutates the row.
--
-- Design decisions:
--   - SECURITY DEFINER + SET search_path = public: prevents search-path
--     injection (consistent with migration 016 pattern). The trigger function
--     runs as the function owner (postgres/service_role), ensuring it can
--     always INSERT into audit_log regardless of the invoking role's RLS.
--   - AFTER trigger: we record the committed state after the DB validates
--     constraints. BEFORE triggers fire before validation — recording would
--     capture rows that may still be rolled back.
--   - FOR EACH ROW: one audit record per mutated row, not per statement.
--   - control_ref 'SOC2 CC7.2': machine-readable reference surfaced in audit
--     trail queries so compliance tooling can filter by standard.
--
-- Governing standard: SOC2 CC7.2
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS audit_log_profiles       ON profiles;
--   DROP TRIGGER IF EXISTS audit_log_subscriptions  ON subscriptions;
--   DROP TRIGGER IF EXISTS audit_log_api_keys       ON api_keys;
--   DROP FUNCTION IF EXISTS audit_trigger_fn();
-- ============================================================================

CREATE OR REPLACE FUNCTION audit_trigger_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  UUID;
  v_record   JSONB;
BEGIN
  -- WHY: For DELETE we log OLD (the row that was removed). For INSERT and
  -- UPDATE we log NEW (the row as it now exists). This mirrors standard
  -- audit-log practice: the "what happened" record is the new/removed state.
  IF TG_OP = 'DELETE' THEN
    v_record := to_jsonb(OLD);
    -- WHY: Attempt to extract user_id from the deleted row so the audit entry
    -- is owner-attributed. Falls back to NULL if the column doesn't exist on
    -- this table (handled by the EXCEPTION block below).
    BEGIN
      v_user_id := (OLD).user_id;
    EXCEPTION WHEN others THEN
      v_user_id := NULL;
    END;
  ELSE
    v_record := to_jsonb(NEW);
    BEGIN
      v_user_id := (NEW).user_id;
    EXCEPTION WHEN others THEN
      v_user_id := NULL;
    END;
  END IF;

  INSERT INTO audit_log (
    user_id,
    action,
    resource_type,
    resource_id,
    details,
    created_at
  ) VALUES (
    -- WHY: Prefer the row's own user_id. If the trigger fires from a
    -- service-role operation (e.g. billing webhook updating subscriptions),
    -- the row's user_id is the affected user — correct for audit attribution.
    -- Falls back to auth.uid() if the row has no user_id column.
    COALESCE(v_user_id, auth.uid()),

    -- WHY: Cast TG_OP to audit_action via text. TG_OP values are 'INSERT',
    -- 'UPDATE', 'DELETE' — which must exist in the audit_action enum.
    -- If they don't, this cast will raise a DB error and the migration should
    -- be updated to add the missing enum values first.
    TG_OP::text::audit_action,

    -- WHY: TG_TABLE_NAME is the unqualified table name (e.g. 'profiles').
    -- This is consistent with how other audit_log entries record resource_type.
    TG_TABLE_NAME,

    -- WHY: Try to extract 'id' as the resource identifier. Most Styrby tables
    -- use UUID primary key named 'id'. EXCEPTION block handles tables without it.
    CASE
      WHEN TG_OP = 'DELETE' THEN (v_record->>'id')::text
      ELSE (v_record->>'id')::text
    END,

    -- WHY: Store the full row snapshot as JSONB in details. This lets auditors
    -- reconstruct the exact state at the time of mutation, including which
    -- fields changed on UPDATE. No PII scrubbing here — audit_log is a
    -- high-privilege table with service-role access only (SOC2 requirement).
    jsonb_build_object(
      'operation', TG_OP,
      'table',     TG_TABLE_NAME,
      'record',    v_record,
      'control_ref', 'SOC2 CC7.2'
    ),

    now()
  );

  -- WHY: For AFTER triggers, the return value is ignored for non-STATEMENT
  -- triggers. We return NULL here as the canonical form; returning NEW or OLD
  -- would also work but NULL makes the intent explicit: we are observing, not
  -- modifying the row.
  RETURN NULL;
END;
$$;

-- Attach audit trigger to profiles
-- WHY: profiles is extended from auth.users and stores role, subscription tier,
-- and consent fields. Mutations here (especially role or tier changes) are high-
-- value audit events. IF EXISTS guard makes this idempotent on re-run.
DROP TRIGGER IF EXISTS audit_log_profiles ON profiles;
CREATE TRIGGER audit_log_profiles
  AFTER INSERT OR UPDATE OR DELETE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION audit_trigger_fn();

-- Attach audit trigger to subscriptions
-- WHY: Billing state changes (plan upgrades, downgrades, cancellations) must be
-- in the audit trail for revenue integrity and SOC2 evidence. Subscriptions are
-- synced from Polar webhooks — the trigger ensures even service-role webhook
-- writes are audited at the DB layer.
DROP TRIGGER IF EXISTS audit_log_subscriptions ON subscriptions;
CREATE TRIGGER audit_log_subscriptions
  AFTER INSERT OR UPDATE OR DELETE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION audit_trigger_fn();

-- Attach audit trigger to api_keys
-- WHY: API key creation, revocation, and rotation are the highest-risk mutations
-- in the system. A leaked or rogue key can exfiltrate all session data. The DB
-- trigger ensures key lifecycle events survive even if the application-layer log
-- is unavailable.
DROP TRIGGER IF EXISTS audit_log_api_keys ON api_keys;
CREATE TRIGGER audit_log_api_keys
  AFTER INSERT OR UPDATE OR DELETE ON api_keys
  FOR EACH ROW
  EXECUTE FUNCTION audit_trigger_fn();

-- Optional: attach to team_members if the table exists.
-- WHY: team_members may not exist in all environments (teams feature is gated).
-- We use a DO block so the trigger is registered if the table is present,
-- without failing the entire migration if it isn't.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'team_members'
  ) THEN
    -- Drop before recreate to keep idempotent
    EXECUTE 'DROP TRIGGER IF EXISTS audit_log_team_members ON team_members';
    EXECUTE '
      CREATE TRIGGER audit_log_team_members
        AFTER INSERT OR UPDATE OR DELETE ON team_members
        FOR EACH ROW
        EXECUTE FUNCTION audit_trigger_fn()
    ';
  END IF;
END;
$$;

-- Optional: attach to team_policies if the table exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'team_policies'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS audit_log_team_policies ON team_policies';
    EXECUTE '
      CREATE TRIGGER audit_log_team_policies
        AFTER INSERT OR UPDATE OR DELETE ON team_policies
        FOR EACH ROW
        EXECUTE FUNCTION audit_trigger_fn()
    ';
  END IF;
END;
$$;


-- ============================================================================
-- PART 2: pg_cron — Hourly Refresh of mv_daily_cost_summary
-- ============================================================================
--
-- WHY: mv_daily_cost_summary is a materialized view (migration 010). Unlike a
-- regular view, it does not recompute on every query — it holds a snapshot of
-- data at the last REFRESH time. Without a scheduled refresh, the cost
-- dashboard shows stale data: a session completed an hour ago might not appear
-- in the "today's spend" card until the MV is manually refreshed.
--
-- Live infra audit (2026-04-20) finding: "mv_daily_cost_summary refresh is
-- unscheduled; cost dashboard will show stale data."
--
-- CONCURRENTLY: We use REFRESH MATERIALIZED VIEW CONCURRENTLY so queries
-- against the MV continue to succeed during the refresh (no exclusive lock).
-- This requires the MV to have at least one unique index — migration 010 adds
-- a unique index on (user_id, record_date, agent_type, model). If that index
-- is ever dropped, CONCURRENTLY will fail; use non-concurrent refresh instead.
--
-- WHY hourly: Cost data is written by the CLI in near-real-time, but the
-- aggregated dashboard summary only needs to be "fresh within an hour" to
-- give useful spend tracking. A sub-minute refresh would waste Supabase
-- compute; hourly is a good balance.
--
-- Governing standard: SOC2 CC7.2 operational availability.
--
-- ROLLBACK:
--   SELECT cron.unschedule('refresh-mv-daily-costs');
-- ============================================================================

-- Ensure pg_cron is available.
-- WHY: pg_cron is a Supabase-supported extension (enabled in dashboard under
-- Database > Extensions). CREATE EXTENSION IF NOT EXISTS is idempotent.
-- If Supabase has not enabled it, this will fail with a helpful error.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Unschedule first to make this idempotent on re-run.
-- WHY: cron.schedule() inserts a new row in the cron.job table. Running this
-- migration twice without the unschedule would create duplicate jobs, both
-- refreshing the MV, doubling the compute cost and potentially causing lock
-- contention. Unschedule-before-schedule is the idempotent pattern.
SELECT cron.unschedule('refresh-mv-daily-costs')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'refresh-mv-daily-costs'
);

-- Schedule hourly refresh at the top of every hour.
-- WHY: '0 * * * *' runs at minute 0 of every hour (00:00, 01:00, 02:00, ...).
-- The job runs as the postgres superuser (default for pg_cron) which can
-- REFRESH the MV regardless of RLS. This is correct behaviour: the refresh is
-- a server-side background task, not a user-initiated query.
SELECT cron.schedule(
  'refresh-mv-daily-costs',
  '0 * * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_cost_summary;'
);


-- ============================================================================
-- PART 3: pg_cron — Daily Cleanup of Sent offline_command_queue Rows
-- ============================================================================
--
-- WHY: Migration 016 (Fix 4) created the cleanup_old_sent_offline_commands()
-- function to delete 'sent' rows older than 7 days, but explicitly noted:
-- "pg_cron scheduling is handled separately by the orchestrator." This
-- migration fulfils that note by wiring the actual cron schedule.
--
-- Without the schedule the function is inert — the table still grows without
-- bound. The daily cron is the final piece required to close the cleanup loop.
--
-- WHY 03:00 UTC: Low-traffic window minimises lock contention with mobile
-- clients syncing commands. The planning doc recommends "daily 03:00 UTC"
-- for this job. Note: this is 22:00 CT (Central Time / America/Chicago) —
-- overnight in the primary user timezone, consistent with the project's
-- time-zone rules (low-impact maintenance window).
--
-- Governing standard: SOC2 CC7.2 operational monitoring (unbounded table
-- growth can cause availability incidents).
--
-- ROLLBACK:
--   SELECT cron.unschedule('cleanup-old-sent-offline-commands');
-- ============================================================================

-- Unschedule first to keep idempotent.
SELECT cron.unschedule('cleanup-old-sent-offline-commands')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cleanup-old-sent-offline-commands'
);

-- Schedule daily at 03:00 UTC.
SELECT cron.schedule(
  'cleanup-old-sent-offline-commands',
  '0 3 * * *',
  'SELECT cleanup_old_sent_offline_commands();'
);


-- ============================================================================
-- END OF MIGRATION 018
-- ============================================================================
