/**
 * NPS (Net Promoter Score) Calculation Utilities
 *
 * Pure TypeScript implementation of the NPS metric used on the founder
 * dashboard. Shared across web and mobile so the calculation is never
 * inconsistent between surfaces.
 *
 * WHY shared module: The NPS score is displayed in:
 *   1. The founder web dashboard (/dashboard/founder/feedback)
 *   2. Potentially a mobile admin screen in Phase 2
 * A single shared implementation prevents drift between surfaces, which
 * is especially important for an acquirer-facing metric.
 *
 * NPS formula:
 *   score = (promoters / total) * 100 - (detractors / total) * 100
 *   Promoters:  score >= 9
 *   Passives:   score 7-8
 *   Detractors: score 0-6
 *   Range: -100 to +100 (can be fractional)
 *
 * WHY fractional: The standard NPS calculation produces percentages of
 * each segment, then subtracts. With small sample sizes the result is
 * fractional. We round to 1 decimal for display but keep full precision
 * internally.
 *
 * @module feedback/nps
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Segments a single NPS respondent belongs to.
 *
 * - promoter: score 9-10 — enthusiastic fans who will recommend
 * - passive: score 7-8 — satisfied but unenthusiastic
 * - detractor: score 0-6 — unhappy; at risk of churn and negative word-of-mouth
 */
export type NpsSegment = 'promoter' | 'passive' | 'detractor';

/**
 * Result of calcNPS.
 */
export interface NpsResult {
  /** Number of respondents with score >= 9 */
  promoters: number;
  /** Number of respondents with score 7-8 */
  passives: number;
  /** Number of respondents with score 0-6 */
  detractors: number;
  /** Total valid respondents (excludes null / out-of-range) */
  total: number;
  /**
   * NPS score in range [-100, 100].
   * Calculated as: (promoters/total)*100 - (detractors/total)*100
   * Returns 0 when total === 0 (no responses yet).
   */
  score: number;
  /** Percentage of promoters (0-100) */
  promoterPct: number;
  /** Percentage of passives (0-100) */
  passivePct: number;
  /** Percentage of detractors (0-100) */
  detractorPct: number;
  /** Count of scores that were invalid and excluded from the calculation */
  excluded: number;
}

// ============================================================================
// Core Calculation
// ============================================================================

/**
 * Classify a single NPS score into its segment.
 *
 * Scores outside 0-10 are invalid and return null.
 *
 * @param score - Raw NPS score (expected 0-10)
 * @returns The segment, or null if the score is invalid
 *
 * @example
 * classifyNpsScore(10) // 'promoter'
 * classifyNpsScore(7)  // 'passive'
 * classifyNpsScore(3)  // 'detractor'
 * classifyNpsScore(11) // null
 */
export function classifyNpsScore(score: number): NpsSegment | null {
  // WHY explicit validation: Out-of-range scores (e.g. 11, -1) would corrupt the
  // calculation silently. We exclude them and surface the count in NpsResult.excluded.
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    return null;
  }
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

/**
 * Calculate NPS from an array of raw scores.
 *
 * Handles all edge cases:
 * - Empty input (total 0) → score 0, all segments 0
 * - All promoters → score 100
 * - All detractors → score -100
 * - Out-of-range scores → excluded, not counted in total
 * - null/undefined values → excluded
 * - NaN values → excluded
 *
 * @param scores - Array of raw NPS scores (0-10). Can include nulls.
 * @returns Full NPS breakdown with score, segments, and percentages
 *
 * @example
 * calcNPS([10, 9, 8, 7, 6, 5, 4])
 * // { promoters: 2, passives: 2, detractors: 3, total: 7, score: -14.3, ... }
 *
 * @example
 * calcNPS([]) // { promoters: 0, passives: 0, detractors: 0, total: 0, score: 0, ... }
 *
 * @example
 * calcNPS([10, 10, 10]) // { promoters: 3, score: 100, ... }
 *
 * @example
 * calcNPS([0, 0, 0]) // { detractors: 3, score: -100, ... }
 */
