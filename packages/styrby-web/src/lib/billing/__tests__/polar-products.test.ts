/**
 * Co-located tests for `lib/billing/polar-products.ts`.
 *
 * WHY this file exists alongside `lib/__tests__/billing-polar-products.test.ts`:
 *   The older test file lives one directory up at the legacy `lib/__tests__/`
 *   location. This file is the colocated home (TEST-002 in the /test-ship
 *   audit) and focuses on the gaps the legacy file does not cover:
 *
 *     - `getPlanFromProductId` SEC-LOGIC-001 console.warn emission shape
 *     - Legacy-alias surface of `TIER_DEFINITIONS` in a single block
 *     - Pricing math edge cases asserted from the colocated path so that
 *       future contributors find a test file next to the source they are
 *       editing
 *
 *   The legacy file remains the source of truth for the bulk of pricing
 *   math; it is not removed because it has 60+ assertions already and the
 *   /test-ship report did not call for consolidation.
 *
 * @see ../polar-products.ts
 * @see ../../__tests__/billing-polar-products.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateMonthlyCostCents,
  calculateAnnualCostCents,
  validateSeatCount,
  formatCents,
  getPlanFromProductId,
  getProductId,
  TIER_DEFINITIONS_CANONICAL,
  GROWTH_BASE_SEATS,
  GROWTH_MAX_SEATS,
} from '../polar-products';

// ============================================================================
// calculateMonthlyCostCents — Pro / Growth / legacy aliases
// ============================================================================

describe('calculateMonthlyCostCents', () => {
  it('Pro: returns flat $39/mo regardless of seat count (single-user plan)', () => {
    expect(calculateMonthlyCostCents('pro', 1)).toBe(3900);
    // Pro is single-seat; any seat count above 1 silently clamps to 1 seat.
    // The cost stays flat at $39/mo.
    expect(calculateMonthlyCostCents('pro', 5)).toBe(3900);
    expect(calculateMonthlyCostCents('pro', 100)).toBe(3900);
  });

  it('Growth: 3 seats (base) → $99/mo (no addon yet)', () => {
    expect(calculateMonthlyCostCents('growth', 3)).toBe(9900);
  });

  it('Growth: 4 seats → $99 + 1 × $19 = $118/mo', () => {
    expect(calculateMonthlyCostCents('growth', 4)).toBe(11800);
  });

  it('Growth: max seats (100) → $99 + 97 × $19 = $1942/mo', () => {
    expect(calculateMonthlyCostCents('growth', GROWTH_MAX_SEATS)).toBe(
      9900 + 97 * 1900,
    );
  });

});

// ============================================================================
// calculateAnnualCostCents — annual products bake in the discount
// ============================================================================

describe('calculateAnnualCostCents', () => {
  it('Pro: returns flat $390/yr (Decision #2)', () => {
    expect(calculateAnnualCostCents('pro', 1)).toBe(39000);
  });

  it('Growth: 3 seats → $990/yr base only', () => {
    expect(calculateAnnualCostCents('growth', 3)).toBe(99000);
  });

  it('Growth: 5 seats → $990 + 2 × $190 = $1370/yr', () => {
    expect(calculateAnnualCostCents('growth', 5)).toBe(99000 + 2 * 19000);
  });

  it('annual is cheaper than 12 × monthly (~17% off baked in)', () => {
    expect(calculateAnnualCostCents('pro', 1)).toBeLessThan(
      calculateMonthlyCostCents('pro', 1) * 12,
    );
    expect(calculateAnnualCostCents('growth', 3)).toBeLessThan(
      calculateMonthlyCostCents('growth', 3) * 12,
    );
  });

});

// ============================================================================
// validateSeatCount — bounds enforcement per tier
// ============================================================================

describe('validateSeatCount', () => {
  it('Pro accepts exactly 1 seat', () => {
    expect(validateSeatCount('pro', 1)).toBe(true);
  });

  it('Pro rejects 0 seats', () => {
    expect(validateSeatCount('pro', 0)).toBe(false);
  });

  it('Pro rejects 2+ seats (single-user plan)', () => {
    expect(validateSeatCount('pro', 2)).toBe(false);
    expect(validateSeatCount('pro', 100)).toBe(false);
  });

  it(`Growth accepts the minimum (${GROWTH_BASE_SEATS})`, () => {
    expect(validateSeatCount('growth', GROWTH_BASE_SEATS)).toBe(true);
  });

  it('Growth rejects below the minimum (0, 1, 2 — clear error)', () => {
    expect(validateSeatCount('growth', 0)).toBe(false);
    expect(validateSeatCount('growth', 1)).toBe(false);
    expect(validateSeatCount('growth', 2)).toBe(false);
  });

  it(`Growth accepts the maximum (${GROWTH_MAX_SEATS})`, () => {
    expect(validateSeatCount('growth', GROWTH_MAX_SEATS)).toBe(true);
  });

  it(`Growth rejects above the maximum (${GROWTH_MAX_SEATS + 1})`, () => {
    expect(validateSeatCount('growth', GROWTH_MAX_SEATS + 1)).toBe(false);
  });

  it('rejects non-integer seat counts on every tier', () => {
    expect(validateSeatCount('pro', 1.5)).toBe(false);
    expect(validateSeatCount('growth', 3.5)).toBe(false);
  });
});

// ============================================================================
// formatCents — display formatting
// ============================================================================

describe('formatCents', () => {
  it('formats whole dollars without decimals', () => {
    expect(formatCents(3900)).toBe('$39');
    expect(formatCents(99000)).toBe('$990');
    expect(formatCents(390000)).toBe('$3,900');
  });

  it('formats zero as "$0"', () => {
    expect(formatCents(0)).toBe('$0');
  });

  it('formats sub-dollar with two decimals', () => {
    expect(formatCents(50)).toBe('$0.50');
    expect(formatCents(199)).toBe('$1.99');
  });

  it('handles very large numbers with grouping separators', () => {
    expect(formatCents(1_000_000_00)).toBe('$1,000,000');
  });
});

// ============================================================================
// getPlanFromProductId — Polar webhook reverse-resolution
// ============================================================================

describe('getPlanFromProductId', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('POLAR_PRO_MONTHLY_PRODUCT_ID', 'prod_pro_mo');
    vi.stubEnv('POLAR_PRO_ANNUAL_PRODUCT_ID', 'prod_pro_yr');
    vi.stubEnv('POLAR_GROWTH_MONTHLY_PRODUCT_ID', 'prod_growth_mo');
    vi.stubEnv('POLAR_GROWTH_ANNUAL_PRODUCT_ID', 'prod_growth_yr');
    vi.stubEnv('POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID', 'prod_seat_mo');
    vi.stubEnv('POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID', 'prod_seat_yr');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('resolves Pro Monthly UUID → "pro"', () => {
    expect(getPlanFromProductId('prod_pro_mo')).toBe('pro');
  });

  it('resolves Growth Monthly UUID → "growth"', () => {
    expect(getPlanFromProductId('prod_growth_mo')).toBe('growth');
  });

  it('resolves Growth Annual UUID → "growth"', () => {
    expect(getPlanFromProductId('prod_growth_yr')).toBe('growth');
  });

  it('resolves Growth seat addon UUID → "growth" (part of the same bundle)', () => {
    expect(getPlanFromProductId('prod_seat_mo')).toBe('growth');
    expect(getPlanFromProductId('prod_seat_yr')).toBe('growth');
  });

  it('returns "free" for empty input (no warn)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getPlanFromProductId('')).toBe('free');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns "free" for unknown UUID AND emits SEC-LOGIC-001 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getPlanFromProductId('prod_bogus_xxx')).toBe('free');

    // SEC-LOGIC-001: marker assertion stays — warn is the regression signal.
    // WHY trimmed payload: previously the warn dumped all 6 configured Polar
    // product UUIDs. We now log only the offending productId plus a count
    // of configured products to keep log volume sane and avoid shipping
    // internal product UUID inventory to Sentry on every miss.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown Polar product ID'),
      expect.objectContaining({
        productId: 'prod_bogus_xxx',
        configuredCount: 6,
      }),
    );
    // Defensive: ensure the verbose `configuredIds` payload is gone so the
    // log-hygiene fix can't silently regress.
    const payload = warnSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('configuredIds');
  });
});

// ============================================================================
// getProductId — env-driven base product resolution
// ============================================================================

describe('getProductId', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when env var is unset (graceful cutover degradation)', () => {
    vi.stubEnv('POLAR_PRO_MONTHLY_PRODUCT_ID', '');
    expect(getProductId('pro', 'monthly')).toBeNull();
  });

  it('returns env value for Pro monthly when set', () => {
    vi.stubEnv('POLAR_PRO_MONTHLY_PRODUCT_ID', 'prod_pro_mo_abc');
    expect(getProductId('pro', 'monthly')).toBe('prod_pro_mo_abc');
  });

  it('returns env value for Growth annual when set', () => {
    vi.stubEnv('POLAR_GROWTH_ANNUAL_PRODUCT_ID', 'prod_growth_yr_xyz');
    expect(getProductId('growth', 'annual')).toBe('prod_growth_yr_xyz');
  });
});

// ============================================================================
// TIER_DEFINITIONS_CANONICAL — strict 2-tier view
// ============================================================================

describe('TIER_DEFINITIONS_CANONICAL — strict 2-tier view', () => {
  it('contains exactly Pro and Growth, with the new seat math fields', () => {
    expect(Object.keys(TIER_DEFINITIONS_CANONICAL).sort()).toEqual(['growth', 'pro']);
    expect(TIER_DEFINITIONS_CANONICAL.pro.baseMonthlyUsdCents).toBe(3900);
    expect(TIER_DEFINITIONS_CANONICAL.growth.baseMonthlyUsdCents).toBe(9900);
    expect(TIER_DEFINITIONS_CANONICAL.growth.seatPriceMonthlyUsdCents).toBe(1900);
    expect(TIER_DEFINITIONS_CANONICAL.growth.baseSeats).toBe(GROWTH_BASE_SEATS);
  });
});
