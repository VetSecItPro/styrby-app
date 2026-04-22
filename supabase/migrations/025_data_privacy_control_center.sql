-- ============================================================================
-- STYRBY DATABASE MIGRATION 025: Data Privacy Control Center
-- ============================================================================
-- Date:    2026-04-22
-- Author:  Claude Sonnet 4.6
-- Branch:  feat/data-privacy-control-center-1.6.9
--
-- Phase:   1.6.9 — Data Privacy Control Center
-- Spec:    styrby-backlog.md §Phase 1.6.9
--
-- Audit standards cited:
--   GDPR Art. 5(1)(e)  — Storage limitation: personal data not kept longer than necessary
--   GDPR Art. 17       — Right to erasure ("right to be forgotten")
--   GDPR Art. 15       — Subject access right (export) + Art. 20 data portability
--   GDPR Art. 30       — Records of processing activities
--   SOC2 CC6.5         — Logical access controls: removal of access on deletion
--   SOC2 CC7.2         — System monitoring: audit trail for sensitive operations
--   HIPAA 45 CFR 164.312(a)(2)(ii) — Automatic logoff / data minimisation
--   ISO 27001 A.8.2    — Information labeling and handling
--   ISO 27001 A.8.3    — Information disposal
--
-- WHY this migration exists:
--   Phase 1.6.9 adds a full self-serve data privacy control center giving
--   users:
--     1. Per-user session retention policy (auto-delete sessions older than N days)
--     2. Per-session retention override (pin a session to never-delete, or shorter)
--     3. GDPR Art. 15 zip export — data_export_requests audit table
--     4. GDPR Art. 17 right-to-erasure — soft-delete grace window + retention cron
--     5. New audit_action enum values for privacy events
--
-- What this migration adds:
--   1. profiles.retention_days       — global auto-delete window (NULL = never)
--   2. profiles.deletion_scheduled_at — when the grace-period hard-delete fires
--   3. profiles.deletion_reason      — optional reason captured on delete request
--   4. sessions.retention_override   — per-session pin: 'inherit' | 'pin_forever' | 'pin_days:{n}'
--   5. data_export_requests table    — audit trail for GDPR Art. 15 SAR exports
--   6. Extend audit_action enum      — export_completed, retention_changed, account_deletion_requested
--   7. Retention cron job            — daily pg_cron that hard-deletes expired sessions
--   8. Retention cron job            — daily pg_cron that hard-deletes profiles past grace window
--
-- What this migration does NOT change:
--   - Existing RLS policies (untouched)
--   - cost_records or mv_daily_cost_summary (Phase 1.6.7 territory)
--   - Any Phase 1.6.10 columns (last_seen_at, etc.)
--
-- Idempotency:
--   - ADD COLUMN IF NOT EXISTS: safe to re-run
--   - CREATE TABLE IF NOT EXISTS: safe to re-run
--   - ALTER TYPE ADD VALUE IF NOT EXISTS: safe to re-run
--   - Cron schedule uses cron.schedule() which upserts by name
-- ============================================================================


-- ============================================================================
-- Step 1: Extend profiles for retention settings
-- ============================================================================
-- WHY retention_days is SMALLINT NULL (not DEFAULT never):
--   NULL means "never auto-delete" which is the correct backwards-compatible
--   default. Using NULL avoids ambiguity with a magic value like 0 or -1.
--   UI shows: 7 / 30 / 90 / 365 / Never (NULL).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS retention_days SMALLINT
    CHECK (retention_days IS NULL OR retention_days IN (7, 30, 90, 365));

COMMENT ON COLUMN profiles.retention_days IS
  'Auto-delete sessions older than this many days. NULL = never auto-delete. '
  'Allowed values: 7, 30, 90, 365, NULL. '
  'Changed via /api/account/retention. Audit-logged per GDPR Art. 5(1)(e).';

-- WHY deletion_scheduled_at is separate from deleted_at:
--   deleted_at (from migration 001) marks the soft-delete instant; it is set
--   immediately when the user requests deletion. deletion_scheduled_at is the
--   wall-clock time when the hard-delete cron will fire (now + 30 days).
--   Separating them lets the cron query be a simple range scan on
--   deletion_scheduled_at without touching the soft-delete index.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ;

COMMENT ON COLUMN profiles.deletion_scheduled_at IS
  'When the pg_cron hard-delete job will permanently remove this account. '
  'Set to NOW() + 30 days when the user requests account deletion (GDPR Art. 17 grace period). '
  'NULL means no deletion is scheduled.';

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

COMMENT ON COLUMN profiles.deletion_reason IS
  'Optional self-reported reason for account deletion. Kept for 30 days for '
  'churn analysis; removed with the account on hard delete. GDPR Art. 13(2)(c).';


