/**
 * Billing Portal API Route Integration Tests
 *
 * Tests GET /api/billing/portal
 *
 * WHY: The billing portal redirect touches authentication, subscription
 * lookup, and external redirect to Polar. Bugs here could redirect
 * unauthenticated users to Polar (leaking portal access), redirect
 * free-tier users to a broken portal page, or fail to redirect at all
 * when a valid subscription exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();

/**
 * Tracks sequential .from() call results.
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase query builder mock.
 */
function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'insert', 'update', 'delete', 'is', 'not', 'in', 'range']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => createChainMock()),
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 99 })),
  RATE_LIMITS: {
    standard: { windowMs: 60000, maxRequests: 100 },
    budgetAlerts: { windowMs: 60000, maxRequests: 30 },
    sensitive: { windowMs: 60000, maxRequests: 10 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const AUTH_USER = { id: 'user-uuid-123', email: 'test@example.com' };

function createNextRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/billing/portal', {
    method: 'GET',
    headers: {
      'x-forwarded-for': '203.0.113.1',
    },
  });
}

function mockAuthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: AUTH_USER },
    error: null,
  });
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: null },
    error: { message: 'Not authenticated' },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('Billing Portal API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  describe('GET /api/billing/portal', () => {
    it('redirects to /login when unauthenticated', async () => {
      mockUnauthenticated();

      const req = createNextRequest();
      const response = await GET(req);

      // WHY: NextResponse.redirect() returns a 307 (Temporary Redirect)
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/login');
    });

    it('redirects to /settings when user has no subscription', async () => {
      mockAuthenticated();

      // subscriptions.select().eq().single() → no subscription found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest();
      const response = await GET(req);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/settings');
    });

    it('redirects to /settings when subscription has no polar_customer_id', async () => {
      mockAuthenticated();

      // Subscription exists but has no Polar customer ID (incomplete setup)
      fromCallQueue.push({
        data: {
          polar_subscription_id: 'sub_123',
          polar_customer_id: null,
        },
        error: null,
      });

      const req = createNextRequest();
      const response = await GET(req);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/settings');
    });

    it('redirects to Polar portal when subscription with polar_customer_id exists', async () => {
      mockAuthenticated();

      // Subscription with valid Polar customer ID
      fromCallQueue.push({
        data: {
          polar_subscription_id: 'sub_polar_abc',
          polar_customer_id: 'cust_polar_xyz',
        },
        error: null,
      });

      const req = createNextRequest();
      const response = await GET(req);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('polar.sh');
    });

    it('redirects to /settings on unexpected error', async () => {
      mockAuthenticated();

      // Force an error by making the from() mock throw
      fromCallQueue.push({ data: null, error: { code: '500', message: 'DB unavailable' } });

      const req = createNextRequest();
      const response = await GET(req);

      // WHY: The catch block redirects to /settings as a safe fallback
      // when anything goes wrong. Better to show settings than an error page.
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/settings');
    });
  });
});
