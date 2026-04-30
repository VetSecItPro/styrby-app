/**
 * POST /api/v1/templates — Integration Tests
 *
 * Tests the context template creation endpoint. This endpoint is called by the
 * CLI `styrby template new` command to persist reusable project context.
 *
 * WHY these tests exist:
 * 1. The Zod .strict() guard prevents mass-assignment; tests confirm unknown
 *    fields (including user_id injection) are rejected before reaching the DB.
 * 2. The null guard on .single() prevents a downstream TypeError on an
 *    unexpected DB state (insert success but no row returned).
 * 3. Idempotency replay prevents duplicate template creation on CLI retry.
 * 4. Sentry capture + sanitized 500 prevents PII/schema leakage on DB errors.
 *
 * SPEC DEVIATION verified: spec said { name, body, agent_type? } — actual table
 * uses `content` (not `body`), `description`, `variables`, `is_default`. No
 * `agent_type` column exists. Tests use the verified schema.
 * (Migration 002_context_templates.sql, lines 29-57)
 *
 * @security OWASP A07:2021 (Identification and Authentication Failures)
 * @security OWASP A03:2021 (Injection / Mass Assignment)
 * @security SOC 2 CC6.1 (Logical Access Controls)
 * @security GDPR Art 6(1)(a) (Lawful Basis)
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
 * Single queue for the one DB call made by the handler:
 *  INSERT INTO context_templates ... RETURNING id, name, created_at
 *
 * WHY a queue: each .from() call shifts the next result off the queue,
 * giving tests independent control over the DB response.
 */
const insertQueue: Array<{ data: unknown; error: unknown }> = [];

