/**
 * Webhook Deliveries API Route Integration Tests
 *
 * Tests GET /api/webhooks/user/deliveries
 *
 * WHY: Delivery logs contain webhook payloads (session data, budget info).
 * Bugs here could expose another user's delivery history if ownership
 * verification fails, or return unbounded result sets without pagination.
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

const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const AUTH_USER = { id: 'user-uuid-123', email: 'test@example.com' };

/**
 * Creates a NextRequest with query parameters for the GET deliveries endpoint.
 *
 * @param params - Query parameters to include
 * @returns NextRequest instance
 */
function createNextRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/webhooks/user/deliveries');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url.toString(), {
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

describe('Webhook Deliveries API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  describe('GET /api/webhooks/user/deliveries', () => {
    it('returns 401 when unauthenticated', async () => {
      mockUnauthenticated();

      const req = createNextRequest({ webhookId: VALID_UUID });
      const response = await GET(req);
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 400 when webhookId is missing', async () => {
      mockAuthenticated();

      const req = createNextRequest({});
      const response = await GET(req);
      expect(response.status).toBe(400);
    });

    it('returns 400 when webhookId is not a valid UUID', async () => {
      mockAuthenticated();

      const req = createNextRequest({ webhookId: 'not-valid-uuid' });
      const response = await GET(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('Invalid webhook ID');
    });

    it('returns 403 when webhook does not belong to user (ownership check)', async () => {
      mockAuthenticated();

      // WHY: The route verifies webhook ownership before returning deliveries.
      // Without this check, a user could read delivery logs (containing payload
      // data) for webhooks belonging to other users by guessing UUIDs.
      // webhooks.select().eq(id).eq(user_id).single() → not found
      fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

      const req = createNextRequest({ webhookId: VALID_UUID, limit: '50', offset: '0' });
      const response = await GET(req);
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Access denied');
    });

    it('returns 200 with delivery logs for owned webhook', async () => {
      mockAuthenticated();

      // 1. Webhook ownership check → success
      fromCallQueue.push({ data: { id: VALID_UUID }, error: null });
      // 2. webhook_deliveries.select().eq().order().range() → deliveries
      fromCallQueue.push({
        data: [
          {
            id: 'del-1',
            event: 'session.completed',
            payload: { event: 'session.completed' },
            status: 'delivered',
            attempts: 1,
            response_status: 200,
            duration_ms: 142,
            created_at: '2026-02-06T01:00:00Z',
          },
          {
            id: 'del-2',
            event: 'budget.exceeded',
            payload: { event: 'budget.exceeded' },
            status: 'failed',
            attempts: 3,
            response_status: 500,
            error_message: 'Internal Server Error',
            duration_ms: 5001,
            created_at: '2026-02-05T23:00:00Z',
          },
        ],
        error: null,
      });
      // 3. Count query → total
      fromCallQueue.push({ count: 15, error: null });

      const req = createNextRequest({ webhookId: VALID_UUID, limit: '50', offset: '0' });
      const response = await GET(req);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.deliveries).toHaveLength(2);
      expect(body.total).toBe(15);
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
    });

    it('respects limit and offset query parameters', async () => {
      mockAuthenticated();

      // 1. Ownership check → success
      fromCallQueue.push({ data: { id: VALID_UUID }, error: null });
      // 2. Deliveries → single item for page 2
      fromCallQueue.push({
        data: [
          {
            id: 'del-11',
            event: 'session.started',
            status: 'delivered',
            created_at: '2026-02-04T00:00:00Z',
          },
        ],
        error: null,
      });
      // 3. Count → total
      fromCallQueue.push({ count: 25, error: null });

      const req = createNextRequest({
        webhookId: VALID_UUID,
        limit: '10',
        offset: '10',
      });
      const response = await GET(req);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(10);
      expect(body.total).toBe(25);
    });

    it('returns empty deliveries array when webhook has no deliveries', async () => {
      mockAuthenticated();

      // 1. Ownership check → success
      fromCallQueue.push({ data: { id: VALID_UUID }, error: null });
      // 2. No deliveries
      fromCallQueue.push({ data: [], error: null });
      // 3. Count → 0
      fromCallQueue.push({ count: 0, error: null });

      const req = createNextRequest({ webhookId: VALID_UUID, limit: '50', offset: '0' });
      const response = await GET(req);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.deliveries).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });
});
