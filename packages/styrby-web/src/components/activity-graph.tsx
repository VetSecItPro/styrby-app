'use client';

/**
 * ActivityGraph Component
 *
 * GitHub-style 52-week contribution heatmap for coding session activity.
 * Renders one cell per calendar day, colored by activity intensity (0–4).
 * Supports toggling between "Sessions" and "Cost" views.
 *
 * Data is fetched from Supabase (sessions table) and grouped by date
 * client-side. The component is fully self-contained - it fetches its own
 * data on mount so it can be dropped anywhere without passing props.
 *
 * @module components/activity-graph
 */

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { ActivityDay, AgentType } from '@styrby/shared';

// ============================================================================
// Constants
// ============================================================================

/** Total weeks rendered (matches GitHub's graph). */
const WEEKS = 52;

/** Days per week. */
const DAYS_PER_WEEK = 7;

/** Total cells in the grid. */
const TOTAL_DAYS = WEEKS * DAYS_PER_WEEK;

/** Month abbreviations for the x-axis labels. */
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Day-of-week labels (Sun first to match GitHub). */
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ============================================================================
// Tailwind intensity classes (dark-mode aware)
// ============================================================================

/**
 * Returns the Tailwind CSS class for a heatmap cell based on intensity and view mode.
 *
 * WHY: Sessions view uses green tones (matching the developer "contribution" metaphor),
 * while cost view uses amber tones (signalling spend). Both use the same 5-level scale.
 *
 * @param intensity - Activity intensity (0–4)
 * @param mode - Which metric is being displayed
 * @returns Tailwind CSS class string
 */
