/**
 * Costs by Agent Chart Component
 *
 * Displays a horizontal bar chart showing cost breakdown by AI agent type.
 * Uses pure CSS for bars (no external charting library needed).
 *
 * @module components/costs/CostsByAgentChart
 */

'use client';

import {
  formatCost,
  formatTokens,
  getAgentColor,
  type AgentCostBreakdown,
} from '@/lib/costs';

/**
 * Props for CostsByAgentChart component.
 */
interface CostsByAgentChartProps {
  /** Array of cost breakdowns by agent (should be sorted by cost descending) */
  data: AgentCostBreakdown[];
  /** Title for the section (default: "Cost by Agent") */
  title?: string;
}

/**
 * Displays a horizontal bar chart showing costs by agent.
 *
 * Uses CSS-based bars for simplicity and SSR compatibility.
 * Each bar shows:
 * - Agent name with color indicator
 * - Cost amount and percentage of total
 * - Token count and request count
 *
 * @param props - Component props
 * @returns Cost by agent chart element
 *
 * @example
 * // Basic usage
 * <CostsByAgentChart data={agentCosts} />
 *
 * @example
 * // With custom title
 * <CostsByAgentChart
 *   data={agentCosts}
 *   title="Spending by Agent (30 days)"
 * />
 */
export function CostsByAgentChart({
  data,
  title = 'Cost by Agent',
}: CostsByAgentChartProps) {
  // Calculate max cost for bar width scaling
  const maxCost = Math.max(...data.map((d) => d.cost), 1);

  // Empty state
  if (data.length === 0) {
    return (
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
        <h3 className="text-lg font-semibold text-zinc-100 mb-4">{title}</h3>
        <div className="py-8 text-center text-zinc-500">No agent data available</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
      <h3 className="text-lg font-semibold text-zinc-100 mb-4">{title}</h3>

      <div className="space-y-4">
        {data.map((agent) => {
          const barWidth = (agent.cost / maxCost) * 100;
          const totalTokens = agent.inputTokens + agent.outputTokens;

          return (
            <div key={agent.agent}>
              {/* Agent header with name and cost */}
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div
                    className={`h-3 w-3 rounded-full ${getAgentColor(agent.agent)}`}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium text-zinc-100 capitalize">
                    {agent.agent}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-100">
                    {formatCost(agent.cost)}
                  </span>
                  <span className="text-xs text-zinc-500">
                    ({agent.percentage.toFixed(1)}%)
                  </span>
                </div>
              </div>

              {/* Horizontal bar */}
              <div
                className="h-2 bg-zinc-800 rounded-full overflow-hidden"
                role="progressbar"
                aria-valuenow={agent.percentage}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${agent.agent}: ${formatCost(agent.cost)} (${agent.percentage.toFixed(1)}%)`}
              >
                <div
                  className={`h-full rounded-full transition-all duration-500 ${getAgentColor(agent.agent)}`}
                  style={{ width: `${barWidth}%` }}
                />
              </div>

              {/* Token and request counts */}
              <p className="text-xs text-zinc-600 mt-1">
                {formatTokens(totalTokens)} tokens | {agent.requestCount.toLocaleString()}{' '}
                requests
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