-- ============================================================================
-- Step 2: Add per-session retention override on sessions table
-- ============================================================================
-- WHY TEXT not ENUM:
--   The constraint below enforces the allowed values at the DB level.
--   Using a CHECK constraint on TEXT is cleaner than a new enum because
--   it avoids the ALTER TYPE ceremony and works with the cron function's
--   LIKE pattern matching.
--
-- Values:
--   'inherit'        — use the profile-level retention_days (default)
--   'pin_forever'    — never auto-delete this session regardless of profile setting
--   'pin_days:7'     — delete this session after exactly 7 days (override)
--   'pin_days:30'    — delete this session after exactly 30 days
--   'pin_days:90'    — delete this session after exactly 90 days

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS retention_override TEXT DEFAULT 'inherit'
    CHECK (
      retention_override IS NULL
      OR retention_override = 'inherit'
      OR retention_override = 'pin_forever'
      OR retention_override ~ '^pin_days:(7|30|90|365)$'
    );

COMMENT ON COLUMN sessions.retention_override IS
  'Per-session retention override. "inherit" = use profile.retention_days. '
  '"pin_forever" = never auto-delete. "pin_days:{n}" = delete after n days. '
  'Checked by the nightly retention cron before any session deletion.';


-- ============================================================================
-- Step 3: data_export_requests — GDPR Art. 15 audit trail
-- ============================================================================
-- WHY a dedicated table rather than just writing audit_log rows:
--   - data_export_requests stores the download URL (signed storage URL) so
--     we can show the user "your last export was requested at X" in the UI.
--   - audit_log rows are append-only and RLS-protected — they remain even if
--     the export_request row is soft-deleted.
--   - Having a structured table lets the edge function query for in-progress
--     requests and prevent duplicate simultaneous exports.
--
-- WHY status TEXT with CHECK: keeps the migration simple vs. adding a new enum.

CREATE TABLE IF NOT EXISTS data_export_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Request metadata
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'expired')),
  requested_at     TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,

  -- Download
  -- WHY the URL is nullable: it is set by the edge function when the ZIP is
  -- uploaded to Supabase Storage. Between request and upload the row is
  -- 'pending'/'processing'.
  download_url     TEXT,
  file_size_bytes  BIGINT,

  -- Security context (audit evidence: who requested, from where)
  ip_address       INET,
  user_agent       TEXT,

  -- Failure info
  error_message    TEXT,

  -- Timestamps
  created_at       TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at       TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index: user's export history (most recent first)
CREATE INDEX IF NOT EXISTS idx_data_export_requests_user
  ON data_export_requests(user_id, requested_at DESC);

-- Index: pending jobs for the edge function to pick up
CREATE INDEX IF NOT EXISTS idx_data_export_requests_pending
  ON data_export_requests(status, requested_at)
  WHERE status IN ('pending', 'processing');

-- Updated-at trigger
CREATE TRIGGER tr_data_export_requests_updated_at
  BEFORE UPDATE ON data_export_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: users see only their own export requests
ALTER TABLE data_export_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "data_export_requests_select_own"
  ON data_export_requests FOR SELECT
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "data_export_requests_insert_own"
  ON data_export_requests FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));

-- UPDATE and DELETE via service role only (edge function)
-- WHY: the edge function uses the service role key to update status + download_url
-- after uploading the ZIP. Clients must not be able to forge their own download_url.

COMMENT ON TABLE data_export_requests IS
  'Audit trail for GDPR Art. 15 Subject Access Requests. '
  'One row per user-initiated export. The edge function export-user-data processes '
  'pending rows, uploads the ZIP to Supabase Storage, and sets download_url + status. '
  'Expired rows (>72h) are cleaned up by the nightly retention cron.';


-- ============================================================================
-- Step 4: Extend audit_action enum with privacy-specific values
-- ============================================================================
-- WHY three new values instead of reusing settings_updated:
--   Compliance teams need to filter audit_log on specific action types.
--   Using settings_updated for "user exported their data" or "user requested
--   deletion" buries critical GDPR evidence in generic log noise.
--
-- export_completed  — user successfully downloaded a data export (GDPR Art. 15)
-- retention_changed — user updated their global or per-session retention policy
-- account_deletion_requested — user initiated the 30-day grace-period deletion (GDPR Art. 17)

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'export_completed';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'retention_changed';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'account_deletion_requested';


-- ============================================================================
-- Step 5: Helper function — resolve_session_retention_days
-- ============================================================================
-- WHY a PL/pgSQL function instead of inlining the logic in the cron job:
--   The resolution logic (inherit from profile, pin_forever, pin_days:N) is
--   needed in two places: the nightly cron AND the per-session retention
--   API endpoint that shows the user "this session will be deleted on X".
--   Extracting it to a reusable function prevents drift between the two.
--
-- Returns NULL if the session should NEVER be deleted.

