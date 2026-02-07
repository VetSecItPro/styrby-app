/**
 * Webhook Test API Route Integration Tests
 *
 * Tests POST /api/webhooks/user/test
 *
 * WHY: The test endpoint sends a real HTTP-like delivery to the user's
 * webhook URL. Bugs here could allow testing of webhooks that belong to
 * other users (ownership bypass), test disabled webhooks (confusing UX),
 * or fail to create the delivery audit record.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();

/**
 * Tracks sequential .from() call results.
 * Each call to supabase.from() shifts the next result off this queue.
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
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 9 })),
  RATE_LIMITS: {
    sensitive: { windowMs: 60000, maxRequests: 10 },
    standard: { windowMs: 60000, maxRequests: 100 },
    budgetAlerts: { windowMs: 60000, maxRequests: 30 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

import { POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

function createNextRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/webhooks/user/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '203.0.113.1',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const AUTH_USER = { id: 'user-uuid-123', email: 'test@example.com' };
const VALID_UUID = '00000000-0000-0000-0000-000000000001';

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

describe('Webhook Test API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  describe('POST /api/webhooks/user/test', () => {
    it('returns 401 when unauthenticated', async () => {
      mockUnauthenticated();

      const req = createNextRequest({ id: VALID_UUID });
      const response = await POST(req);
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 400 when webhookId is missing', async () => {
      mockAuthenticated();

      const req = createNextRequest({});
      const response = await POST(req);
      expect(response.status).toBe(400);
    });

    it('returns 400 when webhookId is not a valid UUID', async () => {
      mockAuthenticated();

      const req = createNextRequest({ id: 'not-a-uuid' });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('Invalid webhook ID');
    });

    it('returns 404 when webhook not found or not owned by user', async () => {
      mockAuthenticated();

      // webhooks.select().eq().eq().is().single() → not found
      fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

      const req = createNextRequest({ id: VALID_UUID });
      const response = await POST(req);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Webhook not found');
    });

    it('returns 400 when webhook is disabled', async () => {
      mockAuthenticated();

      // Webhook fetch → found but is_active = false
      fromCallQueue.push({
        data: {
          id: VALID_UUID,
          name: 'Disabled Webhook',
          url: 'https://example.com/wh',
          secret: 'whsec_test',
          is_active: false,
        },
        error: null,
      });

      const req = createNextRequest({ id: VALID_UUID });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('disabled');
    });

    it('returns 200 and creates delivery record for active webhook', async () => {
      mockAuthenticated();

      // 1. Webhook fetch → found and active
      fromCallQueue.push({
        data: {
          id: VALID_UUID,
          name: 'My Webhook',
          url: 'https://example.com/wh',
          secret: 'whsec_test_secret',
          is_active: true,
        },
        error: null,
      });
      // 2. webhook_deliveries.insert().select().single() → delivery created
      fromCallQueue.push({
        data: { id: 'delivery-uuid-001' },
        error: null,
      });

      const req = createNextRequest({ id: VALID_UUID });
      const response = await POST(req);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.deliveryId).toBe('delivery-uuid-001');
      expect(body.message).toContain('queued');
    });

    it('returns 500 when delivery record creation fails', async () => {
      mockAuthenticated();

      // 1. Webhook fetch → found and active
      fromCallQueue.push({
        data: {
          id: VALID_UUID,
          name: 'My Webhook',
          url: 'https://example.com/wh',
          secret: 'whsec_test_secret',
          is_active: true,
        },
        error: null,
      });
      // 2. webhook_deliveries.insert() → failure
      fromCallQueue.push({
        data: null,
        error: { code: '23503', message: 'FK violation' },
      });

      const req = createNextRequest({ id: VALID_UUID });
      const response = await POST(req);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toContain('test event');
    });
  });
});
