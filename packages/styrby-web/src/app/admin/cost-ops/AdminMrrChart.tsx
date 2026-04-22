'use client';

/**
 * AdminMrrChart — server-passed MRR trend rendered as a simple bar chart.
 *
 * WHY client component: direct DOM measurement for bar widths.
 * WHY no Recharts: admin page is low-traffic; a lightweight CSS-bar chart
 * avoids the 250 kB Recharts bundle for a secondary internal page.
 *
 * @module app/admin/cost-ops/AdminMrrChart
 */

interface MrrDataPoint {
  month: string;
  mrr: number;
  activeSubscriptions: number;
}

/**
 * Props for {@link AdminMrrChart}.
 */
interface AdminMrrChartProps {
  /** MRR data points sorted ascending by month. */
  data: MrrDataPoint[];
}

/**
 * Renders a horizontal bar chart of MRR by month.
 *
 * @param props - Chart data
 * @returns Bar chart element
 */
export function AdminMrrChart({ data }: AdminMrrChartProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-6 text-center text-zinc-500 text-sm">
        No subscription data yet
      </div>
    );
  }

  const maxMrr = Math.max(...data.map((d) => d.mrr), 1);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 overflow-x-auto">
      <div className="min-w-[400px] space-y-2">
        {data.map((point) => {
          const pct = (point.mrr / maxMrr) * 100;
          return (
            <div key={point.month} className="flex items-center gap-3">
              <span className="text-xs text-zinc-400 w-16 shrink-0 font-mono">{point.month}</span>
              <div className="flex-1 bg-zinc-800 rounded-full h-4 overflow-hidden">
                <div
                  className="h-full bg-orange-500 rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                  role="progressbar"
                  aria-valuenow={point.mrr}
                  aria-valuemax={maxMrr}
                  aria-label={`${point.month}: $${point.mrr}`}
                />
              </div>
              <span className="text-xs font-semibold text-zinc-100 w-16 text-right shrink-0">
                ${point.mrr.toLocaleString()}
              </span>
              <span className="text-xs text-zinc-500 w-12 text-right shrink-0">
                {point.activeSubscriptions} sub{point.activeSubscriptions !== 1 ? 's' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
