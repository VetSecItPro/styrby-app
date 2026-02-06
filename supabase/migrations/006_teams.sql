-- ============================================================================
-- STYRBY DATABASE MIGRATION: Team Collaboration (Power Tier)
-- ============================================================================
-- Adds team functionality for Power tier subscribers, enabling multiple users
-- to share sessions and collaborate within a team context.
--
-- SECURITY-CRITICAL: This migration implements strict RLS policies to prevent
-- cross-tenant data access. Teams must be completely isolated from each other.
--
-- Tables:
-- - teams: Team definitions with ownership
-- - team_members: Team membership with role-based access
-- - team_invitations: Pending invitations with expiration
--
-- Tier Gating:
-- - Only Power tier users can create teams
-- - Team size limits enforced at API level (Power: 5 members)
-- - Team features disabled for Free/Pro users
--
-- Design Decisions:
-- - Separate invitations table: Allows tracking pending invites, expiration,
--   and prevents orphaned records when users decline or invitations expire
-- - Role-based access: owner > admin > member hierarchy for permission control
-- - Soft delete not used: Teams deleted via CASCADE to prevent orphaned data
-- ============================================================================


-- ============================================================================
-- TEAMS TABLE
-- ============================================================================
-- A team is a collection of users who can share sessions and collaborate.
-- Each team has exactly one owner (the user who created it).
-- ============================================================================

CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Team identity
  name TEXT NOT NULL,
  description TEXT,

  -- Ownership (the user who created the team)
  -- WHY owner_id is separate from team_members: Ensures there's always exactly
  -- one owner who cannot be removed without deleting the team.
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Settings
  settings JSONB DEFAULT '{}' NOT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Constraints
  CONSTRAINT teams_name_length CHECK (char_length(name) >= 1 AND char_length(name) <= 100)
);

-- Index for listing teams owned by a user
CREATE INDEX idx_teams_owner ON teams(owner_id);


-- ============================================================================
-- TEAM_MEMBERS TABLE
-- ============================================================================
-- Tracks membership in teams with role-based permissions.
-- Roles: owner, admin, member
-- - owner: Full control (only one per team, matches teams.owner_id)
-- - admin: Can invite/remove members, view all team sessions
-- - member: Can view team sessions, participate in shared work
-- ============================================================================

CREATE TABLE team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Role determines permissions
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member')),

  -- Invitation tracking
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Each user can only be in a team once
  CONSTRAINT unique_team_member UNIQUE (team_id, user_id)
);

-- Index for finding all teams a user belongs to
CREATE INDEX idx_team_members_user ON team_members(user_id);

-- Index for listing all members of a team
CREATE INDEX idx_team_members_team ON team_members(team_id);

-- Index for role-based queries (e.g., finding all admins of a team)
CREATE INDEX idx_team_members_team_role ON team_members(team_id, role);


-- ============================================================================
-- TEAM_INVITATIONS TABLE
-- ============================================================================
-- Tracks pending team invitations. Separate from team_members to:
-- 1. Track invitation history and status
-- 2. Support invitation expiration
-- 3. Allow users to decline without creating a membership record
-- 4. Enable invitation tokens for email links
-- ============================================================================

CREATE TABLE team_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,

  -- Who was invited
  email TEXT NOT NULL,
  invited_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Who sent the invite
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Role they'll have when they join
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member')),

  -- Token for email invite links (secure random string)
  token TEXT NOT NULL UNIQUE,

  -- Invitation status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'revoked')),

  -- Expiration (default 7 days)
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  responded_at TIMESTAMPTZ,

  -- Each email can only have one pending invite per team
  CONSTRAINT unique_pending_invitation UNIQUE (team_id, email)
);

-- Index for looking up invitations by token (email link flow)
CREATE INDEX idx_team_invitations_token ON team_invitations(token)
  WHERE status = 'pending';

-- Index for listing pending invitations for a team
CREATE INDEX idx_team_invitations_team_pending ON team_invitations(team_id, created_at DESC)
  WHERE status = 'pending';

-- Index for finding invitations by email (user checking their invites)
CREATE INDEX idx_team_invitations_email ON team_invitations(email, status);


