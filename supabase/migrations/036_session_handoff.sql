-- Migration 036: Session Handoff — cross-device session state snapshots + device registry
--
-- WHY: Enables "start on desktop, continue on phone" UX (Phase 3.2).
-- When a user switches devices mid-session, we restore cursor position,
-- scroll offset, and any unsent draft — eliminating the "where was I?"
-- context loss that plagues competing tools.
--
-- SOC2 CC6.1: Session continuity across devices is a controlled state
-- transition. All writes are scoped to the owning user via RLS, and
-- snapshots are automatically purged after 30 days to limit data retention.

-- ============================================================================
-- devices table
-- Lightweight device registry — records which surfaces a user accesses
-- Styrby from so handoff banners can label the origin device.
-- ============================================================================

CREATE TABLE IF NOT EXISTS devices (
  -- Stable UUID v7 generated on first app launch and persisted client-side.
  -- UUID v7 is time-ordered, which aids chronological queries.
  id          TEXT        PRIMARY KEY,

  -- Owner of this device record.
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Surface kind for display labels in the handoff banner.
  -- WHY ENUM TEXT not a Postgres enum: Postgres enum alters require
  -- table rewrites; a CHECK constraint is zero-cost to extend later.
  kind        TEXT        NOT NULL CHECK (kind IN ('web', 'mobile_ios', 'mobile_android', 'cli')),

  -- Updated on every app launch / CLI startup so stale devices are visible.
  last_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  CONSTRAINT devices_user_kind_id_valid CHECK (char_length(id) BETWEEN 1 AND 64)
);

-- Index for per-user device lookups
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

-- RLS: users can only see and manage their own device records.
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "devices: user can select own" ON devices
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "devices: user can insert own" ON devices
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "devices: user can update own" ON devices
  FOR UPDATE USING (user_id = (SELECT auth.uid()));

CREATE POLICY "devices: user can delete own" ON devices
  FOR DELETE USING (user_id = (SELECT auth.uid()));

-- ============================================================================
-- session_state_snapshots table
-- Periodic snapshots of UI state (cursor, scroll, draft) per device.
-- Written every 10 s or on significant state change (message sent,
-- app backgrounded). The "latest snapshot" lookup drives the handoff banner.
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_state_snapshots (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owning session; cascade-delete all snapshots when the session is removed.
  session_id       UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- ISO timestamp; used for "latest snapshot" lookup and retention expiry.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Which device wrote this snapshot (matches devices.id).
  device_id        TEXT        NOT NULL,

  -- Index into the session_messages array (0-based).
  -- WHY: We store an index rather than a message ID because the handoff
  -- receiver may not have loaded all messages yet. The index lets the
  -- client scroll to the right position even before older messages load.
  cursor_position  INTEGER     NOT NULL DEFAULT 0,

  -- Pixel offset within the focused message bubble for long tool outputs.
  scroll_offset    INTEGER     NOT NULL DEFAULT 0,

  -- Unsent message text the user was composing when the snapshot was taken.
  -- Stored as plaintext; no PII beyond what the user typed in the input box.
  active_draft     TEXT,

  -- Schema version for forward-compatibility.
  -- Increment this if the snapshot semantics change in a later migration.
  snapshot_version INTEGER     NOT NULL DEFAULT 1
);

-- Partial index optimised for the "latest snapshot for a session" query:
--   SELECT * FROM session_state_snapshots
--   WHERE session_id = $1
--   ORDER BY created_at DESC LIMIT 1
-- The DESC ordering on created_at matches the B-tree scan direction,
-- making this a single index page read rather than a full table scan.
CREATE INDEX IF NOT EXISTS idx_sss_session_created
  ON session_state_snapshots(session_id, created_at DESC);

-- RLS: users can only read/write snapshots for sessions they own.
-- WHY JOIN path: snapshots do not store user_id directly to keep the row
-- lean. We join through sessions which has user_id (and its own RLS).
-- Using a security-definer function is unnecessary here because the
-- sub-select pattern is equivalent and does not require SUPERUSER grants.
ALTER TABLE session_state_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sss: user can select own" ON session_state_snapshots
  FOR SELECT USING (
    session_id IN (
      SELECT id FROM sessions WHERE user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "sss: user can insert own" ON session_state_snapshots
  FOR INSERT WITH CHECK (
    session_id IN (
      SELECT id FROM sessions WHERE user_id = (SELECT auth.uid())
    )
  );

-- No UPDATE policy — snapshots are immutable once written.
-- No DELETE policy for users — retention is handled by the pg_cron job below.

-- ============================================================================
-- Retention: pg_cron nightly purge
-- Delete snapshots older than 30 days to bound table growth.
-- WHY 30 days: Matches session history retention on the Free tier and
-- aligns with GDPR Art. 5(1)(e) storage-limitation principle.
-- Supabase pins pg_cron to pg_catalog; the cron.schedule() call works
-- from migrations even though the schema is not extensions.
-- ============================================================================

SELECT cron.schedule(
  'purge-old-snapshots',           -- job name (idempotent if already exists)
  '0 3 * * *',                     -- 03:00 UTC nightly (low-traffic window)
  $$
    DELETE FROM session_state_snapshots
    WHERE created_at < NOW() - INTERVAL '30 days';
  $$
);
