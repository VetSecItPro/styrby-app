/**
 * Cost forecasting utilities for Phase 3.4 — Predictive Spend Forecasting.
 *
 * Pure-math module with no DB calls. Accepts a user's daily cost series for
 * the last 30 days (integer cents) and the tier quota, then produces
 * short-range forecasts and exhaustion predictions.
 *
 * WHY pure module: Keeping all projection math here — away from DB queries
 * and React — means the same vetted, tested logic drives the web dashboard,
 * the mobile Costs screen, and the nightly pg_cron predictive alert job.
 * Any change to the model is automatically reflected everywhere.
 *
 * WHY integer cents throughout:
 * JavaScript doubles lose precision above 2^53. Working in integer cents
 * (100x USD) keeps all values well within the safe integer range for any
 * realistic user spend amount and avoids 0.1 + 0.2 rounding issues in
 * comparisons used by alert idempotency logic.
 *
 * Audit citations:
 *   SOC2 CC7.2 — System monitoring / cost accounting accuracy
 *   GDPR Art. 5(1)(a) — Accuracy principle
 *
 * @module cost-forecast/forecast
 */

// ============================================================================
// Types
// ============================================================================

/**
 * A single day's cost data for the forecast input series.
 *
 * WHY date string not Date object: ISO strings survive JSON.stringify/parse
 * across the relay channel and Supabase REST boundary without timezone drift.
 */
export interface DailyCostPoint {
  /**
   * UTC calendar date in YYYY-MM-DD format.
   * Must be unique within the series passed to forecast functions.
   */
  date: string;

  /**
   * Total cost in integer cents for this calendar day.
   * Must be >= 0 and a safe integer.
   */
  costCents: number;
}

/**
 * Full forecasting result produced by {@link computeForecast}.
 *
 * All monetary values are integer cents. Callers display them as
 * `(value / 100).toFixed(2)` for USD formatting.
 */
export interface CostForecast {
  /**
   * Arithmetic mean daily spend over the full input series (up to 30 days).
   * Zero when the series is empty or all-zero.
   */
  dailyAverageCents: number;

  /**
   * Arithmetic mean daily spend over the last 7 days of the series.
   * Zero when the series has fewer than 1 day.
   *
   * WHY 7-day window: Catches recent acceleration (e.g. a new project started
   * this week) that the 30-day average would dilute. Weighting both gives a
   * balance between stability and responsiveness.
   */
  trailingWeekAverageCents: number;

  /**
   * Projected daily spend in cents at a given future horizon (in days).
   *
   * Computed as an exponential moving-average (EMA) blend:
   *   weightedForecastCents = alpha * trailingWeekAvg + (1 - alpha) * dailyAvg
   *   where alpha = 0.3
   *
   * WHY EMA blend over raw 7-day avg: Pure 7-day averages are noisy for users
   * with irregular usage (e.g. heavy on weekends). The 30-day floor smooths
   * the estimate while still reacting to genuine acceleration. Alpha = 0.3 is
   * the classic short-range EMA weight used in demand forecasting.
   *
   * Keys: 7, 14, 30 — the number of days forward being projected.
   * Values: projected total cost in cents over that horizon.
   */
  weightedForecastCents: {
    '7d': number;
    '14d': number;
    '30d': number;
  };

  /**
   * ISO 8601 date string on which the user is predicted to exhaust their quota,
   * or null if:
   *   - quota is not applicable (null quotaCents)
   *   - daily burn rate is zero (would never exhaust)
   *   - remaining quota is already exhausted (elapsedCents >= quotaCents)
   *
   * Computed from the remaining quota and the weighted daily burn rate.
   */
  predictedExhaustionDate: string | null;

