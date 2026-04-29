/**
 * POST /api/v1/contexts — Integration Tests
 *
 * Tests the agent context memory upsert endpoint. This endpoint is a critical
 * part of the CLI daemon's reconnect flow: it persists rolling context snapshots
 * so that agents can resume mid-session without full history replay.
 *
 * WHY these tests exist:
 * 1. The IDOR defense (404 on owner mismatch) is a SOC 2 CC6.1 control — any
 *    regression that returns 403 would enable session_group_id enumeration.
 * 2. The 201 vs 200 distinction (insert vs update) is load-bearing for the CLI
 *    daemon's idempotency detection logic.
 * 3. The Zod .strict() guard prevents mass-assignment; tests confirm unknown
 *    fields are rejected before reaching the DB.
 *
 * @security OWASP A01:2021 (Broken Access Control / IDOR)
 * @security OWASP A07:2021 (Identification and Authentication Failures)
 * @security OWASP A03:2021 (Injection / Mass Assignment)
 * @security SOC 2 CC6.1 (Logical Access Controls)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks — withApiAuthAndRateLimit bypass
// ============================================================================

/**
 * Default auth context injected by the mocked middleware.
 * WHY: v1 routes use API key auth (withApiAuthAndRateLimit), not cookie auth.
 * Mocking the middleware allows testing handler logic in isolation.
 */
