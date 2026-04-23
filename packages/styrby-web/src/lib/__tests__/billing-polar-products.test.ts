/**
 * Tests for billing/polar-products.ts
 *
 * Covers:
 * - calculateMonthlyCostCents: edge cases at tier minimums, mid-range, maximum (100 seats)
 * - calculateAnnualCostCents: integer math correctness, discount applied at basis-point precision
 * - calculateAnnualMonthlyEquivalentCents: 17% discount reflected per month
 * - validateSeatCount: boundary enforcement for team (3-100) and business (10-100)
 * - formatCents: whole-dollar and fractional display
 *
 * WHY test at 3, 10, 100 seats: these are the boundary values (min team, min business,
 * max) where off-by-one errors are most likely. Mid-range tests catch proportionality.
 *
 * WHY integer-cents assertions: the entire design guarantee is that these functions
 * produce exact integer results. Any float drift would violate the contract.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateMonthlyCostCents,
  calculateAnnualCostCents,
  calculateAnnualMonthlyEquivalentCents,
  validateSeatCount,
  formatCents,
  ANNUAL_DISCOUNT_BPS,
  TEAM_MIN_SEATS,
  TEAM_MAX_SEATS,
  BUSINESS_MIN_SEATS,
  BUSINESS_MAX_SEATS,
  TIER_DEFINITIONS,
} from '../billing/polar-products';

// ============================================================================
// calculateMonthlyCostCents
// ============================================================================

describe('calculateMonthlyCostCents', () => {
  describe('solo tier (single seat)', () => {
    it('returns 4900 cents for 1 seat', () => {
      expect(calculateMonthlyCostCents('solo', 1)).toBe(4900);
    });

    it('clamps to 1 seat when 2 requested (solo max is 1)', () => {
      // solo max = 1, so clamping to 1
      expect(calculateMonthlyCostCents('solo', 2)).toBe(4900);
    });
  });

  describe('team tier', () => {
    it('returns correct cost at minimum (3 seats)', () => {
      // 3 × 1900 = 5700
      expect(calculateMonthlyCostCents('team', 3)).toBe(5700);
    });

    it('returns correct cost at 10 seats', () => {
      // 10 × 1900 = 19000
      expect(calculateMonthlyCostCents('team', 10)).toBe(19000);
    });

    it('returns correct cost at maximum (100 seats)', () => {
      // 100 × 1900 = 190000
      expect(calculateMonthlyCostCents('team', 100)).toBe(190000);
    });

    it('clamps below minimum to minimum (2 seats → 3)', () => {
      // 3 × 1900 = 5700
      expect(calculateMonthlyCostCents('team', 2)).toBe(5700);
    });

    it('clamps above maximum to maximum (101 seats → 100)', () => {
      // 100 × 1900 = 190000
      expect(calculateMonthlyCostCents('team', 101)).toBe(190000);
    });

    it('returns integer cents (no float drift) at 7 seats', () => {
      const result = calculateMonthlyCostCents('team', 7);
      // 7 × 1900 = 13300 — exact integer
      expect(result).toBe(13300);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe('business tier', () => {
    it('returns correct cost at minimum (10 seats)', () => {
      // 10 × 3900 = 39000
      expect(calculateMonthlyCostCents('business', 10)).toBe(39000);
    });

    it('returns correct cost at 25 seats', () => {
      // 25 × 3900 = 97500
      expect(calculateMonthlyCostCents('business', 25)).toBe(97500);
    });

    it('returns correct cost at maximum (100 seats)', () => {
      // 100 × 3900 = 390000
      expect(calculateMonthlyCostCents('business', 100)).toBe(390000);
    });

    it('clamps below minimum to minimum (5 seats → 10)', () => {
      // 10 × 3900 = 39000
      expect(calculateMonthlyCostCents('business', 5)).toBe(39000);
    });

    it('returns integer cents at all valid values', () => {
      for (const seats of [10, 20, 50, 75, 100]) {
        const result = calculateMonthlyCostCents('business', seats);
        expect(Number.isInteger(result)).toBe(true);
      }
    });
  });

  describe('enterprise tier', () => {
    it('returns 0 (custom pricing)', () => {
      expect(calculateMonthlyCostCents('enterprise', 50)).toBe(0);
    });
  });
});

// ============================================================================
// calculateAnnualCostCents
// ============================================================================

describe('calculateAnnualCostCents', () => {
  // Annual = monthly × 12 × (10000 - 1700) / 10000 = monthly × 12 × 0.83
  // = monthly × 9.96
  // Discount applied to the annual total (not per-month).

  describe('team tier', () => {
    it('applies 17% discount correctly at 3 seats', () => {
      // monthly = 5700
      // undiscounted annual = 5700 × 12 = 68400
      // discount = floor(68400 × 1700 / 10000) = floor(11628) = 11628
      // discounted = 68400 - 11628 = 56772
      const result = calculateAnnualCostCents('team', 3);
      expect(result).toBe(56772);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('applies 17% discount correctly at 10 seats', () => {
      // monthly = 19000
      // undiscounted = 228000
      // discount = floor(228000 × 1700 / 10000) = floor(38760) = 38760
      // discounted = 228000 - 38760 = 189240
      const result = calculateAnnualCostCents('team', 10);
      expect(result).toBe(189240);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('applies 17% discount correctly at 100 seats', () => {
      // monthly = 190000
      // undiscounted = 2280000
      // discount = floor(2280000 × 1700 / 10000) = floor(387600) = 387600
      // discounted = 2280000 - 387600 = 1892400
      const result = calculateAnnualCostCents('team', 100);
      expect(result).toBe(1892400);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('annual cost is always less than 12x monthly', () => {
      for (const seats of [3, 10, 50, 100]) {
        const monthly = calculateMonthlyCostCents('team', seats);
        const annual = calculateAnnualCostCents('team', seats);
        expect(annual).toBeLessThan(monthly * 12);
      }
    });
  });

  describe('business tier', () => {
    it('applies 17% discount correctly at 10 seats', () => {
      // monthly = 39000
      // undiscounted = 468000
      // discount = floor(468000 × 1700 / 10000) = floor(79560) = 79560
      // discounted = 468000 - 79560 = 388440
      const result = calculateAnnualCostCents('business', 10);
      expect(result).toBe(388440);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('applies 17% discount correctly at 100 seats', () => {
      // monthly = 390000
      // undiscounted = 4680000
      // discount = floor(4680000 × 1700 / 10000) = 795600
      // discounted = 3884400
      const result = calculateAnnualCostCents('business', 100);
      expect(result).toBe(3884400);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe('solo tier', () => {
    it('applies 17% discount at 1 seat', () => {
      // monthly = 4900
      // undiscounted = 58800
      // discount = floor(58800 × 1700 / 10000) = floor(9996) = 9996
      // discounted = 48804
      const result = calculateAnnualCostCents('solo', 1);
      expect(result).toBe(48804);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe('enterprise tier', () => {
    it('returns 0', () => {
      expect(calculateAnnualCostCents('enterprise', 50)).toBe(0);
    });
  });

  it('uses the ANNUAL_DISCOUNT_BPS constant (1700)', () => {
    expect(ANNUAL_DISCOUNT_BPS).toBe(1700);
  });
});

// ============================================================================
// calculateAnnualMonthlyEquivalentCents
// ============================================================================

describe('calculateAnnualMonthlyEquivalentCents', () => {
  it('is less than monthly price for team 3 seats', () => {
    const monthly = calculateMonthlyCostCents('team', 3);
    const annualPerMonth = calculateAnnualMonthlyEquivalentCents('team', 3);
    expect(annualPerMonth).toBeLessThan(monthly);
  });

  it('is an integer for team 10 seats', () => {
    const result = calculateAnnualMonthlyEquivalentCents('team', 10);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('is approximately 83% of monthly (17% discount)', () => {
    const monthly = calculateMonthlyCostCents('team', 10);
    const annualPerMonth = calculateAnnualMonthlyEquivalentCents('team', 10);
    // Should be roughly 83% (within 1 cent of floor due to integer division)
    const ratio = annualPerMonth / monthly;
    expect(ratio).toBeGreaterThanOrEqual(0.82);
    expect(ratio).toBeLessThanOrEqual(0.84);
  });
});

// ============================================================================
// validateSeatCount
// ============================================================================

describe('validateSeatCount', () => {
  describe('team tier (min 3, max 100)', () => {
    it('accepts minimum (3)', () => {
      expect(validateSeatCount('team', TEAM_MIN_SEATS)).toBe(true);
    });

    it('accepts middle value (50)', () => {
      expect(validateSeatCount('team', 50)).toBe(true);
    });

    it('accepts maximum (100)', () => {
      expect(validateSeatCount('team', TEAM_MAX_SEATS)).toBe(true);
    });

    it('rejects below minimum (2)', () => {
      expect(validateSeatCount('team', 2)).toBe(false);
    });

    it('rejects above maximum (101)', () => {
      expect(validateSeatCount('team', 101)).toBe(false);
    });

    it('rejects zero', () => {
      expect(validateSeatCount('team', 0)).toBe(false);
    });

    it('rejects negative', () => {
      expect(validateSeatCount('team', -1)).toBe(false);
    });

    it('rejects non-integer (3.5)', () => {
      expect(validateSeatCount('team', 3.5)).toBe(false);
    });
  });

  describe('business tier (min 10, max 100)', () => {
    it('accepts minimum (10)', () => {
      expect(validateSeatCount('business', BUSINESS_MIN_SEATS)).toBe(true);
    });

    it('accepts maximum (100)', () => {
      expect(validateSeatCount('business', BUSINESS_MAX_SEATS)).toBe(true);
    });

    it('rejects below minimum (9)', () => {
      expect(validateSeatCount('business', 9)).toBe(false);
    });

    it('rejects above maximum (101)', () => {
      expect(validateSeatCount('business', 101)).toBe(false);
    });
  });

  describe('solo tier (min 1, max 1)', () => {
    it('accepts 1', () => {
      expect(validateSeatCount('solo', 1)).toBe(true);
    });
  });

  describe('enterprise tier', () => {
    it('accepts any positive integer', () => {
      expect(validateSeatCount('enterprise', 1)).toBe(true);
      expect(validateSeatCount('enterprise', 1000)).toBe(true);
    });

    it('rejects zero', () => {
      expect(validateSeatCount('enterprise', 0)).toBe(false);
    });
  });
});

// ============================================================================
// formatCents
// ============================================================================

describe('formatCents', () => {
  it('formats whole dollars without decimals', () => {
    expect(formatCents(9500)).toBe('$95');
    expect(formatCents(190000)).toBe('$1,900');
    expect(formatCents(4900)).toBe('$49');
  });

  it('formats zero', () => {
    expect(formatCents(0)).toBe('$0');
  });

  it('formats fractional cents with 2 decimal places', () => {
    expect(formatCents(50)).toBe('$0.50');
    expect(formatCents(99)).toBe('$0.99');
  });
});

// ============================================================================
// TIER_DEFINITIONS sanity checks
// ============================================================================

describe('TIER_DEFINITIONS', () => {
  it('has all four tiers', () => {
    expect(TIER_DEFINITIONS).toHaveProperty('solo');
    expect(TIER_DEFINITIONS).toHaveProperty('team');
    expect(TIER_DEFINITIONS).toHaveProperty('business');
    expect(TIER_DEFINITIONS).toHaveProperty('enterprise');
  });

  it('team minimum is 3 and maximum is 100', () => {
    expect(TIER_DEFINITIONS.team.minSeats).toBe(3);
    expect(TIER_DEFINITIONS.team.maxSeats).toBe(100);
  });

  it('business minimum is 10 and maximum is 100', () => {
    expect(TIER_DEFINITIONS.business.minSeats).toBe(10);
    expect(TIER_DEFINITIONS.business.maxSeats).toBe(100);
  });

  it('solo price is $49/mo (4900 cents)', () => {
    expect(TIER_DEFINITIONS.solo.pricePerSeatMonthlyUsdCents).toBe(4900);
  });

  it('team price is $19/seat/mo (1900 cents)', () => {
    expect(TIER_DEFINITIONS.team.pricePerSeatMonthlyUsdCents).toBe(1900);
  });

  it('business price is $39/seat/mo (3900 cents)', () => {
    expect(TIER_DEFINITIONS.business.pricePerSeatMonthlyUsdCents).toBe(3900);
  });

  it('enterprise price is 0 (custom)', () => {
    expect(TIER_DEFINITIONS.enterprise.pricePerSeatMonthlyUsdCents).toBe(0);
  });

  it('team is the recommended tier', () => {
    expect(TIER_DEFINITIONS.team.recommended).toBe(true);
    expect(TIER_DEFINITIONS.solo.recommended).toBe(false);
    expect(TIER_DEFINITIONS.business.recommended).toBe(false);
    expect(TIER_DEFINITIONS.enterprise.recommended).toBe(false);
  });

  it('enterprise checkout path is null (calendar booking)', () => {
    expect(TIER_DEFINITIONS.enterprise.checkoutPath).toBeNull();
  });

  it('all non-enterprise tiers have checkout paths', () => {
    expect(TIER_DEFINITIONS.solo.checkoutPath).toBeTruthy();
    expect(TIER_DEFINITIONS.team.checkoutPath).toBeTruthy();
    expect(TIER_DEFINITIONS.business.checkoutPath).toBeTruthy();
  });

  it('tier highlights contain no em dashes', () => {
    // WHY: CLAUDE.md prohibits em dashes in UI copy.
    for (const tier of Object.values(TIER_DEFINITIONS)) {
      for (const highlight of tier.highlights) {
        expect(highlight).not.toContain('—'); // em dash —
      }
    }
  });

  it('tier taglines contain no em dashes', () => {
    for (const tier of Object.values(TIER_DEFINITIONS)) {
      expect(tier.tagline).not.toContain('—');
    }
  });
});
