/**
 * Daily Cost Chart Component
 *
 * Displays a bar chart showing daily spending over time.
 * Uses pure CSS for bars - no external charting library required.
 * Includes hover tooltips showing exact date and cost.
 *
 * @module components/costs/DailyCostChart
 */

'use client';

import { formatCost, type DailyCostDataPoint } from '@/lib/costs';

/**
 * Props for DailyCostChart component.
 */
interface DailyCostChartProps {
  /** Array of daily cost data points (should be sorted by date ascending) */
  data: DailyCostDataPoint[];
  /** Title for the chart (default: "Daily Spending") */
  title?: string;
  /** Height of the chart in pixels (default: 200) */
  height?: number;
}

/**
 * Format a date string for tooltip display.
 *
 * @param dateStr - ISO date string (YYYY-MM-DD)
 * @returns Formatted date like "Jan 15, 2025"
 */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Displays a CSS-based bar chart of daily costs.
 *
 * This is a lightweight alternative to Recharts for simple visualizations.
 * Features:
 * - Responsive bar widths that fill available space
 * - Hover tooltips showing date and exact cost
 * - Gradient-colored bars with hover effects
 * - X-axis labels showing date range
 *
 * @param props - Component props
 * @returns Daily cost chart element
 *
 * @example
 * // Basic usage
 * <DailyCostChart data={dailyCosts} />
 *
 * @example
 * // With custom title and height
 * <DailyCostChart
 *   data={dailyCosts}
 *   title="Last 30 Days"
 *   height={300}
 * />
 */
export function DailyCostChart({
  data,
  title = 'Daily Spending',
  height = 200,
}: DailyCostChartProps) {
  // Calculate max cost for bar height scaling (minimum 0.01 to avoid division by zero)
  const maxCost = Math.max(...data.map((d) => d.total), 0.01);

  // Empty state
  if (data.length === 0) {
    return (
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
        <h3 className="text-lg font-semibold text-zinc-100 mb-4">{title}</h3>
        <div className="py-8 text-center text-zinc-500">No daily data available</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
      <h3 className="text-lg font-semibold text-zinc-100 mb-4">{title}</h3>

      {/* Bar chart container */}
      <div
        className="flex items-end gap-1"
        style={{ height: `${height}px` }}
        role="img"
        aria-label={`Bar chart showing daily spending over ${data.length} days`}
      >
        {data.map((day) => {
          // Calculate bar height as percentage of container
          const barHeight = (day.total / maxCost) * 100;

          return (
            <div
              key={day.date}
              className="flex-1 min-w-[4px] group relative"
              style={{ height: '100%' }}
            >
              {/* Tooltip (shows on hover) */}
              <div
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10"
                role="tooltip"
              >
                <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-xs whitespace-nowrap shadow-lg">
                  <p className="text-zinc-100 font-medium">{formatDate(day.date)}</p>
                  <p className="text-orange-400">{formatCost(day.total, 4)}</p>
                </div>
              </div>

              {/* Bar */}
              <div className="absolute bottom-0 left-0 right-0 flex flex-col justify-end h-full">
                <div
                  className="w-full bg-gradient-to-t from-orange-600 to-orange-500 rounded-t-sm transition-all duration-200 group-hover:from-orange-500 group-hover:to-orange-400"
                  style={{ height: `${Math.max(barHeight, 1)}%` }}
                  aria-label={`${formatDate(day.date)}: ${formatCost(day.total, 4)}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* X-axis labels showing date range */}
      <div className="flex justify-between mt-2 text-xs text-zinc-600">
        {data.length > 0 && (
          <>
            <span>{formatDate(data[0].date)}</span>
            {data.length > 1 && <span>{formatDate(data[data.length - 1].date)}</span>}
          </>
        )}
      </div>
    </div>
  );
}
