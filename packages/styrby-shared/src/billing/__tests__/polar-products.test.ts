/**
 * Tests for polar-products billing helpers (Phase 2.6).
 *
 * These tests enforce exact integer-cent math and spec-mandated pricing
 * constants. Any price change must fail tests first — intentional red-green.
 *
 * @module billing/__tests__/polar-products
 */

import { describe, it, expect } from 'vitest';
import {
  TIER_DEFINITIONS,
  TierDefinition,
  calculateMonthlyCostCents,
  calculateAnnualCostCents,
  validateSeatCount,
  calculateProrationCents,
} from '../polar-products.js';

// ============================================================================
// TIER_DEFINITIONS spec compliance
// ============================================================================

describe('TIER_DEFINITIONS', () => {
  it('team: $19/seat, 3 min seats, $57 floor', () => {
    expect(TIER_DEFINITIONS.team.seatPriceCents).toBe(1900);
    expect(TIER_DEFINITIONS.team.minSeats).toBe(3);
    expect(TIER_DEFINITIONS.team.floorCents).toBe(5700);
  });

  it('team: 17% annual discount (1700 bps)', () => {
    expect(TIER_DEFINITIONS.team.annualDiscountBps).toBe(1700);
  });

  it('business: $39/seat, 10 min seats, $390 floor', () => {
    expect(TIER_DEFINITIONS.business.seatPriceCents).toBe(3900);
    expect(TIER_DEFINITIONS.business.minSeats).toBe(10);
    expect(TIER_DEFINITIONS.business.floorCents).toBe(39000);
  });

  it('business: 17% annual discount (1700 bps)', () => {
    expect(TIER_DEFINITIONS.business.annualDiscountBps).toBe(1700);
  });

  it('enterprise: custom (zeros)', () => {
    expect(TIER_DEFINITIONS.enterprise.seatPriceCents).toBe(0);
    expect(TIER_DEFINITIONS.enterprise.minSeats).toBe(0);
    expect(TIER_DEFINITIONS.enterprise.floorCents).toBe(0);
    expect(TIER_DEFINITIONS.enterprise.annualDiscountBps).toBe(0);
  });

  it('team and business have productIdEnvVar and annualProductIdEnvVar', () => {
    // WHY only team/business: enterprise deals are bespoke Polar orders created
    // ad-hoc by sales. There is no single product ID for all enterprise accounts,
    // so productIdEnvVar/annualProductIdEnvVar are intentionally absent from the
    // enterprise definition to force callers to guard before reading them.
    for (const name of ['team', 'business'] as const) {
      const def = TIER_DEFINITIONS[name];
      expect(typeof def.productIdEnvVar, `${name}.productIdEnvVar`).toBe('string');
      expect(def.productIdEnvVar!.length, `${name}.productIdEnvVar non-empty`).toBeGreaterThan(0);
      expect(typeof def.annualProductIdEnvVar, `${name}.annualProductIdEnvVar`).toBe('string');
      expect(def.annualProductIdEnvVar!.length, `${name}.annualProductIdEnvVar non-empty`).toBeGreaterThan(0);
    }
  });

  it('enterprise does NOT have productIdEnvVar or annualProductIdEnvVar', () => {
    // WHY: enterprise Polar orders are custom/bespoke; no pre-defined product ID.
    // Callers must route enterprise customers to the sales flow, not Polar checkout.
    // Cast through TierDefinition (the declared interface type) to access the
    // optional fields — TypeScript's `as const satisfies` narrows the enterprise
    // literal to only its defined keys, so we widen to the interface for the check.
    const enterpriseDef = TIER_DEFINITIONS.enterprise as TierDefinition;
    expect(enterpriseDef.productIdEnvVar).toBeUndefined();
    expect(enterpriseDef.annualProductIdEnvVar).toBeUndefined();
  });

  it('floorCents equals minSeats * seatPriceCents for team and business', () => {
    expect(TIER_DEFINITIONS.team.floorCents).toBe(
      TIER_DEFINITIONS.team.minSeats * TIER_DEFINITIONS.team.seatPriceCents,
    );
    expect(TIER_DEFINITIONS.business.floorCents).toBe(
      TIER_DEFINITIONS.business.minSeats * TIER_DEFINITIONS.business.seatPriceCents,
    );
  });
});

