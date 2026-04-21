-- ============================================================================
-- STYRBY DATABASE MIGRATION 023: Quota-Aware Budget Alerts
-- ============================================================================
-- Date:    2026-04-21
-- Author:  Claude Code (claude-sonnet-4-6)
-- Branch:  feat/passkey-ui-2026-04-20
--
-- Phase:   1.6.1 — PR-E: quota-aware budget alerts
-- Spec:    docs/planning/styrby-improve-19Apr.md §1.6.1
--
-- Audit standards cited:
--   SOC2 CC7.2          — System monitoring / cost accounting accuracy
--   SOC2 CC6.1          — Logical access controls (RLS unchanged; extends 001)
--   GDPR Art. 5(1)(a)   — Accuracy principle: data must reflect reality
--   ISO 27001 A.12.4    — Logging and monitoring
--
-- WHY this migration exists:
--   After migration 022, cost_records rows for subscription users have
--   cost_usd = $0 (correct — Styrby has no per-session billing visibility
--   into third-party subscription plans). Budget alerts still sum cost_usd
--   across all rows, so subscription users (e.g., Claude Max) and credit
--   users (Kiro) never trigger any alert: their sums are always $0.
--
--   This migration extends budget_alerts with an alert_type enum that
--   routes each alert to the correct aggregation:
--
--     cost_usd           → sum cost_usd WHERE billing_model = 'api-key'
--                          (legacy behavior, renamed/clarified)
--     subscription_quota → take MAX(subscription_fraction_used)
--                          WHERE billing_model = 'subscription'
--                          compare vs threshold_quota_fraction
--     credits            → sum credits_consumed
--                          WHERE billing_model = 'credit'
--                          compare vs threshold_credits
--
-- Schema diagram (budget_alerts additions):
--
--   budget_alerts
--   ├── alert_type  budget_alert_type  NOT NULL  DEFAULT 'cost_usd'
--   ├── threshold_quota_fraction  NUMERIC(5,4) NULL
--   │     └── required when alert_type = 'subscription_quota'
--   └── threshold_credits         INTEGER NULL
--         └── required when alert_type = 'credits'
--
-- CHECK constraints:
--   - subscription_quota rows must have threshold_quota_fraction > 0 AND <= 1
--   - subscription_quota rows must have threshold_quota_fraction NOT NULL
--   - credits rows must have threshold_credits > 0
--   - credits rows must have threshold_credits NOT NULL
--   - cost_usd rows must NOT populate threshold_quota_fraction or threshold_credits
--
-- Dependencies:
--   - Migration 001 (budget_alerts table, profiles, RLS policies)
--   - Migration 022 (cost_billing_model enum, billing_model column on cost_records)
--
-- Rollback (manual — only safe before app layer uses new columns):
--   ALTER TABLE budget_alerts
--     DROP COLUMN IF EXISTS alert_type,
--     DROP COLUMN IF EXISTS threshold_quota_fraction,
--     DROP COLUMN IF EXISTS threshold_credits;
--   DROP TYPE IF EXISTS budget_alert_type;
-- ============================================================================


-- ============================================================================
-- ENUM: budget_alert_type
-- ============================================================================
-- Determines which cost_records aggregation to use when evaluating a threshold.
--
--   cost_usd           — sum(cost_usd) for billing_model = 'api-key'
--                        threshold column: threshold_usd (pre-existing)
--   subscription_quota — MAX(subscription_fraction_used) for billing_model
--                        = 'subscription'
--                        threshold column: threshold_quota_fraction
--   credits            — sum(credits_consumed) for billing_model = 'credit'
--                        threshold column: threshold_credits
--
-- WHY DO $$ block: Postgres does not support IF NOT EXISTS for enums.
-- Wrapping in an exception handler makes the migration idempotent so it is
-- safe to re-run after a partial failure or during supabase db reset.
-- ============================================================================
DO $$
BEGIN
  CREATE TYPE budget_alert_type AS ENUM (
    'cost_usd',
    'subscription_quota',
    'credits'
  );
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$$;


