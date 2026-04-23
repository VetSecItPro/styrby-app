/**
 * ForecastCard — Predictive spend card for the mobile Costs screen.
 *
 * Mobile parity for web packages/styrby-web/src/components/dashboard/ForecastCard.tsx.
 *
 * Shows:
 *   - "You're on track to spend $X by end of month" OR
 *   - "At current burn you'll hit your cap on <date>"
 *   - Color-coded: green (< 80% projected), amber (80-100%), red (> 100%)
 *   - Accelerating indicator badge when 7-day avg > 30-day avg by > 15%
 *   - 7d / 14d / 30d horizon forecast breakdown
 *
 * WHY separate from RunRateCard: RunRateCard shows MTD actuals and current
 * run-rate. ForecastCard shows EMA-blend predictions (Phase 3.4 math) that
 * weight recent acceleration and predict a specific exhaustion date.
 * Both cards appear together on the Costs tab — "how am I doing now" vs
 * "what will happen next."
 *
 * @module components/costs/ForecastCard
 */

import { View, Text, ActivityIndicator } from 'react-native';
import type { CostForecast } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for {@link ForecastCard}.
 *
 * Accepts the forecast payload from GET /api/costs/forecast plus tier context.
 * The parent screen (app/(tabs)/costs.tsx) owns the fetch and passes the
 * result down to keep the card pure and testable.
 */
export interface ForecastCardProps {
  /**
   * Forecast payload from the API. Null when loading.
   */
  forecast: (CostForecast & {
    tier: string;
    quotaCents: number | null;
    elapsedCents: number;
  }) | null;

  /**
   * True while the parent is fetching the forecast.
   */
  loading?: boolean;

  /**
   * True when the fetch failed.
   */
  error?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats integer cents as a USD string for display.
 *
 * @param cents - Integer cents
 * @returns "$X.XX" formatted string
 *
 * @example
 * fmtCents(4995); // "$49.95"
 */
function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Returns a NativeWind text color class for the color band.
 *
 * Thresholds mirror the web ForecastCard for visual parity:
 *   < 0.8  → green (safe)
 *   < 1.0  → amber (approaching cap)
 *   >= 1.0 → red (projected to exceed)
 *
 * @param fraction - Projected fraction of quota used (may exceed 1.0)
 */
function colorForFraction(fraction: number): 'green' | 'amber' | 'red' {
  if (fraction < 0.8) return 'green';
  if (fraction < 1.0) return 'amber';
  return 'red';
}

function textColorClass(band: 'green' | 'amber' | 'red'): string {
  switch (band) {
    case 'green': return 'text-green-400';
    case 'amber': return 'text-amber-400';
    case 'red': return 'text-red-400';
  }
}

// ============================================================================
// Component
// ============================================================================

/**
 * ForecastCard renders the predictive spend panel on the mobile Costs screen.
 *
 * @param props - See {@link ForecastCardProps}
 * @returns React Native view
 *
 * @example
 * <ForecastCard forecast={forecastData} loading={isFetching} />
 */
export function ForecastCard({ forecast, loading = false, error = false }: ForecastCardProps) {
  if (loading) {
    return (
      <View className="bg-background-secondary rounded-xl p-4 items-center justify-center min-h-[100px]">
        <ActivityIndicator size="small" color="#71717a" />
        <Text className="text-zinc-500 text-xs mt-2">Loading forecast...</Text>
      </View>
    );
  }

  if (error || !forecast) {
    return (
      <View className="bg-background-secondary rounded-xl p-4">
        <Text className="text-zinc-500 text-sm">Forecast unavailable.</Text>
      </View>
    );
  }

  const {
    dailyAverageCents,
    trailingWeekAverageCents,
    weightedForecastCents,
    predictedExhaustionDate,
    isBurnAccelerating,
    quotaCents,
    elapsedCents,
  } = forecast;

  // Compute projected fraction of quota at 30d horizon.
  const projected30d =
    quotaCents !== null && quotaCents > 0
      ? Math.min((elapsedCents + weightedForecastCents['30d']) / quotaCents, 2)
      : null;

  const band = projected30d !== null ? colorForFraction(projected30d) : 'green';

  // Acceleration rate in percent vs. 30-day baseline.
  const accelPct =
    dailyAverageCents > 0
      ? Math.round(
          ((trailingWeekAverageCents - dailyAverageCents) / dailyAverageCents) * 100
        )
      : 0;

  // Format the exhaustion date for display.
  const exhaustionDisplay = predictedExhaustionDate
    ? new Date(predictedExhaustionDate).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : null;

  return (
    <View className="bg-background-secondary rounded-xl p-4">
      {/* Header row */}
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-zinc-400 text-xs font-semibold tracking-wide">
          SPEND FORECAST
        </Text>

        {/* Burn acceleration badge */}
        {isBurnAccelerating && accelPct > 0 && (
          <View className="bg-amber-950/60 rounded-full px-2 py-0.5">
            <Text className="text-amber-400 text-xs font-medium">
              {/* WHY: no em-dash per project style rules */}
              burn up {accelPct}%
            </Text>
          </View>
        )}
      </View>

      {/* Primary message */}
      <View className="mb-4">
        {exhaustionDisplay && quotaCents !== null ? (
          // Cap exhaustion prediction
          <Text className={`text-sm font-medium ${textColorClass(band)}`}>
            At current burn you&apos;ll hit your cap on {exhaustionDisplay}.
          </Text>
        ) : (
          // No cap or exhaustion far out
          <Text className="text-sm text-white">
            On track to spend{' '}
            <Text className={`font-semibold ${textColorClass(band)}`}>
              {fmtCents(elapsedCents + weightedForecastCents['30d'])}
            </Text>{' '}
            by end of month.
          </Text>
        )}
      </View>

      {/* Horizon forecast row */}
      <View className="flex-row mb-4">
        {(['7d', '14d', '30d'] as const).map((horizon, i, arr) => (
          <View key={horizon} className={`flex-1 items-center${i < arr.length - 1 ? '' : ''}`}>
            {i > 0 && <View className="absolute left-0 top-0 bottom-0 w-px bg-zinc-800" />}
            <Text className="text-zinc-500 text-xs mb-0.5">Next {horizon}</Text>
            <Text className="text-white text-sm font-semibold">
              {fmtCents(weightedForecastCents[horizon])}
            </Text>
          </View>
        ))}
      </View>

      {/* Footer: daily averages */}
      <View className="flex-row justify-between">
        <Text className="text-zinc-500 text-xs">
          30d avg: {fmtCents(dailyAverageCents)}/day
        </Text>
        <Text className="text-zinc-500 text-xs">
          7d avg: {fmtCents(trailingWeekAverageCents)}/day
        </Text>
      </View>
    </View>
  );
}
