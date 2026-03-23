/**
 * Daily Mini Chart Component
 *
 * 7-day bar chart showing daily cost totals with stacked agent-type
 * breakdown. Each bar is segmented by agent (Claude, Codex, Gemini,
 * OpenCode) using distinct colors. Includes a legend below the chart.
 *
 * Uses react-native-svg for rendering stacked bar segments with
 * pixel-accurate heights.
 */

import { View, Text } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import type { DailyCostDataPoint } from '../hooks/useCosts';

// ============================================================================
// Constants
// ============================================================================

/**
 * Agent color mapping for chart segments.
 * WHY: These colors match the getAgentHexColor() function in useCosts.ts
 * to ensure visual consistency across all cost-related UI.
 */
const AGENT_COLORS: Record<string, string> = {
  claude: '#f97316',  // orange-500
  codex: '#22c55e',   // green-500
  gemini: '#3b82f6',  // blue-500
  opencode: '#a855f7', // purple-500
};

/**
 * Agent display names for the legend.
 */
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

/**
 * Ordered list of agent keys for consistent stacking order.
 * WHY: Consistent ordering ensures the visual layout is predictable
 * and users can learn to read the chart without checking the legend each time.
 */
const AGENT_ORDER = ['claude', 'codex', 'gemini', 'opencode'] as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the DailyMiniChart component.
 */
