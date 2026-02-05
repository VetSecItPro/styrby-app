/**
 * Cost Table Component
 *
 * Displays a detailed breakdown table of costs by model.
 * Shows model name, agent type, request count, token usage, and total cost.
 * Includes a footer row with totals.
 *
 * @module components/costs/CostTable
 */

import {
  formatCost,
  formatTokens,
  type ModelCostBreakdown,
  type AgentType,
} from '@/lib/costs';

/**
 * Props for CostTable component.
 */
interface CostTableProps {
  /** Array of model cost breakdowns (should be sorted by cost descending) */
  data: ModelCostBreakdown[];
  /** Title for the table section (default: "Cost Breakdown") */
  title?: string;
  /** Whether to show the agent column (default: true) */
  showAgent?: boolean;
}

/**
 * Get the Tailwind CSS classes for an agent badge.
 *
 * @param agent - Agent type
 * @returns Tailwind classes for background and text color
 */
function getAgentBadgeClass(agent: AgentType): string {
  switch (agent) {
    case 'claude':
      return 'bg-orange-500/10 text-orange-400';
    case 'codex':
      return 'bg-green-500/10 text-green-400';
    case 'gemini':
      return 'bg-blue-500/10 text-blue-400';
    case 'opencode':
      return 'bg-purple-500/10 text-purple-400';
    default:
      return 'bg-zinc-500/10 text-zinc-400';
  }
}

/**
 * Displays a detailed breakdown table of costs by model.
 *
 * Table columns:
 * - Model: The LLM model identifier
 * - Agent: Which AI coding agent used this model (optional)
 * - Requests: Number of API calls
 * - Tokens: Total input + output tokens
 * - Cost: Total cost in USD
 *
 * Includes a footer row showing totals across all models.
 *
 * @param props - Component props
 * @returns Cost table element
 *
 * @example
 * // Basic usage
 * <CostTable data={modelCosts} />
 *
 * @example
 * // Without agent column
 * <CostTable
 *   data={modelCosts}
 *   title="Model Usage"
 *   showAgent={false}
 * />
 */
export function CostTable({
  data,
  title = 'Cost Breakdown',
  showAgent = true,
}: CostTableProps) {
  // Empty state
  if (data.length === 0) {
    return (
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h3 className="font-semibold text-zinc-100">{title}</h3>
        </div>
        <div className="px-4 py-8 text-center text-zinc-500">No cost data available</div>
      </div>
    );
  }

  // Calculate totals for footer row
  const totals = data.reduce(
    (acc, row) => ({
      cost: acc.cost + row.cost,
      requests: acc.requests + row.requestCount,
      tokens: acc.tokens + row.inputTokens + row.outputTokens,
    }),
    { cost: 0, requests: 0, tokens: 0 }
  );

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden">
      {/* Table header */}
      <div className="px-4 py-3 border-b border-zinc-800">
        <h3 className="font-semibold text-zinc-100">{title}</h3>
      </div>

      {/* Scrollable table container */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-zinc-800/50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                Model
              </th>
              {showAgent && (
                <th className="px-4 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                  Agent
                </th>
              )}
              <th className="px-4 py-3 text-right text-xs font-medium text-zinc-400 uppercase tracking-wider">
                Requests
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-zinc-400 uppercase tracking-wider">
                Tokens
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-zinc-400 uppercase tracking-wider">
                Cost
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {data.map((row) => (
              <tr key={row.model} className="hover:bg-zinc-800/30 transition-colors">
                {/* Model name */}
                <td className="px-4 py-3">
                  <span className="text-sm font-medium text-zinc-100">{row.model}</span>
                </td>
                {/* Agent badge */}
                {showAgent && (
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${getAgentBadgeClass(row.agent)}`}
                    >
                      {row.agent}
                    </span>
                  </td>
                )}
                {/* Request count */}
                <td className="px-4 py-3 text-right">
                  <span className="text-sm text-zinc-400">
                    {row.requestCount.toLocaleString()}
                  </span>
                </td>
                {/* Token count */}
                <td className="px-4 py-3 text-right">
                  <span className="text-sm text-zinc-400">
                    {formatTokens(row.inputTokens + row.outputTokens)}
                  </span>
                </td>
                {/* Cost */}
                <td className="px-4 py-3 text-right">
                  <span className="text-sm font-semibold text-zinc-100">
                    {formatCost(row.cost, 4)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          {/* Footer with totals */}
          <tfoot className="bg-zinc-800/30">
            <tr>
              <td className="px-4 py-3">
                <span className="text-sm font-semibold text-zinc-100">Total</span>
              </td>
              {showAgent && <td className="px-4 py-3" />}
              <td className="px-4 py-3 text-right">
                <span className="text-sm font-semibold text-zinc-100">
                  {totals.requests.toLocaleString()}
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <span className="text-sm font-semibold text-zinc-100">
                  {formatTokens(totals.tokens)}
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <span className="text-sm font-bold text-orange-400">
                  {formatCost(totals.cost, 4)}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
