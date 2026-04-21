-- ============================================================================
-- STYRBY DATABASE MIGRATION 024: Session State Tracking
-- ============================================================================
-- Date:    2026-04-21
-- Author:  Claude Code (claude-sonnet-4-6)
-- Branch:  feat/passkey-ui-2026-04-20
--
-- Phase:   1.6.2 — PR-3: fix session_id placeholder + relay state persistence
-- Spec:    docs/planning/styrby-improve-19Apr.md §1.6.2
--
-- Audit standards cited:
--   SOC2 CC7.2          — System monitoring: session state visibility
--   SOC2 CC6.1          — Logical access controls (RLS unchanged; extends 001)
--   GDPR Art. 5(1)(a)   — Accuracy: data must reflect actual system state
--   ISO 27001 A.12.4    — Logging and monitoring
--
-- WHY this migration exists:
--   AgentSession (styrby-cli) subscribes to RelayClient lifecycle events
--   (connected, reconnecting, error) and calls SessionStorage.updateState()
--   on each transition. updateState() writes two columns:
--
--     status       → already exists (session_status enum in migration 001)
--     last_seen_at → NEW column added here
--
--   `last_seen_at` is distinct from `last_activity_at`:
--     - last_activity_at: updated when a message or cost record is written
--       (high-level user activity, updated infrequently)
--     - last_seen_at: updated on every relay heartbeat or state transition
--       (connection-level, updated every ~15 s while the daemon is live)
--
--   This powers the "Session last seen X minutes ago" indicator in the
--   mobile UI and lets `styrby resume` determine which sessions are
--   actively connected vs stale.
--
-- What this migration adds:
--   1. last_seen_at TIMESTAMPTZ column on sessions (ADD COLUMN IF NOT EXISTS)
--   2. Index on (machine_id, last_seen_at DESC) for efficient "last active
--      daemon per machine" queries
--
-- What this migration does NOT change:
--   - session_status enum: already covers running/paused/error/stopped
--     (added in migration 001, extended in 016)
--   - RLS policies: unchanged — updateState() runs as the authed user and
--     is already covered by sessions_update_own (migration 001)
--
-- Idempotency:
--   - ADD COLUMN IF NOT EXISTS: safe to re-run
--   - CREATE INDEX IF NOT EXISTS: safe to re-run
-- ============================================================================


-- ============================================================================
-- Step 1: Add last_seen_at column to sessions
-- ============================================================================

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Back-fill: set last_seen_at = last_activity_at for existing rows so the
-- column is never NULL for historical sessions.
-- WHY: A NULL last_seen_at on pre-migration sessions would require extra NULL
-- handling in the mobile UI ("last seen: unknown"). Defaulting to
-- last_activity_at is the most accurate estimate we have.
UPDATE sessions
  SET last_seen_at = last_activity_at
  WHERE last_seen_at IS NULL;

-- Comment for schema introspection
COMMENT ON COLUMN sessions.last_seen_at IS
  'Timestamp of the most recent relay heartbeat or connection state transition. '
  'Updated by AgentSession on every RelayClient event (connected/reconnecting/error). '
  'Distinct from last_activity_at (which tracks message/cost writes). '
  'Powers "Session last seen X minutes ago" in the mobile UI.';


-- ============================================================================
-- Step 2: Index for efficient "last active session per machine" lookup
-- ============================================================================
-- WHY: `styrby resume` needs to find the most recently-seen non-ended session
-- for a given machine. This partial index covers the query pattern:
--   SELECT id FROM sessions
--   WHERE machine_id = $1
--     AND status IN ('running', 'paused', 'idle')
--   ORDER BY last_seen_at DESC
--   LIMIT 1;
-- The partial predicate mirrors idx_sessions_machine_active from migration 001
-- so the planner can use either index.

CREATE INDEX IF NOT EXISTS idx_sessions_machine_last_seen
  ON sessions(machine_id, last_seen_at DESC)
  WHERE status IN ('starting', 'running', 'idle', 'paused')
    AND deleted_at IS NULL;
