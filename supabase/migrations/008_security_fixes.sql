-- ============================================================================
-- MIGRATION 008: Security Fixes
-- ============================================================================
-- Addresses findings from security audit (2026-02-07).
--
-- CRITICAL: FIX-001 — API key revocation authorization bypass
-- HIGH:     FIX-008 — Atomic sequence number generation
--           FIX-009 — Team role escalation via UPDATE (missing WITH CHECK)
--           FIX-010 — Team role escalation via INSERT
--           FIX-011 — Missing search_path on update_updated_at()
-- MEDIUM:   FIX-022/023/024 — Race conditions on tier limit checks
--           FIX-028 — session_messages RLS not updated for teams
--           FIX-030 — Missing index on team_invitations.invited_user_id
--           FIX-031 — profiles.display_name unbounded
--           FIX-032 — webhooks.name unbounded
--           FIX-035 — Machine count enforcement
-- LOW:      FIX-051 — Missing UPDATE policy on session_messages
--           FIX-053 — Missing SELECT policy on user_feedback
--           FIX-061 — Redundant index on machine_keys
--           FIX-062 — sessions.tags unbounded
--           FIX-064 — Teams per user limit
-- ============================================================================


-- ============================================================================
-- FIX-001 (CRITICAL): Add ownership check to revoke_api_key
-- WHY: The function is SECURITY DEFINER (bypasses RLS) but never checks
-- that auth.uid() matches the key owner. Any authenticated user who knows
-- a key UUID can revoke another user's API key.
-- ============================================================================

