/**
 * useTeamMembership — lightweight check for whether the authenticated
 * user belongs to any team.
 *
 * WHY: The Sessions screen needs to know whether to show the
 * "Team Sessions" scope chip. We deliberately avoid the full
 * useTeamManagement hook because it loads invites, members, billing,
 * etc. — far more than we need for a visibility check.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Return value of useTeamMembership.
 */
export interface UseTeamMembershipResult {
  /** True if the current user is a member of at least one team. */
  isTeamMember: boolean;
  /** The user's team ID, or null when they have no team. */
  userTeamId: string | null;
}

/**
 * Hook that resolves the user's team membership exactly once on mount.
 *
 * Errors are swallowed (logged) because this is a non-critical UI
 * affordance — failing closed (no Team Sessions chip) is the safe
 * default for non-members.
 *
 * @returns Membership state — see UseTeamMembershipResult.
 *
 * @example
 * const { isTeamMember, userTeamId } = useTeamMembership();
 * if (isTeamMember) { ... show Team Sessions chip ... }
 */
export function useTeamMembership(): UseTeamMembershipResult {
  const [isTeamMember, setIsTeamMember] = useState(false);
  const [userTeamId, setUserTeamId] = useState<string | null>(null);

  useEffect(() => {
    /**
     * Check if the authenticated user belongs to a team by querying the
     * team_members table. We only need to know if any row exists.
     *
     * WHY: We query team_members directly rather than using the
     * useTeamManagement hook to avoid loading all team management data
     * just for a visibility check.
     */
    const checkTeamMembership = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) return;

        const { data } = await supabase
          .from('team_members')
          .select('team_id')
          .eq('user_id', user.id)
          .limit(1)
          .single();

        if (data?.team_id) {
          setIsTeamMember(true);
          setUserTeamId(data.team_id as string);
        }
      } catch (error) {
        // WHY: Gracefully handle auth or network errors during team
        // membership check. Non-critical — the user just won't see the
        // "Team Sessions" scope filter.
        console.warn('[sessions] Team membership check failed:', error);
      }
    };

    void checkTeamMembership();
  }, []);

  return { isTeamMember, userTeamId };
}
