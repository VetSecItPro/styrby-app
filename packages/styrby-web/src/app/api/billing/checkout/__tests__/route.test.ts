/**
 * Integration tests for POST /api/billing/checkout
 *
 * WHY: This endpoint creates Polar checkout sessions for paid tiers.
 * Critical security paths to test:
 * - Authentication is enforced (prevents anonymous checkouts)
 * - Tier validation prevents invalid tier IDs
 * - Free tier is rejected (no checkout for free tier)
 * - Billing cycle validation (only monthly/annual allowed)
 * - Polar SDK integration handles errors gracefully
 *
 * IMPORTANT: Uses vi.hoisted() for mock variables because vi.mock()
 * factories are hoisted above all other code. Without vi.hoisted(),
 * variables declared with `const` would be in the Temporal Dead Zone
 * when the factory runs, causing ReferenceError.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '../route';

/**
 * Hoisted mock variables — must be declared via vi.hoisted() because
 * vi.mock() factories are hoisted above variable declarations.
 *
 * WHY MOCK_TIERS exists: Real TIERS reads process.env.POLAR_*_PRODUCT_ID
 * at module evaluation time. In tests those env vars aren't set, so
 * polarProductId values would be undefined, causing the route to return
 * 400 "Tier not available for purchase" for ALL checkout attempts.
 * Mocking gives us deterministic product IDs for happy-path tests.
 */
const { mockGetUser, mockCheckoutCreate, MOCK_TIERS } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockCheckoutCreate: vi.fn(),
  MOCK_TIERS: {
    free: {
      id: 'free' as const,
      name: 'Free',
      price: { monthly: 0, annual: 0 },
      polarProductId: {
        monthly: undefined as string | undefined,
        annual: undefined as string | undefined,
      },
      features: [] as string[],
      limits: {
        machines: 1,
        historyDays: 7,
        messagesPerMonth: 1000,
        budgetAlerts: 0,
        webhooks: 0,
        teamMembers: 1,
        apiKeys: 0,
      },
    },
    pro: {
      id: 'pro' as const,
      name: 'Pro',
      price: { monthly: 19, annual: 190 },
      polarProductId: {
        monthly: 'polar_test_pro_monthly',
        annual: 'polar_test_pro_annual',
      },
      features: [] as string[],
      limits: {
        machines: 5,
        historyDays: 90,
        messagesPerMonth: 25000,
        budgetAlerts: 3,
        webhooks: 3,
        teamMembers: 1,
        apiKeys: 0,
      },
    },
    power: {
      id: 'power' as const,
      name: 'Power',
      price: { monthly: 49, annual: 490 },
      polarProductId: {
        monthly: 'polar_test_power_monthly',
        annual: 'polar_test_power_annual',
      },
      features: [] as string[],
      limits: {
        machines: 15,
        historyDays: 365,
        messagesPerMonth: 100000,
        budgetAlerts: 10,
        webhooks: 10,
        teamMembers: 5,
        apiKeys: 5,
      },
    },
  },
}));

/**
 * Mock Supabase client — only auth.getUser needed for checkout
 */
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
}));

/**
 * Mock Polar SDK — intercepted to verify checkout creation params
 * WHY: Uses vi.hoisted() mockCheckoutCreate to avoid hoisting TDZ error
 */
vi.mock('@polar-sh/sdk', () => ({
  Polar: vi.fn(() => ({
    checkouts: {
      create: mockCheckoutCreate,
    },
  })),
}));

/**
 * Mock @/lib/polar — provides TIERS with test product IDs
 */
vi.mock('@/lib/polar', () => ({
  TIERS: MOCK_TIERS,
}));

