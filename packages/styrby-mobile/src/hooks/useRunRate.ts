/**
 * useRunRate — mobile hook for MTD cost projection + tier cap metrics.
 *
 * Queries Supabase for:
 *   - Today's cost (UTC date boundary)
 *   - Month-to-date cost (1st of current month)
 *   - Last 30-day rolling cost
 *   - User's active subscription tier
 *
 * Returns a {@link RunRateProjection} from the shared calcRunRate() function
 * so the RunRateCard and TierUpgradeWarning components can render without
 * duplicating projection logic.
 *
 * WHY a separate hook (not merged into useCosts): useCosts already queries
 * the cost_records table for N days of detail data (up to 90 days). The run-
 * rate projection needs three specific aggregations with different date
 * windows. Keeping them separate avoids making useCosts even larger (it is
 * already 860+ lines) and allows RunRateCard to be mounted on any screen
 * without pulling in the full cost dataset.
 *
 * @module hooks/useRunRate
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { calcRunRate, normalizeTier } from 'styrby-shared';
import type { RunRateProjection } from 'styrby-shared';

// ============================================================================
// Return type
// ============================================================================

/**
 * Return value of {@link useRunRate}.
 */
export interface UseRunRateReturn {
  /** Projection data, or null while loading / on error. */
  projection: RunRateProjection | null;
  /** True while the initial fetch is in progress. */
  isLoading: boolean;
  /** Error message, or null if no error. */
  error: string | null;
  /** Trigger a manual refresh. */
  refresh: () => void;
  /** Human-readable tier label for the warning card. */
  tierLabel: string;
}

// ============================================================================
// Tier display names
// ============================================================================

// WHY display labels diverge from the stored value: Phase 6 collapsed the
// public ladder to Pro + Growth (`.audit/styrby-fulltest.md` Decision #9).
// `'power'` and `'team'` are kept in `SubscriptionTier` as legacy aliases
// for back-compat with existing subscription rows; both render as "Growth"
// at the UI boundary.
const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  power: 'Growth',
  team: 'Growth',
};

// ============================================================================
// Hook
// ============================================================================

/**
 * Returns MTD cost projection and tier cap metrics for the current user.
 *
 * @returns {@link UseRunRateReturn}
 *
 * @example
 * const { projection, isLoading, tierLabel } = useRunRate();
 * if (projection) {
 *   return <RunRateCard projection={projection} />;
 * }
 */
export function useRunRate(): UseRunRateReturn {
  const [projection, setProjection] = useState<RunRateProjection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tierLabel, setTierLabel] = useState('Free');

  const fetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const monthStartStr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString()
        .split('T')[0];
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

      // Fetch three aggregations + subscription tier in parallel.
      // WHY parallel: independent queries; serial would triple the round-trip time.
      const [todayRes, mtdRes, rollingRes, subRes] = await Promise.all([
        // Today's cost
        supabase
          .from('cost_records')
          .select('cost_usd')
          .gte('record_date', todayStr)
          .limit(5000),

        // MTD cost (from 1st of month)
        supabase
          .from('cost_records')
          .select('cost_usd')
          .gte('record_date', monthStartStr)
          .limit(10000),

        // Rolling 30-day cost
        supabase
          .from('cost_records')
          .select('cost_usd')
          .gte('record_date', thirtyDaysAgoStr)
          .limit(10000),

        // Active subscription tier
        supabase
          .from('subscriptions')
          .select('tier')
          .eq('status', 'active')
          .maybeSingle(),
      ]);

      // Propagate the first Supabase error encountered.
      const firstError = todayRes.error || mtdRes.error || rollingRes.error;
      if (firstError) {
        throw new Error(firstError.message);
      }

      // Aggregate USD sums.
      const sumUsd = (rows: { cost_usd: number }[] | null): number =>
        (rows ?? []).reduce((acc, r) => acc + (Number(r.cost_usd) || 0), 0);

      const todayUsd = sumUsd(todayRes.data);
      const mtdUsd = sumUsd(mtdRes.data);
      const last30DaysUsd = sumUsd(rollingRes.data);

      const rawTier = subRes.data?.tier as string | null | undefined;
      const tier = normalizeTier(rawTier);
      setTierLabel(TIER_LABELS[tier] ?? 'Free');

      setProjection(
        calcRunRate({ todayUsd, mtdUsd, last30DaysUsd, tier })
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load run-rate data';
      // WHY: Never swallow errors silently. The component renders a fallback
      // state when error is non-null, so the user knows something went wrong.
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { projection, isLoading, error, refresh: fetch, tierLabel };
}
