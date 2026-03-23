/**
 * Team Management Hook
 *
 * Provides CRUD operations for teams, members, and invitations. Used by the
 * mobile team screen to create teams, invite members, update roles, and
 * remove members. Fetches data via Supabase RPCs and direct table queries.
 *
 * Power tier only. Callers should gate access based on subscription tier
 * before rendering team management UI.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as Crypto from 'expo-crypto';
import { supabase } from '../lib/supabase';
import {
  TeamSchema,
  TeamMemberSchema,
  TeamInvitationSchema,
  UserTeamRowSchema,
  safeParseArray,
  safeParseSingle,
} from '../lib/schemas';
import type {
  ValidatedTeam,
  ValidatedTeamMember,
  ValidatedTeamInvitation,
  ValidatedUserTeamRow,
} from '../lib/schemas';

// ============================================================================
// Types
// ============================================================================

/**
 * Return type for the useTeamManagement hook.
 */
export interface UseTeamManagementReturn {
  /** The current user's team, or null if they are not in a team */
  team: ValidatedTeam | null;
  /** The current user's role in the team (null if no team) */
  currentUserRole: 'owner' | 'admin' | 'member' | null;
  /** List of team members with profile info */
  members: ValidatedTeamMember[];
  /** Pending invitations (visible to owners and admins only) */
  invitations: ValidatedTeamInvitation[];
  /** Whether data is currently loading */
  isLoading: boolean;
  /** Whether a mutation (create, invite, update, remove) is in progress */
  isMutating: boolean;
  /** Error message from the most recent operation, or null */
  error: string | null;
  /** The authenticated user's ID */
  currentUserId: string | null;
  /** Creates a new team with the given name and description */
  createTeam: (name: string, description?: string) => Promise<ValidatedTeam | null>;
  /** Sends an invitation to the given email with the specified role */
  inviteMember: (email: string, role: 'admin' | 'member') => Promise<boolean>;
  /** Updates a team member's role */
  updateMemberRole: (memberId: string, role: 'admin' | 'member') => Promise<boolean>;
  /** Removes a team member by their membership ID */
  removeMember: (memberId: string) => Promise<boolean>;
  /** Refreshes all team data */
  refresh: () => Promise<void>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generates a cryptographically secure invitation token.
 *
 * WHY: Math.random() is not a CSPRNG and produces predictable tokens.
 * Invitation tokens grant team membership, so predictable tokens are
 * a privilege escalation vector. expo-crypto uses the platform's CSPRNG.
 *
 * @returns A 32-character hex string token
 *
 * @example
 * const token = generateInviteToken();
 * // => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
 */
function generateInviteToken(): string {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing team CRUD operations.
 *
 * Loads the user's team, members, and pending invitations on mount.
 * Provides functions for creating teams, inviting members, changing
 * roles, and removing members. All mutations update local state
 * optimistically where possible.
 *
 * @returns Team data, loading/error states, and action functions
 *
 * @example
 * const {
 *   team, members, invitations, isLoading, error,
 *   createTeam, inviteMember, updateMemberRole, removeMember, refresh,
 * } = useTeamManagement();
 *
 * // Create a team
 * const newTeam = await createTeam('My Team', 'A coding team');
 *
 * // Invite a member
 * const success = await inviteMember('user@example.com', 'member');
 */
export function useTeamManagement(): UseTeamManagementReturn {
  const [team, setTeam] = useState<ValidatedTeam | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<'owner' | 'admin' | 'member' | null>(null);
  const [members, setMembers] = useState<ValidatedTeamMember[]>([]);
  const [invitations, setInvitations] = useState<ValidatedTeamInvitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // WHY: Store the team ID in a ref so mutation callbacks can access the
  // latest value without triggering re-renders or stale closures.
  const teamIdRef = useRef<string | null>(null);

  // --------------------------------------------------------------------------
  // Data Loading
  // --------------------------------------------------------------------------

  /**
   * Fetches all team data for the authenticated user.
   *
   * Calls the get_user_teams RPC to find the user's team, then fetches
   * team details, members, and pending invitations in parallel.
   *
   * @throws Sets error state if the user is not authenticated or queries fail
   */
  const loadTeamData = useCallback(async () => {
    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        setError('You must be signed in to view team data.');
        setIsLoading(false);
        return;
      }

      setCurrentUserId(user.id);

      // Fetch user's teams via the get_user_teams RPC
      const { data: teamsData, error: teamsError } = await supabase.rpc('get_user_teams');

      if (teamsError) {
        throw new Error(teamsError.message);
      }

      const validatedTeams = safeParseArray(UserTeamRowSchema, teamsData, 'user_teams');

      if (validatedTeams.length === 0) {
        // User has no team
        setTeam(null);
        setCurrentUserRole(null);
        setMembers([]);
        setInvitations([]);
        teamIdRef.current = null;
        setError(null);
        setIsLoading(false);
        return;
      }

      // Use the first (primary) team
      const primaryTeam = validatedTeams[0];
      setCurrentUserRole(primaryTeam.role as 'owner' | 'admin' | 'member');
      teamIdRef.current = primaryTeam.team_id;

      // Fetch team details, members, and invitations in parallel
      const [teamResult, membersResult, invitationsResult] = await Promise.all([
        supabase.from('teams').select('*').eq('id', primaryTeam.team_id).single(),
        supabase.rpc('get_team_members', { p_team_id: primaryTeam.team_id }),
        // Only fetch invitations if user is owner or admin
        primaryTeam.role === 'owner' || primaryTeam.role === 'admin'
          ? supabase
              .from('team_invitations')
              .select('*')
              .eq('team_id', primaryTeam.team_id)
              .eq('status', 'pending')
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (teamResult.error) {
        throw new Error(teamResult.error.message);
      }

      const validatedTeam = safeParseSingle(TeamSchema, teamResult.data, 'team');
      setTeam(validatedTeam);

      if (membersResult.error) {
        throw new Error(membersResult.error.message);
      }

      setMembers(safeParseArray(TeamMemberSchema, membersResult.data, 'team_members'));
      setInvitations(
        safeParseArray(TeamInvitationSchema, invitationsResult.data, 'team_invitations'),
      );

      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load team data';
      setError(message);
      if (__DEV__) {
        console.error('[useTeamManagement] Error loading team data:', err);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load data on mount
  useEffect(() => {
    loadTeamData();
  }, [loadTeamData]);

  // --------------------------------------------------------------------------
  // Create Team
  // --------------------------------------------------------------------------

  /**
   * Creates a new team and automatically adds the current user as the owner.
   *
   * The database trigger `on_team_created` automatically creates a team_members
   * row with role='owner' for the team creator, so we only need to insert into
   * the teams table.
   *
   * @param name - Team display name (1-100 characters)
   * @param description - Optional team description
   * @returns The created team, or null on failure
   * @throws Sets error state if the name is invalid or the insert fails
   *
   * @example
   * const team = await createTeam('Engineering', 'The engineering team');
   * if (team) console.log('Created team:', team.id);
   */
  const createTeam = useCallback(async (
    name: string,
    description?: string,
  ): Promise<ValidatedTeam | null> => {
    setIsMutating(true);
    setError(null);

    try {
      if (!name || name.trim().length === 0) {
        setError('Team name is required.');
        return null;
      }

      if (name.trim().length > 100) {
        setError('Team name must be 100 characters or fewer.');
        return null;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('You must be signed in to create a team.');
        return null;
      }

      const { data, error: insertError } = await supabase
        .from('teams')
        .insert({
          name: name.trim(),
          description: description?.trim() || null,
          owner_id: user.id,
        })
        .select('*')
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      const validated = safeParseSingle(TeamSchema, data, 'team');
      if (validated) {
        setTeam(validated);
        setCurrentUserRole('owner');
        teamIdRef.current = validated.id;
        // Reload to get the full member list (trigger creates owner membership)
        await loadTeamData();
      }

      return validated;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create team';
      setError(message);
      if (__DEV__) {
        console.error('[useTeamManagement] Error creating team:', err);
      }
      return null;
    } finally {
      setIsMutating(false);
    }
  }, [loadTeamData]);

  // --------------------------------------------------------------------------
  // Invite Member
  // --------------------------------------------------------------------------

  /**
   * Sends a team invitation to the specified email address.
   *
   * Creates a row in the team_invitations table with a unique token and
   * 7-day expiration. The invitation can be accepted via the web dashboard.
   *
   * @param email - Email address of the user to invite
   * @param role - Role to assign upon acceptance ('admin' or 'member')
   * @returns True if the invitation was sent, false on failure
   * @throws Sets error state if validation fails or the insert fails
   *
   * @example
   * const success = await inviteMember('user@example.com', 'member');
   * if (success) console.log('Invitation sent');
   */
  const inviteMember = useCallback(async (
    email: string,
    role: 'admin' | 'member',
  ): Promise<boolean> => {
    setIsMutating(true);
    setError(null);

    try {
      const currentTeamId = teamIdRef.current;
      if (!currentTeamId) {
        setError('You must have a team before inviting members.');
        return false;
      }

      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        setError('Please enter a valid email address.');
        return false;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('You must be signed in to invite members.');
        return false;
      }

      const token = generateInviteToken();

      const { data, error: insertError } = await supabase
        .from('team_invitations')
        .insert({
          team_id: currentTeamId,
          email: normalizedEmail,
          invited_by: user.id,
          role,
          token,
          status: 'pending',
        })
        .select('*')
        .single();

      if (insertError) {
        // Handle unique constraint violation (already invited)
        if (insertError.code === '23505') {
          setError('This email has already been invited to the team.');
          return false;
        }
        throw new Error(insertError.message);
      }

      const validated = safeParseSingle(TeamInvitationSchema, data, 'team_invitation');
      if (validated) {
        setInvitations((prev) => [validated, ...prev]);
      }

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send invitation';
      setError(message);
      if (__DEV__) {
        console.error('[useTeamManagement] Error inviting member:', err);
      }
      return false;
    } finally {
      setIsMutating(false);
    }
  }, []);

  // --------------------------------------------------------------------------
  // Update Member Role
  // --------------------------------------------------------------------------

  /**
   * Updates a team member's role.
   *
   * Only owners can change any role. Admins can change members to admin,
   * but these constraints are enforced by RLS policies on the database side.
   *
   * @param memberId - The team_members.id (UUID) of the member to update
   * @param role - The new role to assign ('admin' or 'member')
   * @returns True if the role was updated, false on failure
   * @throws Sets error state if the update fails
   *
   * @example
   * const success = await updateMemberRole('member-uuid', 'admin');
   */
  const updateMemberRole = useCallback(async (
    memberId: string,
    role: 'admin' | 'member',
  ): Promise<boolean> => {
    setIsMutating(true);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from('team_members')
        .update({ role })
        .eq('id', memberId);

      if (updateError) {
        throw new Error(updateError.message);
      }

      // Update local state optimistically
      setMembers((prev) =>
        prev.map((m) =>
          m.member_id === memberId ? { ...m, role } : m,
        ),
      );

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update member role';
      setError(message);
      if (__DEV__) {
        console.error('[useTeamManagement] Error updating role:', err);
      }
      return false;
    } finally {
      setIsMutating(false);
    }
  }, []);

  // --------------------------------------------------------------------------
  // Remove Member
  // --------------------------------------------------------------------------

  /**
   * Removes a member from the team.
   *
   * Owners can remove anyone. Admins can remove members but not other admins
   * or the owner. These constraints are enforced by RLS policies.
   *
   * @param memberId - The team_members.id (UUID) of the member to remove
   * @returns True if the member was removed, false on failure
   * @throws Sets error state if the deletion fails
   *
   * @example
   * const success = await removeMember('member-uuid');
   */
  const removeMember = useCallback(async (memberId: string): Promise<boolean> => {
    setIsMutating(true);
    setError(null);

    try {
      const { error: deleteError } = await supabase
        .from('team_members')
        .delete()
        .eq('id', memberId);

      if (deleteError) {
        throw new Error(deleteError.message);
      }

      // Remove from local state
      setMembers((prev) => prev.filter((m) => m.member_id !== memberId));

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove member';
      setError(message);
      if (__DEV__) {
        console.error('[useTeamManagement] Error removing member:', err);
      }
      return false;
    } finally {
      setIsMutating(false);
    }
  }, []);

  // --------------------------------------------------------------------------
  // Refresh
  // --------------------------------------------------------------------------

  /**
   * Refreshes all team data by re-fetching from Supabase.
   *
   * @example
   * await refresh();
   */
  const refresh = useCallback(async () => {
    setIsLoading(true);
    await loadTeamData();
  }, [loadTeamData]);

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    team,
    currentUserRole,
    members,
    invitations,
    isLoading,
    isMutating,
    error,
    currentUserId,
    createTeam,
    inviteMember,
    updateMemberRole,
    removeMember,
    refresh,
  };
}
