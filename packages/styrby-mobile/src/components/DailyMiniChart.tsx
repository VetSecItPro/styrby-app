/**
 * Daily Mini Chart Component
 *
 * Simple 7-day bar chart showing daily cost totals.
 * Designed to be compact and fit in the cost dashboard.
 */

import { View, Text } from 'react-native';
import type { DailyCostDataPoint } from '../hooks/useCosts';

/**
 * Props for the DailyMiniChart component.
 */
interface DailyMiniChartProps {
  /** Array of daily cost data points (should be 7 days) */
  data: DailyCostDataPoint[];
  /** Maximum height of the bars in pixels (default 80) */
  maxBarHeight?: number;
}

/**
 * Get the day of week abbreviation from a date string.
 *
 * @param dateStr - Date string in YYYY-MM-DD format
 * @returns 3-letter day abbreviation (e.g., "Mon", "Tue")
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
 */
function isToday(dateStr: string): boolean {
  const today = new Date().toISOString().split('T')[0];
  return dateStr === today;
}

/**
 * DailyMiniChart renders a compact bar chart of daily costs.
 *
 * The chart automatically scales based on the maximum daily cost.
 * Today's bar is highlighted with the brand orange color.
 *
 * @param props - Component props
 * @returns Rendered mini chart
 *
 * @example
 * <DailyMiniChart
 *   data={[
 *     { date: '2024-01-01', total: 5.00, ... },
 *     { date: '2024-01-02', total: 8.50, ... },
 *     ...
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
          // Calculate bar height (minimum 4px for visibility)
          const barHeight = Math.max(4, (day.total / maxValue) * maxBarHeight);
          const today = isToday(day.date);

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

              {/* Bar */}
              <View
                className={`w-full rounded-t-sm ${today ? 'bg-brand' : 'bg-zinc-700'}`}
                style={{ height: barHeight }}
              />

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
          <View key={i} className="flex-1 items-center mx-0.5">
            <View
              className="w-full bg-zinc-800 rounded-t-sm"
              style={{ height: Math.random() * 60 + 20 }}
            />
            <View className="bg-zinc-800 h-3 w-6 rounded mt-1" />
          </View>
        ))}
      </View>
    </View>
  );
}
