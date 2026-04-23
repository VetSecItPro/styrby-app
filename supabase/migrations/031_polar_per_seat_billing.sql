-- ============================================================================
-- Migration 031: Polar Per-Seat Billing (Phase 2.6)
--
-- Adds billing state columns to `teams`, an idempotency table for Polar
-- webhook events, and billing-specific audit action values.
--
-- WHY this migration exists: Phase 2.6 introduces per-seat subscription
-- billing via Polar. The `teams` table must carry enough billing state for
-- the webhook handler (Unit B) to reconcile Polar events without a network
-- round-trip on every API request. The polar_webhook_events table is the
-- deduplication key that makes the webhook handler idempotent — Polar can
-- (and does) replay events on delivery failures, so processing the same
-- event twice must be detectable and safe.
--
-- SOC2 CC7.2: Billing-state transitions are material audit evidence. Every
-- subscription lifecycle event writes a row to audit_log using the new
-- action values added at the bottom of this migration.
--
-- Idempotency strategy: every ALTER/CREATE uses IF NOT EXISTS / DROP IF
-- EXISTS so re-running this migration on an already-migrated database is
-- a no-op rather than an error.
-- ============================================================================

-- ============================================================================
-- 1. Billing state columns on teams
-- ============================================================================

-- WHY polar_subscription_id is nullable on creation: a team row is created
-- when the team owner first signs up; they do not have a Polar subscription
-- yet. The column is populated by the checkout webhook (Unit B) on first
-- successful subscription creation. UNIQUE ensures one Polar subscription
-- can map to exactly one Styrby team — prevents duplicate webhook processing
-- from attaching the same subscription to multiple teams.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS polar_subscription_id TEXT;

-- WHY add constraint separately (idempotent): ADD COLUMN IF NOT EXISTS does
-- not fail when the column already exists, but ADD CONSTRAINT would fail if
-- the constraint already exists. DROP + ADD gives us a clean idempotent path.
ALTER TABLE teams
  DROP CONSTRAINT IF EXISTS teams_polar_subscription_id_unique;
ALTER TABLE teams
  ADD CONSTRAINT teams_polar_subscription_id_unique
    UNIQUE (polar_subscription_id);

-- WHY billing_tier on teams rather than relying solely on subscriptions table:
-- The subscriptions table stores Polar-synced data for individual users.
-- Teams billing is an org-level concept: one subscription covers N seats.
-- Denormalising the tier onto teams avoids a join on every API request and
-- lets the seat-cap validator in migration 030 gate on a single column.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS billing_tier TEXT NOT NULL DEFAULT 'free'
    CHECK (billing_tier IN ('free', 'team', 'business', 'enterprise'));

-- WHY billing_status: we need to distinguish a team mid-payment-failure
-- (past_due) from one in a grace period (grace_period) from an active team.
-- These states drive UI banners and access gating without a Polar API call.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'active'
    CHECK (billing_status IN ('trialing', 'active', 'past_due', 'canceled', 'grace_period'));

-- WHY billing_cycle: monthly vs. annual pricing differ in proration math.
-- The webhook handler needs this when calculating mid-cycle seat changes.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'annual'));

-- WHY trial_ends_at is nullable: not all plans offer a trial. Teams created
-- via admin override or enterprise deals may start directly in 'active' state.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- WHY grace_period_ends_at is nullable: it is only populated when
-- billing_status transitions to 'past_due'. A NULL value here means the team
-- is not in a grace period. The grace period is 7 days post-payment failure
-- (configurable in the webhook handler, Unit B). After grace_period_ends_at
-- passes, a scheduled job downgrades billing_status to 'canceled'.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS grace_period_ends_at TIMESTAMPTZ;

-- Index for the scheduled grace-period expiry job: finds all teams whose
-- grace period has ended and whose status is still past_due/grace_period.
CREATE INDEX IF NOT EXISTS idx_teams_grace_period_expiry
  ON teams (grace_period_ends_at)
  WHERE billing_status IN ('past_due', 'grace_period')
    AND grace_period_ends_at IS NOT NULL;

-- ============================================================================
-- 2. polar_webhook_events — idempotency / dedup table
-- ============================================================================

-- WHY a dedicated table rather than checking audit_log: audit_log is an
-- append-only evidence trail and should not be used for control flow.
-- polar_webhook_events is the authoritative lock: the webhook handler does a
-- single INSERT with ON CONFLICT DO NOTHING and checks rows-affected to decide
-- whether to proceed. If rows-affected = 0, the event was already processed.
--
-- WHY payload_hash (SHA-256): Polar's event ID is the primary dedup key, but
-- we also store a hash of the full payload so we can detect replay attacks
-- where an attacker replays a valid event ID with a modified payload. If the
-- event_id is seen again but payload_hash differs, the handler raises an alert.
--
-- SOC2 CC7.2: This table is the audit trail for idempotent webhook processing.
-- Every row represents one successfully-processed billing event.

