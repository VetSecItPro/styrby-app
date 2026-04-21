/**
 * Costs by Agent Chart Component
 *
 * Displays a horizontal bar chart showing cost breakdown by AI agent type.
 * Each agent row shows a stacked mini-bar: API cost (blue), subscription
 * quota (purple), credits (amber), and free (zinc). This surfaces billing
 * model diversity per-agent without requiring a separate chart.
 *
 * WHY stacked billing model bars: An agent like Kiro uses credits while Claude
 * Code uses API keys and Claude Max uses subscriptions. A single bar per agent
 * obscures this. The stacked breakdown gives users immediate visibility into
 * which billing model drives their per-agent costs.
 *
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
import type { BillingModel } from '@styrby/shared';
import { BILLING_MODEL_LABEL } from './BillingModelChip';

// ============================================================================
// Types
// ============================================================================

/**
 * Per-billing-model sub-total for a single agent.
 */
export interface AgentBillingBreakdown {
  /** USD cost for 'api-key' rows */
  apiKeyCostUsd: number;
  /** Fraction of subscription quota consumed [0, 1], averaged across subscription rows */
  subscriptionFractionUsed: number | null;
  /** Count of subscription rows (to compute average fraction) */
  subscriptionRowCount: number;
  /** Total credits consumed for 'credit' rows */
  creditsConsumed: number;
  /** USD equivalent for credit rows */
  creditCostUsd: number;
  /** USD cost for 'free' rows (always 0 by definition; kept for completeness) */
  freeCostUsd: number;
}

/**
 * Extended agent cost breakdown that includes per-billing-model sub-totals.
 *
 * WHY optional: Pages that fetch from the MV (which does not yet expose
 * billing_model) can still pass plain {@link AgentCostBreakdown} and the
 * component degrades gracefully to the original single-bar display.
 */
export interface AgentCostBreakdownWithBilling extends AgentCostBreakdown {
  /** Per-billing-model sub-totals. Absent for legacy callers. */
  billing?: AgentBillingBreakdown;
}

/**
 * Props for CostsByAgentChart component.
 */
interface CostsByAgentChartProps {
  /** Array of cost breakdowns by agent (should be sorted by cost descending) */
  data: AgentCostBreakdownWithBilling[];
  /** Title for the section (default: "Cost by Agent") */
  title?: string;
}

// ============================================================================
// Colour helpers
// ============================================================================

/** Tailwind inline-style colour for each billing model's segment of the stacked bar. */
const BILLING_BAR_COLOUR: Record<BillingModel, string> = {
  'api-key': '#3b82f6',   // blue-500
  subscription: '#a855f7', // purple-500
  credit: '#f59e0b',       // amber-500
  free: '#71717a',         // zinc-500
};

// ============================================================================
// Component
// ============================================================================

/**
 * Displays a horizontal bar chart showing costs by agent.
 *
 * When billing breakdown data is available (`data[n].billing`), each bar is
 * split into coloured segments for api-key / subscription / credit / free.
 * Without billing data the original single-colour bar is shown.
 *
 * @param props - Component props
 * @returns Cost by agent chart element
 *
 * @example
 * // Basic usage (no billing meta)
 * <CostsByAgentChart data={agentCosts} />
 *
 * @example
 * // With billing meta — stacked bars
 * <CostsByAgentChart data={agentCostsWithBilling} />
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

  // Determine if any row has billing meta, so we know whether to render the legend
  const hasBillingMeta = data.some((d) => d.billing !== undefined);

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
      <h3 className="text-lg font-semibold text-zinc-100 mb-4">{title}</h3>

      {/* Billing model legend — only visible when billing meta is present */}
      {hasBillingMeta && (
        <div className="flex flex-wrap items-center gap-3 mb-4" aria-label="Billing model legend">
          {(['api-key', 'subscription', 'credit', 'free'] as BillingModel[]).map((model) => (
            <div key={model} className="flex items-center gap-1.5">
              <div
                className="h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: BILLING_BAR_COLOUR[model] }}
                aria-hidden="true"
              />
              <span className="text-xs text-zinc-400">{BILLING_MODEL_LABEL[model]}</span>
            </div>
          ))}
        </div>
      )}

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

              {/* Horizontal bar — stacked segments when billing meta is present */}
              {agent.billing ? (
                <StackedBillingBar billing={agent.billing} totalCost={agent.cost} barWidthPct={barWidth} agentName={agent.agent} />
              ) : (
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
              )}

              {/* Token and request counts */}
              <p className="text-xs text-zinc-500 mt-1">
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