-- ============================================================================
-- ALTER TABLE budget_alerts — add new columns
-- ============================================================================
-- We use IF NOT EXISTS on each ADD COLUMN so the migration is idempotent.
--
-- DEFAULT 'cost_usd' on alert_type backfills all pre-existing rows to the
-- legacy cost_usd behavior — existing alerts continue to work unchanged.
-- ============================================================================

ALTER TABLE budget_alerts
  -- Which aggregation logic to use for this alert.
  ADD COLUMN IF NOT EXISTS alert_type budget_alert_type
    NOT NULL DEFAULT 'cost_usd',

  -- Subscription quota fraction threshold (0 < value <= 1).
  -- Only meaningful when alert_type = 'subscription_quota'.
  -- Example: 0.8000 means "alert when 80% of subscription quota is used".
  -- WHY NUMERIC(5,4): four decimal places support e.g. 0.7500 (75%) with
  -- no rounding artefacts. Five digits total so values up to 1.0000 fit.
  ADD COLUMN IF NOT EXISTS threshold_quota_fraction NUMERIC(5, 4),

  -- Credit threshold (integer). Only meaningful when alert_type = 'credits'.
  -- Example: 500 means "alert when 500 credits have been consumed".
  ADD COLUMN IF NOT EXISTS threshold_credits INTEGER;


-- ============================================================================
-- CONSTRAINTS
-- ============================================================================

-- subscription_quota alerts must have a valid fraction in (0, 1].
-- WHY: A fraction of 0 would fire on the very first session (meaningless).
-- A fraction > 1 could never be reached. We enforce the valid range here
-- rather than relying on application validation.
DO $$
BEGIN
  ALTER TABLE budget_alerts
    ADD CONSTRAINT chk_quota_fraction_range
      CHECK (
        alert_type <> 'subscription_quota'
        OR (
          threshold_quota_fraction IS NOT NULL
          AND threshold_quota_fraction > 0
          AND threshold_quota_fraction <= 1
        )
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

-- credits alerts must have a positive integer threshold.
-- WHY: Zero or negative credit thresholds are nonsensical and would fire
-- before any credits are consumed.
DO $$
BEGIN
  ALTER TABLE budget_alerts
    ADD CONSTRAINT chk_credits_range
      CHECK (
        alert_type <> 'credits'
        OR (threshold_credits IS NOT NULL AND threshold_credits > 0)
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

-- cost_usd alerts must NOT carry quota/credit threshold columns.
-- WHY: Prevents confusing hybrid rows where alert_type = 'cost_usd' but
-- threshold_quota_fraction is also set. The extra columns would be silently
-- ignored by the engine — the constraint makes the invariant explicit and
-- catches bugs at insert/update time.
DO $$
BEGIN
  ALTER TABLE budget_alerts
    ADD CONSTRAINT chk_cost_usd_no_quota_fields
      CHECK (
        alert_type <> 'cost_usd'
        OR (threshold_quota_fraction IS NULL AND threshold_credits IS NULL)
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;


-- ============================================================================
-- INDEX: idx_budget_alerts_user_type
-- ============================================================================
-- The monitor queries budget_alerts filtered by (user_id, is_enabled) and
-- may also filter on alert_type to skip irrelevant rows. Adding alert_type
-- to the index lets Postgres skip non-matching type rows without a heap fetch.
--
-- WHY not a partial index: Users typically have only a few alerts, so index
-- size is trivial. A covering index on (user_id, is_enabled, alert_type)
-- keeps the scan path clean without overly-specialized index design.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_budget_alerts_user_type
  ON budget_alerts (user_id, is_enabled, alert_type);


-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON COLUMN budget_alerts.alert_type IS
  'Aggregation logic: cost_usd=sum(cost_usd) for api-key rows, subscription_quota=MAX(subscription_fraction_used), credits=sum(credits_consumed).';

COMMENT ON COLUMN budget_alerts.threshold_quota_fraction IS
  'Fraction of subscription quota (0 < x <= 1) that triggers the alert. Required when alert_type=subscription_quota. NULL for other types.';

COMMENT ON COLUMN budget_alerts.threshold_credits IS
  'Number of credits consumed that triggers the alert. Required when alert_type=credits. NULL for other types.';


-- ============================================================================
-- END OF MIGRATION 023
-- ============================================================================
