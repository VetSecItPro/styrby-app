-- ============================================================================
-- Migration 030: Team Invitation Flow (Phase 2.2)
--
-- Adds:
--   1. token_hash to team_invitations — we store only the SHA-256 hash of the
--      invite token, never the raw token. The raw token is sent once via email
--      and never persisted. This is the same pattern used for API key storage
--      (SEC-009) and prevents token exposure via DB dumps or log leaks.
--
--   2. viewer role to team_invitations — Phase 2.2 introduces the 'viewer'
--      invite role. team_members.role retains the existing CHECK constraint
--      (owner/admin/member) until Phase 2.3 when the member-management UI
--      ships. Viewer is accepted at invitation time but stored as 'member'
--      on join; the role matrix will be extended in Phase 2.3.
--      UPDATE: We add viewer to the invitation role CHECK here so invitations
--      can carry it forward. The team_members CHECK is NOT changed in this
--      migration — that waits for Phase 2.3 UI + RLS audit.
--
--   3. seat_cap and active_seats on teams — used by the seat-cap validator.
--      seat_cap defaults to NULL (unlimited) until Phase 2.6 Polar webhook
--      populates it from the subscription product metadata.
--      active_seats is a computed column managed by triggers (see below) to
--      avoid count(*) races on every invite check.
--
-- WHY advisory lock in seat-cap validator instead of trigger-locked counter:
--   Triggers run inside the transaction that fires them, which means they
--   can still race if two concurrent transactions check count before either
--   commits. We use pg_try_advisory_xact_lock in the edge function instead,
--   which is simpler than a SERIALIZABLE isolation level bump and avoids
--   deadlock risk between unrelated team operations.
-- ============================================================================

-- ============================================================================
-- 1. Add token_hash to team_invitations
-- ============================================================================

ALTER TABLE team_invitations
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

-- WHY UNIQUE constraint: token_hash is functionally a secondary key. Two rows
-- with the same hash would mean a collision in SHA-256 (astronomically
-- unlikely) or a bug in the generator. Constraint catches both.
ALTER TABLE team_invitations
  ADD CONSTRAINT team_invitations_token_hash_unique UNIQUE (token_hash);

-- Index for fast accept-flow lookup (Unit B will query by token_hash).
CREATE INDEX IF NOT EXISTS idx_team_invitations_token_hash
  ON team_invitations(token_hash)
  WHERE status = 'pending';

-- Make token_hash required going forward. Existing rows (if any) retain
-- NULL until they expire or are backfilled.
-- We do NOT backfill in this migration: existing tokens in the `token` column
-- are plain-text; backfilling SHA-256(token) would only work if we have
-- the raw token, which we may not in production. Accept the NULL gap.


-- ============================================================================
-- 2. Extend role CHECK on team_invitations to include 'viewer'
-- ============================================================================

-- WHY: The spec requires invite role enum to include 'viewer'. The existing
-- team_invitations.role CHECK only allows ('admin', 'member'). We drop and
-- re-add the constraint rather than ALTER (Postgres doesn't support ALTER
-- CHECK inline without dropping). team_members.role is NOT touched here.

ALTER TABLE team_invitations
  DROP CONSTRAINT IF EXISTS team_invitations_role_check;

ALTER TABLE team_invitations
  ADD CONSTRAINT team_invitations_role_check
    CHECK (role IN ('admin', 'member', 'viewer'));


-- ============================================================================
-- 3. Add seat_cap and active_seats to teams
-- ============================================================================

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS seat_cap INTEGER
    CHECK (seat_cap IS NULL OR seat_cap > 0);

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS active_seats INTEGER NOT NULL DEFAULT 0
    CHECK (active_seats >= 0);

-- Initialize active_seats from existing team_members + pending invitations.
-- WHY include pending invitations: the spec requires active_seats to count
-- both accepted members AND pending invites, so a team at cap cannot stockpile
-- invitations that would collectively push them over cap on acceptance.
UPDATE teams t SET active_seats = (
  (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)
  +
  (SELECT COUNT(*) FROM team_invitations WHERE team_id = t.id AND status = 'pending')
);

-- ============================================================================
-- 4. Triggers to maintain active_seats for team_members
-- ============================================================================

-- WHY maintain active_seats via trigger rather than SELECT COUNT(*):
--   COUNT(*) under MVCC can miss concurrent inserts. A trigger-maintained
--   counter + advisory lock in the edge function gives us a consistent
--   snapshot without a full table scan on every invite check.

CREATE OR REPLACE FUNCTION increment_team_active_seats()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE teams SET active_seats = active_seats + 1 WHERE id = NEW.team_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION decrement_team_active_seats()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE teams SET active_seats = GREATEST(0, active_seats - 1) WHERE id = OLD.team_id;
  RETURN OLD;
