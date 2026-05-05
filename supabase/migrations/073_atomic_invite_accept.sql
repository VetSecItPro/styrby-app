-- ============================================================================
-- Migration 073: Atomic Team Invitation Accept
-- ============================================================================
-- WAVE-E-002 fix: the previous accept flow ran INSERT (team_members) followed
-- by UPDATE (team_invitations.status='accepted') as two separate PostgREST
-- statements. If the UPDATE failed (RLS edge, deadlock, network blip), the
-- user gained a seat but the invitation remained 'pending' — the seat
-- counter was inflated and the invitation could only be cleared by waiting
-- for natural expiry. The UNIQUE(team_id,user_id) constraint prevents the
-- same user from being double-added but does NOT bound the seat-inflation
-- window for a different user racing the second statement.
--
-- This migration introduces a SECURITY DEFINER function that performs both
-- writes inside a single transaction. If either statement fails, BOTH roll
-- back — the seat counter and invitation state stay in sync.
--
-- Function contract:
--   accept_team_invitation(p_invite_token uuid, p_user_id uuid)
--     RETURNS team_members
--
--   - Looks up team_invitations by id (UUID) with status='pending'
--     and expires_at > now().
--   - Inserts team_members(team_id, user_id, role).
--   - Updates team_invitations to status='accepted', responded_at=now().
--   - Raises a typed exception if any precondition fails so the caller can
--     map it to the right HTTP status.
--
-- Note: the route hashes the raw invite URL token to find the row, then
-- passes the resolved invitation id (UUID) to this function. We DO NOT
-- accept a raw URL token here because (a) it would force the function to
-- re-implement timing-safe lookup and (b) SECURITY DEFINER functions
-- should accept resolved internal IDs, not raw secrets.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.accept_team_invitation(
  p_invitation_id uuid,
  p_user_id       uuid
)
RETURNS public.team_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_invitation public.team_invitations%ROWTYPE;
  v_member     public.team_members%ROWTYPE;
  v_member_role text;
BEGIN
  -- Lock the invitation row so two concurrent accept attempts serialize.
  -- WHY FOR UPDATE: prevents a TOCTOU race where two requests both read
  -- status='pending', both INSERT a team_member (only one succeeds via
  -- UNIQUE), and both attempt to flip status. With FOR UPDATE the second
  -- request waits, observes status='accepted', and exits cleanly.
  SELECT *
    INTO v_invitation
    FROM public.team_invitations
   WHERE id = p_invitation_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'invitation_already_resolved'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_invitation.expires_at < now() THEN
    RAISE EXCEPTION 'invitation_expired'
      USING ERRCODE = 'P0003';
  END IF;

  -- Map invitation role -> member role. Mirrors INVITE_ROLE_TO_MEMBER_ROLE
  -- in @styrby/shared/team/types.ts. team_invitations.role currently allows
  -- ('admin','member'); legacy 'viewer' values fold to 'member'.
  v_member_role := CASE v_invitation.role
                     WHEN 'admin'  THEN 'admin'
                     WHEN 'member' THEN 'member'
                     WHEN 'viewer' THEN 'member'
                     ELSE 'member'
                   END;

  -- INSERT first, then UPDATE — both inside the same implicit transaction.
  -- If the INSERT raises unique_violation (user already a member of this
  -- team) we still flip the invitation to accepted to avoid a permanently
  -- stuck pending row. This matches the behavior the route previously had
  -- when memberInsertError.code === '23505'.
  BEGIN
    INSERT INTO public.team_members (team_id, user_id, role, invited_by)
    VALUES (v_invitation.team_id, p_user_id, v_member_role, v_invitation.invited_by)
    RETURNING * INTO v_member;
  EXCEPTION WHEN unique_violation THEN
    -- Already a member. Surface the existing membership so the caller can
    -- still respond 200/409 deterministically; do not treat as a hard error.
    SELECT *
      INTO v_member
      FROM public.team_members
     WHERE team_id = v_invitation.team_id
       AND user_id = p_user_id;
  END;

  UPDATE public.team_invitations
     SET status        = 'accepted',
         responded_at  = now()
   WHERE id = v_invitation.id;

  RETURN v_member;
END;
$$;

COMMENT ON FUNCTION public.accept_team_invitation(uuid, uuid) IS
  'Atomically accepts a team invitation: inserts team_members and marks '
  'the invitation accepted in a single transaction. WAVE-E-002 fix.';

-- Lock down execution. Default PUBLIC grant on functions is the historical
-- footgun. authenticated callers are the only intended users (the route
-- runs as the user-scoped session client, NOT service_role).
REVOKE ALL ON FUNCTION public.accept_team_invitation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_team_invitation(uuid, uuid) TO authenticated;
