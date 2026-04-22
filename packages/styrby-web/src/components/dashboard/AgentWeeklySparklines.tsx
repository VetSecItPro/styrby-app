/**
 * AgentWeeklySparklines — web per-agent 7-day cost sparkline table.
 *
 * Renders a card with one row per active agent showing:
 *   - Agent color dot + name
 *   - 7 proportionally-scaled bar columns (one per day)
 *   - MTD total cost right-aligned
 *
 * Mirrors the mobile AgentWeeklySparkline component for web/mobile parity.
 *
 * WHY CSS bars instead of Recharts: This is a summary-level micro-chart
 * that renders inside the Cost Analytics page which already loads Recharts
 * for the main daily chart. However, sparklines are used across any tier
 * (the main charts are Power-only), so we intentionally avoid the Recharts
 * dynamic import here to keep this section lightweight and tier-agnostic.
 *
 * @module components/dashboard/AgentWeeklySparklines
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Data for a single agent's 7-day sparkline row.
 */
export interface AgentSparklineRow {
  /** Agent type key (matches cost_records.agent_type). */
  agentType: string;
  /** Display name (e.g. "Claude Code"). */
  label: string;
  /** Brand hex color. */
  color: string;
  /** Daily cost values, length 7, ascending by date. */
  dailyCosts: number[];
  /** Month-to-date total cost in USD. */
  mtdCostUsd: number;
}

/**
 * Props for {@link AgentWeeklySparklines}.
 */
export interface AgentWeeklySparklinesProps {
  /** Rows for agents that had any activity in the last 7 days. */
  rows: AgentSparklineRow[];
}

// ============================================================================
// Component
// ============================================================================

/** Bar area height in px. */
const BAR_HEIGHT_PX = 28;

/**
 * Renders the per-agent 7-day sparkline table for the Cost Analytics page.
 *
 * @param props - See {@link AgentWeeklySparklinesProps}
 * @returns React element, or null if rows is empty
 *
 * @example
 * <AgentWeeklySparklines rows={sparklineRows} />
 */
export function AgentWeeklySparklines({ rows }: AgentWeeklySparklinesProps) {
  if (rows.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-foreground mb-4">
        Agent Trend (7 Days)
      </h2>
      <div className="rounded-xl bg-card/60 border border-border/40 divide-y divide-border/20">
        {rows.map((row) => {
          const maxDay = Math.max(...row.dailyCosts, 0.0001);
          return (
            <div
              key={row.agentType}
              className="px-4 py-3 flex items-center gap-4"
            >
              {/* Color dot + agent name */}
              <div className="flex items-center gap-2 w-32 shrink-0">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: row.color }}
                />
                <span className="text-sm font-medium text-foreground truncate">
                  {row.label}
                </span>
              </div>

              {/* 7-bar mini chart */}
              <div
                className="flex items-end gap-0.5 flex-1"
                style={{ height: BAR_HEIGHT_PX }}
                role="img"
                aria-label={`7-day cost trend for ${row.label}`}
              >
                {row.dailyCosts.map((cost, i) => {
                  const frac = maxDay > 0 ? cost / maxDay : 0;
                  const barH = Math.max(Math.round(frac * BAR_HEIGHT_PX), 2);
                  return (
                    <div
                      // eslint-disable-next-line react/no-array-index-key -- i is stable for a fixed 7-element array
                      key={i}
                      title={`$${cost.toFixed(4)}`}
                      style={{
                        width: 8,
                        height: barH,
                        backgroundColor: row.color,
                        opacity: cost === 0 ? 0.15 : 0.8,
                        borderRadius: 2,
                      }}
                    />
                  );
                })}
              </div>

              {/* MTD total */}
              <span className="text-sm font-semibold text-foreground w-20 text-right shrink-0">
                ${row.mtdCostUsd.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