function createSupabaseMock() {
  return {
    from: vi.fn((_table: string) => {
      const result = insertQueue.shift() ?? {
        data: null,
        error: { message: 'unexpected insert error' },
      };
      const chain: Record<string, unknown> = {};
      chain['insert'] = vi.fn(() => chain);
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

const BASE_URL = 'http://localhost:3000/api/v1/templates';

/**
 * Minimal valid body for POST /api/v1/templates.
 * Only required fields; optionals omitted.
 */
const MINIMAL_VALID_BODY = {
  name: 'Project Architecture',
  content: 'This project uses a monorepo structure with pnpm workspaces.',
};

/**
 * Full valid body with all optional fields.
 */
const FULL_VALID_BODY = {
  name: 'Project Architecture',
  content: 'This is a {{language}} project using {{framework}}.',
  description: 'Base context for all new sessions in the styrby project.',
  variables: [
    { name: 'language', description: 'Programming language', defaultValue: 'TypeScript' },
    { name: 'framework', description: 'Web framework', defaultValue: 'Next.js' },
  ],
  is_default: false,
};

/**
 * Sample row returned by the INSERT.
 */
const SAMPLE_INSERT_ROW = {
  id: 'template-row-uuid-001',
  name: 'Project Architecture',
  created_at: '2026-04-29T00:00:00Z',
};

/**
 * Creates a NextRequest for POST /api/v1/templates.
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
 * Push a successful INSERT result into the queue.
 *
 * @param rowOverride - Optional partial row to merge with SAMPLE_INSERT_ROW
 */
function pushHappyPathQueue(rowOverride: Partial<typeof SAMPLE_INSERT_ROW> = {}): void {
  insertQueue.push({
    data: { ...SAMPLE_INSERT_ROW, ...rowOverride },
    error: null,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/v1/templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertQueue.length = 0;
    idempotencyCheckResult = { replayed: false };
  });

  // --------------------------------------------------------------------------
  // 1. Auth middleware wiring — OWASP A07:2021
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    /**
     * WHY: Proves the route is wired to withApiAuthAndRateLimit. A refactor
     * that accidentally bypasses the wrapper would allow unauthenticated
     * template creation. OWASP A07:2021, SOC 2 CC6.1.
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
  // 2. Zod validation — 400 cases (OWASP A03:2021)
  // --------------------------------------------------------------------------

  describe('validation', () => {
    /**
     * WHY: `name` is required and must be non-empty. An empty or missing name
     * violates the DB CHECK constraint (context_templates_name_not_empty) and
     * would cause a cryptic DB error. The API layer must reject it first.
     * OWASP A03:2021.
     */
    it('returns 400 when name is missing', async () => {
      const response = await POST(createRequest({ content: 'Some content' }));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when name is empty string', async () => {
      const response = await POST(createRequest({ ...MINIMAL_VALID_BODY, name: '' }));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when name exceeds 255 characters', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, name: 'x'.repeat(256) }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('accepts name at exactly 255 characters', async () => {
      pushHappyPathQueue({ name: 'x'.repeat(255) });
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, name: 'x'.repeat(255) }),
      );
      expect(response.status).toBe(201);
    });

    /**
     * WHY: `content` is required (maps to the TEXT NOT NULL column). An empty
     * content violates the DB CHECK constraint. OWASP A03:2021.
     */
    it('returns 400 when content is missing', async () => {
      const response = await POST(createRequest({ name: 'Test Template' }));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when content is empty string', async () => {
      const response = await POST(createRequest({ ...MINIMAL_VALID_BODY, content: '' }));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when content exceeds 50,000 characters', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, content: 'x'.repeat(50_001) }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('accepts content at exactly 50,000 characters', async () => {
      pushHappyPathQueue();
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, content: 'x'.repeat(50_000) }),
      );
      expect(response.status).toBe(201);
    });

    it('returns 400 when description exceeds 1,000 characters', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, description: 'x'.repeat(1_001) }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * WHY .strict() test: callers must not inject unknown fields (e.g. `user_id`,
     * `created_at`, `agent_type`) to tamper with the insert payload. Zod .strict()
     * rejects any unrecognized fields before they reach the DB. OWASP A03:2021.
     */
    it('returns 400 when an unknown field is present (mass-assignment guard)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, agent_type: 'claude' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * WHY: This is the critical mass-assignment guard. A caller injecting `user_id`
     * in the body would attempt to create a template owned by another user.
     * Zod .strict() must reject it before any DB call. OWASP A03:2021, A07:2021.
     */
    it('returns 400 when user_id is injected in the body (mass-assignment guard)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, user_id: 'attacker-uuid-999' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when created_at is injected in the body (mass-assignment guard)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, created_at: '2020-01-01T00:00:00Z' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * WHY nested .strict() on variables items: a caller could inject an unknown
     * field inside a variables element to attempt mass-assignment via a nested
     * object. The nested .strict() guard rejects these. OWASP A03:2021.
     */
    it('returns 400 when a variables element contains an unknown field (nested strict guard)', async () => {
      const response = await POST(
        createRequest({
          ...MINIMAL_VALID_BODY,
          variables: [
            {
              name: 'language',
              description: 'Language',
              defaultValue: 'TypeScript',
              injectedField: 'should-be-rejected',
            },
          ],
        }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when a variable name is empty string', async () => {
      const response = await POST(
        createRequest({
          ...MINIMAL_VALID_BODY,
          variables: [{ name: '' }],
        }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when is_default is not a boolean', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, is_default: 'yes' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Happy path — 201 on first insert
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    /**
     * WHY: Confirms the handler inserts a row and returns 201 with the required
     * TemplateRow fields. Content-Type must be application/json so CLI clients
     * can safely parse it.
     */
    it('returns 201 with TemplateRow on successful insert (minimal body)', async () => {
      pushHappyPathQueue();

      const response = await POST(createRequest());
      expect(response.status).toBe(201);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);

      const body = await response.json();
      expect(body.id).toBe(SAMPLE_INSERT_ROW.id);
      expect(body.name).toBe(SAMPLE_INSERT_ROW.name);
      expect(body.created_at).toBeDefined();
    });

    it('returns 201 with full valid body (all optional fields present)', async () => {
      pushHappyPathQueue();

      const response = await POST(createRequest(FULL_VALID_BODY));
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.id).toBe(SAMPLE_INSERT_ROW.id);
      expect(body.name).toBe(SAMPLE_INSERT_ROW.name);
      expect(body.created_at).toBeDefined();
    });

    it('response body includes exactly the required TemplateRow fields', async () => {
      pushHappyPathQueue();

      const response = await POST(createRequest());
      const body = await response.json();

      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('created_at');
    });

    it('response body does NOT include content, description, variables, or is_default', async () => {
      pushHappyPathQueue();

      const response = await POST(createRequest(FULL_VALID_BODY));
      const body = await response.json();

      // WHY: spec response is { id, name, created_at } only. No other fields
      // should leak into the response — they could expose internal DB structure.
      expect(body).not.toHaveProperty('content');
      expect(body).not.toHaveProperty('description');
      expect(body).not.toHaveProperty('variables');
      expect(body).not.toHaveProperty('is_default');
      expect(body).not.toHaveProperty('user_id');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Null guard on .single() return
  // --------------------------------------------------------------------------

  describe('null guard on .single() return', () => {
    /**
     * WHY CRITICAL: insert succeeds (no error) but .single() returns null.
     * This is an unexpected DB state (RETURNING suppressed). Without the null
     * guard the handler would throw TypeError on insertedRow.id, which would
     * surface as an unhandled 500 without Sentry capture. The guard catches it
     * explicitly and calls Sentry.captureMessage. Task 3 lesson applied.
     */
    it('returns 500 and calls Sentry.captureMessage when insert returns null row with no error', async () => {
      insertQueue.push({ data: null, error: null });

      const Sentry = await import('@sentry/nextjs');
      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureMessage).toHaveBeenCalledOnce();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Insert succeeded but returned no row',
        expect.objectContaining({ level: 'error' }),
      );

      const body = await response.json();
      expect(body.error).toBe('Internal error');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Idempotency
  // --------------------------------------------------------------------------

  describe('idempotency', () => {
    /**
     * WHY: The CLI retries on network failure. Without idempotency, a retry
     * would create a duplicate template. The Idempotency-Key header + cache
     * layer ensures the second request returns the first row's data unchanged.
     */
    it('returns cached response with X-Idempotency-Replay header on replay', async () => {
      idempotencyCheckResult = {
        replayed: true,
        status: 201,
        body: { ...SAMPLE_INSERT_ROW },
      };

      const response = await POST(
        createRequest(MINIMAL_VALID_BODY, { 'Idempotency-Key': 'idem-key-001' }),
      );

      expect(response.status).toBe(201);
      expect(response.headers.get('X-Idempotency-Replay')).toBe('true');

      const body = await response.json();
      expect(body.id).toBe(SAMPLE_INSERT_ROW.id);
      expect(body.name).toBe(SAMPLE_INSERT_ROW.name);
    });

    /**
     * WHY: Reusing an Idempotency-Key with a different body is a client
     * programming error — two different template payloads cannot share the same
     * key. Must return 409 to signal the conflict clearly. RFC 9110 Conflict.
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

    it('calls storeIdempotencyResult after a successful insert', async () => {
      pushHappyPathQueue();

      const { storeIdempotencyResult } = await import('@/lib/middleware/idempotency');

      await POST(createRequest(MINIMAL_VALID_BODY, { 'Idempotency-Key': 'idem-key-002' }));

      expect(storeIdempotencyResult).toHaveBeenCalledOnce();
    });

    it('does NOT call storeIdempotencyResult on idempotency replay', async () => {
      idempotencyCheckResult = {
        replayed: true,
        status: 201,
        body: { ...SAMPLE_INSERT_ROW },
      };

      const { storeIdempotencyResult } = await import('@/lib/middleware/idempotency');

      await POST(
        createRequest(MINIMAL_VALID_BODY, { 'Idempotency-Key': 'idem-key-replay' }),
      );

      expect(storeIdempotencyResult).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 6. Rate limiting — 429 (OWASP A07:2021 flood protection)
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    /**
     * WHY: Proves the route surfaces 429 + Retry-After when the rate-limiter
     * inside withApiAuthAndRateLimit denies the request. The middleware mock is
     * overridden to return a 429 directly; POST() is called normally.
     * OWASP A07:2021 (flood protection).
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
  // 7. 500 + Sentry capture on DB errors
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    /**
     * WHY: Unexpected DB errors (deadlocks, connectivity loss) must be captured
     * in Sentry and surface a sanitized message. Raw DB errors must never reach
     * the caller — they may contain schema or PII details. OWASP A02:2021.
     */
    it('returns 500 and calls Sentry when INSERT fails with a DB error', async () => {
      insertQueue.push({ data: null, error: { message: 'deadlock detected' } });

      const Sentry = await import('@sentry/nextjs');
      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();

      const body = await response.json();
      expect(body.error).toBe('Failed to create template');
    });

    it('does not include raw DB error details in 500 response body', async () => {
      insertQueue.push({ data: null, error: { message: 'pg internal: column "agent_type" does not exist' } });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(JSON.stringify(body)).not.toContain('agent_type');
      expect(JSON.stringify(body)).not.toContain('column');
    });

    it('returns 500 and calls Sentry on connection-level DB error', async () => {
      insertQueue.push({
        data: null,
        error: { code: '08006', message: 'Connection terminated unexpectedly' },
      });

      const Sentry = await import('@sentry/nextjs');
      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();

      const body = await response.json();
      expect(body.error).toBe('Failed to create template');
      expect(JSON.stringify(body)).not.toContain('Connection terminated');
    });
  });

  // --------------------------------------------------------------------------
  // 8. Content-Type on all responses
  // --------------------------------------------------------------------------

  describe('response headers', () => {
    it('sets Content-Type: application/json on 201 response', async () => {
      pushHappyPathQueue();

      const response = await POST(createRequest());
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });

    it('sets Content-Type: application/json on 400 response', async () => {
      const response = await POST(createRequest({ content: 'Missing name field' }));
      expect(response.status).toBe(400);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });

    it('sets Content-Type: application/json on 500 response', async () => {
      insertQueue.push({ data: null, error: { message: 'DB error' } });
      const response = await POST(createRequest());
      expect(response.status).toBe(500);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Supabase client routing smoke test (OWASP A03:2021)
  // --------------------------------------------------------------------------

  describe('query safety', () => {
    /**
     * WHY: Confirms the handler routes through the Supabase admin client.
     * Actual parameterization safety comes from supabase-js always using
     * pg prepared statements. OWASP A03:2021.
     */
    it('routes all DB calls through Supabase admin client', async () => {
      pushHappyPathQueue();

      const { createAdminClient } = await import('@/lib/supabase/server');

      await POST(createRequest(FULL_VALID_BODY));

      expect(createAdminClient).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 10. Spec deviation tests — verified body shape
  // --------------------------------------------------------------------------

  describe('spec deviation (verified body shape)', () => {
    /**
     * WHY: The original spec said the body field was `body` (not `content`).
     * This test confirms the actual column name `content` is accepted and `body`
     * is rejected as an unknown field by Zod .strict().
     *
     * Verified against migration 002_context_templates.sql, line 39:
     *   `content TEXT NOT NULL`
     */
    it('accepts `content` field (correct verified column name)', async () => {
      pushHappyPathQueue();
      const response = await POST(createRequest({ name: 'Test', content: 'Some context content' }));
      expect(response.status).toBe(201);
    });

    it('rejects `body` field (spec said body but actual column is content)', async () => {
      const response = await POST(createRequest({ name: 'Test', body: 'Some body text' }));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * WHY: The original spec said body included `agent_type?`. No such column
     * exists in context_templates (verified migration 002_context_templates.sql).
     * Zod .strict() must reject it.
     */
    it('rejects `agent_type` field (does not exist in context_templates schema)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, agent_type: 'claude' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    /**
     * WHY: The `variables` field is a JSONB array — not in the original spec.
     * This test confirms valid variables array is accepted.
     */
    it('accepts valid `variables` array (additional verified field)', async () => {
      pushHappyPathQueue();
      const response = await POST(
        createRequest({
          ...MINIMAL_VALID_BODY,
          variables: [{ name: 'language', description: 'Language', defaultValue: 'TypeScript' }],
        }),
      );
      expect(response.status).toBe(201);
    });

    /**
     * WHY: `is_default` is a boolean column not in the original spec.
     * Confirms it is accepted as optional boolean.
     */
    it('accepts valid `is_default` boolean (additional verified field)', async () => {
      pushHappyPathQueue();
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, is_default: true }),
      );
      expect(response.status).toBe(201);
    });
  });
});
