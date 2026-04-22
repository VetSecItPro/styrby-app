/**
 * Cost run-rate and MTD projection utilities.
 *
 * Shared between styrby-web and styrby-mobile so the same projection logic
 * drives both surfaces (parity requirement from web_mobile_parity memory).
 *
 * WHY this module exists: Projecting a 30-day run-rate from partial-month
 * actuals requires knowing the elapsed fraction of the billing period. A
 * naive `actual / dayOfMonth * 30` formula has edge cases (first day of month
 * = division by 1 instead of 0-to-1 fraction, last day = 100% elapsed).
 * Centralising the logic here ensures a single, tested implementation.
 *
 * @module cost/run-rate
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a run-rate projection calculation.
 *
 * Used by both the web Cost Analytics page and the mobile Costs screen to
 * render the "at current rate" projection bar and tier-warning card.
 */
export interface RunRateProjection {
  /**
   * Today's actual cost in USD (sum of cost_records for today).
   */
  todayActualUsd: number;

  /**
   * Month-to-date actual cost in USD (sum of cost_records since 1st of month).
   */
  mtdActualUsd: number;

  /**
   * Projected end-of-month cost in USD at the current daily run-rate.
   *
   * Formula: mtdActualUsd / elapsedDayFraction
   * Where elapsedDayFraction = (currentDayOfMonth) / daysInMonth
   *
   * WHY we use elapsed day fraction not elapsed days: The goal is "what will
   * I spend this entire month if my daily average holds?" Dividing by
   * elapsedDayFraction (which approaches 1.0 at month-end) gives the full-
   * month extrapolation, bounded so it can never exceed the actual spend
   * on the last day of the month.
   *
   * Null if elapsedDayFraction < 0.03 (less than ~1 day into the month) to
   * avoid wildly inaccurate projections on day 1.
   */
  projectedMonthUsd: number | null;

  /**
   * 30-day rolling average daily spend in USD.
   *
   * Uses actual 30-day history rather than the current month's average to
   * produce a more stable estimate for users with irregular usage patterns.
   */
  rollingDailyAvgUsd: number;

  /**
   * Days remaining in the current billing month.
   */
  daysRemainingInMonth: number;

  /**
   * Fraction of the tier's monthly cost cap that has been used (0-1).
   *
   * Null when the tier has no defined monthly cost cap (e.g. the user is
   * on the Power tier with BYOK and no Styrby-enforced cap).
   *
   * WHY: Driving a color-coded progress bar requires a normalised fraction,
   * not raw USD amounts, so the same component works for users with
   * different tier caps.
   */
  tierCapFractionUsed: number | null;

  /**
   * The tier's monthly cost cap in USD, or null if not capped.
   *
   * WHY: Surfaces in "X of $Y used" labels on the dashboard.
   */
  tierCapUsd: number | null;

  /**
   * Estimated number of days until the user hits their tier cap at the
   * current rolling daily average. Null if no cap or zero daily average.
   *
   * WHY: "You will hit your cap in 4 days" is more actionable than "you
   * are at 80% of your cap."
   */
  daysUntilCapHit: number | null;
}

// ============================================================================
// Tier cap table
// ============================================================================

/**
 * Monthly cost cap in USD per tier.
 *
 * WHY not in TIER_LIMITS: TIER_LIMITS is a feature-flag table (booleans +
 * numeric quotas). Monthly cost caps are a billing-domain concept with USD
 * values that need to stay in the cost module to avoid a circular dependency.
 *
 * Free tier has a soft cap: we warn at $5/mo to protect against runaway
 * spend on free plans. Power/Team/Business have no Styrby-enforced cap
 * because they are BYOK — the cap is whatever the user sets in budget alerts.
 */
const TIER_MONTHLY_CAP_USD: Record<string, number | null> = {
  free: 5,
  pro: 50,
  power: null,
  team: null,
  business: null,
  enterprise: null,
};

// ============================================================================
// Main calculation function
// ============================================================================

