/**
 * AdminTopSpendTable — top spenders by USD in last 30 days.
 *
 * User IDs are truncated to 8 chars for display. Full IDs accessible in
 * Supabase dashboard. No PII exposed.
 *
 * @module app/admin/cost-ops/AdminTopSpendTable
 */

interface TopSpender {
  userIdPrefix: string;
  spendUsd: number;
  tier: string;
  sessionCount: number;
}

/**
 * Props for {@link AdminTopSpendTable}.
 */
interface AdminTopSpendTableProps {
  /** Top spenders sorted descending by spendUsd. */
  data: TopSpender[];
}

/** Tier badge colours */
const TIER_CLASS: Record<string, string> = {
  power: 'bg-orange-500/10 text-orange-400',
  team: 'bg-blue-500/10 text-blue-400',
  business: 'bg-purple-500/10 text-purple-400',
  enterprise: 'bg-green-500/10 text-green-400',
  free: 'bg-zinc-500/10 text-zinc-400',
};

/**
 * Renders top spenders table with redacted user IDs.
 *
 * @param props - Table data
 * @returns Table element
 */
export function AdminTopSpendTable({ data }: AdminTopSpendTableProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-6 text-center text-zinc-500 text-sm">
        No spend data in the last 30 days
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-zinc-800/50">
          <tr>
            {['#', 'User ID (prefix)', 'Tier', 'Spend (30d)', 'Sessions (30d)'].map((h) => (
              <th key={h} className="px-4 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {data.map((row, i) => (
            <tr key={row.userIdPrefix + i} className="hover:bg-zinc-800/30 transition-colors">
              <td className="px-4 py-3 text-xs text-zinc-500">{i + 1}</td>
              <td className="px-4 py-3 text-xs font-mono text-zinc-300">{row.userIdPrefix}…</td>
              <td className="px-4 py-3">
                <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium capitalize ${TIER_CLASS[row.tier] ?? TIER_CLASS.free}`}>
                  {row.tier}
                </span>
              </td>
              <td className="px-4 py-3 text-xs font-semibold text-zinc-100">
                ${row.spendUsd.toFixed(2)}
              </td>
              <td className="px-4 py-3 text-xs text-zinc-400">
                {row.sessionCount.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
