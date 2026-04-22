/**
 * AgentWeeklySparkline — per-agent 7-day cost sparkline row.
 *
 * Renders a compact row for one agent showing:
 *   - Agent name + color dot
 *   - A 7-day mini bar chart (one bar per day)
 *   - MTD total cost
 *
 * Used in the "BY AGENT (7 DAYS)" section of the mobile Costs screen.
 *
 * WHY mini bars instead of a SVG sparkline: React Native has no `<svg>` and
 * importing a charting library purely for inline 7-bar charts would add ~80kB
 * to the bundle. Seven `<View>` bars with proportional heights is zero-cost
 * and renders identically across iOS and Android.
 *
 * @module components/costs/AgentWeeklySparkline
 */

import { View, Text } from 'react-native';
import type { AgentType } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Daily cost datum for a single agent over 7 days.
 */
export interface AgentDayCost {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  /** Cost in USD for this agent on this day */
  cost: number;
}

/**
 * Props for {@link AgentWeeklySparkline}.
 */
export interface AgentWeeklySparklineProps {
  /** Agent type identifier. */
  agent: AgentType;
  /** Agent display label (e.g. "Claude Code"). */
  label: string;
  /** Hex color for the agent brand dot and bar. */
  color: string;
  /** 7 daily cost data points, sorted ascending by date. */
  days: AgentDayCost[];
  /** Month-to-date total cost for this agent in USD. */
  mtdCostUsd: number;
}

// ============================================================================
// Component
// ============================================================================

/** Bar chart height in dp. */
const BAR_AREA_HEIGHT = 32;

/**
 * AgentWeeklySparkline renders a compact sparkline row for one agent.
 *
 * @param props - See {@link AgentWeeklySparklineProps}
 * @returns React Native view
 *
 * @example
 * <AgentWeeklySparkline
 *   agent="claude"
 *   label="Claude Code"
 *   color="#f97316"
 *   days={sevenDays}
 *   mtdCostUsd={12.40}
 * />
 */
export function AgentWeeklySparkline({
  label,
  color,
  days,
  mtdCostUsd,
}: AgentWeeklySparklineProps) {
  // Derive the max daily cost to normalise bar heights.
  const maxDay = Math.max(...days.map((d) => d.cost), 0.0001);

  return (
    <View className="flex-row items-center py-2.5 border-b border-zinc-800 last:border-0">
      {/* Color dot + label */}
      <View className="flex-row items-center flex-1 mr-3">
        <View
          className="w-2.5 h-2.5 rounded-full mr-2 shrink-0"
          style={{ backgroundColor: color }}
        />
        <Text
          className="text-white text-sm font-medium"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {label}
        </Text>
      </View>

      {/* 7-bar mini chart */}
      <View
        className="flex-row items-end gap-px mr-3"
        style={{ height: BAR_AREA_HEIGHT }}
        accessibilityLabel={`7-day cost chart for ${label}`}
      >
        {days.map((day) => {
          const heightFraction = maxDay > 0 ? day.cost / maxDay : 0;
          const barHeight = Math.max(Math.round(heightFraction * BAR_AREA_HEIGHT), 2);

          return (
            <View
              key={day.date}
              style={{
                width: 6,
                height: barHeight,
                backgroundColor: color,
                opacity: day.cost === 0 ? 0.15 : 0.85,
                borderRadius: 1,
              }}
            />
          );
        })}
      </View>

      {/* MTD total */}
      <Text className="text-white text-sm font-semibold w-16 text-right">
        ${mtdCostUsd.toFixed(2)}
      </Text>
    </View>
  );
}

/**
 * Empty state for the agent sparkline section.
 * Shown when the user has no cost data for the last 7 days.
 */
export function AgentSparklineEmpty() {
  return (
    <View className="py-6 items-center">
      <Text className="text-zinc-500 text-sm">No agent activity in the last 7 days</Text>
    </View>
  );
}
