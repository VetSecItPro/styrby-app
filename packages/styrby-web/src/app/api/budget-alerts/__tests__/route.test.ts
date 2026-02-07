/**
 * Budget Alerts API Route Integration Tests
 *
 * Tests GET, POST, PATCH, DELETE /api/budget-alerts
 *
 * WHY: Budget alerts are tier-gated and handle real user spending data.
 * Bugs here could allow free users to create alerts (bypassing tier limits),
 * corrupt alert records, or fail silently on Zod validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();

/**
 * Tracks sequential .from() call results.
 * Each call to supabase.from() creates a new chain mock that will resolve
 * to the next result in this queue when a terminal method is called.
 *
 * WHY: The budget alerts route calls supabase.from() multiple times (alerts
 * table, subscriptions table, cost_records table). Each call needs different
 * mock data. This queue approach handles the sequencing automatically.
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase query builder mock.
 * Every chainable method (select, eq, gte, etc.) returns `this`.
 * Terminal methods (single, then) resolve with the next result from the queue.
 */
function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  // Chainable methods return the chain itself
  for (const method of ['select', 'eq', 'gte', 'order', 'limit', 'insert', 'update', 'delete']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  // Terminal methods resolve with the queued result
  chain['single'] = vi.fn().mockResolvedValue(result);
  // Make the chain thenable for await without .single()
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => createChainMock()),
  })),
}));