CREATE OR REPLACE FUNCTION revoke_api_key(
  p_key_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Get the key's owner
  SELECT user_id INTO v_user_id
  FROM api_keys
  WHERE id = p_key_id;

  -- Key doesn't exist
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- FIX-001: Verify the caller owns this key
  IF v_user_id != auth.uid() THEN
    RETURN FALSE;
  END IF;

  -- Revoke the key
  UPDATE api_keys
  SET
    revoked_at = NOW(),
    revoked_reason = p_reason
  WHERE id = p_key_id
    AND revoked_at IS NULL;

  RETURN FOUND;
END;
$$;


-- ============================================================================
-- FIX-008 (HIGH): Atomic session message insertion
-- WHY: The current pattern reads max(sequence_number) then inserts +1.
-- Two concurrent requests read the same max and generate duplicates.
-- This function uses pg_advisory_xact_lock to serialize per-session,
-- and also verifies session ownership (replacing RLS in DEFINER context).
-- ============================================================================

CREATE OR REPLACE FUNCTION insert_session_message(
  p_session_id UUID,
  p_message_type TEXT,
  p_content_encrypted TEXT DEFAULT NULL,
  p_encryption_nonce TEXT DEFAULT NULL,
  p_role TEXT DEFAULT NULL,
  p_parent_message_id UUID DEFAULT NULL,
  p_permission_granted BOOLEAN DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS TABLE (id UUID, sequence_number INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_owner UUID;
  v_next INTEGER;
  v_id UUID;
BEGIN
  -- Verify session ownership
  SELECT user_id INTO v_session_owner
  FROM sessions
  WHERE sessions.id = p_session_id;

  IF v_session_owner IS NULL THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_session_owner != auth.uid() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Advisory lock serializes sequence number generation per session
  PERFORM pg_advisory_xact_lock(hashtext(p_session_id::text));

  SELECT COALESCE(MAX(sm.sequence_number), 0) + 1 INTO v_next
  FROM session_messages sm
  WHERE sm.session_id = p_session_id;

  INSERT INTO session_messages (
    session_id, sequence_number, message_type, role,
    content_encrypted, encryption_nonce,
    parent_message_id, permission_granted, metadata
  ) VALUES (
    p_session_id, v_next, p_message_type, p_role,
    p_content_encrypted, p_encryption_nonce,
    p_parent_message_id, p_permission_granted, p_metadata
  )
  RETURNING session_messages.id, session_messages.sequence_number INTO v_id, v_next;

  RETURN QUERY SELECT v_id, v_next;
END;
$$;

GRANT EXECUTE ON FUNCTION insert_session_message TO authenticated;


-- ============================================================================
-- FIX-009 (HIGH): Team role escalation via UPDATE
-- WHY: The UPDATE policy has no WITH CHECK. An admin can set another
-- member's role to 'owner', escalating their own privileges.
-- ============================================================================

DROP POLICY IF EXISTS "team_members_update_admin" ON team_members;

CREATE POLICY "team_members_update_admin"
  ON team_members FOR UPDATE
  USING (
    -- User is owner of the team
    EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_members.team_id
      AND t.owner_id = (SELECT auth.uid())
    )
    OR
    -- User is an admin (but can't modify their own record)
    (
      team_members.user_id != (SELECT auth.uid())
      AND EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = team_members.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
      )
    )
  )
  WITH CHECK (
    -- Only the actual team owner can grant the 'owner' role
    CASE
      WHEN role = 'owner' THEN
        EXISTS (
          SELECT 1 FROM teams t
          WHERE t.id = team_members.team_id
          AND t.owner_id = (SELECT auth.uid())
        )
      ELSE TRUE
    END
  );


-- ============================================================================
-- FIX-010 (HIGH): Team role escalation via INSERT
-- WHY: INSERT policy doesn't restrict role values. An admin could
-- insert a member with role='owner', breaking the single-owner invariant.
-- ============================================================================

DROP POLICY IF EXISTS "team_members_insert_admin" ON team_members;

CREATE POLICY "team_members_insert_admin"
  ON team_members FOR INSERT
  WITH CHECK (
    -- Must be admin or owner to insert
    (
      EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = team_members.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
      )
      OR EXISTS (
        SELECT 1 FROM teams t
        WHERE t.id = team_members.team_id
        AND t.owner_id = (SELECT auth.uid())
      )
    )
    -- Cannot insert with role='owner' unless you are the actual team owner
    AND (
      role != 'owner'
      OR EXISTS (
        SELECT 1 FROM teams t
        WHERE t.id = team_members.team_id
        AND t.owner_id = (SELECT auth.uid())
      )
    )
  );


-- ============================================================================
-- FIX-011 (HIGH): Missing search_path on update_updated_at trigger
-- WHY: Used by 8+ triggers across the schema. Without search_path, a
-- malicious schema could shadow NOW().
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


-- ============================================================================
-- FIX-022/023/024 (MEDIUM): Serialize tier limit checks
-- WHY: Budget alerts, API keys, and webhooks all use check-then-insert
-- without transactions. Concurrent requests can bypass tier limits.
-- Advisory locks serialize inserts per user per table, making the
-- application-level check-then-insert pattern race-free.
-- ============================================================================

CREATE OR REPLACE FUNCTION serialize_user_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Advisory lock prevents concurrent inserts for the same user+table
  -- WHY: hashtext produces a 32-bit int from the user_id + table name,
  -- which pg_advisory_xact_lock uses as the lock key. The lock is held
  -- until the transaction commits, serializing concurrent inserts.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.user_id::text || TG_TABLE_NAME));
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_serialize_budget_alerts') THEN
    CREATE TRIGGER tr_serialize_budget_alerts
      BEFORE INSERT ON budget_alerts
      FOR EACH ROW EXECUTE FUNCTION serialize_user_insert();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_serialize_api_keys') THEN
    CREATE TRIGGER tr_serialize_api_keys
      BEFORE INSERT ON api_keys
      FOR EACH ROW EXECUTE FUNCTION serialize_user_insert();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_serialize_webhooks') THEN
    CREATE TRIGGER tr_serialize_webhooks
      BEFORE INSERT ON webhooks
      FOR EACH ROW EXECUTE FUNCTION serialize_user_insert();
  END IF;
END;
$$;


-- ============================================================================
-- FIX-028 (MEDIUM): Update session_messages SELECT for team sessions
-- WHY: Migration 006 updated sessions SELECT for teams, but
-- session_messages still only checks sessions.user_id = auth.uid().
-- Team members can see team sessions but not the messages within them.
-- ============================================================================

DROP POLICY IF EXISTS "session_messages_select_own" ON session_messages;

CREATE POLICY "session_messages_select_own_or_team"
  ON session_messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = session_messages.session_id
    AND s.deleted_at IS NULL
    AND (
      s.user_id = (SELECT auth.uid())
      OR (
        s.team_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.team_id = s.team_id
          AND tm.user_id = (SELECT auth.uid())
        )
      )
    )
  ));


-- ============================================================================
-- FIX-030 (MEDIUM): Missing index on team_invitations.invited_user_id
-- WHY: Used in RLS policies and accept_team_invitation function.
-- Without index, RLS checks require sequential scans.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_team_invitations_invited_user
  ON team_invitations(invited_user_id);


-- ============================================================================
-- FIX-031 (MEDIUM): profiles.display_name unbounded
-- WHY: No length constraint allows unlimited text storage.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_display_name_length'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_display_name_length
      CHECK (display_name IS NULL OR char_length(display_name) <= 200);
  END IF;
