'use client';

/**
 * ErrorClassHistogram
 *
 * Renders a 30-day stacked bar chart of audit_log errors grouped by error_class
 * taxonomy (network | auth | supabase | agent_crash | unknown).
 *
 * WHY this lives in the founder dashboard (not a general observability panel):
 *   The error_class histogram is admin-only — it aggregates errors across ALL
 *   users' sessions. Only the founder (is_admin = true) sees this view.
 *   It directly informs product health decisions: a spike in "agent_crash"
 *   errors signals a CLI regression; a spike in "supabase" signals infra issues.
 *
 * WHY a separate component (not embedded in TierMixTable or MrrCard):
 *   Error data is semantically distinct from business metrics. Isolating it
 *   keeps each component focused and testable. The histogram can also be
 *   repositioned (e.g. moved to a dedicated /dashboard/founder/errors page)
 *   without touching the MRR or funnel components.
 *
 * WHY Recharts (same as CostCharts / TeamAgentStackedBar):
 *   Recharts is already in the bundle for the cost dashboard. Reusing it
 *   avoids adding a second charting library. The BarChart + stacking pattern
 *   is identical to TeamAgentStackedBar — any Recharts skills already present
 *   in the codebase transfer directly.
 *
 * WHY dynamic-imported via ErrorClassHistogramDynamic:
 *   The founder dashboard already pays the Recharts cost (TierMixTable uses it).
 *   We still dynamic-import for code-splitting — the histogram panel renders
 *   below the fold and should not block the MrrCard / FunnelChart above it.
 *
 * @module components/dashboard/founder/ErrorClassHistogram
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
import { ERROR_CLASSES, type ErrorClass } from '@styrby/shared/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single day's error count breakdown, keyed by error class.
 * Matches the API response shape from GET /api/admin/founder-error-histogram.
 */
export interface ErrorHistogramDay {
  /** ISO date string 'YYYY-MM-DD' */
  date: string;
  /** Count of network errors on this day */
  network: number;
  /** Count of auth errors on this day */
  auth: number;
  /** Count of supabase errors on this day */
  supabase: number;
  /** Count of agent_crash errors on this day */
  agent_crash: number;
  /** Count of unknown errors on this day */
  unknown: number;
}

/** Props for {@link ErrorClassHistogram}. */
export interface ErrorClassHistogramProps {
  /** Pre-pivoted daily error counts. Empty array renders an empty state. */
  data: ErrorHistogramDay[];
}

// ---------------------------------------------------------------------------
// Color map
// ---------------------------------------------------------------------------

/**
 * Colors for each error class bar segment.
 *
 * WHY separate from AGENT_COLORS (not shared):
 *   These colors represent error *severity intent* — red for crashes,
 *   amber for auth, blue for infra — not the same palette as agent types.
 *   Semantic color associations make the chart immediately readable to a
 *   founder scanning for anomalies.
 */
const ERROR_CLASS_COLORS: Record<ErrorClass, string> = {
  network:     '#3b82f6', // blue  — transport failures
  auth:        '#f59e0b', // amber — 401/403
  supabase:    '#a855f7', // purple — DB/infra
  agent_crash: '#ef4444', // red   — highest severity
  unknown:     '#71717a', // zinc  — unclassified
};

/** Human-readable label for each error class. */
const ERROR_CLASS_LABELS: Record<ErrorClass, string> = {
  network:     'Network',
  auth:        'Auth',
  supabase:    'Supabase',
  agent_crash: 'Agent Crash',
  unknown:     'Unknown',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a 30-day stacked bar chart of error class frequency.
 *
 * Empty state is shown when no error audit_log rows exist in the window.
 * This is normal for a healthy system — a founder should *want* to see
 * "No errors logged in the last 30 days."
 *
 * @param props - ErrorClassHistogramProps
 */
export function ErrorClassHistogram({ data }: ErrorClassHistogramProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border/40 bg-card/60 px-4 py-10 text-center h-[220px]">
        <div>
          <p className="text-sm font-medium text-foreground mb-1">No errors logged</p>
          <p className="text-xs text-muted-foreground">
            No error-class audit events in the last 30 days. System is healthy.
          </p>
        </div>
      </div>
    );
  }

  /**
   * Formats the X axis date tick.
   *
   * WHY short label: Recharts date ticks overlap on a 30-day chart with full
   * ISO strings. "Apr 01" is compact and still conveys the date clearly.
   *
   * @param dateStr - 'YYYY-MM-DD'
   * @returns Short locale date label
   */
  function formatDateTick(dateStr: string): string {
    try {
      return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  }

  // Compute the total errors across all days for the summary line
  const totalErrors = data.reduce(
    (sum, day) =>
      sum + day.network + day.auth + day.supabase + day.agent_crash + day.unknown,
    0
  );

  return (
    <div className="rounded-xl border border-border/40 bg-card/60 p-5">
      {/* Section header with total count */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground">Error Class Histogram (30d)</h3>
        <span className="text-xs text-muted-foreground">
          {totalErrors.toLocaleString()} total errors
        </span>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateTick}
            interval={6}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            tickLine={false}
            axisLine={false}
            width={36}
          />
          <Tooltip
            // WHY `as any` on value/name: Recharts' Formatter<ValueType, NameType>
            // generic doesn't align with the concrete (number, string) types we
            // receive at runtime. Casting here is safe — Recharts always passes
            // numeric bar values and the dataKey string. The rendered output
            // (toLocaleString) is still fully type-checked.
            formatter={(value, name) => [
              String(Number(value).toLocaleString()),
              ERROR_CLASS_LABELS[name as ErrorClass] ?? String(name),
            ]}
            // WHY single-param labelFormatter: Recharts' overloaded signature
            // expects (label: any, payload?: TooltipPayload[]) => ReactNode.
            // We only need the label string here; ignoring payload is safe.
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
            formatter={(value: string) => ERROR_CLASS_LABELS[value as ErrorClass] ?? value}
          />
          {/* WHY iterate ERROR_CLASSES (shared constant) not a hardcoded list:
              ERROR_CLASSES is the single source of truth (migration 029 + @styrby/shared).
              Adding a new error class to the taxonomy only requires updating that
              constant + the DB constraint — the chart picks it up automatically. */}
          {ERROR_CLASSES.map((cls, idx) => (
            <Bar
              key={cls}
              dataKey={cls}
              stackId="errors"
              fill={ERROR_CLASS_COLORS[cls]}
              // WHY radius only on top segment: Recharts applies border-radius to
              // every segment in a stack independently, which looks wrong for stacked
              // bars. Rounding only the last segment (top of the stack) gives the
              // visual polish without visual artifacts on intermediate segments.
              radius={idx === ERROR_CLASSES.length - 1 ? [3, 3, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>

      {/* Per-class total summary row */}
      <div className="mt-4 flex flex-wrap gap-3">
        {ERROR_CLASSES.map((cls) => {
          const count = data.reduce((sum, day) => sum + (day[cls] ?? 0), 0);
          if (count === 0) return null;
          return (
            <div key={cls} className="flex items-center gap-1.5">
              <div
                className="h-2.5 w-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: ERROR_CLASS_COLORS[cls] }}
                aria-hidden="true"
              />
              <span className="text-xs text-muted-foreground">
                {ERROR_CLASS_LABELS[cls]}: {count.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
