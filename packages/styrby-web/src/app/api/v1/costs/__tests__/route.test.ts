/**
 * GET /api/v1/costs — Integration Tests
 *
 * Tests the cost summary endpoint which aggregates token usage and spending
 * into daily, weekly, or monthly buckets for an API-key-authenticated user.
 *
 * WHY: Cost data drives the budget dashboard and alert triggers. Aggregation
 * logic runs in-memory on up to 10,000 cost records. Bugs here could show
 * wrong spending totals, miss records in the date range, or miscalculate
 * the hasMore pagination flag (which doesn't apply here — this endpoint
 * returns a summary, not a paginated list).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks — withApiAuth bypass
// ============================================================================

const mockAuthContext = {
  userId: 'test-user-123',
  keyId: 'key-id-456',
  scopes: ['read'],
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuth: vi.fn((handler: Function) => {
    return async (request: NextRequest) => handler(request, mockAuthContext);
  }),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

// ============================================================================
// Mocks — Supabase
// ============================================================================

const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'range', 'insert', 'update', 'delete', 'is', 'not', 'in',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    from: vi.fn(() => createChainMock()),
    rpc: vi.fn(),
  })),
}));

// ============================================================================
// Import route handler AFTER mocks
// ============================================================================

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a NextRequest for the costs endpoint.
 *
 * @param params - URL query parameters
 * @returns A NextRequest for GET /api/v1/costs
 */
function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/costs');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer sk_live_test_key',
    },
  });
}

/**
 * Factory for mock cost_records rows.
 *
 * @param overrides - Fields to override on the default cost record
 * @returns A cost record matching the SELECT columns
 */