-- ============================================================================
-- ADD TEAM_ID TO SESSIONS TABLE
-- ============================================================================
-- Optional foreign key to associate sessions with a team.
-- NULL team_id = personal session (existing behavior)
-- Non-NULL team_id = team session (visible to all team members)
-- ============================================================================

ALTER TABLE sessions
ADD COLUMN team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

-- Index for filtering sessions by team
CREATE INDEX idx_sessions_team ON sessions(team_id)
  WHERE team_id IS NOT NULL;

-- Composite index for team session lists
CREATE INDEX idx_sessions_team_list ON sessions(team_id, created_at DESC)
  INCLUDE (title, status, agent_type, total_cost_usd, message_count, last_activity_at, user_id)
  WHERE team_id IS NOT NULL AND deleted_at IS NULL;


-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- SECURITY-CRITICAL: These policies prevent cross-tenant data access.
-- All policies use (SELECT auth.uid()) for query plan caching optimization.
-- ============================================================================

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- TEAMS POLICIES
-- ============================================================================
-- Owner: Full CRUD access
-- Members: Read-only access to team details
-- ============================================================================

-- Users can view teams they're a member of
CREATE POLICY "teams_select_member"
  ON teams FOR SELECT
  USING (
    -- User is the owner OR user is a team member
    owner_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.team_id = teams.id
      AND team_members.user_id = (SELECT auth.uid())
    )
  );

-- Only the owner can create teams (Power tier check at API level)
-- WHY: We check owner_id matches auth.uid() to prevent users from creating
-- teams owned by others. Tier check is at API level for clearer error messages.
CREATE POLICY "teams_insert_owner"
  ON teams FOR INSERT
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- Only the owner can update team details
CREATE POLICY "teams_update_owner"
  ON teams FOR UPDATE
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- Only the owner can delete the team
CREATE POLICY "teams_delete_owner"
  ON teams FOR DELETE
  USING (owner_id = (SELECT auth.uid()));


-- ============================================================================
-- TEAM_MEMBERS POLICIES
-- ============================================================================
-- Owner/Admin: Can manage members (invite, update roles, remove)
-- Member: Can view team membership list
-- ============================================================================

-- All team members can view the member list
CREATE POLICY "team_members_select_member"
  ON team_members FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_members.team_id
      AND tm.user_id = (SELECT auth.uid())
    )
  );

-- Owner and admins can add new members
-- WHY: INSERT requires checking the inserter has admin+ role, not the new member
CREATE POLICY "team_members_insert_admin"
  ON team_members FOR INSERT
  WITH CHECK (
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
  );

-- Owner and admins can update member roles (not their own)
-- WHY: Prevents admins from elevating themselves to owner
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
  );

-- Owner can remove anyone; admins can remove members (not other admins/owner)
-- Members can remove themselves (leave team)
CREATE POLICY "team_members_delete_admin_or_self"
  ON team_members FOR DELETE
  USING (
    -- User can remove themselves (leave team)
    team_members.user_id = (SELECT auth.uid())
    OR
    -- Owner can remove anyone
    EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_members.team_id
      AND t.owner_id = (SELECT auth.uid())
    )
    OR
    -- Admin can remove members (but not other admins or owner)
    (
      team_members.role = 'member'
      AND EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = team_members.team_id
        AND tm.user_id = (SELECT auth.uid())
        AND tm.role IN ('owner', 'admin')
      )
    )
  );


-- ============================================================================
-- TEAM_INVITATIONS POLICIES
-- ============================================================================
-- Owner/Admin: Can create and manage invitations
-- Invited user: Can view and respond to their own invitations
-- ============================================================================

-- Users can view invitations for their email or teams they admin
CREATE POLICY "team_invitations_select"
  ON team_invitations FOR SELECT
  USING (
    -- Invitation is addressed to the user's email
    email = (SELECT email FROM auth.users WHERE id = (SELECT auth.uid()))
    OR
    -- User is the invited_user_id
    invited_user_id = (SELECT auth.uid())
    OR
    -- User is owner or admin of the team
    EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_invitations.team_id
      AND t.owner_id = (SELECT auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_invitations.team_id
      AND tm.user_id = (SELECT auth.uid())
      AND tm.role IN ('owner', 'admin')
    )
  );

