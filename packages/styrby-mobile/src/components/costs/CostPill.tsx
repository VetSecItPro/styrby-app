/**
 * CostPill (Mobile)
 *
 * Displays a session or message cost inline as a compact pill, branched on
 * the billing model:
 *
 *   'api-key'      → "$4.30"
 *   'subscription' → "47% quota"   (if fractionUsed) or "SUB"
 *   'credit'       → "430 cr ($4.30)"
 *   'free'         → "$0.00"
 *
 * Optionally shows a source badge ("R" / "E") next to the cost text.
 *
 * WHY a single CostPill: The session list (costs.tsx), session detail
 * ([id].tsx), and the message-level cost display in the chat replay all need
 * the same billing-model branching. Centralising it here prevents the three
 * callers from drifting apart.
 *
 * @module components/costs/CostPill
 */

import { View, Text } from 'react-native';
import type { BillingModel, CostSource } from 'styrby-shared';
import { SourceBadge } from './BillingModelChip';

// WHY: Inline formatCost instead of importing from useCosts.ts to avoid pulling
// the Supabase client into this pure-display component (and its test).
// formatCost is a trivial formatter — no reason for the dependency chain.
function formatCost(cost: number, decimals = 2): string {
  return `$${cost.toFixed(decimals)}`;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Props for {@link CostPill}.
 */
export interface CostPillProps {
  /** Billing model controlling the display branch. */
  billingModel: BillingModel;
  /** Total USD cost (used for api-key and credit fallback). */
  costUsd: number;
  /**
   * Subscription quota fraction [0, 1].
   * Present when billingModel === 'subscription'.
   */
  subscriptionFractionUsed?: number | null;
  /**
   * Credits consumed.
   * Present when billingModel === 'credit'.
   */
  creditsConsumed?: number | null;
  /**
   * USD rate per credit at event time.
   * Used to derive the parenthetical $ amount in the credit display.
   */
  creditRateUsd?: number | null;
  /**
   * Data provenance: 'agent-reported' or 'styrby-estimate'.
   * When provided, a small SourceBadge is shown next to the cost text.
   */
  source?: CostSource;
  /**
   * Number of decimal places for USD amounts (default 2).
   * Use 4 for per-message micro-costs.
   */
  decimals?: number;
}

// ============================================================================
// Pure formatter (exported for tests)
// ============================================================================

/**
 * Returns the display string for a cost pill, branched on billing model.
 *
 * @param opts - Formatting parameters
 * @returns Display string ready for rendering
 *
 * @example
 * formatPillCost({ billingModel: 'api-key', costUsd: 1.23 })    // "$1.23"
 * formatPillCost({ billingModel: 'subscription', costUsd: 0,
 *   subscriptionFractionUsed: 0.6 })                             // "60% quota"
 * formatPillCost({ billingModel: 'credit', costUsd: 2, creditsConsumed: 200,
 *   creditRateUsd: 0.01 })                                       // "200 cr ($2.00)"
 */
export function formatPillCost({
  billingModel,
  costUsd,
  subscriptionFractionUsed,
  creditsConsumed,
  creditRateUsd,
  decimals = 2,
}: Omit<CostPillProps, 'source'>): string {
  switch (billingModel) {
    case 'subscription': {
      if (subscriptionFractionUsed != null) {
        return `${Math.round(subscriptionFractionUsed * 100)}% quota`;
      }
      return 'SUB';
    }

    case 'credit': {
      const cr = creditsConsumed ?? 0;
      if (creditRateUsd != null && creditRateUsd > 0) {
        const usd = cr * creditRateUsd;
        return `${cr} cr (${formatCost(usd, decimals)})`;
      }
      if (costUsd > 0) {
        return `${cr} cr (${formatCost(costUsd, decimals)})`;
      }
      return `${cr} cr`;
    }

    case 'free':
      return formatCost(0, decimals);

    case 'api-key':
    default:
      return formatCost(costUsd, decimals);
  }
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a compact cost pill for mobile session / message-level cost display.
 *
 * @param props - Component props
 * @returns Inline View containing cost text and optional source badge
 *
 * @example
 * // API key session cost
 * <CostPill billingModel="api-key" costUsd={3.50} source="agent-reported" />
 *
 * @example
 * // Subscription with fraction
 * <CostPill
 *   billingModel="subscription"
 *   costUsd={0}
 *   subscriptionFractionUsed={0.42}
 *   source="agent-reported"
 * />
 */
export function CostPill({
  billingModel,
  costUsd,
  subscriptionFractionUsed,
  creditsConsumed,
  creditRateUsd,
  source,
  decimals = 2,
}: CostPillProps) {
  const displayText = formatPillCost({
    billingModel,
    costUsd,
    subscriptionFractionUsed,
    creditsConsumed,
    creditRateUsd,
    decimals,
  });

  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
      accessibilityLabel={`Cost: ${displayText}${source ? `, ${source}` : ''}`}
    >
      <Text style={{ color: '#a1a1aa', fontSize: 12 }}>{displayText}</Text>
      {source && <SourceBadge source={source} />}
    </View>
  );
}