  /**
   * True when the 7-day average exceeds the 30-day average by more than 15%.
   *
   * WHY 15% threshold: Small fluctuations (< 15%) are within normal variance
   * for irregular usage. > 15% sustained over a week signals a genuine change
   * in behavior worth surfacing to the user (e.g. "burn rate up 23%").
   */
  isBurnAccelerating: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * EMA blend factor (alpha) applied to the trailing-week average.
 *
 * weightedDailyRate = alpha * trailingWeekAvg + (1 - alpha) * dailyAvg
 *
 * WHY 0.3: Classic short-range EMA weight. Higher values (e.g. 0.5) react
 * too aggressively to single-week spikes; lower values (e.g. 0.1) make the
 * trailing-week average nearly invisible in the blend.
 */
const EMA_ALPHA = 0.3;

/**
 * Acceleration threshold: 7-day avg must exceed 30-day avg by more than this
 * fraction to set isBurnAccelerating = true.
 *
 * WHY 0.15: Corresponds to 15% above the 30-day baseline. See {@link CostForecast.isBurnAccelerating}.
 */
const ACCELERATION_THRESHOLD = 0.15;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Guards against NaN and Infinity in a computed value, replacing them with 0.
 *
 * WHY: Division-by-zero and empty-series edge cases both produce NaN/Infinity.
 * Propagating these to the UI produces blank cards or JS console errors.
 * Clamping to 0 is always safer for the forecast context (no spend predicted).
 *
 * @param value - The computed value to guard.
 * @returns The value itself, or 0 if it is NaN or Infinity.
 */
function safeInt(value: number): number {
  if (!isFinite(value) || isNaN(value)) return 0;
  return Math.round(value);
}

/**
 * Adds a number of days to a Date and returns an ISO 8601 date string.
 *
 * @param baseDate - Starting date.
 * @param days - Number of days to add (must be >= 0).
 * @returns ISO 8601 date string in YYYY-MM-DD format.
 */
function addDays(baseDate: Date, days: number): string {
  const d = new Date(baseDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Computes the arithmetic mean daily spend in integer cents.
 *
 * @param series - Daily cost data points (order does not matter).
 * @returns Mean daily cost in integer cents, or 0 for empty/all-zero series.
 *
 * @example
 * dailyAverageCents([{ date: '2026-04-01', costCents: 100 }, { date: '2026-04-02', costCents: 200 }])
 * // => 150
 */
export function dailyAverageCents(series: DailyCostPoint[]): number {
  if (series.length === 0) return 0;
  const total = series.reduce((sum, d) => sum + d.costCents, 0);
  return safeInt(total / series.length);
}

/**
 * Computes the arithmetic mean daily spend over the last 7 days of the series.
 *
 * "Last 7 days" is determined by sorting the series descending by date and
 * taking the first 7 entries. This is robust to gaps in the series (e.g. if
 * the user had zero spend on some days that were omitted from the input).
 *
 * @param series - Daily cost data points (any order accepted).
 * @returns Trailing-week mean daily cost in integer cents, or 0 for empty series.
 *
 * @example
 * const pts = Array.from({ length: 14 }, (_, i) => ({
 *   date: `2026-04-${String(i + 1).padStart(2, '0')}`,
 *   costCents: (i + 1) * 10,
 * }));
 * trailingWeekAverageCents(pts); // mean of days 8-14: 85
 */
export function trailingWeekAverageCents(series: DailyCostPoint[]): number {
  if (series.length === 0) return 0;
  const sorted = [...series].sort((a, b) => b.date.localeCompare(a.date));
  const last7 = sorted.slice(0, 7);
  const total = last7.reduce((sum, d) => sum + d.costCents, 0);
  return safeInt(total / last7.length);
}

/**
 * Computes the EMA-blended projected daily cost rate in integer cents.
 *
 * Formula: alpha * trailingWeekAvg + (1 - alpha) * dailyAvg
 * where alpha = {@link EMA_ALPHA} (0.3).
 *
 * This function returns the blended DAILY rate. To get a horizon forecast,
 * multiply by the number of days.
 *
 * @param avgCents - 30-day arithmetic mean daily cost (integer cents).
 * @param weekAvgCents - 7-day trailing mean daily cost (integer cents).
 * @returns Blended daily cost estimate in integer cents.
 *
 * @example
 * weightedDailyRate(100, 150); // 0.3 * 150 + 0.7 * 100 = 45 + 70 = 115
 */
export function weightedDailyRate(avgCents: number, weekAvgCents: number): number {
  return safeInt(EMA_ALPHA * weekAvgCents + (1 - EMA_ALPHA) * avgCents);
}

/**
 * Predicts the calendar date on which the user will exhaust their quota.
 *
 * Computation:
 *   remainingCents = quotaCents - elapsedCents
 *   daysUntilExhaustion = remainingCents / dailyRateCents
 *   exhaustionDate = today + ceil(daysUntilExhaustion)
 *
 * Returns null when:
 *   - quotaCents is null (no quota)
 *   - elapsedCents >= quotaCents (already exhausted)
 *   - dailyRateCents <= 0 (zero burn, would never exhaust)
 *
 * WHY ceil not floor: We want to show the LAST safe day, not the day
 * exhaustion is reached. ceil(2.1) = 3 means "you're safe for 3 more days".
 *
 * @param params.quotaCents - Monthly quota in integer cents, or null if uncapped.
 * @param params.elapsedCents - Amount already consumed this period, in integer cents.
 * @param params.dailyRateCents - Current daily burn rate in integer cents.
 * @param params.nowUtc - Reference date for adding days (defaults to new Date()).
 * @returns ISO date string for predicted exhaustion, or null.
 *
 * @example
 * predictedExhaustionDate({ quotaCents: 5000, elapsedCents: 3000, dailyRateCents: 200 })
 * // => ISO date 10 days from today (ceil(2000/200) = 10)
 */
export function predictedExhaustionDate(params: {
  quotaCents: number | null;
  elapsedCents: number;
  dailyRateCents: number;
  nowUtc?: Date;
}): string | null {
  const { quotaCents, elapsedCents, dailyRateCents } = params;
  const now = params.nowUtc ?? new Date();

  // No quota configured — no exhaustion possible.
  if (quotaCents === null) return null;

  // Already exhausted.
  if (elapsedCents >= quotaCents) return null;

  // Zero burn rate — would never exhaust at this pace.
  if (dailyRateCents <= 0) return null;

  const remainingCents = quotaCents - elapsedCents;
  const daysUntil = remainingCents / dailyRateCents;

  // Guard against Infinity/NaN before using Math.ceil.
  if (!isFinite(daysUntil) || isNaN(daysUntil)) return null;

  const daysRounded = Math.ceil(daysUntil);
  return addDays(now, daysRounded);
}

/**
 * Returns true when recent (7-day) burn exceeds the 30-day baseline by more
 * than {@link ACCELERATION_THRESHOLD} (15%).
 *
 * @param avgCents - 30-day arithmetic mean daily cost (integer cents).
 * @param weekAvgCents - 7-day trailing mean daily cost (integer cents).
 * @returns True if burn is accelerating.
 *
 * @example
 * isBurnAccelerating(100, 120); // 20% above baseline → true
 * isBurnAccelerating(100, 114); // 14% above baseline → false
 */
export function isBurnAccelerating(avgCents: number, weekAvgCents: number): boolean {
  if (avgCents <= 0) return false;
  return weekAvgCents > avgCents * (1 + ACCELERATION_THRESHOLD);
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * Computes the full cost forecast from a daily spend series and quota context.
 *
 * This is the primary entry point for consumers. It calls all individual
 * forecast functions and returns a complete {@link CostForecast} object.
 *
 * @param params.series - Daily cost data for the last 30 days (order-independent).
 *   Can contain fewer than 30 points (e.g. new users). All costCents must be
 *   non-negative integers.
 * @param params.quotaCents - Monthly quota ceiling in integer cents, or null if
 *   the user's tier has no cap (Power/Team/Business/Enterprise BYOK tiers).
 * @param params.elapsedCents - Amount already consumed this billing period
 *   in integer cents. Must be >= 0.
 * @param params.nowUtc - Optional reference date. Defaults to new Date().
 *   Inject in tests to pin the clock.
 * @returns {@link CostForecast}
 *
 * @throws Never — all edge cases (empty series, zero spend, null quota) are
 *   handled gracefully with zero values or null.
 *
 * @example
 * const series = [
 *   { date: '2026-04-01', costCents: 120 },
 *   { date: '2026-04-02', costCents: 95 },
 *   // ...28 more days
 * ];
 * const forecast = computeForecast({
 *   series,
 *   quotaCents: 500_00, // $500 tier cap
 *   elapsedCents: 120,  // $1.20 spent so far
 * });
 * console.log(forecast.predictedExhaustionDate); // e.g. "2026-05-18"
 */
export function computeForecast(params: {
  series: DailyCostPoint[];
  quotaCents: number | null;
  elapsedCents: number;
  nowUtc?: Date;
}): CostForecast {
  const { series, quotaCents, elapsedCents } = params;
  const now = params.nowUtc ?? new Date();

  const avg = dailyAverageCents(series);
  const weekAvg = trailingWeekAverageCents(series);
  const dailyRate = weightedDailyRate(avg, weekAvg);

  const forecast: CostForecast = {
    dailyAverageCents: avg,
    trailingWeekAverageCents: weekAvg,
    weightedForecastCents: {
      '7d': safeInt(dailyRate * 7),
      '14d': safeInt(dailyRate * 14),
      '30d': safeInt(dailyRate * 30),
    },
    predictedExhaustionDate: predictedExhaustionDate({
      quotaCents,
      elapsedCents,
      dailyRateCents: dailyRate,
      nowUtc: now,
    }),
    isBurnAccelerating: isBurnAccelerating(avg, weekAvg),
  };

  return forecast;
}
