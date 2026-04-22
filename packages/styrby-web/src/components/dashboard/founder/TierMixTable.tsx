/**
 * TierMixTable — tier distribution and agent usage tables for the founder dashboard.
 *
 * Renders two side-by-side tables:
 *   Left: Tier mix (Free / Pro / Power / Team counts)
 *   Right: Agent usage distribution (session count + cost per agent)
 *
 * WHY combined: Both are compact tables that read at a glance. Placing them
 * side-by-side uses screen real estate efficiently without requiring extra
 * scrolling.
 *
 * @module components/dashboard/founder/TierMixTable
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Count entry for one tier.
 */
export interface TierCount {
  tier: string;
  count: number;
}

/**
 * Agent usage entry.
 */
export interface AgentUsage {
  agentType: string;
  sessionCount: number;
  totalCostUsd: number;
}

/**
 * Props for {@link TierMixTable}.
 */
export interface TierMixTableProps {
  tierMix: TierCount[];
  agentUsage: AgentUsage[];
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders tier mix and agent usage distribution tables.
 *
 * @param props - See {@link TierMixTableProps}
 * @returns React element
 *
 * @example
 * <TierMixTable tierMix={tierMix} agentUsage={agentUsage} />
 */
export function TierMixTable({ tierMix, agentUsage }: TierMixTableProps) {
  const totalTiers = tierMix.reduce((sum, t) => sum + t.count, 0);
  const totalSessions = agentUsage.reduce((sum, a) => sum + a.sessionCount, 0);

  const tierOrder = ['free', 'pro', 'power', 'team', 'business', 'enterprise'];
  const sortedTiers = [...tierMix].sort(
    (a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier)
  );

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* Tier mix */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-5">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Tier Mix
        </h3>
        {sortedTiers.length === 0 ? (
          <p className="text-muted-foreground text-sm">No subscription data</p>
        ) : (
          <div className="space-y-2">
            {sortedTiers.map((t) => {
              const pct = totalTiers > 0 ? (t.count / totalTiers) * 100 : 0;
              return (
                <div key={t.tier} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1 mr-4">
                    <span className="text-sm font-medium text-foreground capitalize w-16">
                      {t.tier}
                    </span>
                    <div className="flex-1 h-1.5 bg-secondary/60 rounded-full overflow-hidden">
                      <div
                        className="h-1.5 rounded-full bg-orange-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-sm text-muted-foreground w-16 text-right">
                    {t.count} ({pct.toFixed(0)}%)
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Agent usage distribution */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-5">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Agent Usage (90d)
        </h3>
        {agentUsage.length === 0 ? (
          <p className="text-muted-foreground text-sm">No session data</p>
        ) : (
          <div className="space-y-2">
            {agentUsage.map((a) => {
              const pct = totalSessions > 0 ? (a.sessionCount / totalSessions) * 100 : 0;
              return (
                <div key={a.agentType} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1 mr-4">
                    <span className="text-sm font-medium text-foreground w-20 shrink-0">
                      {a.agentType}
                    </span>
                    <div className="flex-1 h-1.5 bg-secondary/60 rounded-full overflow-hidden">
                      <div
                        className="h-1.5 rounded-full bg-blue-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground w-20 text-right shrink-0">
                    {a.sessionCount} sess
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