interface DailyMiniChartProps {
  /** Array of daily cost data points (should be 7 days) */
  data: DailyCostDataPoint[];
  /** Maximum height of the bars in pixels (default 80) */
  maxBarHeight?: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the day of week abbreviation from a date string.
 *
 * @param dateStr - Date string in YYYY-MM-DD format
 * @returns 3-letter day abbreviation (e.g., "Mon", "Tue")
 *
 * @example
 * getDayLabel('2025-01-15'); // "Wed"
 */
function getDayLabel(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00'); // Force local timezone
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
}

/**
 * Check if a date string represents today.
 *
 * @param dateStr - Date string in YYYY-MM-DD format
 * @returns True if the date is today
 *
 * @example
 * isToday('2025-01-15'); // true if today is Jan 15, 2025
 */
function isToday(dateStr: string): boolean {
  const today = new Date().toISOString().split('T')[0];
  return dateStr === today;
}

// ============================================================================
// Stacked Bar Component
// ============================================================================

/**
 * Props for the StackedBar component.
 */
interface StackedBarProps {
  /** Daily cost data point with per-agent breakdown */
  day: DailyCostDataPoint;
  /** Maximum cost value across all days (for scaling) */
  maxValue: number;
  /** Maximum bar height in pixels */
  maxBarHeight: number;
  /** Width of this bar in pixels */
  barWidth: number;
}

/**
 * Renders a single stacked bar using react-native-svg.
 *
 * Each agent's cost is represented as a colored segment of the bar,
 * stacked from bottom to top in the order defined by AGENT_ORDER.
 * The bar height is proportional to the total cost relative to maxValue.
 *
 * @param props - Component props
 * @returns SVG element containing stacked rectangles
 */
function StackedBar({ day, maxValue, maxBarHeight, barWidth }: StackedBarProps) {
  // Calculate the total bar height (minimum 4px for visibility)
  const totalHeight = Math.max(4, (day.total / maxValue) * maxBarHeight);

  // Build segments from bottom to top
  const segments: Array<{ key: string; height: number; color: string }> = [];
  for (const agent of AGENT_ORDER) {
    const cost = day[agent] || 0;
    if (cost > 0) {
      const segmentHeight = (cost / day.total) * totalHeight;
      segments.push({
        key: agent,
        height: segmentHeight,
        color: AGENT_COLORS[agent],
      });
    }
  }

  // If there are no agent-specific costs but total > 0, show a single gray bar
  if (segments.length === 0 && day.total > 0) {
    segments.push({ key: 'unknown', height: totalHeight, color: '#71717a' });
  }

  // Calculate y positions (stacking from the bottom)
  let yOffset = maxBarHeight - totalHeight;

  return (
    <Svg width={barWidth} height={maxBarHeight}>
      {segments.map((segment) => {
        const y = yOffset;
        yOffset += segment.height;
        return (
          <Rect
            key={segment.key}
            x={0}
            y={y}
            width={barWidth}
            height={Math.max(1, segment.height)}
            rx={segment.key === segments[0].key ? 2 : 0}
            fill={segment.color}
          />
        );
      })}
    </Svg>
  );
}

// ============================================================================
// Legend Component
// ============================================================================

/**
 * Renders the agent color legend below the chart.
 *
 * Only shows agents that have non-zero costs in the dataset to
 * avoid cluttering the legend with unused agents.
 *
 * @param props.data - The daily cost data points
 * @returns Row of colored dots with agent labels
 */
function ChartLegend({ data }: { data: DailyCostDataPoint[] }) {
  // Determine which agents have non-zero data
  const activeAgents = AGENT_ORDER.filter((agent) =>
    data.some((day) => (day[agent] || 0) > 0),
  );

  if (activeAgents.length === 0) return null;

  return (
    <View className="flex-row flex-wrap justify-center mt-3 gap-x-4 gap-y-1">
      {activeAgents.map((agent) => (
        <View key={agent} className="flex-row items-center">
          <View
            className="w-2.5 h-2.5 rounded-full mr-1"
            style={{ backgroundColor: AGENT_COLORS[agent] }}
          />
          <Text className="text-zinc-500 text-[10px]">
            {AGENT_LABELS[agent]}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * DailyMiniChart renders a compact stacked bar chart of daily costs
 * with agent-type breakdown.
 *
 * The chart automatically scales based on the maximum daily cost.
 * Today's day label is highlighted with the brand orange color.
 * Each bar shows stacked segments per agent (Claude, Codex, Gemini, OpenCode).
 *
 * @param props - Component props
 * @returns Rendered mini chart with legend
 *
 * @example
 * <DailyMiniChart
 *   data={[
 *     { date: '2024-01-01', total: 5.00, claude: 3.0, codex: 1.5, gemini: 0.5, opencode: 0 },
 *     { date: '2024-01-02', total: 8.50, claude: 6.0, codex: 2.0, gemini: 0.5, opencode: 0 },
 *   ]}
 * />
 */
export function DailyMiniChart({ data, maxBarHeight = 80 }: DailyMiniChartProps) {
  // Find the maximum value for scaling
  const maxValue = Math.max(...data.map((d) => d.total), 0.01); // Min 0.01 to avoid division by zero

  // Calculate total for the week
  const weekTotal = data.reduce((sum, d) => sum + d.total, 0);

  return (
    <View className="bg-background-secondary rounded-xl p-4">
      {/* Header */}
      <View className="flex-row items-center justify-between mb-4">
        <Text className="text-zinc-400 text-sm font-medium">LAST 7 DAYS</Text>
        <Text className="text-white font-semibold">${weekTotal.toFixed(2)}</Text>
      </View>

      {/* Chart */}
      <View className="flex-row items-end justify-between" style={{ height: maxBarHeight + 24 }}>
        {data.map((day) => {
          const today = isToday(day.date);
          // WHY: barWidth is calculated as a portion of the available space.
          // Each bar gets roughly 1/7th of the container minus margins.
          const barWidth = 28;

          return (
            <View key={day.date} className="flex-1 items-center mx-0.5">
              {/* Cost label (only show for non-zero values) */}
              {day.total > 0 && (
                <Text
                  className="text-zinc-500 text-[10px] mb-1"
                  numberOfLines={1}
                >
                  ${day.total < 1 ? day.total.toFixed(2) : day.total.toFixed(0)}
                </Text>
              )}

              {/* Stacked Bar */}
              {day.total > 0 ? (
                <StackedBar
                  day={day}
                  maxValue={maxValue}
                  maxBarHeight={maxBarHeight}
                  barWidth={barWidth}
                />
              ) : (
                <View
                  className="bg-zinc-800 rounded-t-sm"
                  style={{ width: barWidth, height: 4 }}
                />
              )}

              {/* Day label */}
              <Text
                className={`text-[10px] mt-1 ${today ? 'text-brand font-medium' : 'text-zinc-500'}`}
              >
                {getDayLabel(day.date)}
              </Text>
            </View>
          );
        })}
      </View>

      {/* Agent Legend */}
      <ChartLegend data={data} />
    </View>
  );
}

/**
 * Empty state for the mini chart when there's no data.
 */
export function DailyMiniChartEmpty() {
  return (
    <View className="bg-background-secondary rounded-xl p-4 items-center py-8">
      <Text className="text-zinc-400 text-sm font-medium mb-2">LAST 7 DAYS</Text>
      <Text className="text-zinc-500 text-center">No cost data for this period</Text>
    </View>
  );
}

/**
 * Fixed bar heights for the skeleton loader.
 * WHY: Using Math.random() causes layout shifts on every re-render and
 * makes snapshot tests non-deterministic. A fixed sequence looks natural
 * while remaining stable across renders.
 */
const SKELETON_HEIGHTS = [40, 65, 35, 75, 50, 60, 45];

/**
 * Loading skeleton for the mini chart.
 */
export function DailyMiniChartSkeleton() {
  return (
    <View className="bg-background-secondary rounded-xl p-4">
      <View className="flex-row items-center justify-between mb-4">
        <View className="bg-zinc-800 h-4 w-20 rounded" />
        <View className="bg-zinc-800 h-5 w-16 rounded" />
      </View>
      <View className="flex-row items-end justify-between" style={{ height: 104 }}>
        {[...Array(7)].map((_, i) => (
          <View key={`skeleton-${i}`} className="flex-1 items-center mx-0.5">
            <View
              className="w-full bg-zinc-800 rounded-t-sm"
              style={{ height: SKELETON_HEIGHTS[i % SKELETON_HEIGHTS.length] }}
            />
            <View className="bg-zinc-800 h-3 w-6 rounded mt-1" />
          </View>
        ))}
      </View>
    </View>
  );
}
