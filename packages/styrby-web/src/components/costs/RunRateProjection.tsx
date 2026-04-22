/**
 * RunRateProjection — "At current burn rate you'll hit your cap on Oct 28."
 *
 * WHY: Premium users need forward-looking cost awareness, not just historical.
 * Showing "12 days until cap" is far more actionable than showing "you've spent $37".
 *
 * Algorithm:
 *   avgDailySpend = sum(last-7d spend) / 7
 *   daysUntilCap  = (monthlyCap - monthToDateSpend) / avgDailySpend
 *   capDate       = today + daysUntilCap
 *
 * Subscription variant: express as "at this pace you'll use 95% of your
 * Claude Max quota" when billingModel is 'subscription'.
 *
 * Hide entirely when:
 *   - fewer than 3 days of history data (not enough signal)
 *   - avgDailySpend === 0 (user hasn't spent anything recently)
 *   - no tier cap configured
 *
 * @module components/costs/RunRateProjection
 */

import type { BillingModel } from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for {@link RunRateProjection}.
 */
export interface RunRateProjectionProps {
  /**
   * Sum of cost_usd over the last 7 calendar days.
   * Must be exactly 7 days of data; pass null if insufficient history.
   */
  last7dSpendUsd: number | null;

  /**
   * Number of distinct calendar days with at least one record in the last 7d.
   * Used to gate the projection — hide if < 3.
   */
  historyDays: number;

  /** Month-to-date spend in USD (resets on the 1st of each month). */
  monthToDateSpendUsd: number;

  /**
   * Monthly cap in USD. Null when the user has no configured cap
   * (e.g., free-tier users with no budget alert, Power users who removed alerts).
   */
  monthlyCap: number | null;

  /**
   * Dominant billing model for the current period.
   * When 'subscription', the copy switches to quota-fraction language.
   */
  billingModel: BillingModel;

  /**
   * Average subscription quota fraction used per day over the last 7 days.
   * Only meaningful when billingModel === 'subscription'. Range [0, 1] per day.
   */
  avgDailySubscriptionFraction?: number | null;

  /**
   * Total subscription quota (1.0 = 100%). Used to project "at this pace you'll
   * use X% of your quota this month."
   */
  subscriptionQuota?: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats an ordinal day suffix (1st, 2nd, 3rd, 4th...).
 *
 * @param day - Day of month (1-31)
 * @returns Ordinal string, e.g. "21st"
 */
function ordinal(day: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = day % 100;
  return day + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/**
 * Format a future date as "Mon DD" (e.g. "Oct 28").
 *
 * @param date - Target date
 * @returns Short month + ordinal day string
 */
function formatCapDate(date: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[date.getMonth()]} ${ordinal(date.getDate())}`;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a run-rate projection banner at the top of the cost dashboard.
 *
 * Shows nothing when insufficient data or no cap is set.
 *
 * @example
 * <RunRateProjection
 *   last7dSpendUsd={21.40}
 *   historyDays={7}
 *   monthToDateSpendUsd={37.00}
 *   monthlyCap={49.00}
 *   billingModel="api-key"
 * />
 */
export function RunRateProjection({
  last7dSpendUsd,
  historyDays,
  monthToDateSpendUsd,
  monthlyCap,
  billingModel,
  avgDailySubscriptionFraction,
  subscriptionQuota,
}: RunRateProjectionProps) {
  // ── Gate: need at least 3 days of history ──────────────────────────────────
  // WHY: With fewer than 3 data points, a daily average is too noisy to be
  // useful. A single heavy-usage day would project a misleading cap date.
  if (historyDays < 3) return null;
  if (last7dSpendUsd === null) return null;

  const avgDailySpend = last7dSpendUsd / 7;

  // ── Subscription variant ───────────────────────────────────────────────────
  if (billingModel === 'subscription') {
    if (
      avgDailySubscriptionFraction == null ||
      avgDailySubscriptionFraction <= 0 ||
      subscriptionQuota == null
    ) {
      return null;
    }

    // Remaining days in month
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const remainingDays = daysInMonth - now.getDate() + 1;

    const projectedFractionUsed = avgDailySubscriptionFraction * remainingDays;
    const projectedPct = Math.min(Math.round(projectedFractionUsed * subscriptionQuota * 100), 200);

    if (projectedPct < 50) return null; // Not interesting below 50%

    const isWarning = projectedPct >= 90;

    return (
      <div
        className={`mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
          isWarning
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
            : 'border-blue-500/20 bg-blue-500/5 text-blue-300'
        }`}
        role="status"
        aria-label="Subscription quota run rate"
      >
        {/* Icon */}
        <svg
          className="h-4 w-4 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d={isWarning
              ? 'M12 9v2m0 4h.01M12 3C6.48 3 2 7.48 2 12s4.48 9 10 9 10-4.48 10-9S17.52 3 12 3z'
              : 'M13 16h-1v-4h-1m1-4h.01M12 3C6.48 3 2 7.48 2 12s4.48 9 10 9 10-4.48 10-9S17.52 3 12 3z'
            }
          />
        </svg>
        <span>
          At this pace you&apos;ll use approximately{' '}
          <strong>{projectedPct}%</strong> of your subscription quota this month.
        </span>
      </div>
    );
  }

  // ── API-key / credit / free variant ───────────────────────────────────────
  // Gate: no cap configured → nothing to project
  if (!monthlyCap || monthlyCap <= 0) return null;
  // Gate: no daily spend → nothing to project
  if (avgDailySpend <= 0) return null;

  const remaining = monthlyCap - monthToDateSpendUsd;
  if (remaining <= 0) {
    // Already over cap — show "you've exceeded your cap"
    return (
      <div
        className="mb-4 flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        role="alert"
        aria-label="Monthly cap exceeded"
      >
        <svg
          className="h-4 w-4 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
        <span>
          You&apos;ve exceeded your monthly cap of{' '}
          <strong>${monthlyCap.toFixed(2)}</strong>. Current spend:{' '}
          <strong>${monthToDateSpendUsd.toFixed(2)}</strong>.
        </span>
      </div>
    );
  }

  const daysUntilCap = remaining / avgDailySpend;
  const capDate = new Date();
  capDate.setDate(capDate.getDate() + Math.round(daysUntilCap));
  const daysRounded = Math.round(daysUntilCap);

  // Only show when cap is within 45 days — beyond that it's not useful
  if (daysRounded > 45) return null;

  const isUrgent = daysRounded <= 7;
  const isMedium = daysRounded <= 14;

  const colourClass = isUrgent
    ? 'border-red-500/30 bg-red-500/10 text-red-300'
    : isMedium
    ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
    : 'border-blue-500/20 bg-blue-500/5 text-blue-300';

  return (
    <div
      className={`mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${colourClass}`}
      role="status"
      aria-label="Monthly spending run rate projection"
    >
      {/* Trend icon */}
      <svg
        className="h-4 w-4 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
        />
      </svg>
      <span>
        At current burn rate, you&apos;ll hit your monthly cap on{' '}
        <strong>{formatCapDate(capDate)}</strong> ({daysRounded}{' '}
        {daysRounded === 1 ? 'day' : 'days'} from now). Avg daily spend:{' '}
        <strong>${avgDailySpend.toFixed(2)}</strong>.
      </span>
    </div>
  );
}
