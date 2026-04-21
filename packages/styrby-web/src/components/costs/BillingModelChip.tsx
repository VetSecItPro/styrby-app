/**
 * BillingModelChip — compact badge showing how a cost was billed.
 *
 * Covers all four billing models from migration 022:
 *   'api-key'      → "API"   (blue)
 *   'subscription' → "SUB"   (purple)
 *   'credit'       → "CR"    (amber)
 *   'free'         → "FREE"  (zinc)
 *
 * WHY a dedicated component: The billing-model display rule (including the
 * subscription % / credit count substitution) would otherwise be duplicated
 * across CostTable, CostsByAgentChart, and the page header strip. One place
 * to change if labels or colours change.
 *
 * @module components/costs/BillingModelChip
 */

import type { BillingModel, CostSource } from '@styrby/shared';

// ============================================================================
// Label / colour maps
// ============================================================================

/** Short label displayed inside the chip. */
export const BILLING_MODEL_LABEL: Record<BillingModel, string> = {
  'api-key': 'API',
  subscription: 'SUB',
  credit: 'CR',
  free: 'FREE',
};

/** Tailwind colour classes for each billing model. */
const BILLING_MODEL_CLASS: Record<BillingModel, string> = {
  'api-key': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  subscription: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  credit: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  free: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
};

/** Human-readable tooltip text per billing model. */
const BILLING_MODEL_TOOLTIP: Record<BillingModel, string> = {
  'api-key': 'Variable API cost — you pay per token at market rate',
  subscription: 'Flat-rate subscription — counted against quota, not variable spend',
  credit: 'Per-prompt credits — consumed from your credit balance',
  free: 'Free or local model — no direct cost',
};

// ============================================================================
// BillingModelChip
// ============================================================================

/**
 * Props for {@link BillingModelChip}.
 */
export interface BillingModelChipProps {
  /** Billing model to display. */
  billingModel: BillingModel;
  /** Additional class names for custom sizing. */
  className?: string;
}

/**
 * Compact chip showing the billing model label with colour coding.
 *
 * Includes an accessible `title` tooltip so keyboard users can understand
 * what "SUB" means without hovering.
 *
 * @param props - Component props
 * @returns Inline span element styled as a chip
 *
 * @example
 * <BillingModelChip billingModel="api-key" />
 * <BillingModelChip billingModel="subscription" />
 */
export function BillingModelChip({ billingModel, className = '' }: BillingModelChipProps) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${BILLING_MODEL_CLASS[billingModel]} ${className}`}
      title={BILLING_MODEL_TOOLTIP[billingModel]}
      aria-label={`Billing model: ${BILLING_MODEL_TOOLTIP[billingModel]}`}
    >
      {BILLING_MODEL_LABEL[billingModel]}
    </span>
  );
}

// ============================================================================
// SourceBadge
// ============================================================================

/**
 * Props for {@link SourceBadge}.
 */
export interface SourceBadgeProps {
  /** Whether cost data came from the agent or was estimated by Styrby. */
  source: CostSource;
  /** Additional class names. */
  className?: string;
}

/**
 * Small letter badge indicating cost data provenance.
 *
 * "R" = agent-reported  (green tint — high confidence)
 * "E" = Styrby estimate (amber tint — best-effort)
 *
 * WHY letter badge instead of coloured dot: Colour alone fails WCAG 1.4.1
 * (use of colour). A letter + colour combination is perceivable by people
 * with colour blindness and still compact enough for a table cell.
 *
 * @param props - Component props
 * @returns Small badge element
 *
 * @example
 * <SourceBadge source="agent-reported" />
 * <SourceBadge source="styrby-estimate" />
 */
export function SourceBadge({ source, className = '' }: SourceBadgeProps) {
  const isReported = source === 'agent-reported';
  const label = isReported ? 'R' : 'E';
  const tooltip = isReported
    ? 'Agent-reported: cost came directly from the agent output'
    : 'Styrby estimate: cost was calculated from token counts';
  const colourClass = isReported
    ? 'bg-green-500/10 text-green-400 border-green-500/20'
    : 'bg-amber-500/10 text-amber-400 border-amber-500/20';

  return (
    <span
      className={`inline-flex items-center rounded border px-1 py-0.5 text-[10px] font-bold ${colourClass} ${className}`}
      title={tooltip}
      aria-label={tooltip}
    >
      {label}
    </span>
  );
}
