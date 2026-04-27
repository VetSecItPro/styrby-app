/**
 * Tests for billing/polar-products.ts — Pro + Growth (Phase 5).
 *
 * Scope: pricing-page-specific helpers + the new Pro / Growth tier model.
 *
 * Post-Phase-5 the public pricing page surfaces exactly two paid tiers:
 *   - Pro    — $39/mo flat, single-user
 *   - Growth — $99/mo base + $19/seat after 3, team
 *
 * Legacy keys (`solo`, `team`, `business`, `enterprise`) survive in
 * `TIER_DEFINITIONS` only as back-compat aliases for the unmodified
 * pricing card components — see deprecation comments in the source.
 *
 * SEC-LOGIC-001 — `getPlanFromProductId` MUST log a warning for unknown
 * product IDs and fall back to `'free'`. The test stubs console.warn to
 * verify the warning fires.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateMonthlyCostCents,
  calculateAnnualCostCents,
  calculateAnnualMonthlyEquivalentCents,
  validateSeatCount,
  formatCents,
  getProductId,
  getPlanFromProductId,
  ANNUAL_DISCOUNT_BPS,
  GROWTH_BASE_SEATS,
  GROWTH_MAX_SEATS,
  TEAM_MIN_SEATS,
  TEAM_MAX_SEATS,
  BUSINESS_MIN_SEATS,
  BUSINESS_MAX_SEATS,
  TIER_DEFINITIONS,
  TIER_DEFINITIONS_CANONICAL,
  type PublicTierId,
} from '../billing/polar-products';

// ============================================================================
// calculateMonthlyCostCents
// ============================================================================

describe('calculateMonthlyCostCents — Phase 5 (Pro + Growth)', () => {
  it('Pro 1 seat → 3900 cents ($39)', () => {
    expect(calculateMonthlyCostCents('pro', 1)).toBe(3900);
  });

  it('Pro clamps to 1 seat (single-user plan)', () => {
    expect(calculateMonthlyCostCents('pro', 5)).toBe(3900);
  });

  it('Growth 3 seats (base) → 9900 cents ($99 base only)', () => {
    expect(calculateMonthlyCostCents('growth', 3)).toBe(9900);
  });

  it('Growth 5 seats → $99 + 2 × $19 = 13700 cents', () => {
    expect(calculateMonthlyCostCents('growth', 5)).toBe(13700);
  });

  it('Growth 10 seats → $99 + 7 × $19 = 23200 cents', () => {
    expect(calculateMonthlyCostCents('growth', 10)).toBe(23200);
  });

  describe('legacy alias inputs (back-compat)', () => {
    it('"solo" maps to pro pricing', () => {
      expect(calculateMonthlyCostCents('solo', 1)).toBe(3900);
    });

    it('"team" maps to growth pricing', () => {
      expect(calculateMonthlyCostCents('team', 5)).toBe(13700);
    });

    it('"business" maps to growth pricing', () => {
      expect(calculateMonthlyCostCents('business', 10)).toBe(23200);
    });
  });
});

// ============================================================================
// calculateAnnualCostCents
// ============================================================================

describe('calculateAnnualCostCents — Phase 5 (Pro + Growth)', () => {
  it('Pro → 39000 cents ($390/yr)', () => {
    expect(calculateAnnualCostCents('pro', 1)).toBe(39000);
  });

  it('Growth 3 seats (base) → 99000 cents ($990/yr)', () => {
    expect(calculateAnnualCostCents('growth', 3)).toBe(99000);
  });

  it('Growth 5 seats → $990 + 2 × $190 = 137000 cents', () => {
    expect(calculateAnnualCostCents('growth', 5)).toBe(137000);
  });

  it('annual is less than 12 × monthly for Pro', () => {
    expect(calculateAnnualCostCents('pro', 1)).toBeLessThan(
      calculateMonthlyCostCents('pro', 1) * 12,
    );
  });

  it('annual is less than 12 × monthly for Growth (base)', () => {
    expect(calculateAnnualCostCents('growth', 3)).toBeLessThan(
      calculateMonthlyCostCents('growth', 3) * 12,
    );
  });

  it('ANNUAL_DISCOUNT_BPS constant is 1700', () => {
    expect(ANNUAL_DISCOUNT_BPS).toBe(1700);
  });
});

// ============================================================================
// calculateAnnualMonthlyEquivalentCents
// ============================================================================

describe('calculateAnnualMonthlyEquivalentCents', () => {
  it('Pro → floor(39000 / 12) = 3250', () => {
    expect(calculateAnnualMonthlyEquivalentCents('pro', 1)).toBe(3250);
  });

  it('Growth base → floor(99000 / 12) = 8250', () => {
    expect(calculateAnnualMonthlyEquivalentCents('growth', 3)).toBe(8250);
  });

  it('result is always an integer', () => {
    expect(Number.isInteger(calculateAnnualMonthlyEquivalentCents('pro', 1))).toBe(true);
    expect(Number.isInteger(calculateAnnualMonthlyEquivalentCents('growth', 5))).toBe(true);
  });
});

// ============================================================================
// validateSeatCount
// ============================================================================

describe('validateSeatCount', () => {
  describe('Pro tier (single-user)', () => {
    it('accepts 1', () => {
      expect(validateSeatCount('pro', 1)).toBe(true);
    });

    it('rejects 0', () => {
      expect(validateSeatCount('pro', 0)).toBe(false);
    });

    it('rejects 2 (max is 1)', () => {
      expect(validateSeatCount('pro', 2)).toBe(false);
    });

    it('rejects non-integer', () => {
      expect(validateSeatCount('pro', 1.5)).toBe(false);
    });
  });

  describe('Growth tier (3-100 seats)', () => {
    it(`accepts minimum (${GROWTH_BASE_SEATS})`, () => {
      expect(validateSeatCount('growth', GROWTH_BASE_SEATS)).toBe(true);
    });

    it('accepts middle value (50)', () => {
      expect(validateSeatCount('growth', 50)).toBe(true);
    });

    it(`accepts maximum (${GROWTH_MAX_SEATS})`, () => {
      expect(validateSeatCount('growth', GROWTH_MAX_SEATS)).toBe(true);
    });

    it('rejects below minimum (2)', () => {
      expect(validateSeatCount('growth', 2)).toBe(false);
    });

    it(`rejects above maximum (${GROWTH_MAX_SEATS + 1})`, () => {
      expect(validateSeatCount('growth', GROWTH_MAX_SEATS + 1)).toBe(false);
    });

    it('rejects non-integer', () => {
      expect(validateSeatCount('growth', 3.5)).toBe(false);
    });
  });
});

// ============================================================================
// formatCents
// ============================================================================

describe('formatCents', () => {
  it('formats whole dollars without decimals', () => {
    expect(formatCents(3900)).toBe('$39');
    expect(formatCents(9900)).toBe('$99');
    expect(formatCents(190000)).toBe('$1,900');
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
// TIER_DEFINITIONS_CANONICAL — Pro + Growth shape
// ============================================================================

describe('TIER_DEFINITIONS_CANONICAL', () => {
  it('has only the two canonical tiers (pro + growth)', () => {
    const keys = Object.keys(TIER_DEFINITIONS_CANONICAL).sort();
    expect(keys).toEqual(['growth', 'pro']);
  });

  it('Pro has $39/mo base price, single seat', () => {
    expect(TIER_DEFINITIONS_CANONICAL.pro.baseMonthlyUsdCents).toBe(3900);
    expect(TIER_DEFINITIONS_CANONICAL.pro.minSeats).toBe(1);
    expect(TIER_DEFINITIONS_CANONICAL.pro.maxSeats).toBe(1);
  });

  it('Growth has $99/mo base, $19/seat addon, 3-seat min, 100-seat max', () => {
    expect(TIER_DEFINITIONS_CANONICAL.growth.baseMonthlyUsdCents).toBe(9900);
    expect(TIER_DEFINITIONS_CANONICAL.growth.seatPriceMonthlyUsdCents).toBe(1900);
    expect(TIER_DEFINITIONS_CANONICAL.growth.baseSeats).toBe(GROWTH_BASE_SEATS);
    expect(TIER_DEFINITIONS_CANONICAL.growth.minSeats).toBe(GROWTH_BASE_SEATS);
    expect(TIER_DEFINITIONS_CANONICAL.growth.maxSeats).toBe(GROWTH_MAX_SEATS);
  });

  it('Growth is the recommended tier', () => {
    expect(TIER_DEFINITIONS_CANONICAL.growth.recommended).toBe(true);
    expect(TIER_DEFINITIONS_CANONICAL.pro.recommended).toBe(false);
  });

  it('every checkout path is non-null for canonical tiers', () => {
    expect(TIER_DEFINITIONS_CANONICAL.pro.checkoutPath).toBeTruthy();
    expect(TIER_DEFINITIONS_CANONICAL.growth.checkoutPath).toBeTruthy();
  });

  it('checkout paths use the new ?plan= URL parameters', () => {
    expect(TIER_DEFINITIONS_CANONICAL.pro.checkoutPath).toContain('plan=pro');
    expect(TIER_DEFINITIONS_CANONICAL.growth.checkoutPath).toContain('plan=growth');
  });

  it('tier highlights contain no em dashes (CLAUDE.md style rule)', () => {
    for (const tier of Object.values(TIER_DEFINITIONS_CANONICAL)) {
      for (const highlight of tier.highlights) {
        expect(highlight).not.toContain('—');
      }
    }
  });

  it('tier taglines contain no em dashes', () => {
    for (const tier of Object.values(TIER_DEFINITIONS_CANONICAL)) {
      expect(tier.tagline).not.toContain('—');
    }
  });
});

// ============================================================================
// TIER_DEFINITIONS — augmented view with legacy back-compat keys
// ============================================================================

describe('TIER_DEFINITIONS (legacy-augmented, back-compat for pricing cards)', () => {
  it('exposes legacy keys (solo, team, business, enterprise)', () => {
    expect(TIER_DEFINITIONS).toHaveProperty('solo');
    expect(TIER_DEFINITIONS).toHaveProperty('team');
    expect(TIER_DEFINITIONS).toHaveProperty('business');
    expect(TIER_DEFINITIONS).toHaveProperty('enterprise');
  });

  it('exposes canonical keys (pro, growth)', () => {
    expect(TIER_DEFINITIONS).toHaveProperty('pro');
    expect(TIER_DEFINITIONS).toHaveProperty('growth');
  });

  it('legacy "solo" exposes pricePerSeatMonthlyUsdCents = $39 (pro pricing)', () => {
    expect(TIER_DEFINITIONS.solo?.pricePerSeatMonthlyUsdCents).toBe(3900);
  });

  it('legacy "team" exposes pricePerSeatMonthlyUsdCents = $19 (growth seat addon)', () => {
    expect(TIER_DEFINITIONS.team?.pricePerSeatMonthlyUsdCents).toBe(1900);
  });

  it('legacy "business" exposes the same growth seat addon price', () => {
    expect(TIER_DEFINITIONS.business?.pricePerSeatMonthlyUsdCents).toBe(1900);
  });

  it('legacy "enterprise" has 0 (custom pricing)', () => {
    expect(TIER_DEFINITIONS.enterprise?.pricePerSeatMonthlyUsdCents).toBe(0);
  });
});

// ============================================================================
// Slider bound constants — back-compat aliases
// ============================================================================

describe('slider bound constants (back-compat for unmodified card components)', () => {
  it('GROWTH_BASE_SEATS is 3', () => {
    expect(GROWTH_BASE_SEATS).toBe(3);
  });

  it('GROWTH_MAX_SEATS is 100', () => {
    expect(GROWTH_MAX_SEATS).toBe(100);
  });

  it('TEAM_MIN_SEATS aliases GROWTH_BASE_SEATS (legacy back-compat)', () => {
    expect(TEAM_MIN_SEATS).toBe(GROWTH_BASE_SEATS);
  });

  it('TEAM_MAX_SEATS aliases GROWTH_MAX_SEATS (legacy back-compat)', () => {
    expect(TEAM_MAX_SEATS).toBe(GROWTH_MAX_SEATS);
  });

  it('BUSINESS_MIN_SEATS aliases GROWTH_BASE_SEATS (collapsed in 2-tier model)', () => {
    expect(BUSINESS_MIN_SEATS).toBe(GROWTH_BASE_SEATS);
  });

  it('BUSINESS_MAX_SEATS aliases GROWTH_MAX_SEATS', () => {
    expect(BUSINESS_MAX_SEATS).toBe(GROWTH_MAX_SEATS);
  });
});

// ============================================================================
// getProductId
// ============================================================================

describe('getProductId', () => {
  it('returns process.env value (or null) for pro monthly', () => {
    expect(getProductId('pro', 'monthly')).toBe(
      process.env.POLAR_PRO_MONTHLY_PRODUCT_ID || null,
    );
  });

  it('returns process.env value (or null) for pro annual', () => {
    expect(getProductId('pro', 'annual')).toBe(
      process.env.POLAR_PRO_ANNUAL_PRODUCT_ID || null,
    );
  });

  it('returns process.env value (or null) for growth monthly', () => {
    expect(getProductId('growth', 'monthly')).toBe(
      process.env.POLAR_GROWTH_MONTHLY_PRODUCT_ID || null,
    );
  });

  it('returns process.env value (or null) for growth annual', () => {
    expect(getProductId('growth', 'annual')).toBe(
      process.env.POLAR_GROWTH_ANNUAL_PRODUCT_ID || null,
    );
  });

  it('returns null when env var unset (graceful degradation during cutover)', () => {
    const original = process.env.POLAR_PRO_MONTHLY_PRODUCT_ID;
    delete process.env.POLAR_PRO_MONTHLY_PRODUCT_ID;
    try {
      expect(getProductId('pro', 'monthly')).toBeNull();
    } finally {
      if (original !== undefined) {
        process.env.POLAR_PRO_MONTHLY_PRODUCT_ID = original;
      }
    }
  });
});

// ============================================================================
// getPlanFromProductId — SEC-LOGIC-001 unknown ID warning
// ============================================================================

describe('getPlanFromProductId', () => {
  const ENV_KEYS = [
    'POLAR_PRO_MONTHLY_PRODUCT_ID',
    'POLAR_PRO_ANNUAL_PRODUCT_ID',
    'POLAR_GROWTH_MONTHLY_PRODUCT_ID',
    'POLAR_GROWTH_ANNUAL_PRODUCT_ID',
    'POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID',
    'POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
    }
    process.env.POLAR_PRO_MONTHLY_PRODUCT_ID = 'prod_pro_monthly_test';
    process.env.POLAR_PRO_ANNUAL_PRODUCT_ID = 'prod_pro_annual_test';
    process.env.POLAR_GROWTH_MONTHLY_PRODUCT_ID = 'prod_growth_monthly_test';
    process.env.POLAR_GROWTH_ANNUAL_PRODUCT_ID = 'prod_growth_annual_test';
    process.env.POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID = 'prod_growth_seat_monthly_test';
    process.env.POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID = 'prod_growth_seat_annual_test';
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
    warnSpy.mockRestore();
  });

  it('resolves pro monthly product ID → "pro"', () => {
    expect(getPlanFromProductId('prod_pro_monthly_test')).toBe('pro');
  });

  it('resolves pro annual product ID → "pro"', () => {
    expect(getPlanFromProductId('prod_pro_annual_test')).toBe('pro');
  });

  it('resolves growth monthly product ID → "growth"', () => {
    expect(getPlanFromProductId('prod_growth_monthly_test')).toBe('growth');
  });

  it('resolves growth annual product ID → "growth"', () => {
    expect(getPlanFromProductId('prod_growth_annual_test')).toBe('growth');
  });

  it('resolves growth seat addon product ID → "growth" (part of the same bundle)', () => {
    expect(getPlanFromProductId('prod_growth_seat_monthly_test')).toBe('growth');
    expect(getPlanFromProductId('prod_growth_seat_annual_test')).toBe('growth');
  });

  it('returns "free" for empty input', () => {
    expect(getPlanFromProductId('')).toBe('free');
  });

  it('returns "free" for unknown product ID and emits SEC-LOGIC-001 warning', () => {
    expect(getPlanFromProductId('prod_totally_unknown_xyz')).toBe('free');
    expect(warnSpy).toHaveBeenCalled();
    const firstCallArgs = warnSpy.mock.calls[0];
    expect(String(firstCallArgs[0])).toContain('Unknown Polar product ID');
  });
});

// ============================================================================
// Type-level: PublicTierId is the canonical 2-tier union
// ============================================================================

describe('PublicTierId type', () => {
  it('accepts only "pro" and "growth"', () => {
    const valid: PublicTierId[] = ['pro', 'growth'];
    expect(valid).toEqual(['pro', 'growth']);
    // @ts-expect-error — 'free' is not in PublicTierId
    const _free: PublicTierId = 'free';
    // @ts-expect-error — 'power' is not in PublicTierId
    const _power: PublicTierId = 'power';
    void _free;
    void _power;
  });
});
