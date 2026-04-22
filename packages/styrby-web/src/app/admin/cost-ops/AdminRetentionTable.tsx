/**
 * AdminRetentionTable — cohort retention at weeks 4, 8, 12.
 *
 * WHY server component: data is passed from the server page; no client
 * interactivity needed.
 *
 * @module app/admin/cost-ops/AdminRetentionTable
 */

interface CohortRetention {
  cohortWeek: string;
  cohortSize: number;
  week4Pct: number | null;
  week8Pct: number | null;
  week12Pct: number | null;
}

/**
 * Props for {@link AdminRetentionTable}.
 */
interface AdminRetentionTableProps {
  /** Cohort retention rows, typically sorted newest-first. */
  data: CohortRetention[];
}

/**
 * Renders cohort retention as a colour-coded table.
 * Green >= 50%, Amber 25-49%, Red < 25%.
 *
 * @param props - Table data
 * @returns Table element
 */
export function AdminRetentionTable({ data }: AdminRetentionTableProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-6 text-center text-zinc-500 text-sm">
        Not enough cohort history yet (need 28+ days of data)
      </div>
    );
  }

  /**
   * Returns Tailwind classes for a retention percentage cell.
   *
   * @param pct - Retention percentage or null
   * @returns Tailwind colour classes
   */
  function retentionClass(pct: number | null): string {
    if (pct === null) return 'text-zinc-500';
    if (pct >= 50) return 'text-green-400 font-semibold';
    if (pct >= 25) return 'text-amber-400 font-semibold';
    return 'text-red-400 font-semibold';
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-zinc-800/50">
          <tr>
            {['Cohort Week', 'Size', 'W4 Retention', 'W8 Retention', 'W12 Retention'].map((h) => (
              <th key={h} className="px-4 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {data.map((row) => (
            <tr key={row.cohortWeek} className="hover:bg-zinc-800/30 transition-colors">
              <td className="px-4 py-3 text-xs font-mono text-zinc-300">{row.cohortWeek}</td>
              <td className="px-4 py-3 text-xs text-zinc-400">{row.cohortSize}</td>
              <td className={`px-4 py-3 text-xs ${retentionClass(row.week4Pct)}`}>
                {row.week4Pct !== null ? `${row.week4Pct}%` : '–'}
              </td>
              <td className={`px-4 py-3 text-xs ${retentionClass(row.week8Pct)}`}>
                {row.week8Pct !== null ? `${row.week8Pct}%` : '–'}
              </td>
              <td className={`px-4 py-3 text-xs ${retentionClass(row.week12Pct)}`}>
                {row.week12Pct !== null ? `${row.week12Pct}%` : '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