const mockAuthContext = {
  userId: 'owner-user-uuid-001',
  keyId: 'key-id-xyz',
  scopes: ['write'],
  keyExpiresAt: null,
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuthAndRateLimit: vi.fn((handler: Function) => {
    return async (request: NextRequest) => handler(request, mockAuthContext);
  }),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

// ============================================================================
// Mocks — Sentry
// ============================================================================

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ============================================================================
// Mocks — Idempotency middleware
// ============================================================================

/**
 * Controls what checkIdempotency returns per test.
 * Reset in beforeEach to { replayed: false } (normal path).
 */
let idempotencyCheckResult: unknown = { replayed: false };

vi.mock('@/lib/middleware/idempotency', () => ({
  checkIdempotency: vi.fn(async () => idempotencyCheckResult),
  storeIdempotencyResult: vi.fn(async () => undefined),
}));

// ============================================================================
// Mocks — Supabase admin client
// ============================================================================

/**
 * Three independent queues for the three DB calls made by the handler:
 * 1. SELECT user_id FROM agent_session_groups (ownership check)
 * 2. SELECT id, version FROM agent_context_memory (pre-upsert existence check)
 * 3. UPSERT INTO agent_context_memory (the actual write)
 *
 * WHY three queues: each .from() call shifts the next result off its respective
 * queue, giving tests independent control over each DB interaction.
 */
const groupSelectQueue: Array<{ data: unknown; error: unknown }> = [];
const contextSelectQueue: Array<{ data: unknown; error: unknown }> = [];
const upsertQueue: Array<{ data: unknown; error: unknown }> = [];

/**
 * Call counter tracks which .from() invocation we're on so the mock can
 * route to the correct queue.
 *
 * Call order per request:
 *  0: agent_session_groups SELECT (ownership check)
 *  1: agent_context_memory SELECT (existence check)
 *  2: agent_context_memory UPSERT
 */
let fromCallCount = 0;

function createSupabaseMock() {
  return {
    from: vi.fn((_table: string) => {
      const callIndex = fromCallCount++;

      // Ownership check — call 0
      if (callIndex === 0) {
        const result = groupSelectQueue.shift() ?? {
          data: null,
          error: { code: 'PGRST116', message: 'no rows returned' },
        };
        const chain: Record<string, unknown> = {};
        chain['select'] = vi.fn(() => chain);
        chain['eq'] = vi.fn(() => chain);
        chain['single'] = vi.fn(() => Promise.resolve(result));
        return chain;
      }

      // Context existence check — call 1
      if (callIndex === 1) {
        const result = contextSelectQueue.shift() ?? {
          data: null,
          error: { code: 'PGRST116', message: 'no rows returned' },
        };
        const chain: Record<string, unknown> = {};
        chain['select'] = vi.fn(() => chain);
        chain['eq'] = vi.fn(() => chain);
        chain['single'] = vi.fn(() => Promise.resolve(result));
        return chain;
      }

      // Upsert — call 2
      const result = upsertQueue.shift() ?? {
        data: null,
        error: { message: 'unexpected upsert error' },
      };
      const chain: Record<string, unknown> = {};
      chain['upsert'] = vi.fn(() => chain);
      chain['select'] = vi.fn(() => chain);
      chain['single'] = vi.fn(() => Promise.resolve(result));
      return chain;
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => createSupabaseMock()),
}));

// ============================================================================
// Import route handler AFTER mocks
// ============================================================================

import { POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const VALID_GROUP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const BASE_URL = 'http://localhost:3000/api/v1/contexts';

/**
 * Minimal valid body for POST /api/v1/contexts.
 * All required fields present; optionals omitted.
 */
const MINIMAL_VALID_BODY = {
  session_group_id: VALID_GROUP_ID,
  summary_markdown: 'Agent is working on authentication module refactor.',
};

/**
 * Full valid body with all optional fields.
 */
const FULL_VALID_BODY = {
  session_group_id: VALID_GROUP_ID,
  summary_markdown: 'Agent is working on authentication module refactor.',
  file_refs: [
    { path: 'src/auth/index.ts', lastTouchedAt: '2026-04-29T10:00:00Z', relevance: 0.9 },
  ],
  recent_messages: [
    { role: 'user', preview: 'Add JWT refresh logic' },
    { role: 'assistant', preview: 'I will add the refresh token rotation...' },
  ],
  token_budget: 4000,
};

/**
 * A sample row returned by the upsert.
 */
const SAMPLE_UPSERT_ROW = {
  id: 'context-row-uuid-001',
  session_group_id: VALID_GROUP_ID,
  version: 1,
  created_at: '2026-04-29T00:00:00Z',
  updated_at: '2026-04-29T00:00:00Z',
};

/**
 * Creates a NextRequest for POST /api/v1/contexts.
 *
 * @param body - JSON body to send
 * @param headers - Additional request headers
 * @returns A NextRequest with the POST method and JSON body
 */
function createRequest(
  body: unknown = MINIMAL_VALID_BODY,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer styrby_live_test_key',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Push the standard happy-path DB results into all three queues.
 *
 * @param versionOverride - Optionally specify the version on the upsert row
 * @param existingVersion - If set, simulates a pre-existing context row
 */
function pushHappyPathQueues(
  versionOverride: number = 1,
  existingVersion?: number,
): void {
  // Ownership check passes
  groupSelectQueue.push({ data: { user_id: mockAuthContext.userId }, error: null });

  if (existingVersion !== undefined) {
    // Simulate an existing context row (update path)
    contextSelectQueue.push({
      data: { id: SAMPLE_UPSERT_ROW.id, version: existingVersion },
      error: null,
    });
  }
  // If existingVersion is undefined, the queue is empty → mock returns PGRST116 (insert path)

  // Upsert returns the row
  upsertQueue.push({
    data: { ...SAMPLE_UPSERT_ROW, version: versionOverride },
    error: null,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/v1/contexts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupSelectQueue.length = 0;
    contextSelectQueue.length = 0;
    upsertQueue.length = 0;
    fromCallCount = 0;
    idempotencyCheckResult = { replayed: false };
  });

  // --------------------------------------------------------------------------
  // 1. Auth middleware wiring
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    /**
     * WHY: Proves the route is wired to withApiAuthAndRateLimit. A refactor
     * that accidentally bypasses the wrapper would allow unauthenticated
     * context writes. OWASP A07:2021, SOC 2 CC6.1.
     */
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 },
        );
      });

      vi.resetModules();
      const { POST: freshPOST } = await import('../route');

      const response = await freshPOST(createRequest());
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Missing Authorization header');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Zod validation — 400 cases
  // --------------------------------------------------------------------------

  describe('validation', () => {
    /**
     * WHY: session_group_id is required and must be a UUID. Passing an arbitrary
     * string would cause a DB-level error (UUID column type mismatch). The API
     * layer must reject it first. OWASP A03:2021.
     */
    it('returns 400 when session_group_id is missing', async () => {
      const response = await POST(
        createRequest({ summary_markdown: 'Some context' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when session_group_id is not a valid UUID', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, session_group_id: 'not-a-uuid' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when summary_markdown is missing', async () => {
      const response = await POST(
        createRequest({ session_group_id: VALID_GROUP_ID }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when summary_markdown is empty string', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, summary_markdown: '' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when summary_markdown exceeds 50,000 characters', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, summary_markdown: 'x'.repeat(50_001) }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('accepts summary_markdown at exactly 50,000 characters', async () => {
      pushHappyPathQueues();
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, summary_markdown: 'x'.repeat(50_000) }),
      );
      // Should reach the DB stage (not a 400) — group ownership check happens next
      // In this test, DB queues are loaded so it should succeed with 201
      expect(response.status).toBe(201);
    });

    /**
     * WHY .strict() test: callers must not inject unknown fields (e.g. `user_id`,
     * `version`, `created_at`) to tamper with the upsert payload. Zod .strict()
     * rejects any unrecognized fields before they reach the DB. OWASP A03:2021.
     */
    it('returns 400 when an unknown field is present (mass-assignment guard)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, user_id: 'attacker-uuid' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when version is injected (mass-assignment guard)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, version: 999 }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * IMPORTANT-1: Nested .strict() guard on file_refs items.
     * An unknown field inside a file_refs element must be rejected. Without .strict()
     * on the nested schema, mass-assignment via nested object fields is possible.
     * OWASP A03:2021.
     */
    it('returns 400 when a file_refs element contains an unknown field (nested strict guard)', async () => {
      const response = await POST(
        createRequest({
          ...MINIMAL_VALID_BODY,
          file_refs: [
            {
              path: 'src/auth/index.ts',
              lastTouchedAt: '2026-04-29T10:00:00Z',
              relevance: 0.9,
              injectedField: 'should-be-rejected',
            },
          ],
        }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * IMPORTANT-2: file_refs.path must not be empty string.
     * An empty path is nonsensical and would write a zero-length string to the
     * DB column. The .min(1) guard ensures clean validation at the API layer.
     */
    it('returns 400 when file_refs contains an element with an empty path', async () => {
      const response = await POST(
        createRequest({
          ...MINIMAL_VALID_BODY,
          file_refs: [
            { path: '', lastTouchedAt: '2026-04-29T10:00:00Z', relevance: 0.5 },
          ],
        }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 3. token_budget boundary validation
  // --------------------------------------------------------------------------

  describe('token_budget bounds', () => {
    /**
     * WHY: token_budget must align with the CHECK constraint on the DB column
     * (100–8000). Values outside this range cause a DB-level constraint violation
     * that returns a cryptic 500. We enforce it at the API layer for a clean 400.
     */
    it('returns 400 when token_budget is 99 (below min)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, token_budget: 99 }),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when token_budget is 8001 (above max)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, token_budget: 8001 }),
      );
      expect(response.status).toBe(400);
    });

    it('accepts token_budget of 100 (min boundary)', async () => {
      pushHappyPathQueues();
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, token_budget: 100 }),
      );
      expect(response.status).toBe(201);
    });

    it('accepts token_budget of 8000 (max boundary)', async () => {
      pushHappyPathQueues();
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, token_budget: 8000 }),
      );
      expect(response.status).toBe(201);
    });
  });

  // --------------------------------------------------------------------------
  // 4. IDOR defense — 404 for non-existent and wrong-owner groups
  // --------------------------------------------------------------------------

  describe('IDOR defense (OWASP A01:2021)', () => {
    /**
     * WHY: If the group does not exist, the handler must return 404. Must not
     * distinguish "not found" from "wrong owner" — consistent 404 prevents
     * session group enumeration. OWASP A01:2021. SOC 2 CC6.1.
     */
    it('returns 404 when session_group_id does not exist in agent_session_groups', async () => {
      // groupSelectQueue is empty → mock returns PGRST116
      const response = await POST(createRequest());
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Not found');
    });

    it('returns 404 when session_group_id belongs to a different user (IDOR)', async () => {
      // Group exists but is owned by a different user
      groupSelectQueue.push({
        data: { user_id: 'different-user-uuid-999' },
        error: null,
      });

      const response = await POST(createRequest());
      expect(response.status).toBe(404);

      const body = await response.json();
      // WHY same message: IDOR defense — caller cannot distinguish "not found"
      // from "belongs to someone else". OWASP A01:2021.
      expect(body.error).toBe('Not found');
    });

    it('returns 404 (not 403) on owner mismatch', async () => {
      groupSelectQueue.push({
        data: { user_id: 'attacker-cannot-see-this-uuid' },
        error: null,
      });

      const response = await POST(createRequest());
      expect(response.status).toBe(404);
      expect(response.status).not.toBe(403);
    });

    it('does not expose the real owner user_id in the 404 response body', async () => {
      groupSelectQueue.push({
        data: { user_id: 'victim-user-uuid-secret' },
        error: null,
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(JSON.stringify(body)).not.toContain('victim-user-uuid-secret');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Happy path — 201 on first insert
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    /**
     * WHY: First upsert (no existing row) must return 201. Response must include
     * all ContextRow fields with version=1. Content-Type must be application/json
     * so CLI clients can safely parse it. MINOR-3 style assertion.
     */
    it('returns 201 with full ContextRow on first insert (version=1)', async () => {
      pushHappyPathQueues(1); // No existingVersion → insert path

      const response = await POST(createRequest());
      expect(response.status).toBe(201);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);

      const body = await response.json();
      expect(body.id).toBe(SAMPLE_UPSERT_ROW.id);
      expect(body.session_group_id).toBe(VALID_GROUP_ID);
      expect(body.version).toBe(1);
      expect(body.created_at).toBeDefined();
      expect(body.updated_at).toBeDefined();
    });

    it('returns 201 with full valid body (all optional fields present)', async () => {
      pushHappyPathQueues(1);

      const response = await POST(createRequest(FULL_VALID_BODY));
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.version).toBe(1);
    });

    /**
     * WHY: Second upsert with same session_group_id must return 200 (not 201).
     * Version must be incremented to 2. The 201 vs 200 distinction is the
     * signal the CLI daemon uses to detect context record creation vs update.
     */
    it('returns 200 on conflict-update with version incremented to 2', async () => {
      // Simulate existing context row with version=1
      groupSelectQueue.push({ data: { user_id: mockAuthContext.userId }, error: null });
      contextSelectQueue.push({ data: { id: SAMPLE_UPSERT_ROW.id, version: 1 }, error: null });
      upsertQueue.push({ data: { ...SAMPLE_UPSERT_ROW, version: 2 }, error: null });

      const response = await POST(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.version).toBe(2);
    });

    it('does NOT return 201 on conflict-update path', async () => {
      groupSelectQueue.push({ data: { user_id: mockAuthContext.userId }, error: null });
      contextSelectQueue.push({ data: { id: SAMPLE_UPSERT_ROW.id, version: 1 }, error: null });
      upsertQueue.push({ data: { ...SAMPLE_UPSERT_ROW, version: 2 }, error: null });

      const response = await POST(createRequest());
      expect(response.status).not.toBe(201);
    });

    it('response body includes all required ContextRow fields', async () => {
      pushHappyPathQueues(1);

      const response = await POST(createRequest());
      const body = await response.json();

      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('session_group_id');
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('created_at');
      expect(body).toHaveProperty('updated_at');
    });
  });

  // --------------------------------------------------------------------------
  // 6. Idempotency
  // --------------------------------------------------------------------------

  describe('idempotency', () => {
    /**
     * WHY: Idempotency replay must return the cached response verbatim with
     * X-Idempotency-Replay: true header. The CLI daemon uses this header to
     * detect replay vs fresh upsert, preventing double-increment of version.
     */
    it('returns cached response with X-Idempotency-Replay header on replay', async () => {
      idempotencyCheckResult = {
        replayed: true,
        status: 201,
        body: { ...SAMPLE_UPSERT_ROW, version: 1 },
      };

      const response = await POST(
        createRequest(MINIMAL_VALID_BODY, { 'Idempotency-Key': 'idem-key-001' }),
      );

      expect(response.status).toBe(201);
      expect(response.headers.get('X-Idempotency-Replay')).toBe('true');

      const body = await response.json();
      expect(body.id).toBe(SAMPLE_UPSERT_ROW.id);
      expect(body.version).toBe(1);
    });

    /**
     * WHY: Reusing an Idempotency-Key with a different body is a client
     * programming error. Must return 409 to signal the conflict clearly.
     * RFC 9110 Conflict.
     */
    it('returns 409 when Idempotency-Key is reused with a different body', async () => {
      idempotencyCheckResult = {
        conflict: true,
        message:
          'Idempotency-Key has already been used with a different request body. ' +
          'Use a new key for a different request.',
      };

      const response = await POST(
        createRequest(MINIMAL_VALID_BODY, { 'Idempotency-Key': 'idem-key-001' }),
      );
      expect(response.status).toBe(409);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('calls storeIdempotencyResult after a successful first insert', async () => {
      pushHappyPathQueues(1);

      const { storeIdempotencyResult } = await import('@/lib/middleware/idempotency');

      await POST(createRequest(MINIMAL_VALID_BODY, { 'Idempotency-Key': 'idem-key-002' }));

      expect(storeIdempotencyResult).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------------------------
  // 7. Rate limiting — 429
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    /**
     * WHY: Proves the route surfaces 429 + Retry-After when the rate-limiter
     * inside withApiAuthAndRateLimit denies the request. The middleware mock is
     * overridden to return a 429 directly; POST() is called normally so the full
     * handler call path executes. OWASP A07:2021 (flood protection).
     */
    it('returns 429 with Retry-After header when rate limit is exceeded', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Rate limit exceeded. Retry after 30 seconds', code: 'RATE_LIMITED' },
          { status: 429, headers: { 'Retry-After': '30' } },
        );
      });

      vi.resetModules();
      const { POST: freshPOST } = await import('../route');

      const response = await freshPOST(createRequest());
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('30');

      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 8. 500 + Sentry capture on DB errors
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    /**
     * WHY: Unexpected DB errors (deadlocks, connectivity loss) must be captured
     * in Sentry and surface a sanitized message. Raw DB errors must never reach
     * the caller — they may contain schema or PII details. OWASP A02:2021.
     */
    it('returns 500 and calls Sentry when agent_session_groups SELECT fails unexpectedly', async () => {
      groupSelectQueue.push({
        data: null,
        error: { code: '08006', message: 'Connection terminated unexpectedly' },
      });

      const Sentry = await import('@sentry/nextjs');
      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();

      const body = await response.json();
      expect(body.error).toBe('Failed to upsert context memory');
      expect(JSON.stringify(body)).not.toContain('Connection terminated');
    });

    it('returns 500 and calls Sentry when upsert fails unexpectedly', async () => {
      // Ownership check passes
      groupSelectQueue.push({ data: { user_id: mockAuthContext.userId }, error: null });
      // Context existence check returns PGRST116 (no existing row)
      // contextSelectQueue empty → mock returns PGRST116 by default
      // Upsert fails
      upsertQueue.push({ data: null, error: { message: 'deadlock detected' } });

      const Sentry = await import('@sentry/nextjs');
      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();

      const body = await response.json();
      expect(body.error).toBe('Failed to upsert context memory');
      expect(JSON.stringify(body)).not.toContain('deadlock detected');
    });

    it('does not include raw DB error details in 500 response body', async () => {
      groupSelectQueue.push({
        data: null,
        error: { code: '57014', message: 'query_canceled: internal pg error' },
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(JSON.stringify(body)).not.toContain('query_canceled');
    });

    it('returns 500 and calls Sentry when agent_context_memory SELECT (existence check) fails unexpectedly', async () => {
      // Ownership check passes
      groupSelectQueue.push({ data: { user_id: mockAuthContext.userId }, error: null });
      // Context existence check fails with non-PGRST116 error
      contextSelectQueue.push({
        data: null,
        error: { code: '08P01', message: 'protocol error' },
      });

      const Sentry = await import('@sentry/nextjs');
      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();
    });

    /**
     * CRITICAL-2: Upsert returns { data: null, error: null } — success-but-empty.
     * This is an unexpected DB state (RETURNING suppressed). The handler must catch
     * it, call Sentry.captureMessage, and return 500 instead of throwing TypeError.
     */
    it('returns 500 and calls Sentry.captureMessage when upsert returns null row with no error', async () => {
      // Ownership check passes
      groupSelectQueue.push({ data: { user_id: mockAuthContext.userId }, error: null });
      // Context existence check: no prior row (insert path)
      // contextSelectQueue empty → mock returns PGRST116 by default
      // Upsert: success but no row returned
      upsertQueue.push({ data: null, error: null });

      const Sentry = await import('@sentry/nextjs');
      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureMessage).toHaveBeenCalledOnce();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Upsert succeeded but returned no row',
        expect.objectContaining({ level: 'error' }),
      );

      const body = await response.json();
      expect(body.error).toBe('Internal error');
    });
  });

  // --------------------------------------------------------------------------
  // 9. Content-Type on all responses
  // --------------------------------------------------------------------------

  describe('response headers', () => {
    it('sets Content-Type: application/json on 201 response', async () => {
      pushHappyPathQueues(1);

      const response = await POST(createRequest());
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });

    it('sets Content-Type: application/json on 200 (update) response', async () => {
      groupSelectQueue.push({ data: { user_id: mockAuthContext.userId }, error: null });
      contextSelectQueue.push({ data: { id: SAMPLE_UPSERT_ROW.id, version: 1 }, error: null });
      upsertQueue.push({ data: { ...SAMPLE_UPSERT_ROW, version: 2 }, error: null });

      const response = await POST(createRequest());
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });
  });

  // --------------------------------------------------------------------------
  // 10. Supabase client routing (OWASP A03:2021 smoke)
  // --------------------------------------------------------------------------

  describe('query safety', () => {
    /**
     * WHY: Confirms the handler routes through the Supabase client (createAdminClient
     * was called). This is a smoke test — actual parameterization safety comes from
     * supabase-js always using pg prepared statements. OWASP A03:2021.
     */
    it('routes all DB calls through Supabase client', async () => {
      pushHappyPathQueues(1);

      const { createAdminClient } = await import('@/lib/supabase/server');

      await POST(createRequest(FULL_VALID_BODY));

      expect(createAdminClient).toHaveBeenCalled();
    });
  });
});