/**
 * Calculates run-rate projection metrics from cost totals and user tier.
 *
 * @param params.todayUsd - Sum of cost_usd for today (UTC date).
 * @param params.mtdUsd - Sum of cost_usd since the 1st of the current month.
 * @param params.last30DaysUsd - Sum of cost_usd for the rolling 30-day window.
 * @param params.tier - Normalised tier ID for the authenticated user.
 * @param params.nowUtc - Optional current UTC date (defaults to `new Date()`).
 *   Exposed for testing so callers can pin the date.
 * @returns {@link RunRateProjection}
 *
 * @example
 * const projection = calcRunRate({
 *   todayUsd: 1.20,
 *   mtdUsd: 12.40,
 *   last30DaysUsd: 38.50,
 *   tier: 'pro',
 * });
 * // projection.projectedMonthUsd ≈ 12.40 / (11/30) ≈ 33.82
 */
export function calcRunRate(params: {
  todayUsd: number;
  mtdUsd: number;
  last30DaysUsd: number;
  tier: string;
  nowUtc?: Date;
}): RunRateProjection {
  const { todayUsd, mtdUsd, last30DaysUsd, tier } = params;
  const now = params.nowUtc ?? new Date();

  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const daysRemainingInMonth = daysInMonth - dayOfMonth;

  // Elapsed fraction: how far through the month we are (0→1).
  // WHY: We use dayOfMonth (inclusive) as the numerator because cost data
  // for today already exists in mtdUsd. Dividing by daysInMonth gives the
  // correct fraction even on the 1st (1/28..31 ≈ 0.032..0.036).
  const elapsedFraction = dayOfMonth / daysInMonth;

  // Projection: only meaningful once we have at least ~1 day of data.
  const projectedMonthUsd =
    elapsedFraction >= 0.03 && mtdUsd > 0
      ? mtdUsd / elapsedFraction
      : null;

  // Rolling daily average: spread 30-day total across 30 days.
  const rollingDailyAvgUsd = last30DaysUsd / 30;

  // Tier cap calculations
  const tierCapUsd = TIER_MONTHLY_CAP_USD[tier] ?? null;

  let tierCapFractionUsed: number | null = null;
  let daysUntilCapHit: number | null = null;

  if (tierCapUsd !== null && tierCapUsd > 0) {
    tierCapFractionUsed = Math.min(mtdUsd / tierCapUsd, 1);

    if (rollingDailyAvgUsd > 0) {
      const remainingCapUsd = Math.max(tierCapUsd - mtdUsd, 0);
      daysUntilCapHit = remainingCapUsd / rollingDailyAvgUsd;
    }
  }

  return {
    todayActualUsd: todayUsd,
    mtdActualUsd: mtdUsd,
    projectedMonthUsd,
    rollingDailyAvgUsd,
    daysRemainingInMonth,
    tierCapFractionUsed,
    tierCapUsd,
    daysUntilCapHit,
  };
}

// ============================================================================
// Color helpers (color-band thresholds shared across web + mobile)
// ============================================================================

/**
 * Returns a semantic color band string for a cost fraction relative to a cap.
 *
 * Thresholds:
 *   < 0.6  → 'green'  (safe)
 *   < 0.8  → 'amber'  (caution)
 *   >= 0.8 → 'red'    (warning)
 *
 * WHY these thresholds: 60% is well within budget; 80% is the conventional
 * "alert" level (matching our budget-alerts default); above 80% requires
 * immediate attention. Same thresholds used by the budget-alerts UI to
 * maintain visual consistency.
 *
 * @param fraction - Value in [0, 1] representing fraction of cap used.
 * @returns 'green' | 'amber' | 'red'
 *
 * @example
 * capColorBand(0.45) // 'green'
 * capColorBand(0.75) // 'amber'
 * capColorBand(0.92) // 'red'
 */
export function capColorBand(fraction: number): 'green' | 'amber' | 'red' {
  if (fraction < 0.6) return 'green';
  if (fraction < 0.8) return 'amber';
  return 'red';
}