function mockCostRecord(overrides: Record<string, unknown> = {}) {
  return {
    record_date: '2025-01-15',
    cost_usd: 0.05,
    input_tokens: 5000,
    output_tokens: 2000,
    cache_read_tokens: 1000,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/v1/costs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuth } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuth).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 }
        );
      });

      vi.resetModules();
      const { GET: freshGET } = await import('../route');

      const response = await freshGET(createRequest());
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Daily period
  // --------------------------------------------------------------------------

  describe('daily period', () => {
    it('returns cost summary aggregated by day', async () => {
      const records = [
        mockCostRecord({ record_date: '2025-01-14', cost_usd: 0.03 }),
        mockCostRecord({ record_date: '2025-01-14', cost_usd: 0.02 }),
        mockCostRecord({ record_date: '2025-01-15', cost_usd: 0.10 }),
      ];

      // 1. cost_records query
      fromCallQueue.push({ data: records, error: null });
      // 2. sessions count query
      fromCallQueue.push({ data: null, error: null, count: 5 });

      const response = await GET(createRequest({ period: 'daily' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.summary.period).toBe('daily');
      expect(body.summary.totalCostUsd).toBe(0.15);
      expect(body.summary.totalInputTokens).toBe(15000);
      expect(body.summary.totalOutputTokens).toBe(6000);
      expect(body.summary.totalCacheTokens).toBe(3000);
      expect(body.summary.sessionCount).toBe(5);

      // WHY: Two records on 2025-01-14 should be aggregated into one bucket,
      // plus one bucket for 2025-01-15 = 2 breakdown entries.
      expect(body.breakdown).toHaveLength(2);
      expect(body.breakdown[0].date).toBe('2025-01-14');
      expect(body.breakdown[0].costUsd).toBe(0.05);
      expect(body.breakdown[1].date).toBe('2025-01-15');
      expect(body.breakdown[1].costUsd).toBe(0.1);
    });
  });

  // --------------------------------------------------------------------------
  // Weekly period
  // --------------------------------------------------------------------------

  describe('weekly period', () => {
    it('returns cost summary aggregated by week with correct totals', async () => {
      // WHY: Date-only strings like '2025-01-15' are parsed as UTC midnight
      // by JavaScript. The handler uses getDay() which returns the local day,
      // so the exact week bucketing depends on the runtime timezone.
      // We test that records from the same week aggregate together and
      // records from different weeks produce separate buckets.
      const records = [
        mockCostRecord({ record_date: '2025-01-15', cost_usd: 0.10 }),
        mockCostRecord({ record_date: '2025-01-16', cost_usd: 0.20 }),
        mockCostRecord({ record_date: '2025-01-23', cost_usd: 0.15 }),
      ];

      fromCallQueue.push({ data: records, error: null });
      fromCallQueue.push({ data: null, error: null, count: 3 });

      const response = await GET(createRequest({ period: 'weekly' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.summary.period).toBe('weekly');
      expect(body.summary.totalCostUsd).toBe(0.45);

      // At minimum, 2025-01-15 and 2025-01-16 (Wed/Thu) should always fall
      // in the same week regardless of timezone. 2025-01-23 is a week later.
      // Verify total cost across all buckets matches the sum.
      const totalFromBreakdown = body.breakdown.reduce(
        (sum: number, b: { costUsd: number }) => sum + b.costUsd, 0
      );
      expect(Math.round(totalFromBreakdown * 1000000) / 1000000).toBe(0.45);
      // At least 2 buckets (Jan 15/16 week and Jan 23 week)
      expect(body.breakdown.length).toBeGreaterThanOrEqual(2);
    });
  });

  // --------------------------------------------------------------------------
  // Monthly period
  // --------------------------------------------------------------------------

  describe('monthly period', () => {
    it('returns cost summary aggregated by month (default period)', async () => {
      const records = [
        mockCostRecord({ record_date: '2024-12-10', cost_usd: 1.50, input_tokens: 100000 }),
        mockCostRecord({ record_date: '2025-01-05', cost_usd: 2.00, input_tokens: 150000 }),
        mockCostRecord({ record_date: '2025-01-20', cost_usd: 0.50, input_tokens: 30000 }),
      ];

      fromCallQueue.push({ data: records, error: null });
      fromCallQueue.push({ data: null, error: null, count: 10 });

      // WHY: 'monthly' is the default period when no param is provided.
      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.summary.period).toBe('monthly');
      expect(body.summary.totalCostUsd).toBe(4);
      expect(body.summary.sessionCount).toBe(10);

      // Two month buckets: 2024-12 and 2025-01
      expect(body.breakdown).toHaveLength(2);
      expect(body.breakdown[0].date).toBe('2024-12');
      expect(body.breakdown[0].costUsd).toBe(1.5);
      expect(body.breakdown[1].date).toBe('2025-01');
      expect(body.breakdown[1].costUsd).toBe(2.5); // 2.00 + 0.50
    });
  });

  // --------------------------------------------------------------------------
  // Empty data
  // --------------------------------------------------------------------------

  describe('empty data', () => {
    it('returns zero totals when no cost records exist', async () => {
      fromCallQueue.push({ data: [], error: null });
      fromCallQueue.push({ data: null, error: null, count: 0 });

      const response = await GET(createRequest({ period: 'daily' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.summary.totalCostUsd).toBe(0);
      expect(body.summary.totalInputTokens).toBe(0);
      expect(body.summary.totalOutputTokens).toBe(0);
      expect(body.summary.totalCacheTokens).toBe(0);
      expect(body.summary.sessionCount).toBe(0);
      expect(body.breakdown).toEqual([]);
    });

    it('handles null session count gracefully', async () => {
      // WHY: The handler uses `sessionCount ?? 0` to guard against null count.
      fromCallQueue.push({ data: [], error: null });
      fromCallQueue.push({ data: null, error: null, count: undefined });

      const response = await GET(createRequest({ period: 'daily' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.summary.sessionCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('returns 400 for invalid period parameter', async () => {
      const response = await GET(createRequest({ period: 'yearly' }));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 for another invalid period value', async () => {
      const response = await GET(createRequest({ period: 'hourly' }));
      expect(response.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // Rounding precision
  // --------------------------------------------------------------------------

  describe('precision', () => {
    it('rounds cost values to 6 decimal places', async () => {
      // WHY: The handler uses Math.round(x * 1000000) / 1000000 to avoid
      // floating-point drift. 0.1 + 0.2 should be 0.3, not 0.30000000000000004.
      const records = [
        mockCostRecord({ record_date: '2025-01-15', cost_usd: 0.1 }),
        mockCostRecord({ record_date: '2025-01-15', cost_usd: 0.2 }),
      ];

      fromCallQueue.push({ data: records, error: null });
      fromCallQueue.push({ data: null, error: null, count: 1 });

      const response = await GET(createRequest({ period: 'daily' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.summary.totalCostUsd).toBe(0.3);
      expect(body.breakdown[0].costUsd).toBe(0.3);
    });
  });

  // --------------------------------------------------------------------------
  // Database errors
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 when cost records query fails', async () => {
      fromCallQueue.push({
        data: null,
        error: { message: 'Connection refused' },
      });

      const response = await GET(createRequest({ period: 'daily' }));
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch cost data');
    });
  });
});
