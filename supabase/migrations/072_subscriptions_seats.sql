-- Migration 072: Add `seats` column to subscriptions table.
--
-- WHY: After Polar pricing-model verification (2026-05-04), the Growth tier
-- is a single seat-based subscription where Polar's webhook fires with
-- `seats: N` on the subscription event. The `subscriptions` table previously
-- had no place to record this, so the seat count was silently dropped on
-- every Growth signup. Customer paid for N seats but the app had no record.
--
-- Architectural decision (P0-BILLING-4):
--   - `subscriptions.seats` is the SOURCE OF TRUTH for "how many seats did
--     this user pay for, per Polar".
--   - `teams.seat_cap` is the SOURCE OF TRUTH for "how many seats are
--     assignable in this team workspace".
--   - When a Growth subscriber creates their first team, the team-creation
--     RPC copies `subscriptions.seats → teams.seat_cap`. Until then, the
--     paid seat count lives on the subscription row and surfaces in the
--     dashboard as "you have N seats waiting to be assigned".
--   - This avoids forcing a team-creation step inside the checkout flow,
--     which would block solo-buyer Growth signups.
--
-- Backfill: NONE. The column is NULL for existing rows. Free + Pro are
-- single-seat plans and are correctly NULL. Existing legacy team/business
-- subscriptions (if any) carry their seat count on `teams.seat_cap`, not
-- here, so a NULL on those is correct too.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS seats INTEGER NULL
  CHECK (seats IS NULL OR seats > 0);

COMMENT ON COLUMN subscriptions.seats IS
  'Number of seats the user paid for, per Polar. NULL for non-seat tiers '
  '(free, pro) or for legacy team subscriptions whose seat count lives on '
  'teams.seat_cap. For Growth subscriptions this mirrors Polar Subscription.seats. '
  'Webhook handler keeps this in sync on subscription.created / .updated events.';

-- Partial index: only Growth (or any other future seat-based tier) writes
-- non-null values, so a partial index keeps the index small while still
-- supporting the dashboard's "users with N+ seats" admin query.
CREATE INDEX IF NOT EXISTS subscriptions_seats_idx
  ON subscriptions(seats)
  WHERE seats IS NOT NULL;
