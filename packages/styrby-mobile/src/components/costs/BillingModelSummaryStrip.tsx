/**
 * BillingModelSummaryStrip (Mobile)
 *
 * A compact one-line strip showing this-period billing model breakdown:
 *
 *   API: $12.40  |  SUB: 47%  |  CR: 430 cr ($4.30)
 *
 * Mirrors the web version in billing-model-summary-strip.tsx.
 * Sections are only rendered when the corresponding billing model has data.
 *
 * @module components/costs/BillingModelSummaryStrip
 */

import { View, Text } from 'react-native';
import type { BillingBreakdown } from './useBillingBreakdown';

// WHY: Inline formatCost to avoid pulling useCosts (Supabase client) into
// a pure-display component. formatCost is trivial — no external dependency needed.
function formatCost(cost: number, decimals = 2): string {
  return `$${cost.toFixed(decimals)}`;
}

/**
 * Props for {@link BillingModelSummaryStrip}.
 */
interface BillingModelSummaryStripProps {
  /** Aggregated billing breakdown for the selected time range. */
  breakdown: BillingBreakdown;
  /** Selected time range in days. */
  days: number;
}

/**
 * Renders the billing model summary strip.
 *
 * @param props - Component props
 * @returns Strip view, or null if no data
 */
export function BillingModelSummaryStrip({ breakdown, days }: BillingModelSummaryStripProps) {
  const hasApi = breakdown.apiKeyCostUsd > 0;
  const hasSub = breakdown.subscriptionRowCount > 0;
  const hasCredits = breakdown.creditsConsumed > 0 || breakdown.creditCostUsd > 0;

  if (!hasApi && !hasSub && !hasCredits) {
    return null;
  }

  return (
    <View
      className="mx-4 mb-4 rounded-xl bg-background-secondary border border-zinc-800 px-4 py-3"
      accessibilityLabel={`Billing breakdown for the last ${days} days`}
    >
      <Text className="text-zinc-500 text-xs font-medium mb-2">Last {days}d breakdown</Text>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        {/* API bucket */}
        {hasApi && (
          <View className="flex-row items-center gap-1.5">
            <View className="h-2 w-2 rounded-sm bg-blue-500" accessibilityElementsHidden />
            <Text className="text-zinc-400 text-xs">API:</Text>
            <Text className="text-white text-xs font-semibold">
              {formatCost(breakdown.apiKeyCostUsd, 2)}
            </Text>
          </View>
        )}

        {/* Subscription bucket */}
        {hasSub && (
          <View className="flex-row items-center gap-1.5">
            <View className="h-2 w-2 rounded-sm bg-purple-500" accessibilityElementsHidden />
            <Text className="text-zinc-400 text-xs">SUB:</Text>
            <Text className="text-white text-xs font-semibold">
              {breakdown.subscriptionFractionUsed != null
                ? `${Math.round(breakdown.subscriptionFractionUsed * 100)}% quota`
                : `${breakdown.subscriptionRowCount} session${breakdown.subscriptionRowCount !== 1 ? 's' : ''}`}
            </Text>
          </View>
        )}

        {/* Credit bucket */}
        {hasCredits && (
          <View className="flex-row items-center gap-1.5">
            <View className="h-2 w-2 rounded-sm bg-amber-500" accessibilityElementsHidden />
            <Text className="text-zinc-400 text-xs">CR:</Text>
            <Text className="text-white text-xs font-semibold">
              {breakdown.creditsConsumed > 0
                ? breakdown.creditCostUsd > 0
                  ? `${breakdown.creditsConsumed} cr (${formatCost(breakdown.creditCostUsd, 2)})`
                  : `${breakdown.creditsConsumed} cr`
                : formatCost(breakdown.creditCostUsd, 2)}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
