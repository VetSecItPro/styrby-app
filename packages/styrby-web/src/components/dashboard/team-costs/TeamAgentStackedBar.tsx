'use client';

/**
 * TeamAgentStackedBar
 *
 * Renders a per-day stacked bar chart grouped by agent_type for a team.
 * Built on Recharts (same pattern as CostCharts in costs/cost-charts.tsx).
 *
 * WHY this component exists separately from CostCharts:
 *   CostCharts renders the *individual user's* daily spend, stacked by claude/
 *   codex/gemini. TeamAgentStackedBar renders the *team's* combined spend
 *   stacked by all 11 supported agents. The data shape is different (API response
 *   from /api/teams/[id]/costs vs mv_daily_cost_summary), and the agents rendered
 *   differ (11 vs 3 explicit + others). Reusing CostCharts would require
 *   significant prop-drilling to accommodate both shapes — a new component is
 *   cleaner.
 *
 * WHY dynamic import (via TeamAgentStackedBarDynamic):
 *   Recharts (~250 kB gzipped) is already paid for on the team costs page.
 *   This component is always shown (no tier gate), so it's dynamic-imported
 *   for consistency and to defer non-critical JS until after LCP.
 *
 * @module components/dashboard/team-costs/TeamAgentStackedBar
 */

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single data point for the stacked bar chart.
 * One point per (date, agentType) from the API response.
 */
export interface DailyAgentCostRow {
  /** ISO date string 'YYYY-MM-DD' */
  date: string;
  /** Agent type (e.g. 'claude', 'codex', 'gemini') */
  agentType: string;
  /** Total USD cost for this agent on this day */
  totalCostUsd: number;
}

/** Props for {@link TeamAgentStackedBar}. */
export interface TeamAgentStackedBarProps {
  /** Raw per-day per-agent rows from the API. */
  dailyByAgent: DailyAgentCostRow[];
  /** Selected time range in days (7, 30, or 90). Controls date axis label density. */
  days: number;
}

// ---------------------------------------------------------------------------
// Agent color map
// ---------------------------------------------------------------------------

/**
 * Hex color for each agent type on the stacked bar chart.
 *
 * WHY hardcoded here (not imported from @styrby/shared/costs):
 *   The web cost charts lib (lib/costs.ts) already has these colors for the
 *   individual cost page. However, importing from lib/costs.ts would pull in
 *   the full costs utility file into this chart bundle. A local constant is
 *   safer for bundle isolation on this dynamic chunk.
 */
const AGENT_COLORS: Record<string, string> = {
  claude:   '#f97316', // orange
  codex:    '#3b82f6', // blue
  gemini:   '#22c55e', // green
  opencode: '#a855f7', // purple
  aider:    '#ec4899', // pink
  goose:    '#14b8a6', // teal
  amp:      '#f59e0b', // amber
  crush:    '#6366f1', // indigo
  kilo:     '#84cc16', // lime
  kiro:     '#06b6d4', // cyan
  droid:    '#ef4444', // red
};

/** Fallback color for agents not in the map. */
const FALLBACK_COLOR = '#71717a'; // zinc-500

// ---------------------------------------------------------------------------
// Data transform
// ---------------------------------------------------------------------------

/**
 * Pivots the raw (date, agentType, cost) rows into the Recharts data format:
 * one object per date with one key per agent_type.
 *
 * WHY pivot here (not on the server):
 *   The server returns normalised rows (one row per agent per day) which are
 *   compact to transmit. Recharts needs a pivoted format (one row per day,
 *   one property per agent). The pivot is cheap JS and keeps the API shape
 *   independent of the chart library.
 *
 * @param rows - Raw API rows
 * @returns Pivoted array sorted ascending by date, plus the set of observed agent keys
 */
function pivotRows(rows: DailyAgentCostRow[]): {
  chartData: Record<string, string | number>[];
  agentKeys: string[];
} {
  const byDate: Record<string, Record<string, number>> = {};
  const agentSet = new Set<string>();

  for (const row of rows) {
    if (!byDate[row.date]) byDate[row.date] = {};
    byDate[row.date][row.agentType] = (byDate[row.date][row.agentType] ?? 0) + row.totalCostUsd;
    agentSet.add(row.agentType);
  }

  const chartData = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, agents]) => ({ date, ...agents }));

  const agentKeys = [...agentSet].sort();

  return { chartData, agentKeys };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a stacked bar chart of team cost by agent over time.
 *
 * @param props - TeamAgentStackedBarProps
 */
export function TeamAgentStackedBar({ dailyByAgent, days }: TeamAgentStackedBarProps) {
  const { chartData, agentKeys } = pivotRows(dailyByAgent);

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border/40 bg-card/60 p-8 h-[280px]">
        <p className="text-sm text-muted-foreground">No agent cost data for this period.</p>
      </div>
    );
  }

  /**
   * Formats a date string for the X axis tick label.
   * WHY short label: Recharts X axis ticks overlap on small screens with full
   * ISO date strings. "Apr 01" is human-readable at all breakpoints.
   *
   * @param dateStr - 'YYYY-MM-DD' string
   * @returns Short locale date label
   */
  function formatDateTick(dateStr: string): string {
    try {
      const d = new Date(`${dateStr}T00:00:00`);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
      return dateStr;
    }
  }

  /**
   * Formats a USD value for the Y axis tick.
   *
   * @param value - Numeric cost value
   * @returns Formatted string (e.g. '$1.23')
   */
  function formatCostTick(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  // WHY interval calculation: For 90-day ranges, show every 15th tick to avoid overlap.
  // For 30-day ranges show every 7th; for 7-day ranges show all.
  const tickInterval = days >= 90 ? 14 : days >= 30 ? 6 : 0;

  return (
    <div className="rounded-xl border border-border/40 bg-card/60 p-4">
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateTick}
            interval={tickInterval}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tickFormatter={formatCostTick}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            tickLine={false}
            axisLine={false}
            width={56}
          />
          <Tooltip
            // WHY untyped params: Recharts Formatter<ValueType, NameType> doesn't
            // narrow to (number, string) at the call site. We coerce explicitly to
            // keep the rendered output correct while satisfying the compiler.
            formatter={(value, name) => [
              `$${Number(value).toFixed(4)}`,
              String(name).charAt(0).toUpperCase() + String(name).slice(1),
            ]}
            labelFormatter={(label) => {
              try {
                return new Date(`${String(label)}T00:00:00`).toLocaleDateString('en-US', {
                  weekday: 'short', month: 'short', day: 'numeric',
                });
              } catch { return String(label); }
            }}
            contentStyle={{
              backgroundColor: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
              fontSize: 12,
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            formatter={(value: string) => value.charAt(0).toUpperCase() + value.slice(1)}
          />
          {agentKeys.map((agentKey) => (
            <Bar
              key={agentKey}
              dataKey={agentKey}
              stackId="a"
              fill={AGENT_COLORS[agentKey] ?? FALLBACK_COLOR}
              radius={agentKey === agentKeys[agentKeys.length - 1] ? [3, 3, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
