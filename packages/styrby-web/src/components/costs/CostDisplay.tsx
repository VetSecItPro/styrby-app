/**
 * CostDisplay — renders cost value branched on billing_model.
 *
 * Central branching logic for how a cost is displayed:
 *   'api-key'      → "$12.40"
 *   'subscription' → "N% quota"  (if fractionUsed available) or "-"
 *   'credit'       → "X cr ($Y)"
 *   'free'         → "$0.00"
 *
 * WHY a single shared component: Both CostTable rows and the page header
 * strip need identical display rules. One component eliminates the risk of
 * the two surfaces drifting out of sync.
 *
 * @module components/costs/CostDisplay
 */

import type { BillingModel } from '@styrby/shared';
import { formatCost } from '@/lib/costs';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for {@link CostDisplay}.
 */
export interface CostDisplayProps {
  /** Billing model controlling which display branch is used. */
  billingModel: BillingModel;
  /** Total USD cost. Used for 'api-key' and 'free'; ignored for 'subscription'. */
  costUsd: number;
  /**
   * Fraction of subscription quota consumed [0, 1].
   * Required for a meaningful 'subscription' display; absent shows "—".
   */
  subscriptionFractionUsed?: number | null;
  /**
   * Number of credits consumed.
   * Used for 'credit' display; required when billingModel === 'credit'.
   */
  creditsConsumed?: number | null;
  /**
   * USD rate per credit at event time.
   * Used together with creditsConsumed to derive the parenthetical dollar amount.
   */
  creditRateUsd?: number | null;
  /** Number of decimal places for USD amounts (default 2). */
  decimals?: number;
  /** Additional CSS class names. */
  className?: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a cost value appropriate for the billing model.
 *
 * @param props - Component props
 * @returns Formatted cost element
 *
 * @example
 * // API-key billing
 * <CostDisplay billingModel="api-key" costUsd={12.4} />
 * // → "$12.40"
 *
 * @example
 * // Subscription with quota fraction
 * <CostDisplay billingModel="subscription" costUsd={0} subscriptionFractionUsed={0.47} />
 * // → "47% quota"
 *
 * @example
 * // Credit billing
 * <CostDisplay billingModel="credit" costUsd={4.3} creditsConsumed={430} creditRateUsd={0.01} />
 * // → "430 cr ($4.30)"
 */
export function CostDisplay({
  billingModel,
  costUsd,
  subscriptionFractionUsed,
  creditsConsumed,
  creditRateUsd,
  decimals = 2,
  className = '',
}: CostDisplayProps) {
  const text = formatCostValue({
    billingModel,
    costUsd,
    subscriptionFractionUsed,
    creditsConsumed,
    creditRateUsd,
    decimals,
  });

  return <span className={className}>{text}</span>;
}

// ============================================================================
// Pure Formatter (exported for tests)
// ============================================================================

/**
 * Pure function that produces the display string for a cost value.
 *
 * Extracted from the component so it can be unit-tested without DOM rendering.
 *
 * @param opts - Formatting options matching {@link CostDisplayProps}
 * @returns Display string
 */
export function formatCostValue({
  billingModel,
  costUsd,
  subscriptionFractionUsed,
  creditsConsumed,
  creditRateUsd,
  decimals = 2,
}: Omit<CostDisplayProps, 'className'>): string {
  switch (billingModel) {
    case 'subscription': {
      if (subscriptionFractionUsed == null) {
        return '-';
      }
      const pct = Math.round(subscriptionFractionUsed * 100);
      return `${pct}% quota`;
    }

    case 'credit': {
      const cr = creditsConsumed ?? 0;
      if (creditRateUsd != null && creditRateUsd > 0) {
        const usd = cr * creditRateUsd;
        return `${cr} cr (${formatCost(usd, decimals)})`;
      }
      // Fallback: we have costUsd but no explicit rate breakdown
      if (costUsd > 0) {
        return `${cr} cr (${formatCost(costUsd, decimals)})`;
      }
      return `${cr} cr`;
    }

    case 'free':
      // WHY: Show $0.00 explicitly for free models so users understand there
      // is a record but no spend, rather than a blank cell that looks like missing data.
      return formatCost(0, decimals);

    case 'api-key':
    default:
      return formatCost(costUsd, decimals);
  }
}
