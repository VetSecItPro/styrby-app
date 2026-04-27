/**
 * Tests for Polar billing module — Pro + Growth (Phase 5 reconciliation).
 *
 * Tests the pure functions and constants that handle tier configuration,
 * pricing calculations, and product ID resolution.
 *
 * Post-Phase-5 the canonical paid tiers are Pro ($39 individual) and Growth
 * ($99 base + $19/seat team). The pre-rename `'power'` tier no longer
 * exists in TIERS — its capability set lives on Pro post-rename, and team
 * features live on Growth.
 */

import { describe, it, expect, vi } from 'vitest';
import { TIERS, getTier, getProductId, getDisplayPrice, type TierId } from '../polar';

// Mock the Polar SDK to prevent actual API calls during tests
vi.mock('@polar-sh/sdk', () => ({
  Polar: vi.fn().mockImplementation(() => ({})),
}));

describe('Polar Billing Module — Phase 5 (Pro + Growth)', () => {
  describe('TIERS constants', () => {
    it('should have all 3 tiers defined', () => {
      expect(TIERS).toHaveProperty('free');
      expect(TIERS).toHaveProperty('pro');
      expect(TIERS).toHaveProperty('growth');
      expect(Object.keys(TIERS)).toHaveLength(3);
    });

    describe('Free tier', () => {
      it('has the expected limits shape', () => {
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

      it('has zero pricing', () => {
        expect(TIERS.free.price.monthly).toBe(0);
        expect(TIERS.free.price.annual).toBe(0);
      });

      it('has undefined product IDs', () => {
        expect(TIERS.free.polarProductId.monthly).toBeUndefined();
        expect(TIERS.free.polarProductId.annual).toBeUndefined();
      });

      it('has correct metadata', () => {
        expect(TIERS.free.id).toBe('free');
        expect(TIERS.free.name).toBe('Free');
        expect(TIERS.free.features).toBeInstanceOf(Array);
        expect(TIERS.free.features.length).toBeGreaterThan(0);
      });
    });

    describe('Pro tier ($39 individual paid)', () => {
      it('has the expected limits shape', () => {
        expect(TIERS.pro.limits).toEqual({
          machines: 9,
          historyDays: 365,
          messagesPerMonth: 100_000,
          budgetAlerts: 5,
          webhooks: 10,
          teamMembers: 1,
          apiKeys: 5,
          bookmarks: -1,
          promptTemplates: -1,
        });
      });

      it('has $39/mo $390/yr pricing (Decision #2)', () => {
        expect(TIERS.pro.price.monthly).toBe(39);
        expect(TIERS.pro.price.annual).toBe(390);
      });

      it('has correct metadata', () => {
        expect(TIERS.pro.id).toBe('pro');
        expect(TIERS.pro.name).toBe('Pro');
      });
    });

    describe('Growth tier ($99 base + $19/seat team)', () => {
      it('has the expected limits shape (team features)', () => {
        expect(TIERS.growth.limits.machines).toBe(9);
        expect(TIERS.growth.limits.historyDays).toBe(365);
        expect(TIERS.growth.limits.teamMembers).toBe(100);
      });

      it('has $99/mo $990/yr base pricing (Decision #3 / #4)', () => {
        expect(TIERS.growth.price.monthly).toBe(99);
        expect(TIERS.growth.price.annual).toBe(990);
      });

      it('has correct metadata', () => {
        expect(TIERS.growth.id).toBe('growth');
        expect(TIERS.growth.name).toBe('Growth');
      });
    });

    describe('Tier progression', () => {
      it('Growth >= Pro >= Free for monthly price', () => {
        expect(TIERS.growth.price.monthly).toBeGreaterThanOrEqual(TIERS.pro.price.monthly);
        expect(TIERS.pro.price.monthly).toBeGreaterThanOrEqual(TIERS.free.price.monthly);
      });

      it('Pro and Growth share the same single-user limits where appropriate', () => {
        // Both grant the full machine cap and history retention; Growth adds
        // team features on top.
        expect(TIERS.pro.limits.machines).toBe(TIERS.growth.limits.machines);
        expect(TIERS.pro.limits.historyDays).toBe(TIERS.growth.limits.historyDays);
      });
    });

    describe('Annual pricing', () => {
      it('Pro annual is less than 12× monthly (~17% off)', () => {
        const proMonthlyTotal = TIERS.pro.price.monthly * 12;
        expect(TIERS.pro.price.annual).toBeLessThan(proMonthlyTotal);
      });

      it('Growth annual is less than 12× monthly base', () => {
        const growthMonthlyTotal = TIERS.growth.price.monthly * 12;
        expect(TIERS.growth.price.annual).toBeLessThan(growthMonthlyTotal);
      });

      it('Free tier annual = monthly (no discount needed)', () => {
        expect(TIERS.free.price.annual).toBe(TIERS.free.price.monthly);
        expect(TIERS.free.price.annual).toBe(0);
      });
    });
  });

  describe('getTier()', () => {
    it('returns free tier when given "free"', () => {
      expect(getTier('free')).toEqual(TIERS.free);
    });

    it('returns pro tier when given "pro"', () => {
      expect(getTier('pro')).toEqual(TIERS.pro);
    });

    it('returns growth tier when given "growth"', () => {
      expect(getTier('growth')).toEqual(TIERS.growth);
    });

    it('falls back to free for unknown tier ID (fail-closed)', () => {
      const unknownTier = 'enterprise' as unknown as TierId;
      expect(getTier(unknownTier)).toEqual(TIERS.free);
    });
  });

  describe('getProductId()', () => {
    it('returns undefined for free tier', () => {
      expect(getProductId('free', 'monthly')).toBeUndefined();
      expect(getProductId('free', 'annual')).toBeUndefined();
    });

    it('returns process.env value for pro tier', () => {
      expect(getProductId('pro', 'monthly')).toBe(process.env.POLAR_PRO_MONTHLY_PRODUCT_ID);
      expect(getProductId('pro', 'annual')).toBe(process.env.POLAR_PRO_ANNUAL_PRODUCT_ID);
    });

    it('returns process.env value for growth tier', () => {
      expect(getProductId('growth', 'monthly')).toBe(process.env.POLAR_GROWTH_MONTHLY_PRODUCT_ID);
      expect(getProductId('growth', 'annual')).toBe(process.env.POLAR_GROWTH_ANNUAL_PRODUCT_ID);
    });
  });

  describe('getDisplayPrice()', () => {
    it('returns $0/month for free tier', () => {
      expect(getDisplayPrice('free', 'monthly')).toEqual({ amount: 0, period: '/month' });
    });

    it('returns $39/month for pro tier', () => {
      expect(getDisplayPrice('pro', 'monthly')).toEqual({ amount: 39, period: '/month' });
    });

    it('returns $99/month for growth tier', () => {
      expect(getDisplayPrice('growth', 'monthly')).toEqual({ amount: 99, period: '/month' });
    });

    it('returns $390/year for pro tier', () => {
      expect(getDisplayPrice('pro', 'annual')).toEqual({ amount: 390, period: '/year' });
    });

    it('returns $990/year for growth tier', () => {
      expect(getDisplayPrice('growth', 'annual')).toEqual({ amount: 990, period: '/year' });
    });

    it('always returns "/month" for monthly cycle', () => {
      expect(getDisplayPrice('free', 'monthly').period).toBe('/month');
      expect(getDisplayPrice('pro', 'monthly').period).toBe('/month');
      expect(getDisplayPrice('growth', 'monthly').period).toBe('/month');
    });

    it('always returns "/year" for annual cycle', () => {
      expect(getDisplayPrice('free', 'annual').period).toBe('/year');
      expect(getDisplayPrice('pro', 'annual').period).toBe('/year');
      expect(getDisplayPrice('growth', 'annual').period).toBe('/year');
    });
  });
});
