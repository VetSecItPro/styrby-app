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
// Mocks — withApiAuthAndRateLimit bypass
// ============================================================================

const mockAuthContext = {
  userId: 'test-user-123',
  keyId: 'key-id-456',
  scopes: ['read'],
};

// WHY withApiAuthAndRateLimit (not withApiAuth): H42 Layer 5 replaced withApiAuth
// with withApiAuthAndRateLimit on all v1 routes to enforce per-key rate limits
// in addition to auth. Mock the new export so the module resolution succeeds and
// the handler is invoked with the test auth context. OWASP A07:2021.
vi.mock('@/middleware/api-auth', () => ({
  withApiAuthAndRateLimit: vi.fn((handler: Function) => {
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
// Mocks — PATCH path uses @/lib/supabase/server (createAdminClient).
// Three independent queues mirror the three DB calls the PATCH handler makes:
//   0: SELECT id, user_id FROM sessions    (ownership check)  → maybeSingle
//   1: SELECT id FROM agent_session_groups (group ownership)  → maybeSingle
//   2: UPDATE sessions ... SELECT id,...   (apply update)     → single
// WHY separate from the GET fromCallQueue: PATCH and GET use different client
// factories; mixing queues would couple unrelated tests.
// ============================================================================

const patchSessionSelectQueue: Array<{ data: unknown; error: unknown }> = [];
const patchGroupSelectQueue: Array<{ data: unknown; error: unknown }> = [];
const patchUpdateQueue: Array<{ data: unknown; error: unknown }> = [];
let patchFromCallCount = 0;

function createPatchSupabaseMock() {
  return {
    from: vi.fn((_table: string) => {
      const callIndex = patchFromCallCount++;

      // Call 0: session ownership check (maybeSingle)
      if (callIndex === 0) {
        const result = patchSessionSelectQueue.shift() ?? { data: null, error: null };
        const chain: Record<string, unknown> = {};
        chain['select'] = vi.fn(() => chain);
        chain['eq'] = vi.fn(() => chain);
        chain['maybeSingle'] = vi.fn(() => Promise.resolve(result));
        return chain;
      }

      // Call 1 OR 2 depending on whether session_group_id was non-null
      // For the simpler cases (null group_id) call 1 IS the update.
      // Disambiguation lives inside each test by how it loads the queues.
      if (callIndex === 1 && patchGroupSelectQueue.length > 0) {
        const result = patchGroupSelectQueue.shift()!;
        const chain: Record<string, unknown> = {};
        chain['select'] = vi.fn(() => chain);
        chain['eq'] = vi.fn(() => chain);
        chain['maybeSingle'] = vi.fn(() => Promise.resolve(result));
        return chain;
      }

      // Update path (.update().eq().eq().select().single())
      const result = patchUpdateQueue.shift() ?? {
        data: null,
        error: { message: 'unexpected update error' },
      };
      const chain: Record<string, unknown> = {};
      chain['update'] = vi.fn(() => chain);
      chain['eq'] = vi.fn(() => chain);
      chain['select'] = vi.fn(() => chain);
      chain['single'] = vi.fn(() => Promise.resolve(result));
      return chain;
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => createPatchSupabaseMock()),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ============================================================================
// Import route handler AFTER mocks
// ============================================================================

import { GET, PATCH } from '../route';

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
    // WHY withApiAuthAndRateLimit wiring test: H42 Layer 5 replaced withApiAuth with
    // withApiAuthAndRateLimit. This test proves the route is wired to the new
    // middleware — if a future refactor bypasses it, the gate failure stops firing.
    // OWASP A07:2021, SOC 2 CC6.1.
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () => {
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

// ============================================================================
// PATCH /api/v1/sessions/[id]
// ============================================================================

const VALID_GROUP_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Build a NextRequest for PATCH /api/v1/sessions/[id].
 *
 * @param sessionId - URL path segment
 * @param body - JSON body (sent as-is so tests can inject malformed values)
 * @returns A NextRequest configured for PATCH
 */
function createPatchRequest(sessionId: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk_live_test_key',
    },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/v1/sessions/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchSessionSelectQueue.length = 0;
    patchGroupSelectQueue.length = 0;
    patchUpdateQueue.length = 0;
    patchFromCallCount = 0;
  });

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    /**
     * WHY: Proves PATCH is wired to withApiAuthAndRateLimit. Same gate as GET.
     * OWASP A07:2021, SOC 2 CC6.1.
     */
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      // WHY queue TWO overrides: route.ts wraps both GET and PATCH. On fresh
      // module load, withApiAuthAndRateLimit is called twice — once per export.
      // mockImplementationOnce only overrides one call; the second falls back
      // to the default (auth-passthrough) and the test would 404. Queue two.
      const reject401 = () => async () =>
        NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 },
        );
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(reject401);
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(reject401);

      vi.resetModules();
      const { PATCH: freshPATCH } = await import('../route');

      const response = await freshPATCH(
        createPatchRequest(VALID_SESSION_ID, { session_group_id: null }),
      );
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('returns 400 for malformed UUID in path', async () => {
      const response = await PATCH(
        createPatchRequest('not-a-uuid', { session_group_id: null }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid session ID');
    });

    it('returns 400 when session_group_id is missing', async () => {
      const response = await PATCH(createPatchRequest(VALID_SESSION_ID, {}));
      expect(response.status).toBe(400);
    });

    it('returns 400 when session_group_id is not a UUID and not null', async () => {
      const response = await PATCH(
        createPatchRequest(VALID_SESSION_ID, { session_group_id: 'nope' }),
      );
      expect(response.status).toBe(400);
    });

    /**
     * WHY .strict() guard: caller must not be able to bypass mass-assignment
     * by injecting `user_id` or other columns. OWASP A03:2021.
     */
    it('returns 400 when an unknown field is present (mass-assignment guard)', async () => {
      const response = await PATCH(
        createPatchRequest(VALID_SESSION_ID, {
          session_group_id: VALID_GROUP_ID,
          user_id: 'attacker-uuid',
        }),
      );
      expect(response.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // IDOR defense
  // --------------------------------------------------------------------------

  describe('IDOR defense (OWASP A01:2021)', () => {
    it('returns 404 when session does not exist', async () => {
      patchSessionSelectQueue.push({ data: null, error: null });

      const response = await PATCH(
        createPatchRequest(VALID_SESSION_ID, { session_group_id: null }),
      );
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Session not found');
    });

    it('returns 404 when session belongs to another user (cross-user)', async () => {
      patchSessionSelectQueue.push({
        data: { id: VALID_SESSION_ID, user_id: 'different-user-uuid', deleted_at: null },
        error: null,
      });

      const response = await PATCH(
        createPatchRequest(VALID_SESSION_ID, { session_group_id: null }),
      );
      expect(response.status).toBe(404);
      // Must not leak the real owner ID.
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain('different-user-uuid');
    });

    it('returns 404 when target session_group does not exist or is owned by another user', async () => {
      // Session is owned by us...
      patchSessionSelectQueue.push({
        data: { id: VALID_SESSION_ID, user_id: mockAuthContext.userId, deleted_at: null },
        error: null,
      });
      // ...but the target group is not (or doesn't exist).
      patchGroupSelectQueue.push({ data: null, error: null });

      const response = await PATCH(
        createPatchRequest(VALID_SESSION_ID, { session_group_id: VALID_GROUP_ID }),
      );
      expect(response.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // Success
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    it('returns 200 with updated row when clearing session_group_id (null)', async () => {
      patchSessionSelectQueue.push({
        data: { id: VALID_SESSION_ID, user_id: mockAuthContext.userId, deleted_at: null },
        error: null,
      });
      // No group queue push since session_group_id is null — handler skips that step.
      patchUpdateQueue.push({
        data: {
          id: VALID_SESSION_ID,
          session_group_id: null,
          updated_at: '2026-04-30T12:00:00Z',
        },
        error: null,
      });

      const response = await PATCH(
        createPatchRequest(VALID_SESSION_ID, { session_group_id: null }),
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.id).toBe(VALID_SESSION_ID);
      expect(body.session_group_id).toBeNull();
      expect(body.updated_at).toBeDefined();
    });

    it('returns 200 with updated row when assigning a session_group_id (uuid)', async () => {
      patchSessionSelectQueue.push({
        data: { id: VALID_SESSION_ID, user_id: mockAuthContext.userId, deleted_at: null },
        error: null,
      });
      patchGroupSelectQueue.push({ data: { id: VALID_GROUP_ID }, error: null });
      patchUpdateQueue.push({
        data: {
          id: VALID_SESSION_ID,
          session_group_id: VALID_GROUP_ID,
          updated_at: '2026-04-30T12:01:00Z',
        },
        error: null,
      });

      const response = await PATCH(
        createPatchRequest(VALID_SESSION_ID, { session_group_id: VALID_GROUP_ID }),
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.session_group_id).toBe(VALID_GROUP_ID);
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 and calls Sentry when sessions SELECT fails unexpectedly', async () => {
      patchSessionSelectQueue.push({
        data: null,
        error: { code: '08006', message: 'connection terminated' },
      });

      const Sentry = await import('@sentry/nextjs');
      const response = await PATCH(
        createPatchRequest(VALID_SESSION_ID, { session_group_id: null }),
      );

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();

      const body = await response.json();
      expect(body.error).toBe('Failed to update session');
      expect(JSON.stringify(body)).not.toContain('connection terminated');
    });

    it('returns 500 and calls Sentry when UPDATE fails unexpectedly', async () => {
      patchSessionSelectQueue.push({
        data: { id: VALID_SESSION_ID, user_id: mockAuthContext.userId, deleted_at: null },
        error: null,
      });
      patchUpdateQueue.push({
        data: null,
        error: { message: 'deadlock detected' },
      });

      const Sentry = await import('@sentry/nextjs');
      const response = await PATCH(
        createPatchRequest(VALID_SESSION_ID, { session_group_id: null }),
      );
      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();
    });
  });
});
