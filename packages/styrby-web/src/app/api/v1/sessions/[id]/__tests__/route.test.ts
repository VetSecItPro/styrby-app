/**
 * GET /api/v1/sessions/[id] — Integration Tests
 *
 * Tests the single session endpoint which retrieves detailed session data
 * for an API-key-authenticated user.
 *
 * WHY: This endpoint returns sensitive session data including error codes,
 * context window usage, and git remote URLs. The user_id filter ensures
 * one user can't access another user's sessions (IDOR prevention).
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

/** Valid UUID format (36 chars with hyphens) */
const VALID_SESSION_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Creates a NextRequest for a single session lookup.
 *
 * @param sessionId - The session ID to put in the URL path
 * @returns A NextRequest for GET /api/v1/sessions/[id]
 */
function createRequest(sessionId: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/sessions/${sessionId}`, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer sk_live_test_key',
    },
  });
}

/**
 * Factory for a full session record matching the SELECT columns.
 *
 * @param overrides - Fields to override on the default session
 * @returns A session object
 */
function mockSession(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_SESSION_ID,
    machine_id: 'machine-001',
    agent_type: 'claude',
    model: 'claude-sonnet-4',
    title: 'Refactoring auth module',
    summary: 'Moved auth logic to middleware',
    project_path: '/home/user/project',
    git_branch: 'feature/auth',
    git_remote_url: 'https://github.com/user/project.git',
    tags: ['refactoring', 'auth'],
    is_archived: false,
    status: 'stopped',
    error_code: null,
    error_message: null,
    started_at: '2025-01-15T10:00:00Z',
    ended_at: '2025-01-15T12:00:00Z',
    last_activity_at: '2025-01-15T12:00:00Z',
    total_cost_usd: 1.25,
    total_input_tokens: 50000,
    total_output_tokens: 20000,
    total_cache_tokens: 15000,
    message_count: 45,
    context_window_used: 80000,
    context_window_limit: 200000,
    created_at: '2025-01-15T10:00:00Z',
    updated_at: '2025-01-15T12:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/v1/sessions/[id]', () => {
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

      const response = await freshGET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Success
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    it('returns a single session with all fields', async () => {
      const session = mockSession();
      fromCallQueue.push({ data: session, error: null });

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.session).toBeDefined();
      expect(body.session.id).toBe(VALID_SESSION_ID);
      expect(body.session.agent_type).toBe('claude');
      expect(body.session.model).toBe('claude-sonnet-4');
      expect(body.session.tags).toEqual(['refactoring', 'auth']);
    });

    it('returns session with error details when session had errors', async () => {
      const session = mockSession({
        status: 'error',
        error_code: 'TIMEOUT',
        error_message: 'Session timed out after 5 hours',
      });
      fromCallQueue.push({ data: session, error: null });

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.session.error_code).toBe('TIMEOUT');
      expect(body.session.error_message).toBe('Session timed out after 5 hours');
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('returns 400 for session ID shorter than 36 chars', async () => {
      const response = await GET(createRequest('too-short'));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid session ID');
    });

    it('returns 400 for session ID longer than 36 chars', async () => {
      const response = await GET(createRequest('a'.repeat(37)));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid session ID');
    });

    it('returns 400 for empty session ID', async () => {
      // WHY: URL /api/v1/sessions/ with trailing slash — the last segment
      // after split('/') is '' which has length 0, not 36.
      const response = await GET(
        new NextRequest('http://localhost:3000/api/v1/sessions/', {
          method: 'GET',
          headers: { Authorization: 'Bearer sk_live_test_key' },
        })
      );
      expect(response.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // Not found
  // --------------------------------------------------------------------------

  describe('not found', () => {
    it('returns 404 when session does not exist (PGRST116)', async () => {
      // WHY: PGRST116 is PostgREST's error code for "no rows returned"
      // when .single() is used. The handler maps this to a 404.
      fromCallQueue.push({
        data: null,
        error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
      });

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Session not found');
    });

    it('returns 404 when session belongs to a different user', async () => {
      // WHY: The query filters by user_id from the auth context.
      // If the session exists but belongs to another user, .single() returns
      // PGRST116 because no rows match both id AND user_id filters.
      fromCallQueue.push({
        data: null,
        error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
      });

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // Database errors
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 for unexpected database errors', async () => {
      fromCallQueue.push({
        data: null,
        error: { code: '42P01', message: 'relation "sessions" does not exist' },
      });

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch session');
    });
  });
});