/**
 * Mock rate limiter — correct path matching route import
 * WHY: Route imports { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit'
 * (camelCase, not kebab-case). Mock must export the same names.
 */
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 99 })),
  RATE_LIMITS: {
    checkout: { windowMs: 60000, maxRequests: 5 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

describe('POST /api/billing/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // WHY: Route builds successUrl as `${process.env.NEXT_PUBLIC_APP_URL}/settings?checkout=success`
    // Without this, the URL would be "undefined/settings?checkout=success"
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /**
   * Test 1: Returns 401 when user is not authenticated
   * WHY: Prevents anonymous users from creating checkout sessions
   * which could lead to orphaned Polar checkouts or billing fraud.
   */
  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: 'pro' }),
    });

    const response = await POST(request as never);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  /**
   * Test 2: Returns 400 when tierId is missing
   * WHY: tierId is required by Zod schema. Missing field triggers 'Required' error.
   */
  it('returns 400 when tierId is missing', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1', email: 'test@example.com' } },
      error: null,
    });

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await POST(request as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBeDefined();
  });

  /**
   * Test 3: Returns 400 when tierId is empty string
   * WHY: z.string().min(1, 'tierId is required') catches empty strings
   */
  it('returns 400 when tierId is empty string', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1', email: 'test@example.com' } },
      error: null,
    });

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: '' }),
    });

    const response = await POST(request as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('tierId is required');
  });

  /**
   * Test 4: Returns 400 when billingCycle is invalid
   * WHY: Polar only supports monthly/annual. z.enum() rejects other values.
   */
  it('returns 400 when billingCycle is invalid', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1', email: 'test@example.com' } },
      error: null,
    });

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: 'pro', billingCycle: 'yearly' }),
    });

    const response = await POST(request as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBeDefined();
  });

  /**
   * Test 5: Returns 400 when tier does not exist in TIERS
   * WHY: Route checks !TIERS[tierId] and returns 'Invalid tier'
   */
  it('returns 400 when tier does not exist in TIERS', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1', email: 'test@example.com' } },
      error: null,
    });

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: 'mega' }),
    });

    const response = await POST(request as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid tier');
  });

  /**
   * Test 6: Returns 400 when attempting checkout for free tier
   * WHY: TIERS.free.polarProductId.monthly is undefined — free tier has
   * no Polar product. Route hits the !productId check after TIERS lookup.
   */
  it('returns 400 when attempting checkout for free tier', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1', email: 'test@example.com' } },
      error: null,
    });

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: 'free' }),
    });

    const response = await POST(request as never);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Tier not available for purchase');
  });

  /**
   * Test 7: Returns 200 with checkout URL for pro/monthly
   * WHY: Happy path verifying full flow: auth → validation → Polar → URL
   */
  it('returns 200 with checkout URL for pro/monthly', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1', email: 'test@example.com' } },
      error: null,
    });

    mockCheckoutCreate.mockResolvedValueOnce({
      url: 'https://polar.sh/checkout/test123',
    });

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: 'pro', billingCycle: 'monthly' }),
    });

    const response = await POST(request as never);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.url).toBe('https://polar.sh/checkout/test123');
    expect(mockCheckoutCreate).toHaveBeenCalledWith({
      productId: MOCK_TIERS.pro.polarProductId.monthly,
      successUrl: expect.stringContaining('/settings?checkout=success'),
      customerEmail: 'test@example.com',
      metadata: {
        userId: 'user1',
        tierId: 'pro',
        billingCycle: 'monthly',
      },
    });
  });

  /**
   * Test 8: Returns 200 with checkout URL for pro/annual
   * WHY: Verifies annual billing cycle passes correct Polar product ID
   */
  it('returns 200 with checkout URL for pro/annual', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1', email: 'test@example.com' } },
      error: null,
    });

    mockCheckoutCreate.mockResolvedValueOnce({
      url: 'https://polar.sh/checkout/annual456',
    });

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: 'pro', billingCycle: 'annual' }),
    });

    const response = await POST(request as never);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.url).toBe('https://polar.sh/checkout/annual456');
    expect(mockCheckoutCreate).toHaveBeenCalledWith({
      productId: MOCK_TIERS.pro.polarProductId.annual,
      successUrl: expect.stringContaining('/settings?checkout=success'),
      customerEmail: 'test@example.com',
      metadata: {
        userId: 'user1',
        tierId: 'pro',
        billingCycle: 'annual',
      },
    });
  });

  /**
   * Test 9: Passes correct metadata to Polar for webhook reconciliation
   * WHY: Without proper metadata, we can't map Polar subscriptions back to users.
   */
  it('passes correct metadata (userId, tierId, billingCycle) to Polar', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user-abc-123', email: 'metadata@test.com' } },
      error: null,
    });

    mockCheckoutCreate.mockResolvedValueOnce({
      url: 'https://polar.sh/checkout/metadata-test',
    });

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: 'power', billingCycle: 'annual' }),
    });

    const response = await POST(request as never);
    expect(response.status).toBe(200);

    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          userId: 'user-abc-123',
          tierId: 'power',
          billingCycle: 'annual',
        },
      })
    );
  });

  /**
   * Test 10: Returns 500 when Polar SDK throws
   * WHY: Polar can throw network/API/rate-limit errors. Route catches
   * and returns a generic error message to avoid leaking internal details.
   */
  it('returns 500 when Polar SDK throws', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1', email: 'test@example.com' } },
      error: null,
    });

    mockCheckoutCreate.mockRejectedValueOnce(
      new Error('Polar API rate limit exceeded')
    );

    const request = new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: 'pro' }),
    });

    const response = await POST(request as never);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Failed to create checkout session');
  });
});
