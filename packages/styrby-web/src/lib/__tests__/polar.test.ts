/**
 * Tests for Polar billing module.
 *
 * Tests the pure functions and constants that handle tier configuration,
 * pricing calculations, and product ID resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TIERS,
  getTier,
  getProductId,
  getDisplayPrice,
  STYRBY_PRORATION_BEHAVIOR,
  getPolarServer,
  getTeamSeatProductId,
  isTeamSeatProduct,
  type TierId,
} from '../polar';

// Mock the Polar SDK to prevent actual API calls during tests
vi.mock('@polar-sh/sdk', () => ({
  Polar: vi.fn().mockImplementation(() => ({})),
}));

describe('Polar Billing Module', () => {
  describe('TIERS constants', () => {
    it('should have all 3 tiers defined', () => {
      expect(TIERS).toHaveProperty('free');
      expect(TIERS).toHaveProperty('pro');
      expect(TIERS).toHaveProperty('power');
      expect(Object.keys(TIERS)).toHaveLength(3);
    });

    describe('Free tier', () => {
      it('should have correct limits', () => {
        expect(TIERS.free.limits).toEqual({
          machines: 1,
          historyDays: 7,
          messagesPerMonth: 1_000,
          budgetAlerts: 1,
          webhooks: 0,
          teamMembers: 1,
          apiKeys: 0,
          bookmarks: 5,
          promptTemplates: 3,
        });
      });

      it('should have zero pricing', () => {
        expect(TIERS.free.price.monthly).toBe(0);
        expect(TIERS.free.price.annual).toBe(0);
      });

      it('should have undefined product IDs', () => {
        expect(TIERS.free.polarProductId.monthly).toBeUndefined();
        expect(TIERS.free.polarProductId.annual).toBeUndefined();
      });

      it('should have correct metadata', () => {
        expect(TIERS.free.id).toBe('free');
        expect(TIERS.free.name).toBe('Free');
        expect(TIERS.free.features).toBeInstanceOf(Array);
        expect(TIERS.free.features.length).toBeGreaterThan(0);
      });
    });

    describe('Pro tier', () => {
      it('should have correct limits', () => {
        expect(TIERS.pro.limits).toEqual({
          machines: 3,
          historyDays: 90,
          messagesPerMonth: 25_000,
          budgetAlerts: 3,
          webhooks: 3,
          teamMembers: 1,
          apiKeys: 0,
          bookmarks: 50,
          promptTemplates: 20,
        });
      });

      it('should have correct pricing', () => {
        expect(TIERS.pro.price.monthly).toBe(24);
        expect(TIERS.pro.price.annual).toBe(240);
      });

      it('should have correct metadata', () => {
        expect(TIERS.pro.id).toBe('pro');
        expect(TIERS.pro.name).toBe('Pro');
        expect(TIERS.pro.features).toBeInstanceOf(Array);
        expect(TIERS.pro.features.length).toBeGreaterThan(0);
      });
    });

    describe('Power tier', () => {
      it('should have correct limits', () => {
        expect(TIERS.power.limits).toEqual({
          machines: 9,
          historyDays: 365,
          messagesPerMonth: 100_000,
          budgetAlerts: 5,
          webhooks: 10,
          teamMembers: 3,
          apiKeys: 5,
          bookmarks: -1,
          promptTemplates: -1,
        });
      });

      it('should have correct pricing', () => {
        expect(TIERS.power.price.monthly).toBe(59);
        expect(TIERS.power.price.annual).toBe(590);
      });

      it('should have correct metadata', () => {
        expect(TIERS.power.id).toBe('power');
        expect(TIERS.power.name).toBe('Power');
        expect(TIERS.power.features).toBeInstanceOf(Array);
        expect(TIERS.power.features.length).toBeGreaterThan(0);
      });
    });

    describe('Tier progression', () => {
      it('should have increasing machine limits (Power >= Pro >= Free)', () => {
        expect(TIERS.power.limits.machines).toBeGreaterThanOrEqual(TIERS.pro.limits.machines);
        expect(TIERS.pro.limits.machines).toBeGreaterThanOrEqual(TIERS.free.limits.machines);
      });

      it('should have increasing history days (Power >= Pro >= Free)', () => {
        expect(TIERS.power.limits.historyDays).toBeGreaterThanOrEqual(TIERS.pro.limits.historyDays);
        expect(TIERS.pro.limits.historyDays).toBeGreaterThanOrEqual(TIERS.free.limits.historyDays);
      });

      it('should have increasing message limits (Power >= Pro >= Free)', () => {
        expect(TIERS.power.limits.messagesPerMonth).toBeGreaterThanOrEqual(TIERS.pro.limits.messagesPerMonth);
        expect(TIERS.pro.limits.messagesPerMonth).toBeGreaterThanOrEqual(TIERS.free.limits.messagesPerMonth);
      });

      it('should have increasing budget alert limits (Power >= Pro >= Free)', () => {
        expect(TIERS.power.limits.budgetAlerts).toBeGreaterThanOrEqual(TIERS.pro.limits.budgetAlerts);
        expect(TIERS.pro.limits.budgetAlerts).toBeGreaterThanOrEqual(TIERS.free.limits.budgetAlerts);
      });

      it('should have increasing webhook limits (Power >= Pro >= Free)', () => {
        expect(TIERS.power.limits.webhooks).toBeGreaterThanOrEqual(TIERS.pro.limits.webhooks);
        expect(TIERS.pro.limits.webhooks).toBeGreaterThanOrEqual(TIERS.free.limits.webhooks);
      });

      it('should have increasing team member limits (Power >= Pro >= Free)', () => {
        expect(TIERS.power.limits.teamMembers).toBeGreaterThanOrEqual(TIERS.pro.limits.teamMembers);
        expect(TIERS.pro.limits.teamMembers).toBeGreaterThanOrEqual(TIERS.free.limits.teamMembers);
      });

      it('should have increasing API key limits (Power >= Pro >= Free)', () => {
        expect(TIERS.power.limits.apiKeys).toBeGreaterThanOrEqual(TIERS.pro.limits.apiKeys);
        expect(TIERS.pro.limits.apiKeys).toBeGreaterThanOrEqual(TIERS.free.limits.apiKeys);
      });

      it('should have increasing monthly prices (Power >= Pro >= Free)', () => {
        expect(TIERS.power.price.monthly).toBeGreaterThanOrEqual(TIERS.pro.price.monthly);
        expect(TIERS.pro.price.monthly).toBeGreaterThanOrEqual(TIERS.free.price.monthly);
      });

      it('should have increasing annual prices (Power >= Pro >= Free)', () => {
        expect(TIERS.power.price.annual).toBeGreaterThanOrEqual(TIERS.pro.price.annual);
        expect(TIERS.pro.price.annual).toBeGreaterThanOrEqual(TIERS.free.price.annual);
      });
    });

    describe('Annual pricing discount', () => {
      it('should give Pro users ~2 months free (annual < 12 * monthly)', () => {
        const proMonthlyTotal = TIERS.pro.price.monthly * 12;
        expect(TIERS.pro.price.annual).toBeLessThan(proMonthlyTotal);
        // Should be equivalent to ~10 months
        expect(TIERS.pro.price.annual).toBe(240);
        expect(proMonthlyTotal).toBe(288);
      });

      it('should give Power users ~2 months free (annual < 12 * monthly)', () => {
        const powerMonthlyTotal = TIERS.power.price.monthly * 12;
        expect(TIERS.power.price.annual).toBeLessThan(powerMonthlyTotal);
        // Should be equivalent to ~10 months
        expect(TIERS.power.price.annual).toBe(590);
        expect(powerMonthlyTotal).toBe(708);
      });

      it('should have Free tier annual = monthly (no discount needed)', () => {
        expect(TIERS.free.price.annual).toBe(TIERS.free.price.monthly);
        expect(TIERS.free.price.annual).toBe(0);
      });
    });
  });

  describe('getTier()', () => {
    it('should return free tier when given "free"', () => {
      const tier = getTier('free');
      expect(tier).toEqual(TIERS.free);
      expect(tier.id).toBe('free');
    });

    it('should return pro tier when given "pro"', () => {
      const tier = getTier('pro');
      expect(tier).toEqual(TIERS.pro);
      expect(tier.id).toBe('pro');
    });

    it('should return power tier when given "power"', () => {
      const tier = getTier('power');
      expect(tier).toEqual(TIERS.power);
      expect(tier.id).toBe('power');
    });

    it('should return free tier for unknown tier ID (fallback)', () => {
      // TypeScript would prevent this, but test runtime fallback
      const unknownTier = 'enterprise' as TierId;
      const tier = getTier(unknownTier);
      expect(tier).toEqual(TIERS.free);
    });
  });

  describe('getProductId()', () => {
    describe('Free tier', () => {
      it('should return undefined for free tier monthly', () => {
        const productId = getProductId('free', 'monthly');
        expect(productId).toBeUndefined();
      });

      it('should return undefined for free tier annual', () => {
        const productId = getProductId('free', 'annual');
        expect(productId).toBeUndefined();
      });
    });

    describe('Pro tier', () => {
      it('should return process.env value for pro monthly', () => {
        const productId = getProductId('pro', 'monthly');
        expect(productId).toBe(process.env.POLAR_PRO_MONTHLY_PRODUCT_ID);
      });

      it('should return process.env value for pro annual', () => {
        const productId = getProductId('pro', 'annual');
        expect(productId).toBe(process.env.POLAR_PRO_ANNUAL_PRODUCT_ID);
      });
    });

    describe('Power tier', () => {
      it('should return process.env value for power monthly', () => {
        const productId = getProductId('power', 'monthly');
        expect(productId).toBe(process.env.POLAR_POWER_MONTHLY_PRODUCT_ID);
      });

      it('should return process.env value for power annual', () => {
        const productId = getProductId('power', 'annual');
        expect(productId).toBe(process.env.POLAR_POWER_ANNUAL_PRODUCT_ID);
      });
    });
  });

  describe('getDisplayPrice()', () => {
    describe('Monthly pricing', () => {
      it('should return $0/month for free tier', () => {
        const price = getDisplayPrice('free', 'monthly');
        expect(price).toEqual({
          amount: 0,
          period: '/month',
        });
      });

      it('should return $24/month for pro tier', () => {
        const price = getDisplayPrice('pro', 'monthly');
        expect(price).toEqual({
          amount: 24,
          period: '/month',
        });
      });

      it('should return $59/month for power tier', () => {
        const price = getDisplayPrice('power', 'monthly');
        expect(price).toEqual({
          amount: 59,
          period: '/month',
        });
      });
    });

    describe('Annual pricing', () => {
      it('should return $0/year for free tier', () => {
        const price = getDisplayPrice('free', 'annual');
        expect(price).toEqual({
          amount: 0,
          period: '/year',
        });
      });

      it('should return $240/year for pro tier', () => {
        const price = getDisplayPrice('pro', 'annual');
        expect(price).toEqual({
          amount: 240,
          period: '/year',
        });
      });

      it('should return $590/year for power tier', () => {
        const price = getDisplayPrice('power', 'annual');
        expect(price).toEqual({
          amount: 590,
          period: '/year',
        });
      });
    });

    describe('Period string', () => {
      it('should always return "/month" for monthly cycle', () => {
        expect(getDisplayPrice('free', 'monthly').period).toBe('/month');
        expect(getDisplayPrice('pro', 'monthly').period).toBe('/month');
        expect(getDisplayPrice('power', 'monthly').period).toBe('/month');
      });

      it('should always return "/year" for annual cycle', () => {
        expect(getDisplayPrice('free', 'annual').period).toBe('/year');
        expect(getDisplayPrice('pro', 'annual').period).toBe('/year');
        expect(getDisplayPrice('power', 'annual').period).toBe('/year');
      });
    });
  });
});

// ============================================================================
// Polar helpers ported from Kaulby — Bug #6 (no proration) + H7 (POLAR_ENV)
// ============================================================================

describe('STYRBY_PRORATION_BEHAVIOR', () => {
  it('is the literal string "next_period" (no proration policy)', () => {
    // WHY: This constant is the wire-level value Polar accepts to skip
    // proration on subscription updates. If this drifts to "prorate" or
    // "invoice" we lose Bug #6 protection — partial refunds resume.
    expect(STYRBY_PRORATION_BEHAVIOR).toBe('next_period');
  });
});

describe('getPolarServer()', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns "sandbox" when POLAR_ENV === "sandbox"', () => {
    vi.stubEnv('POLAR_ENV', 'sandbox');
    expect(getPolarServer()).toBe('sandbox');
  });

  it('returns "production" when POLAR_ENV is unset', () => {
    vi.stubEnv('POLAR_ENV', '');
    expect(getPolarServer()).toBe('production');
  });

  it('returns "production" when POLAR_ENV === "production"', () => {
    vi.stubEnv('POLAR_ENV', 'production');
    expect(getPolarServer()).toBe('production');
  });

  it('returns "production" for any value other than the literal "sandbox"', () => {
    // WHY strict equality: we only flip to sandbox on the exact string. Typos
    // like "Sandbox" or "test" must NOT route to sandbox — they must fail
    // closed to production so accidental misconfig doesn't ship test traffic
    // against the production billing surface.
    vi.stubEnv('POLAR_ENV', 'Sandbox');
    expect(getPolarServer()).toBe('production');
    vi.stubEnv('POLAR_ENV', 'test');
    expect(getPolarServer()).toBe('production');
    vi.stubEnv('POLAR_ENV', 'staging');
    expect(getPolarServer()).toBe('production');
  });
});

describe('getTeamSeatProductId()', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the monthly seat env var for "monthly"', () => {
    vi.stubEnv('POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID', 'prod_seat_mo_123');
    vi.stubEnv('POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID', 'prod_seat_yr_456');
    expect(getTeamSeatProductId('monthly')).toBe('prod_seat_mo_123');
  });

  it('returns the annual seat env var for "annual"', () => {
    vi.stubEnv('POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID', 'prod_seat_mo_123');
    vi.stubEnv('POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID', 'prod_seat_yr_456');
    expect(getTeamSeatProductId('annual')).toBe('prod_seat_yr_456');
  });

  it('does not cross interval (monthly call must not return annual id)', () => {
    vi.stubEnv('POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID', 'prod_seat_mo_123');
    vi.stubEnv('POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID', 'prod_seat_yr_456');
    expect(getTeamSeatProductId('monthly')).not.toBe('prod_seat_yr_456');
    expect(getTeamSeatProductId('annual')).not.toBe('prod_seat_mo_123');
  });

  it('returns null when the matching env var is unset', () => {
    vi.stubEnv('POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID', '');
    vi.stubEnv('POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID', '');
    expect(getTeamSeatProductId('monthly')).toBeNull();
    expect(getTeamSeatProductId('annual')).toBeNull();
  });
});

describe('isTeamSeatProduct()', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID', 'prod_seat_mo_123');
    vi.stubEnv('POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID', 'prod_seat_yr_456');
  });

  it('returns true for the monthly seat product id', () => {
    expect(isTeamSeatProduct('prod_seat_mo_123')).toBe(true);
  });

  it('returns true for the annual seat product id', () => {
    expect(isTeamSeatProduct('prod_seat_yr_456')).toBe(true);
  });

  it('returns false for an unrelated product id (base plan, etc.)', () => {
    expect(isTeamSeatProduct('prod_pro_mo_xyz')).toBe(false);
    expect(isTeamSeatProduct('prod_power_yr_zzz')).toBe(false);
  });

  it('returns false for the empty string', () => {
    // WHY: Polar webhook payloads can carry an empty product id during
    // rare partial-payload edge cases. Returning true for "" would falsely
    // classify those as seat products and skew seat accounting.
    expect(isTeamSeatProduct('')).toBe(false);
  });

  it('returns false when both seat env vars are unset (no false positives)', () => {
    vi.stubEnv('POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID', '');
    vi.stubEnv('POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID', '');
    // Even if a real-looking id is passed, both env vars empty → never a seat
    expect(isTeamSeatProduct('prod_seat_mo_123')).toBe(false);
  });
});