export function calcNPS(scores: (number | null | undefined)[]): NpsResult {
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  let excluded = 0;

  for (const raw of scores) {
    // Null / undefined checks first
    if (raw == null || typeof raw !== 'number' || !isFinite(raw)) {
      excluded++;
      continue;
    }

    const segment = classifyNpsScore(raw);
    if (segment === null) {
      excluded++;
      continue;
    }

    if (segment === 'promoter') promoters++;
    else if (segment === 'passive') passives++;
    else detractors++;
  }

  const total = promoters + passives + detractors;

  // WHY: Guard against division by zero. When no responses exist, score is 0
  // (no signal). This is correct — an NPS of 0 with 0 responses is distinct
  // from a genuine NPS of 0 (equal promoters and detractors).
  if (total === 0) {
    return {
      promoters: 0,
      passives: 0,
      detractors: 0,
      total: 0,
      score: 0,
      promoterPct: 0,
      passivePct: 0,
      detractorPct: 0,
      excluded,
    };
  }

  const promoterPct = (promoters / total) * 100;
  const passivePct = (passives / total) * 100;
  const detractorPct = (detractors / total) * 100;

  // WHY round to 1 decimal: NPS is typically displayed as a whole number or 1dp.
  // We compute full precision then round here. Downstream callers can re-round
  // for display if needed.
  const score = Math.round((promoterPct - detractorPct) * 10) / 10;

  return {
    promoters,
    passives,
    detractors,
    total,
    score,
    promoterPct: Math.round(promoterPct * 10) / 10,
    passivePct: Math.round(passivePct * 10) / 10,
    detractorPct: Math.round(detractorPct * 10) / 10,
    excluded,
  };
}

// ============================================================================
// Weekly NPS Trend Helper
// ============================================================================

/**
 * A single data point in a weekly NPS trend series.
 */
export interface NpsTrendPoint {
  /** ISO week string (YYYY-Www, e.g. "2026-W16") */
  week: string;
  /** NPS score for this week */
  score: number;
  /** Number of responses this week */
  responseCount: number;
  /** Promoter count */
  promoters: number;
  /** Passive count */
  passives: number;
  /** Detractor count */
  detractors: number;
}

/**
 * Group raw NPS responses by ISO week and compute per-week NPS.
 *
 * Used by the founder dashboard trend chart.
 *
 * @param responses - Array of {score, created_at} rows from user_feedback
 * @returns Weekly NPS trend sorted ascending by week
 *
 * @example
 * groupNpsByWeek([
 *   { score: 9, created_at: '2026-04-14T10:00:00Z' },
 *   { score: 3, created_at: '2026-04-21T10:00:00Z' },
 * ])
 * // [{ week: '2026-W16', score: 100, responseCount: 1, ... }, ...]
 */
export function groupNpsByWeek(
  responses: Array<{ score: number | null; created_at: string }>
): NpsTrendPoint[] {
  const byWeek = new Map<string, Array<number | null>>();

  for (const row of responses) {
    const week = toIsoWeek(new Date(row.created_at));
    if (!byWeek.has(week)) {
      byWeek.set(week, []);
    }
    byWeek.get(week)!.push(row.score);
  }

  const result: NpsTrendPoint[] = [];
  for (const [week, scores] of byWeek.entries()) {
    const nps = calcNPS(scores);
    result.push({
      week,
      score: nps.score,
      responseCount: nps.total,
      promoters: nps.promoters,
      passives: nps.passives,
      detractors: nps.detractors,
    });
  }

  // Sort ascending by week string (ISO week strings sort lexicographically)
  result.sort((a, b) => a.week.localeCompare(b.week));
  return result;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Convert a Date to its ISO 8601 week string (YYYY-Www).
 *
 * Uses the ISO 8601 convention where weeks start on Monday and the
 * first week contains Thursday.
 *
 * @param date - The date to convert
 * @returns ISO week string, e.g. "2026-W16"
 *
 * @example
 * toIsoWeek(new Date('2026-04-21')) // '2026-W17'
 */
export function toIsoWeek(date: Date): string {
  // WHY: getDay() returns 0 for Sunday. ISO weeks start Monday so we adjust.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // 1=Mon ... 7=Sun
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of same ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Format an NPS score for display.
 *
 * Returns a string with a +/- prefix and no decimal for scores that are
 * whole numbers, or 1 decimal for fractional scores.
 *
 * @param score - The NPS score (output of calcNPS.score)
 * @returns Formatted string, e.g. "+42", "-7.5", "0"
 *
 * @example
 * formatNpsScore(42)   // '+42'
 * formatNpsScore(-7.5) // '-7.5'
 * formatNpsScore(0)    // '0'
 */
export function formatNpsScore(score: number): string {
  if (score === 0) return '0';
  const formatted = Number.isInteger(score) ? String(score) : score.toFixed(1);
  return score > 0 ? `+${formatted}` : formatted;
}
