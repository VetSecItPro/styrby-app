/**
 * AdminTierMix — shows distribution of subscribers across tiers.
 *
 * @module app/admin/cost-ops/AdminTierMix
 */

interface TierCount {
  tier: string;
  count: number;
}

interface AdminTierMixProps {
  data: TierCount[];
  totalActive: number;
}

const TIER_COLOUR: Record<string, string> = {
  power: 'bg-orange-500',
  team: 'bg-blue-500',
  business: 'bg-purple-500',
  enterprise: 'bg-green-500',
  free: 'bg-zinc-600',
};

/**
 * Renders tier mix as a stacked bar + legend.
 *
 * @param props - Tier data + total count
 * @returns Tier mix element
 */
export function AdminTierMix({ data, totalActive }: AdminTierMixProps) {
  if (data.length === 0 || totalActive === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-6 text-center text-zinc-500 text-sm">
        No active subscribers yet
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      {/* Stacked bar */}
      <div className="flex w-full h-6 rounded-full overflow-hidden mb-4">
        {data.map((t) => {
          const pct = (t.count / totalActive) * 100;
          return (
            <div
              key={t.tier}
              className={`${TIER_COLOUR[t.tier] ?? TIER_COLOUR.free} first:rounded-l-full last:rounded-r-full`}
              style={{ width: `${pct}%` }}
              title={`${t.tier}: ${t.count} (${Math.round(pct)}%)`}
              role="img"
              aria-label={`${t.tier}: ${t.count}`}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="space-y-1.5">
        {data.map((t) => {
          const pct = Math.round((t.count / totalActive) * 100);
          return (
            <div key={t.tier} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${TIER_COLOUR[t.tier] ?? TIER_COLOUR.free}`} aria-hidden="true" />
                <span className="text-xs text-zinc-300 capitalize">{t.tier}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-zinc-400">{t.count.toLocaleString()}</span>
                <span className="text-xs text-zinc-500 w-10 text-right">{pct}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
