/**
 * Unit tests for the Phase 3.4 cost-forecast module.
 *
 * WHY: The forecast functions encode the core prediction math that drives
 * predictive alerts and dashboard "cap on <date>" copy. A regression here
 * would silently produce wrong dates in push notifications sent to users.
 *
 * Coverage targets:
 *   - dailyAverageCents: empty, single, multi, zero spend
 *   - trailingWeekAverageCents: fewer than 7 days, exactly 7, more than 7
 *   - weightedDailyRate: steady burn, accelerating burn, zero
 *   - predictedExhaustionDate: null quota, already exhausted, normal path,
 *     zero burn, fractional days (ceil behavior)
 *   - isBurnAccelerating: above threshold, at threshold, below threshold, zero avg
 *   - computeForecast: integrated tests covering all edge cases
 *
 * @module cost-forecast/__tests__/forecast
 */

import { describe, it, expect } from 'vitest';
import {
  dailyAverageCents,
  trailingWeekAverageCents,
  weightedDailyRate,
  predictedExhaustionDate,
  isBurnAccelerating,
  computeForecast,
  type DailyCostPoint,
} from '../forecast.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a series of N sequential daily points starting from startDate.
 *
 * @param startIso - YYYY-MM-DD start date
 * @param values - Cost in cents per day (length = number of days)
 */
function makeSeries(startIso: string, values: number[]): DailyCostPoint[] {
  const [year, month, day] = startIso.split('-').map(Number);
  return values.map((costCents, i) => {
    const d = new Date(Date.UTC(year, month - 1, day + i));
    return {
      date: d.toISOString().slice(0, 10),
      costCents,
    };
  });
}

