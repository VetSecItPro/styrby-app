/**
 * TeamCostProjectionCard
 *
 * Compact mobile card showing team MTD spend vs projected vs seat-budget.
 * Renders within the TEAM COSTS collapsible section on the Costs screen.
 *
 * WHY a new component (not extending TeamCostSection):
 *   TeamCostSection shows per-member breakdown (member list + bars). The
 *   projection card shows aggregate budget progress — a different concern
 *   that logically appears *above* the per-member list, not inside it.
 *   Separating them keeps each component focused and independently testable.
 *
 * WHY compact design:
 *   On mobile, screen real estate is scarce. The projection card surfaces
 *   the "am I over budget?" answer in a single glance before the user
 *   expands the full member list. Three numbers + one progress bar is the
 *   minimum viable answer.
 *
 * @module components/costs/TeamCostProjectionCard
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Projection data for the team budget card.
 * This mirrors the projection shape from GET /api/teams/[id]/costs
 * and is populated by the useTeamCosts hook (Phase 2.5 extension).
 */
export interface TeamProjectionCardData {
  /** Monthly budget in USD (active_seats x per-seat price) */
  seatBudgetUsd: number;
  /** Actual MTD spend across all team members */
  mtdSpendUsd: number;
  /** Linear projection: (mtd / daysElapsed) * daysInMonth */
  projectedMtdUsd: number;
  /** Calendar days elapsed so far this month */
  daysElapsed: number;
  /** Total calendar days in the current month */
  daysInMonth: number;
  /** Number of active billed seats */
  activeSeats: number;
}

/** Props for {@link TeamCostProjectionCard}. */
export interface TeamCostProjectionCardProps {
  /** Projection data. If null, renders nothing (caller guards). */
  projection: TeamProjectionCardData;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a compact MTD spend vs seat-budget projection card for mobile.
 *
 * Color coding matches the web TeamBudgetProjection component:
 *   - Under 80% projected: neutral (no warning)
 *   - 80-100% projected: amber warning
 *   - Over 100% projected: red alert
 *
 * @param props - TeamCostProjectionCardProps
 */
export function TeamCostProjectionCard({ projection }: TeamCostProjectionCardProps) {
  const {
    seatBudgetUsd,
    mtdSpendUsd,
    projectedMtdUsd,
    daysElapsed,
    daysInMonth,
    activeSeats,
  } = projection;

  // WHY guard: if no budget configured (seats = 0 or billing not yet synced)
  // the card would show $0/$0 which is confusing. Return nothing instead.
  if (seatBudgetUsd <= 0) return null;

  const actualPct = Math.min((mtdSpendUsd / seatBudgetUsd) * 100, 100);
  const projectedPct = (projectedMtdUsd / seatBudgetUsd) * 100;

  const isOver = projectedPct >= 100;
  const isWarn = projectedPct >= 80 && !isOver;

  // WHY inline style for bar width: NativeWind's w-[xx%] syntax requires a
  // fixed-width class (e.g., w-[80%]) but we need a dynamic value here.
  // The inline style approach is the correct RN pattern for dynamic widths.
  const barColor = isOver
    ? '#ef4444' // red
    : isWarn
    ? '#f59e0b' // amber
    : '#f97316'; // orange (brand)

  return (
    <View className="bg-background-secondary rounded-xl px-4 py-3 mb-3">
      {/* Header */}
      <View className="flex-row items-center justify-between mb-3">
        <View className="flex-row items-center gap-2">
          <Ionicons name="wallet-outline" size={14} color="#a1a1aa" />
          <Text className="text-zinc-400 text-xs font-medium">MONTHLY BUDGET</Text>
        </View>
        <View className="flex-row items-center gap-1">
          {isOver ? (
            <Ionicons name="trending-up" size={12} color="#ef4444" />
          ) : (
            <Ionicons name="trending-down" size={12} color="#22c55e" />
          )}
          <Text
            className="text-xs font-medium"
            style={{ color: isOver ? '#ef4444' : isWarn ? '#f59e0b' : '#22c55e' }}
          >
            {isOver ? 'Over budget' : isWarn ? 'Approaching limit' : 'On track'}
          </Text>
        </View>
      </View>

      {/* Three-number summary */}
      <View className="flex-row mb-3">
        <View className="flex-1">
          <Text className="text-zinc-500 text-xs mb-0.5">MTD Spend</Text>
          <Text className="text-white font-bold text-sm">${mtdSpendUsd.toFixed(2)}</Text>
        </View>
        <View className="flex-1 items-center">
          <Text className="text-zinc-500 text-xs mb-0.5">Projected</Text>
          <Text
            className="font-bold text-sm"
            style={{ color: isOver ? '#ef4444' : isWarn ? '#f59e0b' : 'white' }}
          >
            ${projectedMtdUsd.toFixed(2)}
          </Text>
        </View>
        <View className="flex-1 items-end">
          <Text className="text-zinc-500 text-xs mb-0.5">{activeSeats} seats</Text>
          <Text className="text-white font-bold text-sm">${seatBudgetUsd.toFixed(2)}</Text>
        </View>
      </View>

      {/* Progress bar */}
      <View className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden mb-1.5">
        <View
          className="h-full rounded-full"
          style={{
            width: `${actualPct.toFixed(1)}%`,
            backgroundColor: barColor,
          }}
          accessibilityRole="progressbar"
          accessibilityValue={{
            min: 0,
            max: 100,
            now: Math.round(actualPct),
          }}
        />
      </View>

      {/* Footer: days and percentage */}
      <View className="flex-row justify-between">
        <Text className="text-zinc-600 text-xs">
          Day {daysElapsed} of {daysInMonth}
        </Text>
        <Text className="text-zinc-600 text-xs">
          {actualPct.toFixed(1)}% used
        </Text>
      </View>
    </View>
  );
}
