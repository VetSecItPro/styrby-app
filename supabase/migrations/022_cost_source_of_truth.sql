-- ============================================================================
-- STYRBY DATABASE MIGRATION 022: Cost Source of Truth
-- ============================================================================
-- Date:    2026-04-21
-- Author:  Claude Code (claude-sonnet-4-6)
-- Branch:  feat/passkey-ui-2026-04-20
--
-- Phase:   1.6.1 — Real LLM cost surfacing
-- Spec:    docs/planning/styrby-improve-19Apr.md §1.6
--
-- Audit standards cited:
--   SOC2 CC7.2          — System monitoring / cost accounting accuracy
--   SOC2 CC6.1          — Logical access controls (RLS unchanged; extends 001)
--   GDPR Art. 5(1)(a)   — Accuracy principle: data must reflect reality
--   ISO 27001 A.12.4    — Logging and monitoring (raw_agent_payload audit trail)
--
-- WHY this migration exists:
--   Prior to this migration every cost_records row was an estimate computed
--   by the Styrby CLI using token counts and a hardcoded price table. This
--   approach:
--     1. Cannot distinguish zero-cost subscription sessions from API-billed ones.
--     2. Loses the ground-truth usage blob emitted by agents that do report
--        their own costs (Claude Code, Kiro credits).
--     3. Cannot model credit-based billing (Kiro today, others likely soon).
--   This migration adds the metadata required to surface accurate, auditable
--   costs in the dashboard and budget-alert engine.
--
-- Schema diagram (cost_records additions):
--
--   cost_records
--   ├── billing_model  cost_billing_model  NOT NULL  DEFAULT 'api-key'
--   ├── source         cost_source         NOT NULL  DEFAULT 'styrby-estimate'
--   ├── raw_agent_payload  JSONB NULL
--   │     └── populated only when source = 'agent-reported'
--   ├── subscription_fraction_used  NUMERIC(5,4) NULL  [0..1]
--   │     └── populated only when billing_model = 'subscription' AND agent exposes quota
--   ├── credits_consumed  INTEGER NULL  >= 0
--   │     └── populated only when billing_model = 'credit'
--   └── credit_rate_usd   NUMERIC(6,4) NULL  >= 0
--         └── point-in-time rate (Kiro: 0.0100); stored so rate changes don't
--             retroactively alter historical cost_usd values
--
-- New index:
--   idx_cost_records_user_billing_date(user_id, billing_model, record_date DESC)
--   Rationale: budget alerts now need to sum/count by billing_model before
--   applying per-model thresholds. Pushing the filter into the index avoids a
--   sequential scan over the already-large (user_id, record_date) result set.
--
-- Dependencies:
--   - Migration 001 (cost_records table, profiles, RLS policies)
--
-- Rollback (manual — only safe before app layer uses new columns):
--   ALTER TABLE cost_records
--     DROP COLUMN IF EXISTS billing_model,
--     DROP COLUMN IF EXISTS source,
--     DROP COLUMN IF EXISTS raw_agent_payload,
--     DROP COLUMN IF EXISTS subscription_fraction_used,
--     DROP COLUMN IF EXISTS credits_consumed,
--     DROP COLUMN IF EXISTS credit_rate_usd;
--   DROP TYPE IF EXISTS cost_billing_model;
--   DROP TYPE IF EXISTS cost_source;
--   DROP INDEX IF EXISTS idx_cost_records_user_billing_date;
-- ============================================================================


-- ============================================================================
-- ENUM: cost_billing_model
-- ============================================================================
-- Describes how the agent session was billed to the end user.
--
--   api-key      — user's own API key; cost_usd = real API spend
--   subscription — agent subscription (e.g. Claude Pro); cost_usd must be $0
--                  because Styrby cannot know the per-session fraction unless
--                  the agent exposes quota data (subscription_fraction_used)
--   credit       — credit-pack billing (Kiro today); total cost derived from
--                  credits_consumed × credit_rate_usd
--   free         — no-charge tier (e.g. Gemini CLI free quota, agent free plan)
--
-- WHY DO $$ block instead of IF NOT EXISTS (which Postgres doesn't support for
-- enums): wrap in an exception handler so re-running the migration (e.g. after
-- a reset) is safe.
-- ============================================================================
DO $$
BEGIN
  CREATE TYPE cost_billing_model AS ENUM (
    'api-key',
    'subscription',
    'credit',
    'free'
  );
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$$;


-- ============================================================================
-- ENUM: cost_source
-- ============================================================================
-- Tracks provenance of the cost figure stored in cost_usd.
--
--   agent-reported   — the agent emitted a usage/cost blob; Styrby recorded it
--                      verbatim (raw_agent_payload holds the raw JSON)
--   styrby-estimate  — Styrby computed cost from token counts + price table;
--                      raw_agent_payload MUST be NULL for these rows (CHECK below)
-- ============================================================================
DO $$
BEGIN
  CREATE TYPE cost_source AS ENUM (
    'agent-reported',
    'styrby-estimate'
  );
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$$;


