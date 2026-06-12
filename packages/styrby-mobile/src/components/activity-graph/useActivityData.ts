/**
 * useActivityData — fetches + aggregates coding-session activity by date.
 *
 * Extracted from ActivityGraph.tsx (Cluster A2 split). Owns the Supabase query,
 * the pre-flight auth gate, and the per-day aggregation; the component consumes
 * the returned map and only renders.
 *
 * @module components/activity-graph/useActivityData
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import type { ActivityDay, AgentType } from 'styrby-shared';
import { MAX_WEEKS, DAYS_PER_WEEK } from './constants';
import { toDateStr } from './activity-grid';

/** State the ActivityGraph component needs to render. */
export interface UseActivityData {
  /** Map of YYYY-MM-DD to aggregated ActivityDay. */
  rawData: Map<string, ActivityDay>;
  /** True while the initial fetch is in flight. */
  isLoading: boolean;
}

/**
 * Fetch session data from Supabase and aggregate by date.
 *
 * @returns The aggregated activity map + loading flag.
 */
export function useActivityData(): UseActivityData {
  const [rawData, setRawData] = useState<Map<string, ActivityDay>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  /**
   * Fetch session rows and aggregate them into per-day totals.
   *
   * WHY query `sessions` (not `cost_records`): sessions carry a `started_at`
   * date that naturally represents the coding-contribution date. Using cost
   * record dates would fragment a session that spans midnight.
   */
  const fetchData = useCallback(async () => {
    // WHY pre-flight auth check: the `sessions` RLS policy
    // `sessions_select_own_or_team` includes a branch that calls
    // is_team_member() when a session row has team_id IS NOT NULL.
    // is_team_member is REVOKE'd from `anon`. If the calling JWT is
    // missing/expired/anon, Postgres returns 42501 and the whole
    // query fails - including the rows we'd otherwise be allowed to see.
    // Pre-checking auth here is the proper fix: when there is no user,
    // there is nothing for us to fetch under any circumstance, so we
    // skip the call entirely and render an empty state. This avoids
    // the spurious permission-denied error AND makes the not-yet-authed
    // path correct by construction (the graph stays empty until the user
    // is fully authenticated).
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) {
      setRawData(new Map());
      setIsLoading(false);
      return;
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_WEEKS * DAYS_PER_WEEK);
    const cutoffStr = toDateStr(cutoff);

    const { data, error } = await supabase
      .from('sessions')
      .select('started_at, total_cost_usd, agent_type, context_window_used')
      .gte('started_at', cutoffStr + 'T00:00:00Z')
      .order('started_at', { ascending: true });

    if (error) {
      console.error('[ActivityGraph] Fetch error:', __DEV__ ? error : error.message);
      return;
    }

    const map = new Map<string, ActivityDay>();

    for (const row of data ?? []) {
      const dateStr = (row.started_at as string).split('T')[0];
      const cost = Number(row.total_cost_usd) || 0;
      const tokens = Number(row.context_window_used) || 0;
      const agent = (row.agent_type as string) || 'unknown';

      const existing = map.get(dateStr) ?? {
        date: dateStr,
        sessionCount: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        agents: [] as AgentType[],
        intensity: 0 as const,
      };

      const agents = (existing.agents as string[]).includes(agent)
        ? existing.agents
        : ([...existing.agents, agent] as AgentType[]);

      map.set(dateStr, {
        date: dateStr,
        sessionCount: existing.sessionCount + 1,
        totalCostUsd: existing.totalCostUsd + cost,
        totalTokens: existing.totalTokens + tokens,
        agents,
        intensity: 0, // recomputed in buildGrid
      });
    }

    setRawData(map);
  }, []);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await fetchData();
      setIsLoading(false);
    };
    load();
  }, [fetchData]);

  return { rawData, isLoading };
}
