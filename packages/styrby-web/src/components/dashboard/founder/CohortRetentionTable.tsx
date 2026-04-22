/**
 * CohortRetentionTable — cohort retention table for the founder dashboard.
 *
 * Renders a table of signup cohorts (by month) with:
 *   - Cohort month
 *   - Cohort size
 *   - 30-day retention (fraction of cohort that had a session in the first 30 days)
 *   - 90-day retention (fraction still active at 90 days)
 *
 * WHY a table not a heatmap: A retention heatmap (like Amplitude) requires
 * custom SVG or a charting library. A table with color-coded cells achieves
 * 90% of the signal with zero extra dependencies. Color bands match the
 * capColorBand thresholds for visual consistency.
 *
 * @module components/dashboard/founder/CohortRetentionTable
 */

// ============================================================================
// Types
// ============================================================================

/**
 * One cohort row.
 */
export interface CohortRow {
  cohortMonth: string;
  cohortSize: number;
  retention30d: number | null;
  retention90d: number | null;
}

/**
 * Props for {@link CohortRetentionTable}.
 */
export interface CohortRetentionTableProps {
  cohorts: CohortRow[];
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns a Tailwind text color class for a retention fraction.
 *
 * WHY: Consistent color coding with the rest of the cost dashboard makes
 * retention metrics immediately interpretable by someone already familiar
 * with the cost UI color language.
 */
function retentionColor(rate: number): string {
  if (rate >= 0.6) return 'text-green-400';
  if (rate >= 0.4) return 'text-amber-400';
  return 'text-red-400';
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a cohort retention table for the founder dashboard.
 *
 * @param props - See {@link CohortRetentionTableProps}
 * @returns React element
 *
 * @example
 * <CohortRetentionTable cohorts={cohortRetention} />
 */
export function CohortRetentionTable({ cohorts }: CohortRetentionTableProps) {
  if (cohorts.length === 0) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/60 p-5">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Cohort Retention
        </h3>
        <p className="text-muted-foreground text-sm">No cohort data yet</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
      <div className="px-5 py-4 border-b border-border/40">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Cohort Retention
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-secondary/30">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Cohort
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Size
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                30-day
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                90-day
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">
            {cohorts.map((row) => (
              <tr key={row.cohortMonth}>
                <td className="px-4 py-3 text-sm font-medium text-foreground">
                  {row.cohortMonth}
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground text-right">
                  {row.cohortSize}
                </td>
                <td className="px-4 py-3 text-sm text-right">
                  {row.retention30d !== null ? (
                    <span className={`font-medium ${retentionColor(row.retention30d)}`}>
                      {(row.retention30d * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-right">
                  {row.retention90d !== null ? (
                    <span className={`font-medium ${retentionColor(row.retention90d)}`}>
                      {(row.retention90d * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
