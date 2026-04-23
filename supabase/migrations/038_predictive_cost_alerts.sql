-- ============================================================================
-- STYRBY DATABASE MIGRATION 038: Predictive Cost Alerts
-- ============================================================================
-- Date:    2026-04-22
-- Author:  Claude Code (claude-sonnet-4-6)
-- Branch:  feat/cost-forecasting-3.4
--
-- Phase:   3.4 — Cost forecasting + predictive alerts
-- Spec:    docs/planning/styrby-improve-19Apr.md §3.4
--
-- Audit standards cited:
--   SOC2 CC7.2          — System monitoring (predictive alerting audit trail)
--   SOC2 CC6.1          — Logical access controls (RLS on new table)
--   GDPR Art. 5(1)(a)   — Accuracy principle: predictions are labelled as such
--   ISO 27001 A.12.4    — Logging and monitoring (cron job audit trail)
--
-- WHY this migration exists:
--   Phase 3.4 adds EMA-blend cost forecasting. The forecasting math lives in
--   packages/styrby-shared/src/cost-forecast/forecast.ts and is consumed by:
--
--     1. GET /api/costs/forecast — real-time forecast for the dashboard
--     2. Nightly pg_cron job (this migration) — proactive push alerts
--     3. Web + mobile ForecastCard components — "cap on <date>" display
--
--   Without a dedicated idempotency table, the nightly cron would re-send
--   the same prediction alert every night, flooding users with duplicates.
--   predictive_cost_alert_sends provides the same guard that
--   budget_threshold_sends (migration 023) provides for threshold alerts.
--
-- Schema additions:
--   notification_preferences
--     └── push_predictive_alert  BOOLEAN NOT NULL DEFAULT TRUE
--
--   predictive_cost_alert_sends   (new table)
--     ├── id                      UUID PK
--     ├── user_id                 UUID FK → auth.users
--     ├── billing_period_start    DATE      (YYYY-MM-DD, 1st of month)
--     ├── predicted_exhaustion_date DATE
--     ├── sent_at                 TIMESTAMPTZ DEFAULT now()
--     └── created_at              TIMESTAMPTZ DEFAULT now()
--
--   pg_cron job at 02:00 UTC daily:
--     cron.schedule('styrby_predictive_cost_alerts', '0 2 * * *',
--       $$SELECT net.http_post(...)$$)
--
-- Dependencies:
--   - Migration 001 (notification_preferences, auth.users)
--   - Migration 023 (budget_threshold_sends pattern — reference only)
--   - pg_cron must be enabled (Supabase default: yes)
--   - pg_net must be enabled for the HTTP callback pattern
--
-- Rollback (manual, pre-app-deploy only):
--   SELECT cron.unschedule('styrby_predictive_cost_alerts');
--   DROP TABLE IF EXISTS predictive_cost_alert_sends;
--   ALTER TABLE notification_preferences DROP COLUMN IF EXISTS push_predictive_alert;
-- ============================================================================


-- ============================================================================
-- STEP 1: Add push_predictive_alert opt-in column to notification_preferences
-- ============================================================================

-- WHY default TRUE: Users benefit from knowing their quota is about to run
-- out. Opt-out is intentional — users who don't want these alerts can toggle
-- the preference in Settings. Defaulting to FALSE would mean no user gets
-- alerts until they discover and enable the feature.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS push_predictive_alert BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN notification_preferences.push_predictive_alert IS
  'Send a push notification when EMA-blend forecast predicts quota exhaustion within 7 days. Default TRUE. Added Phase 3.4.';


-- ============================================================================
-- STEP 2: Create predictive_cost_alert_sends idempotency table
-- ============================================================================

-- WHY this table and not a flag on notification_preferences:
--   A simple "last_sent_at" column cannot distinguish between "sent for March"
--   and "sent for April". Using (user_id, billing_period_start) as a composite
--   natural key means one send per billing period per user — regardless of how
--   many nights the cron runs within that period.
--
-- WHY predicted_exhaustion_date is stored:
--   The audit trail must record what prediction was communicated to the user.
--   If the forecast model is later improved, historical sends show the old
--   prediction — satisfying SOC2 CC7.2 evidence-of-activity requirements.

CREATE TABLE IF NOT EXISTS predictive_cost_alert_sends (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The user who received the alert.
  user_id                  UUID NOT NULL
    REFERENCES auth.users(id) ON DELETE CASCADE,

  -- First day of the billing period in which the prediction was made.
  -- YYYY-MM-DD format, always the 1st of the month.
  billing_period_start     DATE NOT NULL,

  -- The ISO date the forecast predicted quota would be exhausted.
  -- Stored for audit purposes — see WHY comment above.
  predicted_exhaustion_date DATE NOT NULL,

  -- When the alert was dispatched. Indexed for audit log queries.
  sent_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Row creation timestamp (immutable).
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Idempotency constraint: one send per user per billing period.
  -- WHY UNIQUE not just PK: The PK is a surrogate UUID for stable foreign
  -- keys. The unique constraint enforces business logic separately.
  CONSTRAINT uq_predictive_alert_sends_user_period
    UNIQUE (user_id, billing_period_start)
);