function getCellClass(intensity: 0 | 1 | 2 | 3 | 4, mode: 'sessions' | 'cost'): string {
  if (mode === 'sessions') {
    switch (intensity) {
      case 0: return 'bg-zinc-800 dark:bg-zinc-800';
      case 1: return 'bg-emerald-900 dark:bg-emerald-900';
      case 2: return 'bg-emerald-700 dark:bg-emerald-700';
      case 3: return 'bg-emerald-500 dark:bg-emerald-500';
      case 4: return 'bg-emerald-400 dark:bg-emerald-400';
    }
  } else {
    switch (intensity) {
      case 0: return 'bg-zinc-800 dark:bg-zinc-800';
      case 1: return 'bg-amber-900 dark:bg-amber-900';
      case 2: return 'bg-amber-700 dark:bg-amber-700';
      case 3: return 'bg-amber-500 dark:bg-amber-500';
      case 4: return 'bg-amber-400 dark:bg-amber-400';
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a date as YYYY-MM-DD string.
 *
 * @param date - Date to format
 * @returns ISO date string without time component
 */
function toDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Compute intensity bucket (0–4) from a raw value relative to a maximum.
 *
 * WHY: Relative bucketing means heavy users see variation across their cells.
 * If we used absolute thresholds (e.g., >5 sessions = 4), light users would
 * always see only intensity 1, making the graph useless.
 *
 * @param value - The raw value for this day
 * @param max - The maximum value across all days in the range
 * @returns Intensity bucket 0–4
 */
function computeIntensity(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value === 0 || max === 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.15) return 1;
  if (ratio <= 0.40) return 2;
  if (ratio <= 0.70) return 3;
  return 4;
}

/**
 * Build the full 52-week grid of ActivityDay objects.
 *
 * WHY: We pre-populate all cells with zero-activity days so the grid always
 * has TOTAL_DAYS cells, regardless of how many days have actual data.
 * Without this, days with no sessions would be missing from the grid.
 *
 * @param rawData - Map of YYYY-MM-DD → ActivityDay from Supabase
 * @param mode - Which metric to use for intensity computation
 * @returns Array of TOTAL_DAYS ActivityDay objects, oldest-first
 */
function buildGrid(rawData: Map<string, ActivityDay>, mode: 'sessions' | 'cost'): ActivityDay[] {
  const today = new Date();
  const grid: ActivityDay[] = [];

  // Find the max value for relative intensity
  let maxValue = 0;
  for (const day of rawData.values()) {
    const v = mode === 'sessions' ? day.sessionCount : day.totalCostUsd;
    if (v > maxValue) maxValue = v;
  }

  // Build grid from (TOTAL_DAYS - 1) days ago up to today
  for (let i = TOTAL_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = toDateString(d);
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
 * Arrange a flat grid of days into columns of 7 (one column per week).
 *
 * @param grid - Flat array of TOTAL_DAYS ActivityDay objects, oldest-first
 * @returns Array of 52 columns, each containing 7 ActivityDay objects
 */
function gridToColumns(grid: ActivityDay[]): ActivityDay[][] {
  const columns: ActivityDay[][] = [];
  for (let col = 0; col < WEEKS; col++) {
    columns.push(grid.slice(col * DAYS_PER_WEEK, (col + 1) * DAYS_PER_WEEK));
  }
  return columns;
}

/**
 * Compute month label positions for the x-axis.
 *
 * Returns the column index where each month label should appear.
 * A month label is placed at the first column that falls within that month.
 *
 * @param grid - Flat grid of ActivityDay objects
 * @returns Array of { month: string; colIndex: number } entries
 */
function computeMonthLabels(grid: ActivityDay[]): Array<{ label: string; colIndex: number }> {
  const labels: Array<{ label: string; colIndex: number }> = [];
  let lastMonth = -1;

  for (let col = 0; col < WEEKS; col++) {
    const dayIndex = col * DAYS_PER_WEEK;
    const day = grid[dayIndex];
    if (!day) continue;
    const month = new Date(day.date + 'T12:00:00').getMonth();
    if (month !== lastMonth) {
      labels.push({ label: MONTH_LABELS[month], colIndex: col });
      lastMonth = month;
    }
  }

  return labels;
}

// ============================================================================
// Tooltip Component
// ============================================================================

/**
 * Props for the ActivityTooltip component.
 */
interface TooltipProps {
  day: ActivityDay;
  mode: 'sessions' | 'cost';
}

/**
 * Tooltip shown on hover over a heatmap cell.
 *
 * @param props - Day data and display mode
 */
function ActivityTooltip({ day, mode: _mode }: TooltipProps) {
  const date = new Date(day.date + 'T12:00:00');
  const formatted = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="pointer-events-none absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 rounded-lg bg-zinc-900 border border-zinc-700 p-2.5 shadow-xl text-xs">
      <p className="text-zinc-300 font-medium mb-1">{formatted}</p>
      <div className="space-y-0.5">
        <p className="text-zinc-400">
          Sessions: <span className="text-zinc-200 font-medium">{day.sessionCount}</span>
        </p>
        <p className="text-zinc-400">
          Cost: <span className="text-zinc-200 font-medium">${day.totalCostUsd.toFixed(2)}</span>
        </p>
        {day.totalTokens > 0 && (
          <p className="text-zinc-400">
            Tokens: <span className="text-zinc-200 font-medium">
              {day.totalTokens >= 1_000_000
                ? `${(day.totalTokens / 1_000_000).toFixed(1)}M`
                : day.totalTokens >= 1_000
                  ? `${(day.totalTokens / 1_000).toFixed(1)}K`
                  : day.totalTokens}
            </span>
          </p>
        )}
        {day.agents.length > 0 && (
          <p className="text-zinc-400">
            Agents: <span className="text-zinc-200 font-medium">{day.agents.join(', ')}</span>
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Props for the ActivityGraph component.
 */
export interface ActivityGraphProps {
  /** Optional CSS class name to apply to the wrapper div */
  className?: string;
}

/**
 * GitHub-style 52-week activity heatmap for coding sessions.
 *
 * Fetches session data from Supabase, groups by date, and renders a
 * grid of colored cells. Supports toggling between "Sessions" and "Cost"
 * views. Hover over any cell to see a detailed tooltip.
 *
 * @param props - Component props
 * @returns The activity graph component
 *
 * @example
 * // In a dashboard page
 * <ActivityGraph className="mt-8" />
 */
export function ActivityGraph({ className }: ActivityGraphProps) {
  const [mode, setMode] = useState<'sessions' | 'cost'>('sessions');
  const [rawData, setRawData] = useState<Map<string, ActivityDay>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [hoveredDay, setHoveredDay] = useState<{ day: ActivityDay; cellKey: string } | null>(null);
  const supabase = createClient();

  // ── Data Fetching ──────────────────────────────────────────────────────────

  /**
   * Fetch the last 52 weeks of sessions from Supabase and aggregate by date.
   *
   * WHY: We query the `sessions` table (not `cost_records`) because sessions
   * have a `started_at` date which is the natural "contribution" date. Using
   * `cost_records.record_date` would split multi-day sessions across multiple
   * days, distorting the heatmap.
   *
   * Token count is derived from message-level data stored on the session row
   * as `context_window_used`, which is a close-enough proxy without joining
   * to session_messages (which would be 100x more expensive per query).
   */
  const fetchActivityData = useCallback(async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - TOTAL_DAYS);
    const cutoffStr = toDateString(cutoff);

    const { data, error } = await supabase
      .from('sessions')
      .select('started_at, total_cost_usd, agent_type, context_window_used')
      .gte('started_at', cutoffStr + 'T00:00:00Z')
      .order('started_at', { ascending: true });

    if (error) {
      console.error('[ActivityGraph] Error fetching session data:', error.message);
      return;
    }

    // Aggregate sessions by date
    const map = new Map<string, ActivityDay>();

    for (const row of data ?? []) {
      const dateStr = (row.started_at as string).split('T')[0];
      const cost = Number(row.total_cost_usd) || 0;
      const tokens = Number(row.context_window_used) || 0;
      const agent = row.agent_type as AgentType;

      const existing = map.get(dateStr) ?? {
        date: dateStr,
        sessionCount: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        agents: [] as AgentType[],
        intensity: 0 as const,
      };

      const agents = existing.agents.includes(agent)
        ? existing.agents
        : [...existing.agents, agent];

      map.set(dateStr, {
        date: dateStr,
        sessionCount: existing.sessionCount + 1,
        totalCostUsd: existing.totalCostUsd + cost,
        totalTokens: existing.totalTokens + tokens,
        agents: agents,
        intensity: 0, // recomputed in buildGrid
      });
    }

    setRawData(map);
  }, [supabase]);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await fetchActivityData();
      setIsLoading(false);
    };
    load();
  }, [fetchActivityData]);

  // ── Grid Computation ────────────────────────────────────────────────────────

  const grid = buildGrid(rawData, mode);
  const columns = gridToColumns(grid);
  const monthLabels = computeMonthLabels(grid);

  // ── Summary Stats ──────────────────────────────────────────────────────────

  const totalSessions = Array.from(rawData.values()).reduce((sum, d) => sum + d.sessionCount, 0);
  const totalCost = Array.from(rawData.values()).reduce((sum, d) => sum + d.totalCostUsd, 0);
  const activeDays = Array.from(rawData.values()).filter((d) => d.sessionCount > 0).length;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className={`rounded-xl bg-card/60 border border-border/40 p-5 ${className ?? ''}`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-foreground">Activity</h2>
        </div>
        {/* Skeleton grid */}
        <div className="flex gap-[3px] animate-pulse">
          {Array.from({ length: WEEKS }).map((_, i) => (
            <div key={i} className="flex flex-col gap-[3px]">
              {Array.from({ length: DAYS_PER_WEEK }).map((_, j) => (
                <div key={j} className="h-3 w-3 rounded-sm bg-zinc-800" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-xl bg-card/60 border border-border/40 p-5 ${className ?? ''}`}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-semibold text-foreground">Activity</h2>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{totalSessions.toLocaleString()} sessions</span>
            <span className="text-border">·</span>
            <span>${totalCost.toFixed(2)} cost</span>
            <span className="text-border">·</span>
            <span>{activeDays} active days</span>
          </div>
        </div>

        {/* Toggle: Sessions / Cost */}
        <div className="flex rounded-md overflow-hidden border border-border/60 text-xs">
          <button
            type="button"
            onClick={() => setMode('sessions')}
            className={`px-2.5 py-1 transition-colors ${
              mode === 'sessions'
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Sessions
          </button>
          <button
            type="button"
            onClick={() => setMode('cost')}
            className={`px-2.5 py-1 transition-colors border-l border-border/60 ${
              mode === 'cost'
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Cost
          </button>
        </div>
      </div>

      {/* Month labels x-axis */}
      <div className="relative mb-1 overflow-hidden">
        <div className="flex" style={{ gap: '3px' }}>
          {/* Day-of-week label column spacer */}
          <div className="w-7 flex-shrink-0" />
          {/* Month labels positioned over the grid columns */}
          <div className="relative flex-1 h-4">
            {monthLabels.map(({ label, colIndex }) => (
              <span
                key={`${label}-${colIndex}`}
                className="absolute text-[10px] text-muted-foreground/70"
                style={{ left: `${(colIndex / WEEKS) * 100}%` }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Main grid */}
      <div className="flex" style={{ gap: '3px' }}>
        {/* Day-of-week labels */}
        <div className="flex flex-col w-7 flex-shrink-0" style={{ gap: '3px' }}>
          {DOW_LABELS.map((label, i) => (
            <div
              key={label}
              className="h-3 text-[9px] text-muted-foreground/50 flex items-center"
              style={{ opacity: i % 2 === 1 ? 1 : 0 }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Columns (weeks) */}
        {columns.map((week, colIndex) => (
          <div key={colIndex} className="flex flex-col" style={{ gap: '3px' }}>
            {week.map((day, rowIndex) => {
              const cellKey = `${colIndex}-${rowIndex}`;
              const isHovered = hoveredDay?.cellKey === cellKey;
              const isFuture = day.date > toDateString(new Date());

              return (
                <div
                  key={day.date}
                  className={`relative h-3 w-3 rounded-sm cursor-pointer transition-opacity ${
                    isFuture ? 'opacity-0 pointer-events-none' : 'hover:ring-1 hover:ring-zinc-400'
                  } ${getCellClass(day.intensity, mode)}`}
                  onMouseEnter={() => setHoveredDay({ day, cellKey })}
                  onMouseLeave={() => setHoveredDay(null)}
                >
                  {/* Tooltip */}
                  {isHovered && !isFuture && (
                    <ActivityTooltip day={day} mode={mode} />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-end gap-1.5 mt-2">
        <span className="text-[10px] text-muted-foreground/60">Less</span>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <div
            key={level}
            className={`h-3 w-3 rounded-sm ${getCellClass(level, mode)}`}
          />
        ))}
        <span className="text-[10px] text-muted-foreground/60">More</span>
      </div>
    </div>
  );
}
