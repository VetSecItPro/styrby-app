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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// WHY vi.hoisted: vi.mock factories run BEFORE module imports. Capturing the
// SDK method spies in a hoisted block lets the mock factory reference them
// while still allowing test bodies to assert against the same spies.
// Aligns with the recent PR #192 mock pattern.
const polarMocks = vi.hoisted(() => ({
  subscriptionsUpdate: vi.fn(),
  subscriptionsGet: vi.fn(),
  checkoutsCreate: vi.fn(),
}));

// Mock the Polar SDK to prevent actual API calls during tests
vi.mock('@polar-sh/sdk', () => ({
  Polar: vi.fn().mockImplementation(() => ({
    subscriptions: {
      update: polarMocks.subscriptionsUpdate,
      get: polarMocks.subscriptionsGet,
    },
    checkouts: {
      create: polarMocks.checkoutsCreate,
    },
  })),
}));

import {
  TIERS,
  getTier,
  getProductId,
  getDisplayPrice,
  STYRBY_PRORATION_BEHAVIOR,
  getPolarServer,
  getTeamSeatProductId,
  isTeamSeatProduct,
  cancelSubscription,
  getSubscription,
  createCheckoutSession,
  getCustomerPortalUrl,
  type TierId,
} from '../polar';

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

// ============================================================================
// SDK wrapper coverage — TEST-001 / Bug #6 regression guard
// ============================================================================
//
// WHY this block exists:
//   The Polar SDK wrapper functions (`cancelSubscription`,
//   `createCheckoutSession`, `getSubscription`, `getCustomerPortalUrl`) were
//   previously untested. Bug #6 was a missing `prorationBehavior` argument
//   on the cancel call that allowed Polar's org-level default (which could
//   drift to "prorate") to issue partial refunds. The tests below pin the
//   wire contract so any future drift surfaces as a test failure rather than
//   a silent billing-policy regression.