COMMENT ON TABLE predictive_cost_alert_sends IS
  'Idempotency log for nightly predictive cost alerts. Prevents duplicate alerts within the same billing period. Phase 3.4. Audit: SOC2 CC7.2.';

COMMENT ON COLUMN predictive_cost_alert_sends.billing_period_start IS
  'First day of the billing month for which this alert was sent (YYYY-MM-DD). Part of the idempotency constraint.';

COMMENT ON COLUMN predictive_cost_alert_sends.predicted_exhaustion_date IS
  'ISO date the EMA-blend forecast predicted quota exhaustion when this alert was sent. Immutable audit record.';


-- ============================================================================
-- STEP 3: Row-Level Security on predictive_cost_alert_sends
-- ============================================================================

-- WHY RLS: Users must never see each other's alert send history.
-- Admins access the table via the service_role key (bypasses RLS) for
-- the cron job; users can read their own history for the Settings screen.

ALTER TABLE predictive_cost_alert_sends ENABLE ROW LEVEL SECURITY;

-- Users can read their own sends (Settings > Notifications history).
-- WHY (SELECT auth.uid()): Supabase query-plan caching trick — wrapping
-- auth.uid() in a subselect causes the planner to treat it as a stable
-- parameter, enabling index caching across rows in the same query.
CREATE POLICY predictive_cost_alert_sends_read_own
  ON predictive_cost_alert_sends
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- WHY no INSERT policy for authenticated: The cron job runs as service_role
-- (which bypasses RLS). Allowing authenticated users to insert rows would
-- let a user pre-insert fake send records to suppress legitimate alerts —
-- a security concern analogous to replay attacks. Cron writes exclusively.

-- WHY no DELETE policy: Sends are immutable audit records (SOC2 CC7.2).
-- Only a Supabase admin with direct DB access can delete them.


-- ============================================================================
-- STEP 4: Indexes
-- ============================================================================

-- B-tree index for fast user-period lookup (cron job idempotency check).
CREATE INDEX IF NOT EXISTS idx_predictive_alert_sends_user_period
  ON predictive_cost_alert_sends (user_id, billing_period_start);

-- BRIN index on sent_at for time-series audit queries.
-- WHY BRIN not B-tree: sent_at is monotonically increasing (rows are only
-- ever appended). BRIN is ~100x smaller for this access pattern.
-- Matches the pattern established in migration 022 for cost_records.
CREATE INDEX IF NOT EXISTS idx_predictive_alert_sends_sent_at_brin
  ON predictive_cost_alert_sends USING brin (sent_at);


-- ============================================================================
-- STEP 5: Nightly pg_cron predictive alert job
-- ============================================================================

-- WHY HTTP callback pattern (not inline SQL):
--   The EMA-blend forecast requires reading 30 days of cost_records per user
--   and running the computeForecast() TypeScript function. pg_cron cannot call
--   TypeScript. Instead, the cron fires a POST to the Next.js cron endpoint
--   which handles the forecast math in Node.js.
--
--   This matches the pattern used by all other cron jobs in the Styrby
--   system (weekly-digest, budget-threshold, retention, nps-prompt-dispatch).
--
-- WHY 02:00 UTC:
--   2 AM UTC is midnight Central Time (standard) / 1 AM Central (daylight),
--   satisfying the project's "Central Time for all scheduled tasks" rule.
--   Cost_records writes are lowest at this hour, so the query is fast.
--   Matching the CI requirement to use UTC for pg_cron while documenting
--   the CT equivalence.
--
-- WHY schedule even if no CRON_SECRET yet:
--   The job will fail gracefully with a 401 if CRON_SECRET is not set,
--   rather than silently not running. This is the safe-fail behavior.

-- Unschedule existing job if it was previously installed (idempotent migration).
SELECT cron.unschedule('styrby_predictive_cost_alerts')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'styrby_predictive_cost_alerts'
);

-- Schedule nightly job at 02:00 UTC.
-- The endpoint URL uses the SITE_URL environment variable injected by Supabase.
-- If SITE_URL is not set, the job logs a pg_net error and moves on — it does
-- NOT crash other cron jobs (pg_net failures are non-fatal in Supabase).
SELECT cron.schedule(
  'styrby_predictive_cost_alerts',
  '0 2 * * *',
  $$
    SELECT net.http_post(
      url     := current_setting('app.site_url', true) || '/api/cron/predictive-cost-alerts',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.cron_secret', true)
      ),
      body    := '{}'::jsonb
    );
  $$
);

COMMENT ON EXTENSION pg_cron IS 'pg_cron: job scheduler (see cron.job for registered jobs). Styrby jobs: styrby_predictive_cost_alerts.';