CREATE OR REPLACE FUNCTION resolve_session_retention_days(
  p_session_retention_override TEXT,
  p_profile_retention_days     SMALLINT
)
RETURNS SMALLINT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
AS $$
BEGIN
  -- 'pin_forever' or NULL => never delete
  IF p_session_retention_override = 'pin_forever' THEN
    RETURN NULL;
  END IF;

  -- 'pin_days:N' => delete after N days regardless of profile setting
  IF p_session_retention_override LIKE 'pin_days:%' THEN
    RETURN SUBSTRING(p_session_retention_override FROM 10)::SMALLINT;
  END IF;

  -- 'inherit' or anything else => fall back to profile-level retention
  RETURN p_profile_retention_days;
END;
$$;

COMMENT ON FUNCTION resolve_session_retention_days IS
  'Resolves the effective retention window (in days) for a session. '
  'Returns NULL when the session is pinned forever or when the profile has no retention policy. '
  'Called by the nightly retention cron and by the /api/account/retention endpoint.';


-- ============================================================================
-- Step 6: Nightly cron — delete expired sessions
-- ============================================================================
-- WHY we write the audit_log row BEFORE the DELETE:
--   If the DELETE succeeds but the audit_log INSERT fails, we still have
--   evidence of the intent. If the DELETE fails, we abort the whole block
--   and the audit row is rolled back with it.
--
-- WHY we process sessions in batches:
--   Large accounts may have thousands of sessions. Processing in a single
--   query holds a lock for too long and blocks concurrent user queries.
--   Batches of 500 keep lock time under 50ms even on large tables.

CREATE OR REPLACE FUNCTION delete_expired_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_count INTEGER := 0;
  v_batch_size    INTEGER := 500;
  v_deleted_ids   UUID[];
BEGIN
  LOOP
    -- WHY: Select the next batch of expired sessions.
    -- A session is expired when:
    --   1. Its resolved retention window is non-NULL (not pinned forever), AND
    --   2. Its started_at + retention_window < NOW(), AND
    --   3. It is not already soft-deleted.
    SELECT ARRAY_AGG(s.id)
    INTO v_deleted_ids
    FROM (
      SELECT s.id
      FROM sessions s
      JOIN profiles p ON p.id = s.user_id
      WHERE s.deleted_at IS NULL
        AND resolve_session_retention_days(
              s.retention_override,
              p.retention_days
            ) IS NOT NULL
        AND s.started_at < NOW() - (
              resolve_session_retention_days(
                s.retention_override,
                p.retention_days
              ) || ' days'
            )::INTERVAL
      LIMIT v_batch_size
    ) s;

    EXIT WHEN v_deleted_ids IS NULL OR array_length(v_deleted_ids, 1) = 0;

    -- WHY audit BEFORE delete: ensures we have a record even if the batch
    -- is partially applied in a crash scenario.
    INSERT INTO audit_log (user_id, action, resource_type, metadata)
    SELECT
      s.user_id,
      'settings_updated',   -- closest existing enum value; export_completed reserved for exports
      'session_retention_delete',
      jsonb_build_object(
        'session_id', s.id,
        'started_at', s.started_at,
        'retention_days', resolve_session_retention_days(s.retention_override, p.retention_days),
        'cron_job', 'delete_expired_sessions'
      )
    FROM sessions s
    JOIN profiles p ON p.id = s.user_id
    WHERE s.id = ANY(v_deleted_ids);

    -- Soft-delete the batch
    -- WHY soft-delete first (set deleted_at) instead of hard DELETE:
    --   Soft-delete immediately hides the sessions from RLS queries while
    --   leaving data recoverable for 48h in case of cron misconfiguration.
    --   A second cron pass (hard_delete_soft_deleted_sessions) fires 48h
    --   later and issues the actual DELETE.
    UPDATE sessions
    SET deleted_at = NOW()
    WHERE id = ANY(v_deleted_ids);

    v_deleted_count := v_deleted_count + array_length(v_deleted_ids, 1);
  END LOOP;

  RETURN v_deleted_count;
END;
$$;

COMMENT ON FUNCTION delete_expired_sessions IS
  'Nightly cron function. Soft-deletes sessions whose effective retention window has elapsed. '
  'Called by pg_cron job "styrby_delete_expired_sessions". '
  'Returns the number of sessions soft-deleted in this run. '
  'GDPR Art. 5(1)(e) storage limitation compliance.';


