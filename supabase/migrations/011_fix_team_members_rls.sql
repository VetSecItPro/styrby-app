-- ============================================================================
-- Migration 011: Fix team_members RLS infinite recursion
--
-- BUG: The team_members_select_member policy queries team_members to check
-- if the current user is a member of the same team. Since this policy IS on
-- team_members, Postgres enters infinite recursion when evaluating RLS.
-- This also breaks sessions_select_own_or_team because that policy
-- references team_members, which triggers the recursive policy.
--
-- FIX: Create a SECURITY DEFINER function that bypasses RLS to check team
-- membership. The function runs as the database owner, so it can read
-- team_members without triggering the SELECT policy. The RLS policy then
-- calls this function instead of querying the table directly.
--
-- WHY security definer: This is the standard Supabase pattern for
-- self-referential RLS policies. The function is tightly scoped (returns
-- boolean, takes team_id + user_id) and cannot be abused to read arbitrary
-- data. It only answers "is this user in this team?"
-- ============================================================================

-- Step 1: Create the helper function (bypasses RLS)
CREATE OR REPLACE FUNCTION public.is_team_member(
  _team_id UUID,
  _user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members
    WHERE team_id = _team_id
    AND user_id = _user_id
  );
$$;

-- Step 2: Drop the broken policy
DROP POLICY IF EXISTS "team_members_select_member" ON team_members;

-- Step 3: Recreate with the helper function (no recursion)
CREATE POLICY "team_members_select_member"
  ON team_members FOR SELECT
  USING (
    public.is_team_member(team_id, (SELECT auth.uid()))
  );

-- Step 4: Also fix the sessions policy to use the same function
-- This avoids sessions_select_own_or_team querying team_members directly
-- (which would still trigger the old recursive path if any caching issues)
DROP POLICY IF EXISTS "sessions_select_own_or_team" ON sessions;

CREATE POLICY "sessions_select_own_or_team"
  ON sessions FOR SELECT
  USING (
    deleted_at IS NULL
    AND (
      user_id = (SELECT auth.uid())
      OR
      (
        team_id IS NOT NULL
        AND public.is_team_member(team_id, (SELECT auth.uid()))
      )
    )
  );

-- Step 5: Fix any other policies that reference team_members directly
-- Check cost_records, session_messages, etc.

-- cost_records: check if there's a team-aware policy
DO $$
BEGIN
  -- Drop and recreate cost_records team policy if it exists
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'cost_records' AND policyname LIKE '%team%'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "cost_records_select_own_or_team" ON cost_records';
    EXECUTE '
      CREATE POLICY "cost_records_select_own_or_team"
        ON cost_records FOR SELECT
        USING (
          user_id = (SELECT auth.uid())
          OR
          (
            session_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM sessions s
              WHERE s.id = cost_records.session_id
              AND s.team_id IS NOT NULL
              AND public.is_team_member(s.team_id, (SELECT auth.uid()))
            )
          )
        )
    ';
  END IF;
END
$$;
