/**
 * useBillingBreakdown hook
 *
 * Fetches billing model breakdown from cost_records for the selected time range.
 * Returns aggregated buckets for the billing model summary strip.
 *
 * WHY a dedicated hook: The existing useCosts hook fetches from v_my_daily_costs
 * (the materialized view) which does not include billing_model or source columns
 * added in migration 022. Rather than invasively modify the hook and schema, this
 * lightweight companion hook queries cost_records directly for the billing metadata.
 * It can be retired in favour of a MV update in a future migration.
 *
 * @module components/costs/useBillingBreakdown
 */

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import type { BillingModel } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Aggregated billing model buckets for the selected time range.
 */
export interface BillingBreakdown {
  /** Total USD cost from api-key billed records. */
  apiKeyCostUsd: number;
  /**
   * Average subscription quota fraction consumed [0, 1] across all
   * subscription records that reported a fraction. Null when no such records
   * exist or none reported a fraction.
   */
  subscriptionFractionUsed: number | null;
  /** Number of subscription-billed records (determines whether to show the bucket). */
  subscriptionRowCount: number;
  /** Total credits consumed across credit-billed records. */
  creditsConsumed: number;
  /** USD equivalent of all credit-billed records. */
  creditCostUsd: number;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Fetches and aggregates billing model breakdown for the selected time range.
 *
 * @param timeRangeDays - Number of days to look back (7, 30, or 90)
 * @returns Billing model breakdown buckets + loading state
 *
 * @example
 * const { breakdown, isLoading } = useBillingBreakdown(30);
 */
export function useBillingBreakdown(timeRangeDays: number): {
  breakdown: BillingBreakdown | null;
  isLoading: boolean;
} {
  const [breakdown, setBreakdown] = useState<BillingBreakdown | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      setIsLoading(true);

      const rangeStart = new Date();
      rangeStart.setDate(rangeStart.getDate() - timeRangeDays);
      const rangeStartDate = rangeStart.toISOString().split('T')[0];

      const { data, error } = await supabase
        .from('cost_records')
        .select('billing_model, cost_usd, subscription_fraction_used, credits_consumed')
        .gte('record_date', rangeStartDate)
        .limit(5000);

      if (cancelled) return;

      if (error || !data) {
        if (__DEV__) {
          console.warn('[useBillingBreakdown] fetch error:', error?.message);
        }
        setBreakdown(null);
        setIsLoading(false);
        return;
      }

      // Aggregate into buckets
      let apiKeyCostUsd = 0;
      let subscriptionFractionSum = 0;
      let subscriptionRowCount = 0;
      let creditsConsumed = 0;
      let creditCostUsd = 0;

      for (const row of data) {
        const cost = Number(row.cost_usd) || 0;
        const model = (row.billing_model as BillingModel | null) ?? 'api-key';

        switch (model) {
          case 'api-key':
            apiKeyCostUsd += cost;
            break;
          case 'subscription':
            subscriptionRowCount += 1;
            if (row.subscription_fraction_used != null) {
              subscriptionFractionSum += Number(row.subscription_fraction_used) || 0;
            }
            break;
          case 'credit':
            creditsConsumed += Number(row.credits_consumed) || 0;
            creditCostUsd += cost;
            break;
          case 'free':
            // WHY: free rows don't contribute to any spend bucket; we count
            // them nowhere to keep the strip clean.
            break;
        }
      }

      const avgFraction =
        subscriptionRowCount > 0 ? subscriptionFractionSum / subscriptionRowCount : null;

      setBreakdown({
        apiKeyCostUsd,
        subscriptionFractionUsed: avgFraction,
        subscriptionRowCount,
        creditsConsumed,
        creditCostUsd,
      });
      setIsLoading(false);
    }

    void fetch();

    return () => {
      cancelled = true;
    };
  }, [timeRangeDays]);

  return { breakdown, isLoading };
}
