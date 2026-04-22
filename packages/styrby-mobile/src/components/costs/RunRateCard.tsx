/**
 * RunRateCard — mobile cost projection card.
 *
 * Displays:
 *  - Today's actual spend
 *  - Month-to-date actual spend
 *  - Projected end-of-month spend at current run-rate
 *  - Color-coded progress bar against tier cap
 *  - "X days until cap" warning when cap is close
 *
 * WHY: Users need a single glance to answer "am I on track this month?"
 * without navigating to a detail page. The color-coded bar (green/amber/red)
 * mirrors the web Cost Analytics page for visual parity.
 *
 * @module components/costs/RunRateCard
 */

import { View, Text } from 'react-native';
import type { RunRateProjection } from 'styrby-shared';
import { capColorBand } from 'styrby-shared';

// ============================================================================
// Helpers
// ============================================================================

/** Formats a USD cost for display. Returns "$0.00" for zero. */
function fmt(usd: number, decimals = 2): string {
  return `$${usd.toFixed(decimals)}`;
}

/**
 * Returns a NativeWind background class string for the cap color band.
 *
 * WHY inline map: avoids importing Tailwind config or a design-token package
 * into this component. The three bands are stable and unlikely to change.
 */
function progressBgClass(band: 'green' | 'amber' | 'red'): string {
  switch (band) {
    case 'green':
      return 'bg-green-500';
    case 'amber':
      return 'bg-amber-500';
    case 'red':
      return 'bg-red-500';
  }
}

/**
 * Returns a NativeWind text class for the cap fraction label.
 */
function fractionTextClass(band: 'green' | 'amber' | 'red'): string {
  switch (band) {
    case 'green':
      return 'text-green-400';
    case 'amber':
      return 'text-amber-400';
    case 'red':
      return 'text-red-400';
  }
}

// ============================================================================
// Props
// ============================================================================

/**
 * Props for {@link RunRateCard}.
 */
export interface RunRateCardProps {
  /** Projection data calculated by calcRunRate() in the parent hook. */
  projection: RunRateProjection;
}

// ============================================================================
// Component
// ============================================================================

/**
 * RunRateCard renders a mobile-native cost projection summary card.
 *
 * @param props - See {@link RunRateCardProps}
 * @returns React Native view
 *
 * @example
 * <RunRateCard projection={runRateProjection} />
 */
export function RunRateCard({ projection }: RunRateCardProps) {
  const {
    todayActualUsd,
    mtdActualUsd,
    projectedMonthUsd,
    rollingDailyAvgUsd,
    daysRemainingInMonth,
    tierCapFractionUsed,
    tierCapUsd,
    daysUntilCapHit,
  } = projection;

  const hasCap = tierCapUsd !== null && tierCapFractionUsed !== null;
  const band = hasCap ? capColorBand(tierCapFractionUsed!) : 'green';
  const barWidthPct = hasCap
    ? Math.min(Math.round(tierCapFractionUsed! * 100), 100)
    : 0;

  return (
    <View className="bg-background-secondary rounded-xl p-4">
      {/* Header row */}
      <View className="flex-row items-center justify-between mb-4">
        <Text className="text-zinc-400 text-xs font-semibold tracking-wide">
          MONTHLY RUN-RATE
        </Text>
        {hasCap && (
          <Text className={`text-xs font-medium ${fractionTextClass(band)}`}>
            {Math.round(tierCapFractionUsed! * 100)}% of ${tierCapUsd} cap
          </Text>
        )}
      </View>

      {/* Key metrics row */}
      <View className="flex-row mb-4">
        {/* Today */}
        <View className="flex-1 items-center">
          <Text className="text-zinc-500 text-xs mb-1">Today</Text>
          <Text className="text-white font-semibold text-base">
            {fmt(todayActualUsd)}
          </Text>
        </View>

        <View className="w-px bg-zinc-800 mx-2" />

        {/* MTD Actual */}
        <View className="flex-1 items-center">
          <Text className="text-zinc-500 text-xs mb-1">Month to date</Text>
          <Text className="text-white font-semibold text-base">
            {fmt(mtdActualUsd)}
          </Text>
        </View>

        <View className="w-px bg-zinc-800 mx-2" />

        {/* Projected */}
        <View className="flex-1 items-center">
          <Text className="text-zinc-500 text-xs mb-1">Projected</Text>
          <Text className="text-white font-semibold text-base">
            {projectedMonthUsd !== null ? fmt(projectedMonthUsd) : '-'}
          </Text>
        </View>
      </View>

      {/* Progress bar (only when tier has a cap) */}
      {hasCap && (
        <View className="mb-3">
          <View className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <View
              className={`h-2 rounded-full ${progressBgClass(band)}`}
              style={{ width: `${barWidthPct}%` }}
            />
          </View>
        </View>
      )}

      {/* Footer: daily avg + days remaining / cap warning */}
      <View className="flex-row items-center justify-between">
        <Text className="text-zinc-500 text-xs">
          {fmt(rollingDailyAvgUsd, 3)}/day avg - {daysRemainingInMonth} days left
        </Text>

        {/* WHY: "4 days until cap" is more actionable than a percentage. Only
            show when cap is relevant AND user is close (band !== 'green'). */}
        {hasCap && daysUntilCapHit !== null && band !== 'green' && (
          <Text className={`text-xs font-medium ${fractionTextClass(band)}`}>
            Cap in ~{Math.ceil(daysUntilCapHit)}d
          </Text>
        )}
      </View>
    </View>
  );
}
