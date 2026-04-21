/**
 * Cost Table Component
 *
 * Displays a detailed breakdown table of costs by model.
 * Shows model name, agent type, billing model, source, request count,
 * token usage, and total cost.
 * Includes a footer row with totals.
 *
 * WHY billing_model + source columns: Migration 022 added these fields so
 * users can distinguish API costs (variable USD) from subscription quota
 * consumption (flat-rate) and credit consumption (per-prompt). Without surfacing
 * them here, the cost table would be misleading for subscription/credit users.
 *
 * @module components/costs/CostTable
 */

import {
  formatCost,
  formatTokens,
  type ModelCostBreakdown,
  type AgentType,
} from '@/lib/costs';
import type { BillingModel, CostSource } from '@styrby/shared';
import { BillingModelChip, SourceBadge } from './BillingModelChip';
import { CostDisplay } from './CostDisplay';

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
  /**
   * Whether to show the billing model + source columns.
   * Default: false (preserves the original compact layout for callers that do
   * not yet have billing metadata).
   */
  showBillingMeta?: boolean;
}

/**
 * Extended model cost breakdown row with optional billing metadata.
 *
 * WHY optional: The billing fields are added by migration 022 and exposed
 * via the v_my_daily_costs view update. Pages that haven't migrated their
 * data-fetching to include these columns can still use CostTable without
 * breaking — the columns simply won't render if showBillingMeta is false.
 */
export interface ModelCostBreakdownWithMeta extends ModelCostBreakdown {
  /** Billing model for this record (from cost_records.billing_model). */
  billingModel?: BillingModel;
  /** Source of the cost data (from cost_records.source). */
  source?: CostSource;
  /** Subscription quota fraction [0, 1] (present when billingModel === 'subscription'). */
  subscriptionFractionUsed?: number | null;
  /** Credits consumed (present when billingModel === 'credit'). */
  creditsConsumed?: number | null;
  /** USD rate per credit (present when billingModel === 'credit'). */
  creditRateUsd?: number | null;
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
    case 'aider':
      return 'bg-pink-500/10 text-pink-400';
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
 * - Billing: Compact billing model chip — "API", "SUB", "CR", "FREE" (when showBillingMeta)
 * - Src: Source badge — "R" (agent-reported) or "E" (estimate) (when showBillingMeta)
 * - Requests: Number of API calls
 * - Tokens: Total input + output tokens
 * - Cost: USD amount, quota %, or credit count — branched on billing model
 *
 * Includes a footer row showing totals across all models.
 *
 * @param props - Component props
 * @returns Cost table element
 *
 * @example
 * // Basic usage (no billing meta)
 * <CostTable data={modelCosts} />
 *
 * @example
 * // With billing metadata columns
 * <CostTable data={modelCostsWithMeta} showBillingMeta />
 */
export function CostTable({
  data,
  title = 'Cost Breakdown',
  showAgent = true,
  showBillingMeta = false,
}: CostTableProps) {
  // WHY type cast: ModelCostBreakdownWithMeta extends ModelCostBreakdown so
  // all existing callers continue to work. The extra fields are optional and
  // only accessed when showBillingMeta is true.
  const rows = data as ModelCostBreakdownWithMeta[];

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
              {/* Billing model + source columns — shown only when caller has metadata */}
              {showBillingMeta && (
                <>
                  <th className="px-4 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    Billing
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    Src
                  </th>
                </>
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
            {rows.map((row) => (
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
                {/* Billing model chip + source badge */}
                {showBillingMeta && (
                  <>
                    <td className="px-4 py-3">
                      {row.billingModel ? (
                        <BillingModelChip billingModel={row.billingModel} />
                      ) : (
                        <span className="text-zinc-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {row.source ? (
                        <SourceBadge source={row.source} />
                      ) : (
                        <span className="text-zinc-400 text-xs">—</span>
                      )}
                    </td>
                  </>
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
                {/* Cost — branches on billing model when metadata is present */}
                <td className="px-4 py-3 text-right">
                  {showBillingMeta && row.billingModel ? (
                    <CostDisplay
                      billingModel={row.billingModel}
                      costUsd={row.cost}
                      subscriptionFractionUsed={row.subscriptionFractionUsed}
                      creditsConsumed={row.creditsConsumed}
                      creditRateUsd={row.creditRateUsd}
                      decimals={4}
                      className="text-sm font-semibold text-zinc-100"
                    />
                  ) : (
                    <span className="text-sm font-semibold text-zinc-100">
                      {formatCost(row.cost, 4)}
                    </span>
                  )}
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
              {/* Empty cells for billing meta columns */}
              {showBillingMeta && (
                <>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3" />
                </>
              )}
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