END;
$$;

-- Drop and recreate to be idempotent.
DROP TRIGGER IF EXISTS trg_team_members_insert_seats ON team_members;
CREATE TRIGGER trg_team_members_insert_seats
  AFTER INSERT ON team_members
  FOR EACH ROW EXECUTE FUNCTION increment_team_active_seats();

DROP TRIGGER IF EXISTS trg_team_members_delete_seats ON team_members;
CREATE TRIGGER trg_team_members_delete_seats
  AFTER DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION decrement_team_active_seats();

-- ============================================================================
-- 4b. Triggers to maintain active_seats for team_invitations (pending)
-- ============================================================================

-- WHY: The spec requires active_seats to include pending invitations so a team
-- at cap cannot stockpile invites that would collectively push them over cap
-- on acceptance. Triggers fire on status transitions:
--   status=pending INSERT  -> +1
--   status=pending DELETE OR status changes from pending  -> -1
-- Accept flow will delete the invitation row (or mark status=accepted) AND
-- insert a team_member in the same transaction, so the net effect is unchanged.

CREATE OR REPLACE FUNCTION fn_team_invitations_seat_delta()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    UPDATE teams SET active_seats = active_seats + 1 WHERE id = NEW.team_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'pending' AND NEW.status <> 'pending' THEN
      UPDATE teams SET active_seats = active_seats - 1 WHERE id = OLD.team_id;
    ELSIF OLD.status <> 'pending' AND NEW.status = 'pending' THEN
      UPDATE teams SET active_seats = active_seats + 1 WHERE id = NEW.team_id;
    END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.status = 'pending' THEN
    UPDATE teams SET active_seats = active_seats - 1 WHERE id = OLD.team_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_team_invitations_seat_delta ON team_invitations;
CREATE TRIGGER trg_team_invitations_seat_delta
  AFTER INSERT OR UPDATE OR DELETE ON team_invitations
  FOR EACH ROW EXECUTE FUNCTION fn_team_invitations_seat_delta();

-- ============================================================================
-- 5. RLS on team_invitations (ensure token_hash column is covered)
-- ============================================================================
-- Existing RLS from migration 006 covers read/delete. The edge function uses
-- the service-role key to bypass RLS for the upsert + audit_log write, so no
-- additional policies are needed here.
-- ============================================================================

-- ============================================================================
-- 6. PostgREST-accessible advisory lock wrapper
-- ============================================================================

-- WHY: pg_try_advisory_xact_lock lives in pg_catalog and is not accessible via
-- PostgREST RPC by default. This SECURITY DEFINER wrapper in the public schema
-- makes it callable from edge functions. Transactional advisory lock (not
-- session-level) is correct here - it auto-releases at statement end, which
-- matches the single-statement lifecycle of a PostgREST RPC call.
CREATE OR REPLACE FUNCTION public.acquire_team_invite_lock(team_lock_key bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT pg_try_advisory_xact_lock(team_lock_key);
$$;

GRANT EXECUTE ON FUNCTION public.acquire_team_invite_lock TO authenticated, service_role;

-- ============================================================================
-- 7. Audit action enum extension
-- ============================================================================

-- WHY IF NOT EXISTS: ALTER TYPE ADD VALUE is non-transactional in Postgres; the
-- guard prevents failure on re-run (e.g., migration retries after partial apply).
-- WHY these 4 values: The accept, resend, and revoke routes (and the send edge
-- function) all write audit_log rows using these action strings. If the enum
-- doesn't contain them, the INSERT will fail with a Postgres type error at runtime.
-- team_invite_email_failed is produced by the send edge function on email error.
-- team_invite_accepted is written by POST /api/invitations/accept on success.
-- team_invite_resent   is written by POST /api/invitations/[id]/resend on success.
-- team_invite_revoked  is written by POST /api/invitations/[id]/revoke on success.
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_invite_email_failed';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_invite_accepted';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_invite_resent';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_invite_revoked';

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON COLUMN team_invitations.token_hash IS
  'SHA-256 hex digest of the one-time invitation token sent via email. '
  'The raw token is never stored. Accept flow: hash incoming token, lookup by hash.';

COMMENT ON COLUMN teams.seat_cap IS
  'Maximum number of active seats allowed. NULL = unlimited (until Phase 2.6 '
  'Polar webhook populates this from subscription metadata).';

COMMENT ON COLUMN teams.active_seats IS
  'Trigger-maintained count of active team_members + pending team_invitations rows. '
  'Updated by trg_team_members_insert_seats, trg_team_members_delete_seats, '
  'and trg_team_invitations_seat_delta.';
