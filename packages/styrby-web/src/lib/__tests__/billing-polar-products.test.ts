/**
 * Tests for billing/polar-products.ts
 *
 * Scope: pricing-page-specific extensions only.
 *
 * WHY we do NOT re-test team/business monthly/annual math here:
 *   Those calculations delegate to @styrby/shared/billing which has its own
 *   comprehensive test suite (packages/styrby-shared/src/billing/__tests__/).
 *   Duplicating those assertions here would violate SOC2 CC7.2 single-source
 *   intent — two test suites asserting different expected values would mask
 *   divergence instead of catching it.
 *
 * What IS tested here (page-specific):
 *   - PublicTierId including 'solo' tier math (solo is not in shared BillableTier)
 *   - Slider bound constants (TEAM_MIN_SEATS, BUSINESS_MIN_SEATS, etc.)
 *   - ANNUAL_DISCOUNT_BPS exported constant value
 *   - calculateAnnualMonthlyEquivalentCents — display helper (annual ÷ 12)
 *   - validateSeatCount — boolean API (shared returns SeatValidationResult; we
 *     return .ok — this adapter behaviour belongs in this test suite)
 *   - formatCents — display formatting
 *   - TIER_DEFINITIONS — structure, UI metadata, copy rules
 *   - Enterprise / solo zero-return paths
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
// calculateMonthlyCostCents — solo and enterprise only
// (team/business delegate to @styrby/shared/billing; tested there)
// ============================================================================

describe('calculateMonthlyCostCents', () => {
  describe('solo tier (single seat — handled locally, not in shared BillableTier)', () => {
    it('returns 4900 cents for 1 seat', () => {
      expect(calculateMonthlyCostCents('solo', 1)).toBe(4900);
    });

    it('clamps to 1 seat when 2 requested (solo max is 1)', () => {
      // solo maxSeats = 1, so clamping to 1
      expect(calculateMonthlyCostCents('solo', 2)).toBe(4900);
    });
  });

  describe('enterprise tier', () => {
    it('returns 0 (custom pricing — delegates to shared which returns 0)', () => {
      expect(calculateMonthlyCostCents('enterprise', 50)).toBe(0);
    });
  });
});

// ============================================================================
// calculateAnnualCostCents — solo and enterprise only
// (team/business delegate to @styrby/shared/billing; tested there)
// ============================================================================

describe('calculateAnnualCostCents', () => {
  describe('solo tier (handled locally with ANNUAL_DISCOUNT_BPS)', () => {
    it('applies 17% discount at 1 seat', () => {
      // monthly = 4900
      // undiscounted annual = 4900 × 12 = 58800
      // discount = floor(58800 × 1700 / 10000) = floor(9996) = 9996
      // discounted = 58800 - 9996 = 48804
      const result = calculateAnnualCostCents('solo', 1);
      expect(result).toBe(48804);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('is less than 12x monthly for solo', () => {
      const monthly = calculateMonthlyCostCents('solo', 1);
      const annual = calculateAnnualCostCents('solo', 1);
      expect(annual).toBeLessThan(monthly * 12);
    });
  });

  describe('enterprise tier', () => {
    it('returns 0 (delegates to shared)', () => {
      expect(calculateAnnualCostCents('enterprise', 50)).toBe(0);
    });
  });

  it('ANNUAL_DISCOUNT_BPS constant is 1700', () => {
    expect(ANNUAL_DISCOUNT_BPS).toBe(1700);
  });
});

// ============================================================================
// calculateAnnualMonthlyEquivalentCents
// (page-specific display helper — floor(annual / 12))
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

  it('is 0 for enterprise', () => {
    expect(calculateAnnualMonthlyEquivalentCents('enterprise', 50)).toBe(0);
  });
});

// ============================================================================
// validateSeatCount — boolean adapter over shared SeatValidationResult
// (the boolean return type is page-specific; tested here)
// ============================================================================

describe('validateSeatCount', () => {
  describe('solo tier (min 1, max 1 — handled locally)', () => {
    it('accepts 1', () => {
      expect(validateSeatCount('solo', 1)).toBe(true);
    });

    it('rejects 0', () => {
      expect(validateSeatCount('solo', 0)).toBe(false);
    });

    it('rejects 2 (max is 1)', () => {
      expect(validateSeatCount('solo', 2)).toBe(false);
    });

    it('rejects non-integer', () => {
      expect(validateSeatCount('solo', 1.5)).toBe(false);
    });
  });

  describe('team tier (min 3, max 100 — delegates to shared)', () => {
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

  describe('business tier (min 10, max 100 — delegates to shared)', () => {
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

  describe('enterprise tier', () => {
    it('accepts any positive integer (delegates to shared)', () => {
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
  it('has all four tiers including solo', () => {
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
        expect(highlight).not.toContain('—'); // em dash
      }
    }
  });

  it('tier taglines contain no em dashes', () => {
    for (const tier of Object.values(TIER_DEFINITIONS)) {
      expect(tier.tagline).not.toContain('—');
    }
  });
});

// ============================================================================
// Slider bound constants
// ============================================================================

describe('slider bound constants', () => {
  it('TEAM_MIN_SEATS is 3', () => {
    expect(TEAM_MIN_SEATS).toBe(3);
  });

  it('TEAM_MAX_SEATS is 100', () => {
    expect(TEAM_MAX_SEATS).toBe(100);
  });

  it('BUSINESS_MIN_SEATS is 10', () => {
    expect(BUSINESS_MIN_SEATS).toBe(10);
  });

  it('BUSINESS_MAX_SEATS is 100', () => {
    expect(BUSINESS_MAX_SEATS).toBe(100);
  });

  it('constants match TIER_DEFINITIONS entries', () => {
    expect(TIER_DEFINITIONS.team.minSeats).toBe(TEAM_MIN_SEATS);
    expect(TIER_DEFINITIONS.team.maxSeats).toBe(TEAM_MAX_SEATS);
    expect(TIER_DEFINITIONS.business.minSeats).toBe(BUSINESS_MIN_SEATS);
    expect(TIER_DEFINITIONS.business.maxSeats).toBe(BUSINESS_MAX_SEATS);
  });
});