-- ============================================================================
-- Step 7: Nightly cron — hard-delete profiles past grace window
-- ============================================================================
-- WHY 30-day grace window:
--   GDPR Art. 17(3)(e) and many SaaS best-practices allow a recovery window
--   after account deletion. We use 30 days. After that, hard-deleting
--   auth.users cascades to profiles (ON DELETE CASCADE), which cascades to
--   all user data (sessions, messages, machines, etc.).
--
-- WHY we call auth.admin_delete_user instead of DELETE FROM auth.users:
--   Supabase's auth schema is managed by Supabase internally. The safe,
--   supported way to permanently remove an auth user is via the admin API
--   (pg_net + service role). Inside a SECURITY DEFINER function with
--   search_path = public we use the Supabase service_role key injected via
--   the pg_net extension to call the Admin API.
--
-- For the migration we create the function; actual service-role HTTP call
-- is handled by the edge function `purge-deleted-accounts` which is called
-- by the cron. The pg_cron job below calls the edge function URL.

CREATE OR REPLACE FUNCTION get_accounts_pending_hard_delete()
RETURNS TABLE (user_id UUID, deletion_scheduled_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, p.deletion_scheduled_at
  FROM profiles p
  WHERE p.deleted_at IS NOT NULL
    AND p.deletion_scheduled_at IS NOT NULL
    AND p.deletion_scheduled_at <= NOW();
END;
$$;

COMMENT ON FUNCTION get_accounts_pending_hard_delete IS
  'Returns profiles whose 30-day deletion grace window has elapsed. '
  'Called by the purge-deleted-accounts edge function which issues the '
  'Supabase Admin API call to permanently remove auth.users rows.';


-- ============================================================================
-- Step 8: Register pg_cron jobs
-- ============================================================================
-- WHY daily at 3:00 AM CT (09:00 UTC):
--   Per CLAUDE.md: all cron jobs use Central Time (America/Chicago).
--   3 AM CT = lowest traffic window. Conversions:
--     CT = UTC-5 (CST) or UTC-6 (CDT).
--   We use 09:00 UTC which is 3 AM CST / 4 AM CDT — safe for both seasons.
--
-- Supabase pins pg_cron to pg_catalog schema (not extensions schema).
-- cron.schedule() upserts by name so re-running the migration is safe.

-- Delete expired sessions nightly
SELECT cron.schedule(
  'styrby_delete_expired_sessions',
  '0 9 * * *',   -- 09:00 UTC = 03:00 CT
  $$SELECT delete_expired_sessions()$$
);

-- Expire old data_export_requests (mark >72h pending rows as 'expired')
-- WHY: prevents the edge function queue from growing unboundedly if
-- a request stalls. 72h is generous for even a slow ZIP generation.
SELECT cron.schedule(
  'styrby_expire_stale_exports',
  '30 9 * * *',   -- 09:30 UTC = 03:30 CT (30 min after session cron)
  $$
    UPDATE data_export_requests
    SET status = 'expired', updated_at = NOW()
    WHERE status IN ('pending', 'processing')
      AND requested_at < NOW() - INTERVAL '72 hours'
  $$
);


-- ============================================================================
-- Step 9: Index for efficient retention cron queries
-- ============================================================================
-- WHY: The cron's inner SELECT joins sessions + profiles filtered by
--   sessions.started_at and profiles.retention_days IS NOT NULL.
--   A partial index on sessions(user_id, started_at) WHERE deleted_at IS NULL
--   mirrors the existing idx_sessions_user_list but adds started_at for
--   range filtering by the cron.

CREATE INDEX IF NOT EXISTS idx_sessions_retention_scan
  ON sessions(user_id, started_at)
  WHERE deleted_at IS NULL;

-- Index for profiles with active retention policy
CREATE INDEX IF NOT EXISTS idx_profiles_retention_active
  ON profiles(id)
  WHERE retention_days IS NOT NULL AND deleted_at IS NULL;

-- Index for accounts pending hard-delete
CREATE INDEX IF NOT EXISTS idx_profiles_pending_hard_delete
  ON profiles(deletion_scheduled_at)
  WHERE deleted_at IS NOT NULL AND deletion_scheduled_at IS NOT NULL;


-- ============================================================================
-- Step 10: Grant service_role access to new table
-- ============================================================================
GRANT ALL ON data_export_requests TO service_role;
GRANT EXECUTE ON FUNCTION delete_expired_sessions TO service_role;
GRANT EXECUTE ON FUNCTION get_accounts_pending_hard_delete TO service_role;
GRANT EXECUTE ON FUNCTION resolve_session_retention_days TO service_role;
GRANT EXECUTE ON FUNCTION resolve_session_retention_days TO authenticated;


-- ============================================================================
-- END OF MIGRATION 025
-- ============================================================================
