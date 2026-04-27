/**
 * Tests for `lib/billing/tier-config.ts` — pure-data tier configuration.
 *
 * WHY these are colocated:
 *   The module is the SDK-free counterpart to `lib/polar.ts` so it can be
 *   imported from `'use client'` components without bundling the Polar SDK.
 *   Tests live next to the source (TEST-003 in the /test-ship audit).
 *
 * @see ../tier-config.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TIERS,
  getTier,
  getProductId,
  getDisplayPrice,
  type TierId,
} from '../tier-config';

describe('TIERS — canonical 3-tier config (free + pro + growth)', () => {
  it('has exactly the three canonical tiers', () => {
    expect(Object.keys(TIERS).sort()).toEqual(['free', 'growth', 'pro']);
  });

  it('Free has zero pricing and undefined product ids', () => {
    expect(TIERS.free.price.monthly).toBe(0);
    expect(TIERS.free.price.annual).toBe(0);
    expect(TIERS.free.polarProductId.monthly).toBeUndefined();
    expect(TIERS.free.polarProductId.annual).toBeUndefined();
  });

  it('Pro has $39/$390 pricing (Decision #2)', () => {
    expect(TIERS.pro.price.monthly).toBe(39);
    expect(TIERS.pro.price.annual).toBe(390);
  });

  it('Growth has $99/$990 base pricing + 100-seat ceiling (Decisions #3 / #4)', () => {
    expect(TIERS.growth.price.monthly).toBe(99);
    expect(TIERS.growth.price.annual).toBe(990);
    expect(TIERS.growth.limits.teamMembers).toBe(100);
  });
});

describe('getTier()', () => {
  it('returns each canonical tier by id', () => {
    expect(getTier('free')).toBe(TIERS.free);
    expect(getTier('pro')).toBe(TIERS.pro);
    expect(getTier('growth')).toBe(TIERS.growth);
  });

  it('falls back to Free for any unknown id (SOC2 CC6.1 — fail closed)', () => {
    // WHY: paid limits must never leak to a malformed tier value.
    const unknown = 'enterprise' as unknown as TierId;
    expect(getTier(unknown)).toBe(TIERS.free);
  });
});

describe('getProductId() — env-driven Polar product resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns undefined for free tier (no Polar product)', () => {
    expect(getProductId('free', 'monthly')).toBeUndefined();
    expect(getProductId('free', 'annual')).toBeUndefined();
  });

  it('returns the Pro monthly env var when set', async () => {
    vi.stubEnv('POLAR_PRO_MONTHLY_PRODUCT_ID', 'prod_pro_mo_set');
    // WHY re-import: TIERS is built at module load time, so we re-evaluate
    // the module to pick up the freshly stubbed env var.
    const mod = await vi.importActual<typeof import('../tier-config')>('../tier-config');
    expect(mod.getProductId('pro', 'monthly')).toBe('prod_pro_mo_set');
  });

  it('returns the Pro annual env var when set', async () => {
    vi.stubEnv('POLAR_PRO_ANNUAL_PRODUCT_ID', 'prod_pro_yr_set');
    const mod = await vi.importActual<typeof import('../tier-config')>('../tier-config');
    expect(mod.getProductId('pro', 'annual')).toBe('prod_pro_yr_set');
  });

  it('returns the Growth monthly env var when set', async () => {
    vi.stubEnv('POLAR_GROWTH_MONTHLY_PRODUCT_ID', 'prod_growth_mo_set');
    const mod = await vi.importActual<typeof import('../tier-config')>('../tier-config');
    expect(mod.getProductId('growth', 'monthly')).toBe('prod_growth_mo_set');
  });

  it('returns the Growth annual env var when set', async () => {
    vi.stubEnv('POLAR_GROWTH_ANNUAL_PRODUCT_ID', 'prod_growth_yr_set');
    const mod = await vi.importActual<typeof import('../tier-config')>('../tier-config');
    expect(mod.getProductId('growth', 'annual')).toBe('prod_growth_yr_set');
  });

  it('returns undefined when the env var is set-but-empty (graceful Phase H12 cutover degradation)', async () => {
    // WHY this guard: previously the function returned the empty string `''`
    // when an env var was set-but-empty (Vercel's standard projection of a
    // declared-but-blank var). Empty strings coerce truthily in some `||`
    // chains and disagreed with the JSDoc `string | undefined` contract.
    // TEST-003 fix: normalise empty string → undefined so callers can
    // branch on a single sentinel. Surfaced by /test-ship audit.
    vi.stubEnv('POLAR_PRO_MONTHLY_PRODUCT_ID', '');
    vi.stubEnv('POLAR_PRO_ANNUAL_PRODUCT_ID', '');
    vi.stubEnv('POLAR_GROWTH_MONTHLY_PRODUCT_ID', '');
    vi.stubEnv('POLAR_GROWTH_ANNUAL_PRODUCT_ID', '');
    const mod = await vi.importActual<typeof import('../tier-config')>('../tier-config');

    expect(mod.getProductId('pro', 'monthly')).toBeUndefined();
    expect(mod.getProductId('pro', 'annual')).toBeUndefined();
    expect(mod.getProductId('growth', 'monthly')).toBeUndefined();
    expect(mod.getProductId('growth', 'annual')).toBeUndefined();
  });
});

describe('getDisplayPrice()', () => {
  it('returns $0/month for Free', () => {
    expect(getDisplayPrice('free', 'monthly')).toEqual({ amount: 0, period: '/month' });
  });

  it('returns $39/month and $390/year for Pro', () => {
    expect(getDisplayPrice('pro', 'monthly')).toEqual({ amount: 39, period: '/month' });
    expect(getDisplayPrice('pro', 'annual')).toEqual({ amount: 390, period: '/year' });
  });

  it('returns $99/month and $990/year for Growth (base only)', () => {
    expect(getDisplayPrice('growth', 'monthly')).toEqual({ amount: 99, period: '/month' });
    expect(getDisplayPrice('growth', 'annual')).toEqual({ amount: 990, period: '/year' });
  });
});
