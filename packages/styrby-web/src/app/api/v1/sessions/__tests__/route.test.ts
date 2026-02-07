/**
 * GET /api/v1/sessions — Integration Tests
 *
 * Tests the sessions list endpoint which returns paginated, filterable
 * session data for an API-key-authenticated user.
 *
 * WHY: Sessions are core to Styrby's value prop. This endpoint powers
 * the CLI's session listing and the mobile app's session browser.
 * Pagination bugs could cause missing sessions or infinite loops.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks — withApiAuth bypass
// ============================================================================

/**
 * Default auth context injected by the mocked middleware.
 * WHY: v1 routes use API key auth (withApiAuth), not cookie auth.
 * Mocking the middleware to pass through lets us test the handler logic directly.
 */
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
// Mocks — Supabase chain builder
// ============================================================================

/**
 * Queue of results for sequential supabase.from() calls.
 * Each call shifts the next result off the queue.
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase query mock.
 * Terminal methods resolve with the next queued result.
 */
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
// Import route handler AFTER mocks are set up
// ============================================================================

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a NextRequest aimed at the sessions list endpoint.
 *
 * @param params - URL query parameters to append
 * @returns A NextRequest for GET /api/v1/sessions
 */
function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/sessions');
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
 * Factory for mock session rows.
 *
 * @param overrides - Fields to override on the default session
 * @returns A session object matching the SELECT columns
 */
function mockSession(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    agent_type: 'claude',
    model: 'claude-sonnet-4',
    title: 'Test Session',
    summary: null,
    project_path: '/home/user/project',
    git_branch: 'main',
    tags: [],
    is_archived: false,
    status: 'running',
    started_at: '2025-01-15T10:00:00Z',
    ended_at: null,
    last_activity_at: '2025-01-15T10:30:00Z',
    total_cost_usd: 0.05,
    total_input_tokens: 5000,
    total_output_tokens: 2000,
    total_cache_tokens: 1000,
    message_count: 12,
    created_at: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/v1/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Auth middleware passthrough
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when auth middleware rejects the request', async () => {
      // WHY: Override the mock to simulate auth failure. This tests that the
      // withApiAuth wrapper correctly short-circuits before reaching the handler.
      const { withApiAuth } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuth).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 }
        );
      });

      // Re-import the route to pick up the new mock
      vi.resetModules();
      const { GET: freshGET } = await import('../route');

      const request = createRequest();
      const response = await freshGET(request);
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Missing Authorization header');
    });
  });

  // --------------------------------------------------------------------------
  // Successful responses
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    it('returns sessions with pagination object', async () => {
      const sessions = [mockSession(), mockSession({ id: '00000000-0000-0000-0000-000000000002' })];

      fromCallQueue.push({ data: sessions, error: null, count: 2 });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.sessions).toHaveLength(2);
      expect(body.pagination).toEqual({
        total: 2,
        limit: 20,
        offset: 0,
        hasMore: false,
      });
    });

    it('respects limit query param', async () => {
      const sessions = [mockSession()];
      fromCallQueue.push({ data: sessions, error: null, count: 50 });

      const response = await GET(createRequest({ limit: '5' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.pagination.limit).toBe(5);
      // WHY: hasMore is true because total (50) > offset (0) + limit (5)
      expect(body.pagination.hasMore).toBe(true);
    });

    it('respects offset query param', async () => {
      const sessions = [mockSession()];
      fromCallQueue.push({ data: sessions, error: null, count: 25 });

      const response = await GET(createRequest({ offset: '10', limit: '10' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.pagination.offset).toBe(10);
      expect(body.pagination.limit).toBe(10);
      // WHY: hasMore is true because total (25) > offset (10) + limit (10) = 20
      expect(body.pagination.hasMore).toBe(true);
    });

    it('filters by status query param', async () => {
      const sessions = [mockSession({ status: 'stopped' })];
      fromCallQueue.push({ data: sessions, error: null, count: 1 });

      const response = await GET(createRequest({ status: 'stopped' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].status).toBe('stopped');
    });

    it('filters by agent_type query param', async () => {
      const sessions = [mockSession({ agent_type: 'codex' })];
      fromCallQueue.push({ data: sessions, error: null, count: 1 });

      const response = await GET(createRequest({ agent_type: 'codex' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].agent_type).toBe('codex');
    });

    it('includes archived sessions when archived=true', async () => {
      const sessions = [
        mockSession({ is_archived: true }),
        mockSession({ id: '00000000-0000-0000-0000-000000000002', is_archived: false }),
      ];
      fromCallQueue.push({ data: sessions, error: null, count: 2 });

      const response = await GET(createRequest({ archived: 'true' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.sessions).toHaveLength(2);
    });

    it('returns empty sessions array when user has none', async () => {
      fromCallQueue.push({ data: [], error: null, count: 0 });

      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.sessions).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(body.pagination.hasMore).toBe(false);
    });

    it('sets hasMore correctly when more results exist', async () => {
      fromCallQueue.push({ data: [mockSession()], error: null, count: 100 });

      const response = await GET(createRequest({ limit: '20' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      // WHY: 100 total > 0 offset + 20 limit = hasMore true
      expect(body.pagination.hasMore).toBe(true);
    });

    it('sets hasMore to false when at the last page', async () => {
      fromCallQueue.push({ data: [mockSession()], error: null, count: 21 });

      const response = await GET(createRequest({ limit: '20', offset: '20' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      // WHY: 21 total > 20 offset + 20 limit = 40, so 21 < 40 => hasMore false
      expect(body.pagination.hasMore).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Validation errors
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('returns 400 for limit of 0', async () => {
      const response = await GET(createRequest({ limit: '0' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for negative limit', async () => {
      const response = await GET(createRequest({ limit: '-1' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for limit exceeding 100', async () => {
      const response = await GET(createRequest({ limit: '101' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid status value', async () => {
      const response = await GET(createRequest({ status: 'invalid' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid agent_type value', async () => {
      const response = await GET(createRequest({ agent_type: 'gpt4' }));
      expect(response.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // Database errors
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 when Supabase query fails', async () => {
      fromCallQueue.push({ data: null, error: { message: 'Connection refused' } });

      const response = await GET(createRequest());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch sessions');
    });
  });
});