-- Owner and admins can create invitations
CREATE POLICY "team_invitations_insert_admin"
  ON team_invitations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_invitations.team_id
      AND t.owner_id = (SELECT auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_invitations.team_id
      AND tm.user_id = (SELECT auth.uid())
      AND tm.role IN ('owner', 'admin')
    )
  );

-- Invited user can update (accept/decline) their own invitations
-- Owner/admins can update (revoke) invitations
CREATE POLICY "team_invitations_update"
  ON team_invitations FOR UPDATE
  USING (
    -- Invited user can update their own invitation
    email = (SELECT email FROM auth.users WHERE id = (SELECT auth.uid()))
    OR invited_user_id = (SELECT auth.uid())
    OR
    -- Owner can update any invitation
    EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_invitations.team_id
      AND t.owner_id = (SELECT auth.uid())
    )
    OR
    -- Admin can update invitations
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_invitations.team_id
      AND tm.user_id = (SELECT auth.uid())
      AND tm.role IN ('owner', 'admin')
    )
  );

-- Owner and admins can delete invitations (revoke)
CREATE POLICY "team_invitations_delete_admin"
  ON team_invitations FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_invitations.team_id
      AND t.owner_id = (SELECT auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = team_invitations.team_id
      AND tm.user_id = (SELECT auth.uid())
      AND tm.role IN ('owner', 'admin')
    )
  );


-- ============================================================================
-- UPDATED SESSIONS POLICIES
-- ============================================================================
-- Extend existing session policies to allow team members to view team sessions.
-- Personal sessions (team_id IS NULL) remain visible only to the owner.
-- ============================================================================

-- Drop the existing select policy and recreate with team support
DROP POLICY IF EXISTS "sessions_select_own" ON sessions;

-- Users can view sessions they own OR that belong to their teams
CREATE POLICY "sessions_select_own_or_team"
  ON sessions FOR SELECT
  USING (
    deleted_at IS NULL
    AND (
      -- User owns the session
      user_id = (SELECT auth.uid())
      OR
      -- Session belongs to a team the user is a member of
      (
        team_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.team_id = sessions.team_id
          AND tm.user_id = (SELECT auth.uid())
        )
      )
    )
  );

-- Update policy: Only session owner can update (even for team sessions)
-- WHY: Prevents team members from modifying each other's session data
-- This preserves the existing behavior - no change needed.

-- Insert policy: User can only create sessions for themselves
-- Team assignment is validated at API level
-- No change needed to existing insert policy.


-- ============================================================================
-- TRIGGERS: AUTO-UPDATE TIMESTAMPS
-- ============================================================================

CREATE TRIGGER tr_teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_team_members_updated_at BEFORE UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================================
-- TRIGGERS: AUTO-CREATE OWNER AS TEAM MEMBER
-- ============================================================================
-- When a team is created, automatically add the owner as a team member
-- with the 'owner' role. This ensures owner is always in team_members.
-- ============================================================================