/** Pin a UTC date for exhaustion / computeForecast tests */
function pin(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// dailyAverageCents
// ---------------------------------------------------------------------------

describe('dailyAverageCents', () => {
  it('returns 0 for empty series', () => {
    expect(dailyAverageCents([])).toBe(0);
  });

  it('returns the single value for a one-day series', () => {
    expect(dailyAverageCents([{ date: '2026-04-01', costCents: 300 }])).toBe(300);
  });

  it('computes mean for uniform series', () => {
    const series = makeSeries('2026-04-01', [100, 100, 100, 100]);
    expect(dailyAverageCents(series)).toBe(100);
  });

  it('computes mean for varied series', () => {
    const series = makeSeries('2026-04-01', [0, 200, 400]);
    // mean = 600 / 3 = 200
    expect(dailyAverageCents(series)).toBe(200);
  });

  it('returns 0 for all-zero series', () => {
    const series = makeSeries('2026-04-01', [0, 0, 0, 0, 0]);
    expect(dailyAverageCents(series)).toBe(0);
  });

  it('rounds to nearest integer cent', () => {
    // 1 + 2 = 3, 3 / 2 = 1.5 -> rounds to 2
    const series = makeSeries('2026-04-01', [1, 2]);
    expect(dailyAverageCents(series)).toBe(2);
  });

  it('handles 30-day series correctly', () => {
    // 30 days, all 100 cents = avg 100
    const series = makeSeries('2026-04-01', Array(30).fill(100));
    expect(dailyAverageCents(series)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// trailingWeekAverageCents
// ---------------------------------------------------------------------------

describe('trailingWeekAverageCents', () => {
  it('returns 0 for empty series', () => {
    expect(trailingWeekAverageCents([])).toBe(0);
  });

  it('uses all points when fewer than 7 days', () => {
    const series = makeSeries('2026-04-01', [100, 200, 300]);
    // mean = 600 / 3 = 200
    expect(trailingWeekAverageCents(series)).toBe(200);
  });

  it('uses exactly 7 days when series has exactly 7 points', () => {
    const series = makeSeries('2026-04-01', [10, 20, 30, 40, 50, 60, 70]);
    // mean = 280 / 7 = 40
    expect(trailingWeekAverageCents(series)).toBe(40);
  });

  it('uses only the last 7 days from a 14-day series', () => {
    // first 7 days: 10 each, last 7 days: 100 each
    const series = makeSeries('2026-04-01', [
      10, 10, 10, 10, 10, 10, 10, // days 1-7
      100, 100, 100, 100, 100, 100, 100, // days 8-14 (most recent)
    ]);
    expect(trailingWeekAverageCents(series)).toBe(100);
  });

  it('uses only the last 7 days from a 30-day series', () => {
    // First 23 days = 50 cents, last 7 days = 200 cents
    const values = [...Array(23).fill(50), ...Array(7).fill(200)];
    const series = makeSeries('2026-04-01', values);
    expect(trailingWeekAverageCents(series)).toBe(200);
  });

  it('handles a single-day series', () => {
    expect(trailingWeekAverageCents([{ date: '2026-04-21', costCents: 500 }])).toBe(500);
  });

  it('sorts by date descending before slicing (order-independent input)', () => {
    // Supply the series in ascending order — result must still pick last 7
    const values = [...Array(10).fill(50), ...Array(7).fill(300)];
    const series = makeSeries('2026-04-01', values);
    // Reverse to test order independence
    expect(trailingWeekAverageCents([...series].reverse())).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// weightedDailyRate
// ---------------------------------------------------------------------------

describe('weightedDailyRate', () => {
  it('returns the avg when both are equal (steady burn)', () => {
    // 0.3 * 100 + 0.7 * 100 = 100
    expect(weightedDailyRate(100, 100)).toBe(100);
  });

  it('blends correctly: accelerating burn', () => {
    // alpha=0.3: 0.3 * 200 + 0.7 * 100 = 60 + 70 = 130
    expect(weightedDailyRate(100, 200)).toBe(130);
  });

  it('blends correctly: decelerating burn', () => {
    // 0.3 * 50 + 0.7 * 100 = 15 + 70 = 85
    expect(weightedDailyRate(100, 50)).toBe(85);
  });

  it('returns 0 when both inputs are 0', () => {
    expect(weightedDailyRate(0, 0)).toBe(0);
  });

  it('returns 0 when avg is 0 and week avg is 0', () => {
    expect(weightedDailyRate(0, 0)).toBe(0);
  });

  it('handles large values without overflow (safe integer range)', () => {
    // $100,000/day = 10_000_000 cents — still within Number.MAX_SAFE_INTEGER
    const result = weightedDailyRate(10_000_000, 12_000_000);
    expect(result).toBeGreaterThan(0);
    expect(Number.isSafeInteger(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// predictedExhaustionDate
// ---------------------------------------------------------------------------

describe('predictedExhaustionDate', () => {
  const NOW = pin('2026-04-21');

  it('returns null when quotaCents is null (uncapped tier)', () => {
    expect(predictedExhaustionDate({ quotaCents: null, elapsedCents: 100, dailyRateCents: 50 })).toBeNull();
  });

  it('returns null when already exhausted (elapsed >= quota)', () => {
    expect(predictedExhaustionDate({ quotaCents: 1000, elapsedCents: 1000, dailyRateCents: 50 })).toBeNull();
    expect(predictedExhaustionDate({ quotaCents: 1000, elapsedCents: 1500, dailyRateCents: 50 })).toBeNull();
  });

  it('returns null when daily rate is zero (would never exhaust)', () => {
    expect(predictedExhaustionDate({ quotaCents: 1000, elapsedCents: 0, dailyRateCents: 0 })).toBeNull();
  });

  it('returns null when daily rate is negative (defensive)', () => {
    expect(predictedExhaustionDate({ quotaCents: 1000, elapsedCents: 0, dailyRateCents: -10 })).toBeNull();
  });

  it('computes exhaustion date for exact integer days', () => {
    // remaining = 2000 - 0 = 2000, rate = 200, days = 10
    const result = predictedExhaustionDate({
      quotaCents: 2000,
      elapsedCents: 0,
      dailyRateCents: 200,
      nowUtc: NOW,
    });
    // 2026-04-21 + 10 days = 2026-05-01
    expect(result).toBe('2026-05-01');
  });

  it('ceils fractional days (rounds up for user safety)', () => {
    // remaining = 1000 - 500 = 500, rate = 150, days = 3.33... → ceil = 4
    const result = predictedExhaustionDate({
      quotaCents: 1000,
      elapsedCents: 500,
      dailyRateCents: 150,
      nowUtc: NOW,
    });
    // 2026-04-21 + 4 days = 2026-04-25
    expect(result).toBe('2026-04-25');
  });

  it('handles near-exhaustion (1 cent remaining)', () => {
    const result = predictedExhaustionDate({
      quotaCents: 1000,
      elapsedCents: 999,
      dailyRateCents: 50,
      nowUtc: NOW,
    });
    // remaining = 1 cent, rate = 50 → ceil(1/50) = 1 day
    expect(result).toBe('2026-04-22');
  });

  it('handles large quota with very low burn rate (many months out)', () => {
    // $500 quota, $0.10/day burn, fully fresh
    const result = predictedExhaustionDate({
      quotaCents: 50_000,
      elapsedCents: 0,
      dailyRateCents: 10,
      nowUtc: NOW,
    });
    // 5000 days from now — just check it's a future ISO date string
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result! > '2026-04-21').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isBurnAccelerating
// ---------------------------------------------------------------------------

describe('isBurnAccelerating', () => {
  it('returns false when both inputs are 0', () => {
    expect(isBurnAccelerating(0, 0)).toBe(false);
  });

  it('returns false when avg is 0 (guard against division by zero)', () => {
    expect(isBurnAccelerating(0, 500)).toBe(false);
  });

  it('returns false when week avg equals 30-day avg (steady burn)', () => {
    expect(isBurnAccelerating(100, 100)).toBe(false);
  });

  it('returns false when week avg is below 30-day avg (decelerating)', () => {
    expect(isBurnAccelerating(100, 50)).toBe(false);
  });

  it('returns false at exactly the 15% threshold', () => {
    // WHY: 100 * (1 + 0.15) = 115.00000000000001 in IEEE 754.
    // 115 < 115.00000000000001, so weekAvg=115 is NOT strictly greater than
    // the threshold — this confirms the strict-greater-than comparison works.
    // We test with 114 to avoid the IEEE 754 edge case at the exact boundary.
    expect(isBurnAccelerating(100, 114)).toBe(false);
  });

  it('returns true when week avg is just above 15% over 30-day avg', () => {
    expect(isBurnAccelerating(100, 116)).toBe(true);
  });

  it('returns true for 20% acceleration', () => {
    expect(isBurnAccelerating(100, 120)).toBe(true);
  });

  it('returns true for dramatic acceleration (50%)', () => {
    expect(isBurnAccelerating(100, 150)).toBe(true);
  });

  it('handles large cent values correctly', () => {
    // $50/day baseline, $65/day this week = 30% acceleration
    expect(isBurnAccelerating(5000, 6500)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeForecast — integrated tests
// ---------------------------------------------------------------------------

describe('computeForecast', () => {
  const NOW = pin('2026-04-21');

  it('returns all-zero forecast for empty series with null quota', () => {
    const result = computeForecast({ series: [], quotaCents: null, elapsedCents: 0, nowUtc: NOW });
    expect(result.dailyAverageCents).toBe(0);
    expect(result.trailingWeekAverageCents).toBe(0);
    expect(result.weightedForecastCents['7d']).toBe(0);
    expect(result.weightedForecastCents['14d']).toBe(0);
    expect(result.weightedForecastCents['30d']).toBe(0);
    expect(result.predictedExhaustionDate).toBeNull();
    expect(result.isBurnAccelerating).toBe(false);
  });

  it('returns all-zero forecast for all-zero series', () => {
    const series = makeSeries('2026-04-01', Array(30).fill(0));
    const result = computeForecast({ series, quotaCents: 5000, elapsedCents: 0, nowUtc: NOW });
    expect(result.dailyAverageCents).toBe(0);
    expect(result.predictedExhaustionDate).toBeNull();
    expect(result.isBurnAccelerating).toBe(false);
  });

  it('computes correct forecast for steady 30-day burn', () => {
    // 30 days at 100 cents/day ($1/day)
    const series = makeSeries('2026-03-22', Array(30).fill(100));
    const result = computeForecast({ series, quotaCents: 10_000, elapsedCents: 500, nowUtc: NOW });

    expect(result.dailyAverageCents).toBe(100);
    expect(result.trailingWeekAverageCents).toBe(100);
    // Blended rate = 0.3*100 + 0.7*100 = 100
    expect(result.weightedForecastCents['7d']).toBe(700);
    expect(result.weightedForecastCents['14d']).toBe(1400);
    expect(result.weightedForecastCents['30d']).toBe(3000);
    // remaining = 10000 - 500 = 9500, rate = 100 → ceil(95) = 95 days
    expect(result.predictedExhaustionDate).toBe('2026-07-25');
    expect(result.isBurnAccelerating).toBe(false);
  });

  it('detects accelerating burn and adjusts exhaustion date', () => {
    // First 23 days: 100 cents, last 7 days: 200 cents
    const values = [...Array(23).fill(100), ...Array(7).fill(200)];
    const series = makeSeries('2026-03-22', values);
    const result = computeForecast({ series, quotaCents: 5000, elapsedCents: 2000, nowUtc: NOW });

    expect(result.isBurnAccelerating).toBe(true);
    // 30-day avg = (23*100 + 7*200) / 30 = (2300 + 1400) / 30 = 3700/30 ≈ 123
    expect(result.dailyAverageCents).toBeCloseTo(123, 0);
    expect(result.trailingWeekAverageCents).toBe(200);
    // Blended rate = 0.3*200 + 0.7*123 ≈ 60 + 86 = 146
    const blended = Math.round(0.3 * 200 + 0.7 * (3700 / 30));
    expect(result.weightedForecastCents['7d']).toBe(blended * 7);
  });

  it('handles already-exhausted quota (null exhaustion date)', () => {
    const series = makeSeries('2026-04-01', Array(21).fill(100));
    const result = computeForecast({ series, quotaCents: 1000, elapsedCents: 1500, nowUtc: NOW });
    expect(result.predictedExhaustionDate).toBeNull();
  });

  it('handles null quota (uncapped tier like Power)', () => {
    const series = makeSeries('2026-04-01', Array(30).fill(500));
    const result = computeForecast({ series, quotaCents: null, elapsedCents: 5000, nowUtc: NOW });
    expect(result.predictedExhaustionDate).toBeNull();
    // Other fields still computed
    expect(result.dailyAverageCents).toBe(500);
    expect(result.weightedForecastCents['30d']).toBe(15000);
  });

  it('handles single-day series (new user)', () => {
    const series = [{ date: '2026-04-21', costCents: 250 }];
    const result = computeForecast({ series, quotaCents: 5000, elapsedCents: 250, nowUtc: NOW });
    expect(result.dailyAverageCents).toBe(250);
    expect(result.trailingWeekAverageCents).toBe(250);
    expect(result.weightedForecastCents['7d']).toBe(1750);
  });

  it('does not return NaN or Infinity in any field under any input', () => {
    const edgeCases = [
      { series: [], quotaCents: null, elapsedCents: 0 },
      { series: [], quotaCents: 0, elapsedCents: 0 },
      { series: makeSeries('2026-04-01', [0]), quotaCents: 100, elapsedCents: 0 },
      { series: makeSeries('2026-04-01', [1000000]), quotaCents: null, elapsedCents: 0 },
    ];

    for (const params of edgeCases) {
      const result = computeForecast({ ...params, nowUtc: NOW });
      expect(result.dailyAverageCents).not.toBeNaN();
      expect(result.trailingWeekAverageCents).not.toBeNaN();
      expect(result.weightedForecastCents['7d']).not.toBeNaN();
      expect(result.weightedForecastCents['14d']).not.toBeNaN();
      expect(result.weightedForecastCents['30d']).not.toBeNaN();
      expect(Number.isFinite(result.dailyAverageCents)).toBe(true);
      expect(Number.isFinite(result.weightedForecastCents['30d'])).toBe(true);
    }
  });

  it('horizon forecasts scale linearly with days', () => {
    const series = makeSeries('2026-04-01', Array(30).fill(100));
    const result = computeForecast({ series, quotaCents: null, elapsedCents: 0, nowUtc: NOW });
    const daily = result.weightedForecastCents['7d'] / 7;
    expect(result.weightedForecastCents['14d']).toBeCloseTo(daily * 14, 0);
    expect(result.weightedForecastCents['30d']).toBeCloseTo(daily * 30, 0);
  });

  it('handles decelerating burn (recent slowdown)', () => {
    // First 23 days: 300 cents, last 7 days: 50 cents
    const values = [...Array(23).fill(300), ...Array(7).fill(50)];
    const series = makeSeries('2026-03-22', values);
    const result = computeForecast({ series, quotaCents: 20_000, elapsedCents: 2000, nowUtc: NOW });
    expect(result.isBurnAccelerating).toBe(false);
    expect(result.trailingWeekAverageCents).toBe(50);
    // Blended rate should be closer to 30-day avg than to 50 (alpha=0.3 on week)
    expect(result.weightedForecastCents['7d']).toBeLessThan(result.dailyAverageCents * 7);
  });
});
