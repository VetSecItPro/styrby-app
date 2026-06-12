/**
 * Pure grid math for the activity heatmap.
 *
 * Extracted from ActivityGraph.tsx (Cluster A2 split). These were untestable
 * while embedded in the component; as standalone pure functions they can be
 * verified directly and reused by the web heatmap for visual parity.
 *
 * @module components/activity-graph/activity-grid
 */

import type { ActivityDay } from 'styrby-shared';
import { MAX_WEEKS, DAYS_PER_WEEK, type ActivityMode } from './constants';

/**
 * Format a date as YYYY-MM-DD.
 *
 * @param date - Date to format.
 * @returns ISO date string (date portion only).
 */
export function toDateStr(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Compute intensity bucket (0-4) from a raw value relative to a maximum.
 *
 * WHY relative (not fixed thresholds): relative bucketing ensures light users
 * see variation just like heavy users. Fixed thresholds would always render
 * intensity 1 for low-volume users, defeating the purpose of a heatmap.
 *
 * @param value - Raw value for this day.
 * @param max - Maximum value across all days.
 * @returns Intensity 0-4.
 */
export function computeIntensity(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value === 0 || max === 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.15) return 1;
  if (ratio <= 0.40) return 2;
  if (ratio <= 0.70) return 3;
  return 4;
}

/**
 * Build the full grid (MAX_WEEKS x DAYS_PER_WEEK), oldest day first.
 *
 * WHY pre-populate with zeros: guarantees the grid always has the right number
 * of cells regardless of data sparsity, so the calendar layout stays stable.
 *
 * @param rawData - Map of YYYY-MM-DD to ActivityDay from Supabase.
 * @param mode - Which metric to use for intensity computation.
 * @returns Flat array of ActivityDay objects, oldest-first.
 */
export function buildGrid(rawData: Map<string, ActivityDay>, mode: ActivityMode): ActivityDay[] {
  const today = new Date();
  const totalDays = MAX_WEEKS * DAYS_PER_WEEK;
  const grid: ActivityDay[] = [];

  let maxValue = 0;
  for (const day of rawData.values()) {
    const v = mode === 'sessions' ? day.sessionCount : day.totalCostUsd;
    if (v > maxValue) maxValue = v;
  }

  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = toDateStr(d);
    const existing = rawData.get(dateStr);

    if (existing) {
      const value = mode === 'sessions' ? existing.sessionCount : existing.totalCostUsd;
      grid.push({ ...existing, intensity: computeIntensity(value, maxValue) });
    } else {
      grid.push({
        date: dateStr,
        sessionCount: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        agents: [],
        intensity: 0,
      });
    }
  }

  return grid;
}

/**
 * Arrange a flat grid into week columns.
 *
 * @param grid - Flat ActivityDay array, oldest-first.
 * @returns Array of week columns, each with 7 days.
 */
export function gridToColumns(grid: ActivityDay[]): ActivityDay[][] {
  const totalWeeks = Math.floor(grid.length / DAYS_PER_WEEK);
  const columns: ActivityDay[][] = [];
  for (let col = 0; col < totalWeeks; col++) {
    columns.push(grid.slice(col * DAYS_PER_WEEK, (col + 1) * DAYS_PER_WEEK));
  }
  return columns;
}

/**
 * Format a token count with a K/M suffix.
 *
 * @param tokens - Raw token count.
 * @returns Formatted string (e.g. "1.2K", "3.4M").
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}
