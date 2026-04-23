/**
 * Tests for ROI calculator math (computeAnnualROI).
 *
 * WHY test the math function separately from the component: the visual layer
 * (sliders, formatted output) changes frequently; the math must be stable.
 * Testing pure functions is faster and more reliable than React component tests.
 *
 * WHY test at specific values: ensures the formula matches the documented
 * behaviour and that edge cases (low-end rates, single developer) are correct.
 */

import { describe, it, expect } from 'vitest';
import { computeAnnualROI } from '../ROICalculator';

describe('computeAnnualROI', () => {
  describe('default calculator values', () => {
    it('computes correct result for 5 devs, 40h/wk, $100/hr, 25% gain', () => {
      // weeklyHoursRecovered = 40 × 25 / 100 = 10
      // annualHoursRecovered = 10 × 52 = 520
      // annualValue = 5 × 520 × 100 = 260000
      const result = computeAnnualROI({
        developers: 5,
        hoursPerWeek: 40,
        hourlyRateUsd: 100,
        productivityGainPct: 25,
      });
      expect(result).toBe(260_000);
    });
  });

  describe('single developer', () => {
    it('computes correctly for 1 developer', () => {
      // weeklyHoursRecovered = 40 × 25 / 100 = 10
      // annualHoursRecovered = 10 × 52 = 520
      // annualValue = 1 × 520 × 100 = 52000
      const result = computeAnnualROI({
        developers: 1,
        hoursPerWeek: 40,
        hourlyRateUsd: 100,
        productivityGainPct: 25,
      });
      expect(result).toBe(52_000);
    });
  });

  describe('40% productivity gain (max slider)', () => {
    it('computes correctly at maximum gain for 10 devs, $150/hr, 40h/wk', () => {
      // weeklyHoursRecovered = 40 × 40 / 100 = 16
      // annualHoursRecovered = 16 × 52 = 832
      // annualValue = 10 × 832 × 150 = 1248000
      const result = computeAnnualROI({
        developers: 10,
        hoursPerWeek: 40,
        hourlyRateUsd: 150,
        productivityGainPct: 40,
      });
      expect(result).toBe(1_248_000);
    });
  });

  describe('5% productivity gain (min slider)', () => {
    it('computes correctly at minimum gain', () => {
      // weeklyHoursRecovered = 40 × 5 / 100 = 2
      // annualHoursRecovered = 2 × 52 = 104
      // annualValue = 5 × 104 × 100 = 52000
      const result = computeAnnualROI({
        developers: 5,
        hoursPerWeek: 40,
        hourlyRateUsd: 100,
        productivityGainPct: 5,
      });
      expect(result).toBe(52_000);
    });
  });

  describe('part-time developer', () => {
    it('handles 20h/wk correctly', () => {
      // weeklyHoursRecovered = 20 × 25 / 100 = 5
      // annualHoursRecovered = 5 × 52 = 260
      // annualValue = 1 × 260 × 100 = 26000
      const result = computeAnnualROI({
        developers: 1,
        hoursPerWeek: 20,
        hourlyRateUsd: 100,
        productivityGainPct: 25,
      });
      expect(result).toBe(26_000);
    });
  });

  describe('large enterprise team', () => {
    it('handles 100 developers correctly', () => {
      // weeklyHoursRecovered = 40 × 25 / 100 = 10
      // annualHoursRecovered = 10 × 52 = 520
      // annualValue = 100 × 520 × 200 = 10400000
      const result = computeAnnualROI({
        developers: 100,
        hoursPerWeek: 40,
        hourlyRateUsd: 200,
        productivityGainPct: 25,
      });
      expect(result).toBe(10_400_000);
    });
  });

  describe('linearity', () => {
    it('ROI scales linearly with developer count', () => {
      const base = computeAnnualROI({
        developers: 1,
        hoursPerWeek: 40,
        hourlyRateUsd: 100,
        productivityGainPct: 25,
      });
      const triple = computeAnnualROI({
        developers: 3,
        hoursPerWeek: 40,
        hourlyRateUsd: 100,
        productivityGainPct: 25,
      });
      expect(triple).toBe(base * 3);
    });

    it('ROI scales linearly with hourly rate', () => {
      const base = computeAnnualROI({
        developers: 5,
        hoursPerWeek: 40,
        hourlyRateUsd: 100,
        productivityGainPct: 25,
      });
      const double = computeAnnualROI({
        developers: 5,
        hoursPerWeek: 40,
        hourlyRateUsd: 200,
        productivityGainPct: 25,
      });
      expect(double).toBe(base * 2);
    });
  });

  describe('zero cases', () => {
    it('returns 0 for 0% gain', () => {
      const result = computeAnnualROI({
        developers: 5,
        hoursPerWeek: 40,
        hourlyRateUsd: 100,
        productivityGainPct: 0,
      });
      expect(result).toBe(0);
    });

    it('returns 0 for 0 developers', () => {
      const result = computeAnnualROI({
        developers: 0,
        hoursPerWeek: 40,
        hourlyRateUsd: 100,
        productivityGainPct: 25,
      });
      expect(result).toBe(0);
    });
  });
});