/** Mock rate limiting to always allow requests */
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 29 })),
  RATE_LIMITS: {
    budgetAlerts: { windowMs: 60000, maxRequests: 30 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

import { GET, POST, PATCH, DELETE } from '../route';

// ============================================================================
// Helpers
// ============================================================================

function createNextRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/budget-alerts', {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const AUTH_USER = { id: 'user-uuid-123', email: 'test@example.com' };

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

describe('Budget Alerts API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Authentication (applies to all methods)
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('GET returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const response = await GET();
      expect(response.status).toBe(401);
    });

    it('POST returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest({ name: 'Test', threshold_usd: 10, period: 'daily', action: 'notify' });
      const response = await POST(req);
      expect(response.status).toBe(401);
    });

    it('PATCH returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest({ id: '00000000-0000-0000-0000-000000000001', name: 'Updated' });
      const response = await PATCH(req);
      expect(response.status).toBe(401);
    });

    it('DELETE returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest({ id: '00000000-0000-0000-0000-000000000001' });
      const response = await DELETE(req);
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/budget-alerts
  // --------------------------------------------------------------------------

  describe('GET /api/budget-alerts', () => {
    it('returns alerts with tier info for authenticated user', async () => {
      mockAuthenticated();

      // Queue results for the 3 .from() calls the GET handler makes:
      // 1. budget_alerts.select().eq().order().limit()
      fromCallQueue.push({
        data: [
          { id: 'alert-1', name: 'Daily limit', threshold_usd: 10, period: 'daily', agent_type: null, action: 'notify' },
        ],
        error: null,
      });
      // 2. subscriptions.select().eq().eq().single() — getUserTier
      fromCallQueue.push({ data: null, error: null }); // free tier
      // 3. cost_records.select().eq().gte().limit() — spend calc
      fromCallQueue.push({ data: [{ cost_usd: 3.5 }, { cost_usd: 1.2 }], error: null });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.alerts).toHaveLength(1);
      expect(body.tier).toBeDefined();
      expect(body.alertLimit).toBeDefined();
      expect(body.alertCount).toBe(1);
    });

    it('returns empty alerts array when user has none', async () => {
      mockAuthenticated();

      // 1. No alerts
      fromCallQueue.push({ data: [], error: null });
      // 2. Free tier
      fromCallQueue.push({ data: null, error: null });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.alerts).toHaveLength(0);
      expect(body.alertCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/budget-alerts
  // --------------------------------------------------------------------------

  describe('POST /api/budget-alerts', () => {
    it('rejects invalid body (missing required fields)', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: 'Test' });
      const response = await POST(req);
      expect(response.status).toBe(400);
    });

    it('rejects empty alert name', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: '', threshold_usd: 10, period: 'daily', action: 'notify' });
      const response = await POST(req);
      expect(response.status).toBe(400);
    });

    it('rejects negative threshold', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: 'Test', threshold_usd: -5, period: 'daily', action: 'notify' });
      const response = await POST(req);
      expect(response.status).toBe(400);
    });

    it('rejects threshold exceeding $100,000', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: 'Test', threshold_usd: 200_000, period: 'daily', action: 'notify' });
      const response = await POST(req);
      expect(response.status).toBe(400);
    });

    it('rejects invalid period value', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: 'Test', threshold_usd: 10, period: 'yearly', action: 'notify' });
      const response = await POST(req);
      expect(response.status).toBe(400);
    });

    it('rejects invalid action value', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: 'Test', threshold_usd: 10, period: 'daily', action: 'shutdown' });
      const response = await POST(req);
      expect(response.status).toBe(400);
    });

    it('returns 403 when free user tries to create alert (limit 0)', async () => {
      mockAuthenticated();

      // POST calls Promise.all with 2 parallel queries:
      // 1. getUserTier → subscriptions.select().eq().eq().single()
      fromCallQueue.push({ data: null, error: null }); // free tier
      // 2. count query → budget_alerts.select('id', { count: 'exact', head: true }).eq()
      fromCallQueue.push({ count: 0, error: null });

      const req = createNextRequest({ name: 'Daily budget', threshold_usd: 10, period: 'daily', action: 'notify' });
      const response = await POST(req);
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('Free plan');
    });

    it('returns 403 when pro user exceeds 3 alert limit', async () => {
      mockAuthenticated();

      // 1. getUserTier → pro
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });
      // 2. count → 3 (at limit)
      fromCallQueue.push({ count: 3, error: null });

      const req = createNextRequest({ name: 'Another alert', threshold_usd: 10, period: 'daily', action: 'notify' });
      const response = await POST(req);
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('limit');
    });

    it('creates alert successfully for pro user under limit', async () => {
      mockAuthenticated();

      // 1. getUserTier → pro
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });
      // 2. count → 1 (under limit of 3)
      fromCallQueue.push({ count: 1, error: null });
      // 3. insert().select().single()
      fromCallQueue.push({
        data: { id: 'new-alert-id', name: 'Daily budget', threshold_usd: 10, period: 'daily', action: 'notify' },
        error: null,
      });

      const req = createNextRequest({ name: 'Daily budget', threshold_usd: 10, period: 'daily', action: 'notify' });
      const response = await POST(req);
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.alert).toBeDefined();
      expect(body.alert.name).toBe('Daily budget');
    });
  });

  // --------------------------------------------------------------------------
  // PATCH /api/budget-alerts
  // --------------------------------------------------------------------------

  describe('PATCH /api/budget-alerts', () => {
    it('rejects missing alert ID', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: 'Updated name' });
      const response = await PATCH(req);
      expect(response.status).toBe(400);
    });

    it('rejects invalid UUID for ID', async () => {
      mockAuthenticated();
      const req = createNextRequest({ id: 'not-a-uuid', name: 'Updated' });
      const response = await PATCH(req);
      expect(response.status).toBe(400);
    });

    it('rejects request with no update fields', async () => {
      mockAuthenticated();
      const req = createNextRequest({ id: '00000000-0000-0000-0000-000000000001' });
      const response = await PATCH(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('No fields');
    });

    it('returns 404 when alert not found (PGRST116)', async () => {
      mockAuthenticated();

      // update().eq().eq().select().single() → PGRST116
      fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

      const req = createNextRequest({ id: '00000000-0000-0000-0000-000000000001', name: 'Updated' });
      const response = await PATCH(req);
      expect(response.status).toBe(404);
    });

    it('updates alert successfully', async () => {
      mockAuthenticated();

      // update().eq().eq().select().single() → success
      fromCallQueue.push({
        data: { id: '00000000-0000-0000-0000-000000000001', name: 'Updated name', threshold_usd: 20 },
        error: null,
      });

      const req = createNextRequest({ id: '00000000-0000-0000-0000-000000000001', name: 'Updated name' });
      const response = await PATCH(req);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.alert.name).toBe('Updated name');
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /api/budget-alerts
  // --------------------------------------------------------------------------

  describe('DELETE /api/budget-alerts', () => {
    it('rejects missing alert ID', async () => {
      mockAuthenticated();
      const req = createNextRequest({});
      const response = await DELETE(req);
      expect(response.status).toBe(400);
    });

    it('rejects invalid UUID for ID', async () => {
      mockAuthenticated();
      const req = createNextRequest({ id: 'not-valid' });
      const response = await DELETE(req);
      expect(response.status).toBe(400);
    });

    it('returns 404 when alert not found', async () => {
      mockAuthenticated();

      // Existence check → not found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest({ id: '00000000-0000-0000-0000-000000000001' });
      const response = await DELETE(req);
      expect(response.status).toBe(404);
    });

    it('deletes alert successfully', async () => {
      mockAuthenticated();

      // 1. Existence check → found
      fromCallQueue.push({ data: { id: '00000000-0000-0000-0000-000000000001' }, error: null });
      // 2. Delete → success
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest({ id: '00000000-0000-0000-0000-000000000001' });
      const response = await DELETE(req);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
    });
  });
});
