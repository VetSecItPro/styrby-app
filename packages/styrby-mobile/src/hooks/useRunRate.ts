/**
 * useRunRate — fetches last-7d spend data for the run-rate projection banner.
 *
 * WHY separate hook: useCosts fetches data for the selected time range (7/30/90d).
 * The run-rate projection always needs exactly 7 days of data, regardless of
 * the selected time range. A separate hook keeps the concerns separate and
 * avoids coupling the run-rate to the time range selector.
 *
 * @module hooks/useRunRate
 */

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

// ============================================================================
// Types
// ============================================================================

/**
 * Run-rate data returned by {@link useRunRate}.
 */
export interface RunRateData {
  /** Total spend in the last 7 calendar days. Null if not loaded. */
  last7dSpendUsd: number | null;
  /** Number of distinct days with records in the last 7d. */
  historyDays: number;
  /** Month-to-date spend (resets 1st of month). */
  monthToDateSpendUsd: number;
  /** Monthly cap from lowest monthly budget alert. Null if none set. */
  monthlyCap: number | null;
  /** Loading state. */
  isLoading: boolean;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Fetches data needed for the RunRateProjection banner.
 *
 * @returns Run-rate data + loading state
 *
 * @example
 * const { last7dSpendUsd, historyDays, monthToDateSpendUsd, monthlyCap } = useRunRate();
 */
export function useRunRate(): RunRateData {
  const [state, setState] = useState<RunRateData>({
    last7dSpendUsd: null,
    historyDays: 0,
    monthToDateSpendUsd: 0,
    monthlyCap: null,
    isLoading: true,
  });

  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const sevenDaysAgoDate = sevenDaysAgo.toISOString().split('T')[0];

      const now = new Date();
      const monthStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString().split('T')[0];

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Fetch last-7d cost records in parallel with budget alerts
      const [costsResult, alertsResult] = await Promise.all([
        supabase
          .from('cost_records')
          .select('record_date, cost_usd')
          .eq('user_id', user.id)
          .gte('record_date', sevenDaysAgoDate)
          .limit(10_000),
        supabase
          .from('budget_alerts')
          .select('threshold_usd, period, agent_type')
          .eq('user_id', user.id)
          .eq('is_enabled', true)
          .eq('period', 'monthly'),
      ]);

      if (cancelled) return;

      // Aggregate last-7d spend and distinct days
      let last7dSpendUsd = 0;
      let monthToDateSpendUsd = 0;
      const distinctDays = new Set<string>();

      for (const row of costsResult.data ?? []) {
        const cost = Number(row.cost_usd) || 0;
        const date = row.record_date as string;
        last7dSpendUsd += cost;
        distinctDays.add(date);
        if (date >= monthStartDate) {
          monthToDateSpendUsd += cost;
        }
      }

      // Find lowest threshold monthly alert (no agent filter = all-agents cap)
      const monthlyAlerts = (alertsResult.data ?? []).filter((a) => !a.agent_type);
      const lowestCap = monthlyAlerts
        .map((a) => Number(a.threshold_usd))
        .filter((n) => n > 0)
        .sort((a, b) => a - b)[0] ?? null;

      setState({
        last7dSpendUsd,
        historyDays: distinctDays.size,
        monthToDateSpendUsd,
        monthlyCap: lowestCap,
        isLoading: false,
      });
    }

    void fetch();
    return () => { cancelled = true; };
  }, []);

  return state;
}
