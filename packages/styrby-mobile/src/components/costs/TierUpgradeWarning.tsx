/**
 * TierUpgradeWarning — mobile tier-cap warning card.
 *
 * Shown when projected MTD cost > 80% of the user's tier cap, or when
 * MTD actual is already past the cap. Includes an upgrade CTA.
 *
 * WHY: Budget-conscious users at 80%+ of their tier cap need a clear signal
 * and a one-tap path to upgrade. A warning card with ROI framing ("you saved
 * N hours") converts better than a generic banner.
 *
 * @module components/costs/TierUpgradeWarning
 */

import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import type { RunRateProjection } from 'styrby-shared';
import { capColorBand } from 'styrby-shared';

// ============================================================================
// Props
// ============================================================================

/**
 * Props for {@link TierUpgradeWarning}.
 */
export interface TierUpgradeWarningProps {
  /** Projection data used to determine warning severity. */
  projection: RunRateProjection;
  /**
   * Current tier name for display ("Free", "Pro", etc.).
   * Used in the warning copy.
   */
  tierLabel: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a warning card when the user is at 80%+ of their monthly tier cap.
 * Returns null when the tier has no cap or the fraction is below the amber threshold.
 *
 * @param props - See {@link TierUpgradeWarningProps}
 * @returns Warning card or null
 *
 * @example
 * <TierUpgradeWarning projection={projection} tierLabel="Free" />
 */
export function TierUpgradeWarning({
  projection,
  tierLabel,
}: TierUpgradeWarningProps) {
  const router = useRouter();

  const { tierCapFractionUsed, tierCapUsd, projectedMonthUsd } = projection;

  // Only render when there is a cap AND fraction is amber/red.
  if (
    tierCapFractionUsed === null ||
    tierCapUsd === null ||
    capColorBand(tierCapFractionUsed) === 'green'
  ) {
    return null;
  }

  const isOverCap = tierCapFractionUsed >= 1;
  const pct = Math.round(tierCapFractionUsed * 100);

  return (
    <View className="bg-amber-950/40 border border-amber-500/30 rounded-xl p-4 mt-4">
      {/* Icon row */}
      <View className="flex-row items-start gap-3">
        <View className="w-8 h-8 rounded-full bg-amber-500/20 items-center justify-center shrink-0">
          <Text className="text-amber-400 text-sm font-bold">!</Text>
        </View>

        <View className="flex-1">
          <Text className="text-amber-300 font-semibold text-sm mb-1">
            {isOverCap
              ? `${tierLabel} cap reached`
              : `Approaching ${tierLabel} cap (${pct}%)`}
          </Text>

          <Text className="text-zinc-400 text-xs leading-relaxed">
            {isOverCap
              ? `You have exceeded the $${tierCapUsd} monthly cap on the ${tierLabel} plan. Upgrade to keep your agents running without interruption.`
              : `At this rate you will hit the $${tierCapUsd}${
                  projectedMonthUsd !== null
                    ? ` cap — projected end-of-month: $${projectedMonthUsd.toFixed(2)}`
                    : ' cap'
                }. Upgrade to Power for unlimited spend.`}
          </Text>
        </View>
      </View>

      {/* CTA button */}
      <Pressable
        onPress={() => router.push('/pricing' as never)}
        className="mt-3 bg-amber-500 rounded-lg py-2.5 items-center active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Upgrade your plan"
      >
        <Text className="text-black font-semibold text-sm">
          Upgrade plan
        </Text>
      </Pressable>
    </View>
  );
}