CREATE TABLE IF NOT EXISTS polar_webhook_events (
  -- Polar's own event UUID — used as the primary dedup key.
  event_id       TEXT        PRIMARY KEY,

  -- WHY event_type stored separately: allows fast filtered queries such as
  -- "how many subscription.created events were processed this month?"
  event_type     TEXT        NOT NULL,

  -- nullable — some Polar events (e.g. customer.created) are not scoped to
  -- a subscription. webhook handler sets this when present in the payload.
  subscription_id TEXT,

  -- WHY DEFAULT NOW(): the processed_at timestamp is set by the DB, not the
  -- application. Clock skew between the edge function and the DB is irrelevant
  -- because we only need this for ordering, not billing calculation.
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- SHA-256 of the full raw webhook payload (hex-encoded). Used for replay
  -- attack detection — see comment above. NOT NULL because we always have a
  -- payload when inserting.
  payload_hash   TEXT        NOT NULL
);

COMMENT ON TABLE polar_webhook_events IS
  'Deduplication table for Polar webhook events (Phase 2.6). '
  'The webhook handler inserts a row on first processing and detects replays '
  'via ON CONFLICT DO NOTHING. payload_hash guards against replay attacks '
  'where event_id is reused with a different payload. '
  'SOC2 CC7.2: every row is billing audit evidence.';

COMMENT ON COLUMN polar_webhook_events.event_id IS
  'Polar event UUID — primary dedup key. Matches the `id` field in Polar webhook body.';

COMMENT ON COLUMN polar_webhook_events.payload_hash IS
  'SHA-256 (hex) of the full raw request body. Used to detect modified replays '
  'where the same event_id arrives with different payload contents.';

-- Index on (event_type, processed_at DESC): supports analytics queries
-- like "all subscription.updated events in the last 30 days".
CREATE INDEX IF NOT EXISTS idx_polar_webhook_events_type_time
  ON polar_webhook_events (event_type, processed_at DESC);

-- ============================================================================
-- 2a. RLS on polar_webhook_events — service_role ONLY
-- ============================================================================

-- WHY nobody from the client can touch this table: polar_webhook_events
-- contains billing audit evidence. The edge function uses the service_role
-- key and bypasses RLS intentionally (SECURITY DEFINER / service key).
-- Client-side access would allow a malicious user to insert fake event records
-- and fool the dedup check, enabling double-processing of billing webhooks.

ALTER TABLE polar_webhook_events ENABLE ROW LEVEL SECURITY;

-- Deny all client access (service_role bypasses RLS automatically).
-- We create explicit DENY policies rather than relying on "no policy = deny"
-- so that the intent is auditable via pg_policies.
DROP POLICY IF EXISTS polar_webhook_events_no_select ON polar_webhook_events;
CREATE POLICY polar_webhook_events_no_select
  ON polar_webhook_events FOR SELECT
  USING (false);

DROP POLICY IF EXISTS polar_webhook_events_no_insert ON polar_webhook_events;
CREATE POLICY polar_webhook_events_no_insert
  ON polar_webhook_events FOR INSERT
  WITH CHECK (false);

DROP POLICY IF EXISTS polar_webhook_events_no_update ON polar_webhook_events;
CREATE POLICY polar_webhook_events_no_update
  ON polar_webhook_events FOR UPDATE
  USING (false);

DROP POLICY IF EXISTS polar_webhook_events_no_delete ON polar_webhook_events;
CREATE POLICY polar_webhook_events_no_delete
  ON polar_webhook_events FOR DELETE
  USING (false);

-- ============================================================================
-- 3. Extend audit_action enum with billing-specific values
-- ============================================================================

-- WHY ALTER TYPE ... ADD VALUE IF NOT EXISTS: Postgres enum extensions are
-- non-transactional (they take effect immediately, not at transaction commit).
-- IF NOT EXISTS makes each statement idempotent — re-running the migration
-- does not error if the value already exists. This matches the pattern
-- established in migrations 025, 028, 030.
--
-- SOC2 CC7.2: These action values are material billing audit evidence.
-- Every subscription lifecycle event and seat-count change writes a row
-- to audit_log using one of these values, creating an immutable trail of
-- who changed what billing state and when.

-- Subscription lifecycle events
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_subscription_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_subscription_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_subscription_canceled';

-- Seat count change events
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_seat_count_increased';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_seat_count_decreased';

-- Payment failure / grace period lifecycle events
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_billing_grace_period_entered';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_billing_past_due';

-- Checkout and downgrade guard events
-- WHY team_checkout_initiated: written by POST /api/billing/checkout/team at the moment
-- a team-tier Polar checkout session is created. Provides an audit trail of intent
-- before any Polar webhook fires — important for reconciliation if a checkout
-- completes but the webhook is delayed or dropped. SOC2 CC7.2 requires we log
-- every billing state-change attempt, not just confirmed transitions.
--
-- WHY team_downgrade_blocked: written by POST /api/billing/seats when a seat
-- reduction would violate the minimum seat floor for the current billing tier
-- (e.g. attempting to drop a Team plan below 3 seats). Logging the blocked
-- attempt gives ops visibility into customer friction points and confirms the
-- floor enforcement is firing as intended.
--
-- Full taxonomy of all 9 billing audit_action values added in this migration:
--   Subscription lifecycle:  team_subscription_created, team_subscription_updated, team_subscription_canceled
--   Seat count changes:      team_seat_count_increased, team_seat_count_decreased
--   Payment failure:         team_billing_grace_period_entered, team_billing_past_due
--   Checkout / guards:       team_checkout_initiated, team_downgrade_blocked
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_checkout_initiated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_downgrade_blocked';
