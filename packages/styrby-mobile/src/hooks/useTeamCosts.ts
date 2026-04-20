/**
 * Team Cost Data Hook
 *
 * Fetches per-member cost breakdown for a Power-tier team via the Supabase
 * `get_team_cost_summary` RPC function. The RPC aggregates cost data from
 * mv_daily_cost_summary (service-role access, bypasses the per-user v_my_daily_costs view)
 * for all team members and returns per-user totals.
 *
 * WHY RPC: Team members' cost_records are scoped by user_id under RLS. The
 * server-side function runs with elevated privileges to join across member IDs
 * and returns only pre-aggregated totals — no raw cost_records are returned.
 *
 * Power tier + team membership required. Returns an empty/gated state for
 * Free/Pro users or users who are not in a team.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

// ============================================================================
// Types
// ============================================================================

/**
 * Per-member cost summary row, as returned by get_team_cost_summary RPC.
 */
export interface MemberCostRow {
  /** Supabase user ID */
  userId: string;
  /** Display name from profiles, or email fallback */
  displayName: string;
  /** Member's email address */
  email: string;
  /** Total USD spend for the selected period */
  totalCostUsd: number;
  /** Total input tokens consumed */
  totalInputTokens: number;
  /** Total output tokens generated */
  totalOutputTokens: number;
  /** Percentage of the team total (0–100) */
  percentageOfTotal: number;
}

/**
 * Return type for the useTeamCosts hook.
 */
export interface UseTeamCostsReturn {
  /** Per-member cost rows sorted by spend descending */
  memberCosts: MemberCostRow[];
  /** Combined total spend for all members */
  teamTotal: number;
  /** Whether data is currently loading */
  isLoading: boolean;
  /** Error message if the fetch failed */
  error: string | null;
  /** Whether the current user is on Power tier and in a team */
  isEligible: boolean;
  /** Refresh the team cost data */
  refresh: () => Promise<void>;
}

// ============================================================================
// RPC row type
// ============================================================================

/**
 * Raw row shape returned by the get_team_cost_summary Supabase RPC.
 */
interface RpcRow {
  user_id: string;
  display_name: string | null;
  email: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for fetching team cost breakdown for Power-tier teams.
 *
 * Checks the user's subscription tier and team membership on mount. If the
 * user is eligible (Power + team member), fetches and returns per-member costs.
 * Otherwise, returns `isEligible: false` so the caller can render a gate.
 *
 * @param rangeStartDate - ISO date string for the start of the cost window
 * @returns Team cost rows, team total, and loading/error states
 *
 * @example
 * const { memberCosts, teamTotal, isLoading, isEligible } = useTeamCosts('2026-03-01');
 *
 * if (!isEligible) return <PowerTeamGate />;
 * if (isLoading) return <ActivityIndicator />;
 * return <TeamCostList members={memberCosts} total={teamTotal} />;
 */
export function useTeamCosts(rangeStartDate: string): UseTeamCostsReturn {
  const [memberCosts, setMemberCosts] = useState<MemberCostRow[]>([]);
  const [teamTotal, setTeamTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEligible, setIsEligible] = useState(false);
  const [teamId, setTeamId] = useState<string | null>(null);

  /**
   * Checks eligibility (Power tier + team membership) and resolves the team ID.
   *
   * WHY two checks: Tier and team membership are independent. A user could be
   * on Power with no team (solo Power subscriber), or in a team on a legacy plan.
   * Both conditions must be true to show team costs.
   *
   * @returns The team ID if eligible, or null
   */
  const checkEligibility = useCallback(async (): Promise<string | null> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    // Check subscription tier
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .single();

    if (subscription?.tier !== 'power') {
      setIsEligible(false);
      return null;
    }

    // Check team membership via the get_user_teams RPC
    const { data: teams } = await supabase.rpc('get_user_teams');

    if (!teams || (teams as Array<{ team_id: string }>).length === 0) {
      // User is Power but not in a team — show a prompt to create/join a team
      setIsEligible(false);
      return null;
    }

    // Use the first (primary) team
    const primaryTeamId = (teams as Array<{ team_id: string }>)[0].team_id;
    setIsEligible(true);
    setTeamId(primaryTeamId);
    return primaryTeamId;
  }, []);

  /**
   * Fetches team cost breakdown from the get_team_cost_summary RPC.
   *
   * @param resolvedTeamId - Team ID to aggregate costs for
   * @param startDate - ISO date string for the lookback window start
   */
  const fetchTeamCosts = useCallback(async (
    resolvedTeamId: string,
    startDate: string,
  ): Promise<void> => {
    setError(null);

    const { data, error: rpcError } = await supabase.rpc('get_team_cost_summary', {
      p_team_id: resolvedTeamId,
      p_start_date: startDate,
    });

    if (rpcError) {
      // WHY: Surface a clear message if the RPC function doesn't exist yet
      // (i.e. the database migration hasn't been applied).
      if (rpcError.code === 'PGRST202' || rpcError.message.includes('does not exist')) {
        setError('Team cost data requires a database migration. Contact support if this persists.');
      } else {
        setError('Failed to load team costs. Please try again.');
      }
      if (__DEV__) {
        console.error('[useTeamCosts] RPC error:', rpcError);
      }
      return;
    }

    const rows: MemberCostRow[] = ((data as RpcRow[]) ?? []).map((row) => ({
      userId: row.user_id,
      displayName: row.display_name ?? row.email,
      email: row.email,
      totalCostUsd: Number(row.total_cost_usd) || 0,
      totalInputTokens: Number(row.total_input_tokens) || 0,
      totalOutputTokens: Number(row.total_output_tokens) || 0,
      percentageOfTotal: 0, // calculated below
    }));

    // Sort by cost descending — highest spender at the top
    rows.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    const total = rows.reduce((sum, r) => sum + r.totalCostUsd, 0);

    // Calculate each member's percentage of team total
    const rowsWithPct = rows.map((r) => ({
      ...r,
      percentageOfTotal: total > 0 ? (r.totalCostUsd / total) * 100 : 0,
    }));

    setMemberCosts(rowsWithPct);
    setTeamTotal(total);
  }, []);

  /**
   * Full load sequence: check eligibility, then fetch cost data if eligible.
   */
  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const resolvedTeamId = await checkEligibility();
      if (resolvedTeamId) {
        await fetchTeamCosts(resolvedTeamId, rangeStartDate);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load team costs';
      setError(message);
      if (__DEV__) {
        console.error('[useTeamCosts] Load error:', err);
      }
    } finally {
      setIsLoading(false);
    }
  }, [checkEligibility, fetchTeamCosts, rangeStartDate]);

  // Initial load on mount
  useEffect(() => {
    load();
  }, [load]);

  /**
   * Re-fetch when rangeStartDate changes (e.g. user switches time range).
   * Skip the eligibility check since we already have the team ID.
   */
  useEffect(() => {
    if (!teamId || !isEligible) return;

    setIsLoading(true);
    fetchTeamCosts(teamId, rangeStartDate)
      .finally(() => setIsLoading(false));
  }, [rangeStartDate, teamId, isEligible, fetchTeamCosts]);

  /**
   * Public refresh function for pull-to-refresh.
   */
  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  return {
    memberCosts,
    teamTotal,
    isLoading,
    error,
    isEligible,
    refresh,
  };
}
