/**
 * BillingModelSummaryStrip
 *
 * A compact one-line header strip showing this-period totals broken out by
 * billing model:
 *
 *   "API: $12.40  |  Subscription: 47% quota  |  Credits: 430 cr ($4.30)"
 *
 * Sections are only rendered when the corresponding billing model has data,
 * keeping the strip clean for users who only use one billing model.
 *
 * WHY a separate server component: The strip consumes pre-aggregated bucket
 * data passed from the parent page (no additional fetch needed). It renders
 * zero JS on the client and stays in RSC output.
 *
 * @module app/dashboard/costs/billing-model-summary-strip
 */

import { formatCost } from '@/lib/costs';

/**
 * Props for {@link BillingModelSummaryStrip}.
 */
interface BillingModelSummaryStripProps {
  /** Total USD cost from api-key billing rows. */
  apiKeyCostUsd: number;
  /**
   * Average subscription quota fraction [0, 1] across all subscription rows.
   * Null when there are no subscription rows or none reported a fraction.
   */
  subscriptionFractionUsed: number | null;
  /** Number of subscription-billed records (used to decide whether to show the SUB bucket). */
  subscriptionRowCount: number;
  /** Total credits consumed across credit-billed records. */
  creditsConsumed: number;
  /** USD equivalent for all credit-billed records. */
  creditCostUsd: number;
  /** Selected time range in days (for the tooltip). */
  days: number;
}

/**
 * Renders the billing model summary strip.
 *
 * Each billing bucket has a distinct colour to help users instantly associate
 * "blue = API spend", "purple = subscription quota", "amber = credits":
 *   - API key → blue
 *   - Subscription → purple
 *   - Credits → amber
 *
 * @param props - Component props
 * @returns Strip element, or null when there is no data at all
 */
export function BillingModelSummaryStrip({
  apiKeyCostUsd,
  subscriptionFractionUsed,
  subscriptionRowCount,
  creditsConsumed,
  creditCostUsd,
  days,
}: BillingModelSummaryStripProps) {
  const hasApi = apiKeyCostUsd > 0;
  const hasSub = subscriptionRowCount > 0;
  const hasCredits = creditsConsumed > 0 || creditCostUsd > 0;

  // If there is nothing to show, skip the strip entirely to keep the page clean.
  if (!hasApi && !hasSub && !hasCredits) {
    return null;
  }

  return (
    <div
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border/40 bg-card/40 px-4 py-3"
      aria-label={`Billing model summary for the last ${days} days`}
    >
      <span className="text-xs font-medium text-muted-foreground shrink-0">
        Last {days}d:
      </span>

      {/* API-key bucket */}
      {hasApi && (
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-sm bg-blue-500"
            aria-hidden="true"
          />
          <span className="text-xs text-muted-foreground">API:</span>
          <span className="text-xs font-semibold text-foreground">
            {formatCost(apiKeyCostUsd, 2)}
          </span>
        </div>
      )}

      {/* Separator */}
      {hasApi && (hasSub || hasCredits) && (
        <span className="text-muted-foreground/30 text-sm select-none" aria-hidden="true">|</span>
      )}

      {/* Subscription bucket */}
      {hasSub && (
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-sm bg-purple-500"
            aria-hidden="true"
          />
          <span className="text-xs text-muted-foreground">Subscription:</span>
          <span className="text-xs font-semibold text-foreground">
            {subscriptionFractionUsed != null
              ? `${Math.round(subscriptionFractionUsed * 100)}% quota`
              : `${subscriptionRowCount} session${subscriptionRowCount !== 1 ? 's' : ''}`}
          </span>
        </div>
      )}

      {/* Separator */}
      {hasSub && hasCredits && (
        <span className="text-muted-foreground/30 text-sm select-none" aria-hidden="true">|</span>
      )}

      {/* Credit bucket */}
      {hasCredits && (
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-sm bg-amber-500"
            aria-hidden="true"
          />
          <span className="text-xs text-muted-foreground">Credits:</span>
          <span className="text-xs font-semibold text-foreground">
            {creditsConsumed > 0
              ? creditCostUsd > 0
                ? `${creditsConsumed} cr (${formatCost(creditCostUsd, 2)})`
                : `${creditsConsumed} cr`
              : formatCost(creditCostUsd, 2)}
          </span>
        </div>
      )}
    </div>
  );
}