END;
$$;


-- ============================================================================
-- FIX-032 (MEDIUM): webhooks.name unbounded
-- WHY: URL is constrained to 2048 chars but name is not.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhooks_name_length'
  ) THEN
    ALTER TABLE webhooks ADD CONSTRAINT webhooks_name_length
      CHECK (char_length(name) <= 255);
  END IF;
END;
$$;


-- ============================================================================
-- FIX-035 (MEDIUM): Machine count enforcement trigger
-- WHY: Tier config defines machine limits (Free:1, Pro:5, Power:15) but
-- the RLS INSERT policy only checks user_id. Direct DB access could
-- bypass the application-level limit check.
-- ============================================================================

CREATE OR REPLACE FUNCTION check_machine_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier TEXT;
  v_current_count INTEGER;
  v_limit INTEGER;
BEGIN
  -- Get user's current tier
  SELECT COALESCE(s.tier, 'free') INTO v_tier
  FROM subscriptions s
  WHERE s.user_id = NEW.user_id AND s.status = 'active'
  LIMIT 1;

  IF v_tier IS NULL THEN v_tier := 'free'; END IF;

  -- Tier-based machine limits
  v_limit := CASE v_tier
    WHEN 'power' THEN 15
    WHEN 'pro' THEN 5
    ELSE 1
  END;

  SELECT COUNT(*) INTO v_current_count
  FROM machines WHERE user_id = NEW.user_id;

  IF v_current_count >= v_limit THEN
    RAISE EXCEPTION 'Machine limit reached for % tier (limit: %)', v_tier, v_limit;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_check_machine_limit') THEN
    CREATE TRIGGER tr_check_machine_limit
      BEFORE INSERT ON machines
      FOR EACH ROW EXECUTE FUNCTION check_machine_limit();
  END IF;
END;
$$;


-- ============================================================================
-- FIX-051 (LOW): Missing UPDATE policy on session_messages
-- WHY: The permission-response route updates session_messages to set
-- permission_granted. Without an UPDATE policy, RLS denies this.
-- ============================================================================

CREATE POLICY "session_messages_update_own"
  ON session_messages FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = session_messages.session_id
    AND s.user_id = (SELECT auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = session_messages.session_id
    AND s.user_id = (SELECT auth.uid())
  ));


-- ============================================================================
-- FIX-053 (LOW): Missing SELECT policy on user_feedback
-- WHY: Users cannot read their own submitted feedback.
-- ============================================================================

CREATE POLICY "feedback_select_own"
  ON user_feedback FOR SELECT
  USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- FIX-061 (LOW): Redundant index on machine_keys.machine_id
-- WHY: UNIQUE(machine_id) constraint already creates an implicit index.
-- The explicit index wastes storage and write overhead.
-- ============================================================================

DROP INDEX IF EXISTS idx_machine_keys_machine;


-- ============================================================================
-- FIX-062 (LOW): sessions.tags unbounded
-- WHY: TEXT[] with no limits allows arbitrarily large tag arrays.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_tags_limit'
  ) THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_tags_limit
      CHECK (tags IS NULL OR tags = '{}' OR array_length(tags, 1) <= 50);
  END IF;
END;
$$;


-- ============================================================================
-- FIX-064 (LOW): No limit on teams per user
-- WHY: A user bypassing the API could create unlimited teams.
-- Power tier: 5 teams max. All other tiers: 0 (cannot create teams).
-- ============================================================================

CREATE OR REPLACE FUNCTION check_team_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier TEXT;
  v_current_count INTEGER;
  v_limit INTEGER;
BEGIN
  SELECT COALESCE(s.tier, 'free') INTO v_tier
  FROM subscriptions s
  WHERE s.user_id = NEW.owner_id AND s.status = 'active'
  LIMIT 1;

  IF v_tier IS NULL THEN v_tier := 'free'; END IF;

  v_limit := CASE v_tier
    WHEN 'power' THEN 5
    ELSE 0
  END;

  SELECT COUNT(*) INTO v_current_count
  FROM teams WHERE owner_id = NEW.owner_id;

  IF v_current_count >= v_limit THEN
    RAISE EXCEPTION 'Team limit reached for % tier (limit: %)', v_tier, v_limit;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_check_team_limit') THEN
    CREATE TRIGGER tr_check_team_limit
      BEFORE INSERT ON teams
      FOR EACH ROW EXECUTE FUNCTION check_team_limit();
  END IF;
END;
$$;


-- ============================================================================
-- END OF SECURITY FIXES
-- ============================================================================