-- ============================================================================
-- ALTER TABLE cost_records — add new columns
-- ============================================================================
-- DEFAULT clauses handle the backfill of all pre-existing rows:
--   billing_model → 'api-key'      (all historic rows assumed API-key billed)
--   source        → 'styrby-estimate' (all historic rows were estimates)
--   remaining columns → NULL       (N/A for historic rows)
--
-- We use IF NOT EXISTS on each ADD COLUMN so the migration is idempotent and
-- safe to re-run after a partial failure.
-- ============================================================================

ALTER TABLE cost_records
  ADD COLUMN IF NOT EXISTS billing_model cost_billing_model
    NOT NULL DEFAULT 'api-key',

  ADD COLUMN IF NOT EXISTS source cost_source
    NOT NULL DEFAULT 'styrby-estimate',

  -- Raw usage payload from the agent SDK (e.g. Anthropic usage object, Kiro
  -- receipt JSON). Stored for audit trail; app layer parses it separately.
  -- WHY JSONB not TEXT: indexed, queryable, and cheaper to store than escaped
  -- string. We may add GIN indexes on specific fields in a later migration.
  ADD COLUMN IF NOT EXISTS raw_agent_payload JSONB,

  -- Quota fraction consumed this session (0.0000 – 1.0000). Only meaningful
  -- for subscription billing when the agent SDK exposes quota metadata.
  -- NULL when agent does not report quota data.
  ADD COLUMN IF NOT EXISTS subscription_fraction_used NUMERIC(5, 4)
    CHECK (subscription_fraction_used >= 0 AND subscription_fraction_used <= 1),

  -- Number of credits consumed this session (Kiro: integer credits).
  ADD COLUMN IF NOT EXISTS credits_consumed INTEGER
    CHECK (credits_consumed >= 0),

  -- USD-per-credit rate at the time of this record. Stored historically so
  -- that future price changes don't retroactively alter cost_usd values.
  -- WHY NUMERIC(6,4): supports rates from $0.0001 to $99.9999 per credit;
  -- Kiro today is $0.0100. Six digits of precision is ample for foreseeable
  -- credit schemes.
  ADD COLUMN IF NOT EXISTS credit_rate_usd NUMERIC(6, 4)
    CHECK (credit_rate_usd >= 0);


-- ============================================================================
-- CONSTRAINTS
-- ============================================================================

-- Subscription sessions must record $0 variable cost because Styrby has no
-- per-session billing visibility into third-party subscription plans.
-- WHY: Prevents accidental double-counting: if an admin runs a budget report
-- that sums cost_usd across billing_model, subscription rows must be $0 lest
-- we claim costs we did not actually incur.
ALTER TABLE cost_records
  ADD CONSTRAINT chk_subscription_zero_cost
    CHECK (billing_model <> 'subscription' OR cost_usd = 0);

-- Credit records are meaningless without both fields populated because
-- cost_usd = credits_consumed × credit_rate_usd is the only ground truth for
-- credit billing. Requiring both enforces data completeness at write time.
ALTER TABLE cost_records
  ADD CONSTRAINT chk_credit_fields_required
    CHECK (
      billing_model <> 'credit'
      OR (credits_consumed IS NOT NULL AND credit_rate_usd IS NOT NULL)
    );

-- Estimate rows never carry a raw payload; the column is reserved exclusively
-- for agent-reported records so the dashboard can display provenance clearly.
ALTER TABLE cost_records
  ADD CONSTRAINT chk_estimate_no_payload
    CHECK (source = 'agent-reported' OR raw_agent_payload IS NULL);


-- ============================================================================
-- INDEX: idx_cost_records_user_billing_date
-- ============================================================================
-- Supports budget-alert queries that need per-billing_model cost totals for a
-- user within a date window. Without this index the engine must fetch all rows
-- in the existing (user_id, record_date) index and then filter billing_model
-- in-memory — expensive at scale (users can accumulate millions of rows).
--
-- WHY B-tree (not BRIN): billing_model is a low-cardinality enum but we need
-- exact-match filtering on it, which BRIN does not support. B-tree on the
-- composite key is the right tool here.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_cost_records_user_billing_date
  ON cost_records (user_id, billing_model, record_date DESC);


-- ============================================================================
-- COMMENT
-- ============================================================================
COMMENT ON COLUMN cost_records.billing_model IS
  'How this session was billed: api-key (own API key), subscription (flat-rate plan), credit (credit-pack), free.';

COMMENT ON COLUMN cost_records.source IS
  'Provenance of cost_usd: agent-reported (agent SDK emitted usage) or styrby-estimate (derived from token counts + price table).';

COMMENT ON COLUMN cost_records.raw_agent_payload IS
  'Verbatim usage blob from agent SDK when source = ''agent-reported''. NULL for estimates. Stored for audit trail.';

COMMENT ON COLUMN cost_records.subscription_fraction_used IS
  'Fraction of subscription quota consumed (0–1). NULL unless billing_model = ''subscription'' AND agent exposes quota data.';

COMMENT ON COLUMN cost_records.credits_consumed IS
  'Number of credits consumed. Required when billing_model = ''credit'' (see chk_credit_fields_required).';

COMMENT ON COLUMN cost_records.credit_rate_usd IS
  'USD-per-credit rate at recording time. Stored historically so future rate changes do not alter past cost_usd values.';


-- ============================================================================
-- END OF MIGRATION 022
-- ============================================================================