describe('cancelSubscription() — Bug #6 regression guard', () => {
  beforeEach(() => {
    polarMocks.subscriptionsUpdate.mockReset();
    polarMocks.subscriptionsGet.mockReset();
    polarMocks.checkoutsCreate.mockReset();
  });

  it('default (cancel-at-period-end) calls subscriptions.update with the no-proration policy', async () => {
    // BUG #6 GUARD: prorationBehavior MUST be 'next_period' on every
    // code-initiated cancellation. If this assertion fails, partial refunds
    // can resume on the production billing surface.
    polarMocks.subscriptionsUpdate.mockResolvedValueOnce({ id: 'sub_123', status: 'active', cancelAtPeriodEnd: true });

    const result = await cancelSubscription('sub_123');

    expect(polarMocks.subscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(polarMocks.subscriptionsUpdate).toHaveBeenCalledWith({
      id: 'sub_123',
      subscriptionUpdate: {
        cancelAtPeriodEnd: true,
        prorationBehavior: STYRBY_PRORATION_BEHAVIOR,
      },
    });
    expect(result).toEqual({ id: 'sub_123', status: 'active', cancelAtPeriodEnd: true });
  });

  it('default branch always uses the literal "next_period" (no env-derived value)', async () => {
    // Belt-and-suspenders: if STYRBY_PRORATION_BEHAVIOR ever drifted to a
    // wire-incompatible value, this asserts the hardcoded literal directly.
    polarMocks.subscriptionsUpdate.mockResolvedValueOnce({});
    await cancelSubscription('sub_abc');
    const call = polarMocks.subscriptionsUpdate.mock.calls[0][0];
    expect(call.subscriptionUpdate.prorationBehavior).toBe('next_period');
  });

  it('immediate=true uses revoke and intentionally omits prorationBehavior', async () => {
    polarMocks.subscriptionsUpdate.mockResolvedValueOnce({ id: 'sub_456', status: 'revoked' });

    const result = await cancelSubscription('sub_456', { immediate: true });

    expect(polarMocks.subscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(polarMocks.subscriptionsUpdate).toHaveBeenCalledWith({
      id: 'sub_456',
      subscriptionUpdate: { revoke: true },
    });
    // revoke is the whole-point of immediate cancellation; proration is
    // irrelevant because nothing is renewed afterward.
    const call = polarMocks.subscriptionsUpdate.mock.calls[0][0];
    expect(call.subscriptionUpdate.prorationBehavior).toBeUndefined();
    expect(result).toEqual({ id: 'sub_456', status: 'revoked' });
  });

  it('immediate=false explicitly is the same as default', async () => {
    polarMocks.subscriptionsUpdate.mockResolvedValueOnce({});
    await cancelSubscription('sub_789', { immediate: false });
    const call = polarMocks.subscriptionsUpdate.mock.calls[0][0];
    expect(call.subscriptionUpdate.cancelAtPeriodEnd).toBe(true);
    expect(call.subscriptionUpdate.prorationBehavior).toBe('next_period');
    expect(call.subscriptionUpdate.revoke).toBeUndefined();
  });

  it('propagates SDK errors to the caller (no silent swallow)', async () => {
    // WHY propagate (not swallow): the wrapper has no error handler. Callers
    // (webhook handler, settings UI) must see the failure to surface it
    // rather than continue as if cancellation succeeded. This pins the
    // contract so a future "soft-fail" refactor would require an explicit
    // test update.
    const sdkError = new Error('Polar API: subscription not found');
    polarMocks.subscriptionsUpdate.mockRejectedValueOnce(sdkError);

    await expect(cancelSubscription('sub_missing')).rejects.toThrow(
      'Polar API: subscription not found',
    );
  });
});

describe('getSubscription() — SDK wrapper', () => {
  beforeEach(() => {
    polarMocks.subscriptionsGet.mockReset();
  });

  it('happy path: forwards id to subscriptions.get and returns the subscription', async () => {
    const fakeSub = { id: 'sub_xyz', status: 'active', currentPeriodEnd: '2026-12-01T00:00:00Z' };
    polarMocks.subscriptionsGet.mockResolvedValueOnce(fakeSub);

    const result = await getSubscription('sub_xyz');

    expect(polarMocks.subscriptionsGet).toHaveBeenCalledWith({ id: 'sub_xyz' });
    expect(result).toEqual(fakeSub);
  });

  it('propagates SDK errors (e.g. 404 unknown subscription)', async () => {
    polarMocks.subscriptionsGet.mockRejectedValueOnce(new Error('Not found'));
    await expect(getSubscription('sub_unknown')).rejects.toThrow('Not found');
  });
});

describe('createCheckoutSession() — SDK wrapper', () => {
  beforeEach(() => {
    polarMocks.checkoutsCreate.mockReset();
  });

  it('happy path: forwards products array, successUrl, customerEmail, metadata to checkouts.create', async () => {
    // H19: SDK 0.30+ renamed `productId` (string) → `products` (string[]).
    // The wire API has always accepted an array; the v0.29 type was wrong.
    const fakeCheckout = { id: 'co_123', url: 'https://polar.sh/checkout/co_123' };
    polarMocks.checkoutsCreate.mockResolvedValueOnce(fakeCheckout);

    const result = await createCheckoutSession(
      'prod_pro_mo',
      'user_abc',
      'https://styrby.com/billing/success',
    );

    expect(polarMocks.checkoutsCreate).toHaveBeenCalledTimes(1);
    expect(polarMocks.checkoutsCreate).toHaveBeenCalledWith({
      products: ['prod_pro_mo'],
      successUrl: 'https://styrby.com/billing/success',
      customerEmail: 'user_abc',
      metadata: { userId: 'user_abc' },
    });
    expect(result).toEqual(fakeCheckout);
  });

  it('propagates SDK errors (e.g. invalid product id)', async () => {
    polarMocks.checkoutsCreate.mockRejectedValueOnce(new Error('Invalid product'));
    await expect(
      createCheckoutSession('prod_bogus', 'user_abc', 'https://example.com'),
    ).rejects.toThrow('Invalid product');
  });
});

describe('getCustomerPortalUrl() — generic Polar portal link', () => {
  it('returns the Polar subscriptions portal URL (customer id reserved for future)', async () => {
    // WHY generic URL: Polar does not yet expose
    // `customers.createPortalSession()`. This test pins the temporary
    // contract so when Polar ships the API, the swap is a deliberate
    // change that updates this assertion.
    expect(await getCustomerPortalUrl('cust_123')).toBe(
      'https://polar.sh/purchases/subscriptions',
    );
  });

  it('returns the same URL regardless of customer id (current behavior)', async () => {
    expect(await getCustomerPortalUrl('cust_a')).toBe(await getCustomerPortalUrl('cust_b'));
  });
});