// ============================================================================
// Sub-component: StackedBillingBar
// ============================================================================

/**
 * Props for the stacked billing model bar.
 */
interface StackedBillingBarProps {
  /** Billing breakdown for one agent. */
  billing: AgentBillingBreakdown;
  /** Total USD cost for the agent (used to compute segment widths). */
  totalCost: number;
  /** Width of the full bar as % of the chart container. */
  barWidthPct: number;
  /** Agent name for aria-label. */
  agentName: string;
}

/**
 * Renders a stacked horizontal bar with one segment per billing model.
 *
 * WHY segments computed by USD cost: Subscription rows have $0 cost but a
 * quota fraction. To still show a visible subscription segment we treat the
 * quota fraction as a virtual cost: if the agent consumed 47% of a
 * subscription, the subscription segment occupies 47% of the bar width
 * that the api-key cost does NOT occupy. This gives a proportional feel
 * without distorting the USD totals.
 *
 * @param props - Sub-component props
 * @returns Stacked bar element
 */
function StackedBillingBar({
  billing,
  totalCost,
  barWidthPct,
  agentName,
}: StackedBillingBarProps) {
  // Build segment objects to calculate proportional widths
  const segments: Array<{ model: BillingModel; cost: number; label: string }> = [];

  if (billing.apiKeyCostUsd > 0) {
    segments.push({ model: 'api-key', cost: billing.apiKeyCostUsd, label: `API: ${formatCost(billing.apiKeyCostUsd)}` });
  }
  if (billing.creditCostUsd > 0) {
    segments.push({ model: 'credit', cost: billing.creditCostUsd, label: `Credits: ${billing.creditsConsumed} cr (${formatCost(billing.creditCostUsd)})` });
  }

  // WHY virtual cost for subscription: When there are only subscription rows,
  // totalCost is 0, leaving nothing to proportion. We instead use fractionUsed
  // as the sole segment.
  const hasOnlySubscription = billing.subscriptionRowCount > 0 &&
    billing.apiKeyCostUsd === 0 &&
    billing.creditCostUsd === 0;

  if (billing.subscriptionRowCount > 0) {
    const frac = billing.subscriptionFractionUsed ?? 0;
    const label = billing.subscriptionFractionUsed != null
      ? `Subscription: ${Math.round(frac * 100)}% quota`
      : 'Subscription';
    if (hasOnlySubscription) {
      // Represent as a fraction of the bar rather than a USD proportion
      segments.push({ model: 'subscription', cost: frac, label });
    } else {
      // Estimate a virtual USD equivalent proportional to fraction consumed
      const virtual = Math.max(totalCost * frac, 0.0001);
      segments.push({ model: 'subscription', cost: virtual, label });
    }
  }

  if (segments.length === 0) {
    // Fallback: no billing data in the breakdown — show a plain zinc bar
    return (
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden" aria-label={`${agentName}: no billing data`}>
        <div className="h-full bg-zinc-600 rounded-full" style={{ width: `${barWidthPct}%` }} />
      </div>
    );
  }

  const segmentTotal = segments.reduce((s, seg) => s + seg.cost, 0);

  return (
    <div
      className="h-2 bg-zinc-800 rounded-full overflow-hidden flex"
      role="img"
      aria-label={`${agentName} billing breakdown: ${segments.map((s) => s.label).join(', ')}`}
      style={{ width: `${barWidthPct}%` }}
    >
      {segments.map((seg) => (
        <div
          key={seg.model}
          className="h-full transition-all duration-500"
          title={seg.label}
          style={{
            width: `${(seg.cost / segmentTotal) * 100}%`,
            backgroundColor: BILLING_BAR_COLOUR[seg.model],
          }}
        />
      ))}
    </div>
  );
}