CREATE OR REPLACE FUNCTION handle_new_team()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO team_members (
    team_id,
    user_id,
    role,
    invited_by,
    invited_at,
    joined_at
  )
  VALUES (
    NEW.id,
    NEW.owner_id,
    'owner',
    NEW.owner_id,
    NOW(),
    NOW()
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_team_created
  AFTER INSERT ON teams
  FOR EACH ROW EXECUTE FUNCTION handle_new_team();


-- ============================================================================
-- FUNCTION: Accept Team Invitation
-- ============================================================================
-- Transactionally accepts an invitation: updates invitation status and
-- creates the team membership record. Returns success boolean and message.
-- ============================================================================

CREATE OR REPLACE FUNCTION accept_team_invitation(
  p_invitation_token TEXT
)
RETURNS TABLE (
  success BOOLEAN,
  message TEXT,
  team_id UUID,
  team_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation team_invitations%ROWTYPE;
  v_user_id UUID;
  v_user_email TEXT;
  v_team teams%ROWTYPE;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'You must be logged in to accept an invitation', NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  -- Get user's email
  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  -- Find the invitation
  SELECT * INTO v_invitation
  FROM team_invitations
  WHERE token = p_invitation_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Invitation not found', NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  -- Check invitation is pending
  IF v_invitation.status != 'pending' THEN
    RETURN QUERY SELECT FALSE, 'This invitation has already been ' || v_invitation.status, NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  -- Check invitation hasn't expired
  IF v_invitation.expires_at < NOW() THEN
    UPDATE team_invitations SET status = 'expired' WHERE id = v_invitation.id;
    RETURN QUERY SELECT FALSE, 'This invitation has expired', NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  -- Check invitation is for this user (by email)
  IF v_invitation.email != v_user_email THEN
    RETURN QUERY SELECT FALSE, 'This invitation is for a different email address', NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  -- Check user isn't already a member
  IF EXISTS (SELECT 1 FROM team_members WHERE team_id = v_invitation.team_id AND user_id = v_user_id) THEN
    UPDATE team_invitations SET status = 'accepted', responded_at = NOW() WHERE id = v_invitation.id;
    RETURN QUERY SELECT FALSE, 'You are already a member of this team', NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  -- Get team info
  SELECT * INTO v_team FROM teams WHERE id = v_invitation.team_id;

  -- Create team membership
  INSERT INTO team_members (team_id, user_id, role, invited_by, invited_at, joined_at)
  VALUES (v_invitation.team_id, v_user_id, v_invitation.role, v_invitation.invited_by, v_invitation.created_at, NOW());

  -- Update invitation status
  UPDATE team_invitations
  SET status = 'accepted', responded_at = NOW(), invited_user_id = v_user_id
  WHERE id = v_invitation.id;

  RETURN QUERY SELECT TRUE, 'Successfully joined team', v_team.id, v_team.name;
END;
$$;


-- ============================================================================
-- FUNCTION: Get User's Team Membership
-- ============================================================================
-- Returns the current user's teams with their role and team details.
-- Used for the team selector and team management UI.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_user_teams()
RETURNS TABLE (
  team_id UUID,
  team_name TEXT,
  team_description TEXT,
  owner_id UUID,
  role TEXT,
  member_count BIGINT,
  joined_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id AS team_id,
    t.name AS team_name,
    t.description AS team_description,
    t.owner_id,
    tm.role,
    (SELECT COUNT(*) FROM team_members WHERE team_members.team_id = t.id)::BIGINT AS member_count,
    tm.joined_at
  FROM team_members tm
  JOIN teams t ON t.id = tm.team_id
  WHERE tm.user_id = (SELECT auth.uid())
  ORDER BY tm.joined_at DESC;
END;
$$;


-- ============================================================================
-- FUNCTION: Get Team Members
-- ============================================================================
-- Returns all members of a team with profile info.
-- Only accessible to team members (enforced by RLS on team_members).
-- ============================================================================

CREATE OR REPLACE FUNCTION get_team_members(p_team_id UUID)
RETURNS TABLE (
  member_id UUID,
  user_id UUID,
  role TEXT,
  display_name TEXT,
  email TEXT,
  avatar_url TEXT,
  joined_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Check user is a member of this team
  IF NOT EXISTS (
    SELECT 1 FROM team_members
    WHERE team_id = p_team_id AND user_id = (SELECT auth.uid())
  ) THEN
    RAISE EXCEPTION 'Not a member of this team';
  END IF;

  RETURN QUERY
  SELECT
    tm.id AS member_id,
    tm.user_id,
    tm.role,
    p.display_name,
    u.email,
    p.avatar_url,
    tm.joined_at
  FROM team_members tm
  JOIN auth.users u ON u.id = tm.user_id
  LEFT JOIN profiles p ON p.id = tm.user_id
  WHERE tm.team_id = p_team_id
  ORDER BY
    CASE tm.role
      WHEN 'owner' THEN 1
      WHEN 'admin' THEN 2
      ELSE 3
    END,
    tm.joined_at ASC;
END;
$$;


-- ============================================================================
-- GRANTS FOR SERVICE ROLE
-- ============================================================================

GRANT ALL ON teams TO service_role;
GRANT ALL ON team_members TO service_role;
GRANT ALL ON team_invitations TO service_role;


-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