// ============================================================================
// calculateMonthlyCostCents
// ============================================================================

describe('calculateMonthlyCostCents', () => {
  it('team × 3 = 5700 (floor)', () => {
    expect(calculateMonthlyCostCents('team', 3)).toBe(5700);
  });

  it('team × 5 = 9500', () => {
    expect(calculateMonthlyCostCents('team', 5)).toBe(9500);
  });

  it('business × 10 = 39000 (floor)', () => {
    expect(calculateMonthlyCostCents('business', 10)).toBe(39000);
  });

  it('business × 15 = 58500', () => {
    expect(calculateMonthlyCostCents('business', 15)).toBe(58500);
  });

  it('enterprise always returns 0 (custom pricing)', () => {
    expect(calculateMonthlyCostCents('enterprise', 1)).toBe(0);
    expect(calculateMonthlyCostCents('enterprise', 100)).toBe(0);
  });

  it('returns an integer (no fractional cents)', () => {
    const result = calculateMonthlyCostCents('team', 7);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ============================================================================
// calculateAnnualCostCents
// ============================================================================

describe('calculateAnnualCostCents', () => {
  // WHY exact value: team×3 annual = 5700×12×(10000−1700)/10000
  //   = 68400 × 8300 / 10000
  //   = 567720000 / 10000
  //   = 56772
  it('team × 3 annual = 56772 cents (17% off 68400)', () => {
    expect(calculateAnnualCostCents('team', 3)).toBe(56772);
  });

  it('team × 5 annual: 9500×12×8300/10000 = 94620', () => {
    // 9500 × 12 = 114000 (monthly × 12); 114000 × 8300 / 10000 = 94620 (after 17% annual discount)
    expect(calculateAnnualCostCents('team', 5)).toBe(94620);
  });

  it('business × 10 annual: 39000×12×8300/10000 = 388440', () => {
    // 39000 × 12 = 468000; 468000 × 8300 / 10000 = 388440
    expect(calculateAnnualCostCents('business', 10)).toBe(388440);
  });

  it('enterprise annual always returns 0', () => {
    expect(calculateAnnualCostCents('enterprise', 10)).toBe(0);
  });

  it('result is always an integer (Math.floor applied)', () => {
    const result = calculateAnnualCostCents('team', 7);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ============================================================================
// validateSeatCount
// ============================================================================

describe('validateSeatCount', () => {
  it('accepts minimum seat count for team (3)', () => {
    const result = validateSeatCount('team', 3);
    expect(result.ok).toBe(true);
  });

  it('accepts above minimum for team (10)', () => {
    const result = validateSeatCount('team', 10);
    expect(result.ok).toBe(true);
  });

  it('rejects 2 for team (below 3-seat minimum)', () => {
    const result = validateSeatCount('team', 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.minSeats).toBe(3);
      expect(typeof result.reason).toBe('string');
    }
  });

  it('rejects negative values', () => {
    const result = validateSeatCount('team', -1);
    expect(result.ok).toBe(false);
  });

  it('rejects non-integer (fractional) values', () => {
    const result = validateSeatCount('team', 2.5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/integer/i);
    }
  });

  it('rejects NaN', () => {
    const result = validateSeatCount('team', NaN);
    expect(result.ok).toBe(false);
  });

  it('rejects 0', () => {
    const result = validateSeatCount('team', 0);
    expect(result.ok).toBe(false);
  });

  it('accepts minimum seat count for business (10)', () => {
    const result = validateSeatCount('business', 10);
    expect(result.ok).toBe(true);
  });

  it('rejects 9 for business (below 10-seat minimum)', () => {
    const result = validateSeatCount('business', 9);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.minSeats).toBe(10);
    }
  });

  it('enterprise: accepts 1 seat (no minimum enforced)', () => {
    // WHY: enterprise is custom; seat count validated by sales, not code.
    const result = validateSeatCount('enterprise', 1);
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// calculateProrationCents
// ============================================================================

describe('calculateProrationCents', () => {
  // WHY exact value:
  //   delta = 2 seats; price = $19/seat/month = 1900 cents
  //   fraction = (30 - 15) / 30 = 0.5
  //   proration = 2 × 1900 × 0.5 = 1900 cents
  it('team 3→5 mid-cycle (15/30 elapsed) = 1900 cents EXACT', () => {
    expect(
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 15,
        daysInCycle: 30,
      }),
    ).toBe(1900);
  });

  it('returns 0 when oldSeats equals newSeats (no-op upgrade)', () => {
    expect(
      calculateProrationCents({
        oldSeats: 5,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 10,
        daysInCycle: 30,
      }),
    ).toBe(0);
  });

  it('returns 0 when daysElapsed is 0 (start of cycle, full charge via Polar)', () => {
    expect(
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 0,
        daysInCycle: 30,
      }),
    ).toBe(0);
  });

  it('returns 0 when daysElapsed equals daysInCycle (end of cycle already charged)', () => {
    expect(
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 30,
        daysInCycle: 30,
      }),
    ).toBe(0);
  });

  it('business 10→12 with 10/31 elapsed: 2 × 3900 × (21/31) = 5283 cents', () => {
    // 2 × 3900 = 7800; remaining = 21/31; 7800 × 21 / 31 = 163800/31 = 5283.87...
    // floor → 5283
    expect(
      calculateProrationCents({
        oldSeats: 10,
        newSeats: 12,
        tier: 'business',
        daysElapsed: 10,
        daysInCycle: 31,
      }),
    ).toBe(5283);
  });

  it('enterprise always returns 0 (custom pricing)', () => {
    expect(
      calculateProrationCents({
        oldSeats: 5,
        newSeats: 10,
        tier: 'enterprise',
        daysElapsed: 15,
        daysInCycle: 30,
      }),
    ).toBe(0);
  });

  it('throws on negative daysElapsed', () => {
    expect(() =>
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: -1,
        daysInCycle: 30,
      }),
    ).toThrow();
  });

  it('throws on daysElapsed > daysInCycle', () => {
    expect(() =>
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 31,
        daysInCycle: 30,
      }),
    ).toThrow();
  });

  it('throws on non-integer oldSeats', () => {
    expect(() =>
      calculateProrationCents({
        oldSeats: 3.5,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 10,
        daysInCycle: 30,
      }),
    ).toThrow();
  });

  it('throws on non-integer newSeats', () => {
    expect(() =>
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5.5,
        tier: 'team',
        daysElapsed: 10,
        daysInCycle: 30,
      }),
    ).toThrow();
  });

  it('result is always an integer', () => {
    const result = calculateProrationCents({
      oldSeats: 3,
      newSeats: 7,
      tier: 'team',
      daysElapsed: 10,
      daysInCycle: 30,
    });
    expect(Number.isInteger(result)).toBe(true);
  });

  // ── NaN / Infinity / non-integer guards (Fix 1 — CRITICAL billing integrity) ──
  //
  // WHY these cases: IEEE-754 semantics mean NaN comparisons always return false,
  // so guards like `x < 0` silently accept NaN. `daysInCycle: 0` produces
  // Infinity via division. These tests enforce that the validated input layer
  // rejects every malformed value before it can reach the proration formula.

  it('throws RangeError with "daysElapsed" when daysElapsed is NaN', () => {
    expect(() =>
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: NaN,
        daysInCycle: 30,
      }),
    ).toThrow(/daysElapsed/);
  });

  it('throws RangeError with "daysInCycle" when daysInCycle is NaN', () => {
    expect(() =>
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 15,
        daysInCycle: NaN,
      }),
    ).toThrow(/daysInCycle/);
  });

  it('throws RangeError mentioning "positive integer" when daysInCycle is 0', () => {
    expect(() =>
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 0,
        daysInCycle: 0,
      }),
    ).toThrow(/positive integer/i);
  });

  it('throws RangeError when daysInCycle is Infinity', () => {
    expect(() =>
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 15,
        daysInCycle: Infinity,
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError mentioning "integer" when daysElapsed is non-integer (2.5)', () => {
    expect(() =>
      calculateProrationCents({
        oldSeats: 3,
        newSeats: 5,
        tier: 'team',
        daysElapsed: 2.5,
        daysInCycle: 30,
      }),
    ).toThrow(/integer/i);
  });
});
