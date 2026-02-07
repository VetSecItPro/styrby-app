/**
 * GET /api/v1/costs/breakdown — Integration Tests
 *
 * Tests the cost breakdown endpoint which aggregates spending by agent type
 * for an API-key-authenticated user, with configurable lookback window.
 *
 * WHY: This endpoint powers the "cost by agent" chart on the dashboard.
 * It deduplicates session IDs using Sets and calculates percentage splits.
 * Bugs could show wrong percentages (always 0, >100%, NaN) or double-count
 * sessions that span multiple cost records.
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
 * Creates a NextRequest for the costs breakdown endpoint.
 *
 * @param params - URL query parameters
 * @returns A NextRequest for GET /api/v1/costs/breakdown
 */
function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/costs/breakdown');
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
 * Factory for mock cost_records rows with agent_type and session_id.
 *
 * @param overrides - Fields to override
 * @returns A cost record matching the SELECT columns for this endpoint
 */
function mockCostRecord(overrides: Record<string, unknown> = {}) {
  return {
    agent_type: 'claude',
    cost_usd: 0.10,
    input_tokens: 5000,
    output_tokens: 2000,
    cache_read_tokens: 1000,
    session_id: 'session-001',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/v1/costs/breakdown', () => {
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
  // Success cases
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    it('returns cost breakdown by agent type', async () => {
      const records = [
        mockCostRecord({ agent_type: 'claude', cost_usd: 0.50, session_id: 'session-001' }),
        mockCostRecord({ agent_type: 'claude', cost_usd: 0.30, session_id: 'session-002' }),
        mockCostRecord({ agent_type: 'codex', cost_usd: 0.20, session_id: 'session-003' }),
      ];

      fromCallQueue.push({ data: records, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();

      // Breakdown should be sorted by costUsd descending
      expect(body.breakdown).toHaveLength(2);
      expect(body.breakdown[0].agentType).toBe('claude');
      expect(body.breakdown[0].costUsd).toBe(0.8);
      expect(body.breakdown[0].sessionCount).toBe(2);
      expect(body.breakdown[1].agentType).toBe('codex');
      expect(body.breakdown[1].costUsd).toBe(0.2);
      expect(body.breakdown[1].sessionCount).toBe(1);

      // Totals
      expect(body.total.costUsd).toBe(1);
      expect(body.total.sessionCount).toBe(3);
    });

    it('calculates percentage correctly', async () => {
      const records = [
        mockCostRecord({ agent_type: 'claude', cost_usd: 0.75 }),
        mockCostRecord({ agent_type: 'codex', cost_usd: 0.25 }),
      ];

      fromCallQueue.push({ data: records, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      // WHY: 0.75 / 1.00 = 75%, 0.25 / 1.00 = 25%
      expect(body.breakdown[0].percentage).toBe(75);
      expect(body.breakdown[1].percentage).toBe(25);
    });

    it('deduplicates session IDs across cost records', async () => {
      // WHY: A single session can have multiple cost records (e.g., one per model
      // or per billing interval). The handler uses a Set to count unique sessions.
      const records = [
        mockCostRecord({ agent_type: 'claude', cost_usd: 0.10, session_id: 'session-001' }),
        mockCostRecord({ agent_type: 'claude', cost_usd: 0.15, session_id: 'session-001' }),
        mockCostRecord({ agent_type: 'claude', cost_usd: 0.05, session_id: 'session-002' }),
      ];

      fromCallQueue.push({ data: records, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      // Only 2 unique sessions, not 3
      expect(body.breakdown[0].sessionCount).toBe(2);
      expect(body.total.sessionCount).toBe(2);
    });

    it('respects the days parameter', async () => {
      // WHY: Verify the endpoint accepts the days param and returns period info.
      const records = [
        mockCostRecord({ agent_type: 'claude', cost_usd: 0.50 }),
      ];

      fromCallQueue.push({ data: records, error: null });

      const response = await GET(createRequest({ days: '7' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.period.days).toBe(7);
      expect(body.period.startDate).toBeDefined();
      expect(body.period.endDate).toBeDefined();
    });

    it('uses default 30-day lookback when days param is omitted', async () => {
      fromCallQueue.push({ data: [], error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.period.days).toBe(30);
    });

    it('handles records with null agent_type as "unknown"', async () => {
      // WHY: The handler falls back to 'unknown' when agent_type is null.
      const records = [
        mockCostRecord({ agent_type: null, cost_usd: 0.10, session_id: 'session-x' }),
      ];

      fromCallQueue.push({ data: records, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.breakdown[0].agentType).toBe('unknown');
    });
  });

  // --------------------------------------------------------------------------
  // Empty data
  // --------------------------------------------------------------------------

  describe('empty data', () => {
    it('returns empty breakdown for user with no cost records', async () => {
      fromCallQueue.push({ data: [], error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.breakdown).toEqual([]);
      expect(body.total.costUsd).toBe(0);
      expect(body.total.inputTokens).toBe(0);
      expect(body.total.outputTokens).toBe(0);
      expect(body.total.cacheTokens).toBe(0);
      expect(body.total.sessionCount).toBe(0);
    });

    it('handles null data from Supabase gracefully', async () => {
      fromCallQueue.push({ data: null, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.breakdown).toEqual([]);
      expect(body.total.costUsd).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Percentage edge case
  // --------------------------------------------------------------------------

  describe('percentage edge cases', () => {
    it('returns 0% when total cost is zero', async () => {
      // WHY: The handler guards against division by zero:
      // totalCostUsd > 0 ? Math.round((...) * 10000) / 100 : 0
      const records = [
        mockCostRecord({ agent_type: 'claude', cost_usd: 0, input_tokens: 100 }),
      ];

      fromCallQueue.push({ data: records, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.breakdown[0].percentage).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('returns 400 for days = 0', async () => {
      const response = await GET(createRequest({ days: '0' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for days exceeding 365', async () => {
      const response = await GET(createRequest({ days: '366' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for negative days', async () => {
      const response = await GET(createRequest({ days: '-1' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for non-numeric days', async () => {
      const response = await GET(createRequest({ days: 'abc' }));
      expect(response.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // Rounding
  // --------------------------------------------------------------------------

  describe('precision', () => {
    it('rounds cost values to 6 decimal places', async () => {
      const records = [
        mockCostRecord({ agent_type: 'claude', cost_usd: 0.1 }),
        mockCostRecord({ agent_type: 'claude', cost_usd: 0.2 }),
      ];

      fromCallQueue.push({ data: records, error: null });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.breakdown[0].costUsd).toBe(0.3);
      expect(body.total.costUsd).toBe(0.3);
    });
  });

  // --------------------------------------------------------------------------
  // Database errors
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 when Supabase query fails', async () => {
      fromCallQueue.push({
        data: null,
        error: { message: 'Connection refused' },
      });

      const response = await GET(createRequest());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch cost data');
    });
  });
});
