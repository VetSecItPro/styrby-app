/**
 * POST /api/v1/audit — Integration Tests
 *
 * Tests the audit log ingestion endpoint which is the highest-volume v1 endpoint:
 * 7 of 11 CLI callsites write to audit_log via this route.
 *
 * WHY: The audit log is a SOC 2 CC7.2 control. Any regression that silently
 * drops audit events or allows spoofed user_id injection would fail a compliance
 * review. These tests are the automated gate.
 *
 * @security OWASP A07:2021 (Identification and Authentication Failures)
 * @security SOC 2 CC7.2 (Audit Log Integrity)
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
 * Mocking the middleware to pass through lets us test the handler logic directly.
 */
const mockAuthContext = {
  userId: 'test-user-123',
  keyId: 'key-id-456',
  scopes: ['write'],
  keyExpiresAt: null,
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
// Mocks — Sentry
// ============================================================================

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

// ============================================================================
// Mocks — Idempotency middleware
// ============================================================================

/**
 * Controls what checkIdempotency returns per test.
 * Reset in beforeEach to { replayed: false } (normal path).
 */
let idempotencyCheckResult: unknown = { replayed: false };
let idempotencyStoreError: Error | null = null;

vi.mock('@/lib/middleware/idempotency', () => ({
  checkIdempotency: vi.fn(async () => idempotencyCheckResult),
  storeIdempotencyResult: vi.fn(async () => {
    if (idempotencyStoreError) throw idempotencyStoreError;
  }),
}));

// ============================================================================
// Mocks — Supabase admin client
// ============================================================================

/**
 * Queue of results for sequential supabase.from('audit_log').insert() calls.
 * Each call shifts the next result off the queue.
 */
const insertCallQueue: Array<{ data?: unknown; error?: unknown }> = [];

function createInsertChainMock() {
  const result = insertCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'range']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  // .insert(...).select('id, created_at').single() chain
  chain['insert'] = vi.fn().mockReturnValue(chain);
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => createInsertChainMock()),
  })),
}));

// ============================================================================
// Import route handler AFTER mocks are set up
// ============================================================================

import { POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a NextRequest for POST /api/v1/audit.
 *
 * @param body - JSON body to send
 * @param headers - Additional request headers
 * @returns A NextRequest with the given body
 */
function createRequest(
  body: Record<string, unknown> = { action: 'user.login' },
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/audit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk_live_test_key',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/v1/audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertCallQueue.length = 0;
    idempotencyCheckResult = { replayed: false };
    idempotencyStoreError = null;
  });

  // --------------------------------------------------------------------------
  // 1. Auth middleware wiring
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    // WHY: This test proves the route is wired to withApiAuthAndRateLimit. If a
    // future refactor bypasses the wrapper, this gate fails before any audit
    // event reaches the database. OWASP A07:2021, SOC 2 CC6.1.
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
  // 2. Zod validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('returns 400 when action is missing', async () => {
      const response = await POST(createRequest({}));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when action is an empty string', async () => {
      const response = await POST(createRequest({ action: '' }));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 for unknown fields (strict mode mass-assignment guard)', async () => {
      // WHY .strict(): Zod strict mode rejects extra fields so callers cannot
      // inject unexpected columns via the API body. H42 Layer 3, OWASP A03:2021.
      const response = await POST(
        createRequest({ action: 'user.login', injected_column: 'malicious' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('returns 400 when metadata is not an object', async () => {
      const response = await POST(
        createRequest({ action: 'user.login', metadata: 'not-an-object' }),
      );
      expect(response.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Mass-assignment guard: user_id spoofing
  // --------------------------------------------------------------------------

  describe('mass-assignment guard', () => {
    // WHY: A malicious caller might include user_id in the body to spoof
    // another user's audit trail. Zod .strict() must reject this field
    // before it reaches the INSERT statement. H42 Layer 3, OWASP A03:2021.
    it('rejects a body that includes user_id (spoof attempt)', async () => {
      const response = await POST(
        createRequest({ action: 'user.login', user_id: 'attacker-uuid' }),
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Happy path
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    it('returns 201 with id and created_at on valid minimal body', async () => {
      insertCallQueue.push({
        data: { id: 'audit-row-001', created_at: '2026-04-29T00:00:00Z' },
        error: null,
      });

      const response = await POST(createRequest({ action: 'session.started' }));
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.id).toBe('audit-row-001');
      expect(body.created_at).toBe('2026-04-29T00:00:00Z');
    });

    it('returns 201 with all optional fields present', async () => {
      insertCallQueue.push({
        data: { id: 'audit-row-002', created_at: '2026-04-29T00:01:00Z' },
        error: null,
      });

      const response = await POST(
        createRequest({
          action: 'session.ended',
          resource_type: 'session',
          resource_id: 'sess-abc-123',
          metadata: { duration_ms: 3600000 },
        }),
      );
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.id).toBe('audit-row-002');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Idempotency replay
  // --------------------------------------------------------------------------

  describe('idempotency', () => {
    it('returns cached response with X-Idempotency-Replay header on replay', async () => {
      // Simulate a cache hit from a prior successful request.
      idempotencyCheckResult = {
        replayed: true,
        status: 201,
        body: { id: 'cached-audit-id', created_at: '2026-04-29T00:00:00Z' },
      };

      const response = await POST(
        createRequest({ action: 'user.login' }, { 'Idempotency-Key': 'idem-key-001' }),
      );

      // WHY 200 not 201: replayed responses are returned as-is with the original
      // status from cache. The header signals to the client it is a replay.
      expect(response.status).toBe(201);
      expect(response.headers.get('X-Idempotency-Replay')).toBe('true');

      const body = await response.json();
      expect(body.id).toBe('cached-audit-id');
    });

    it('returns 409 when Idempotency-Key is reused with a different body', async () => {
      idempotencyCheckResult = {
        conflict: true,
        message:
          'Idempotency-Key has already been used with a different request body. ' +
          'Use a new key for a different request.',
      };

      const response = await POST(
        createRequest({ action: 'different.action' }, { 'Idempotency-Key': 'idem-key-001' }),
      );
      expect(response.status).toBe(409);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('stores idempotency result after a successful first request', async () => {
      insertCallQueue.push({
        data: { id: 'audit-row-new', created_at: '2026-04-29T00:02:00Z' },
        error: null,
      });

      const { storeIdempotencyResult } = await import('@/lib/middleware/idempotency');

      await POST(
        createRequest({ action: 'user.login' }, { 'Idempotency-Key': 'idem-key-002' }),
      );

      expect(storeIdempotencyResult).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------------------------
  // 6. Rate limit at 1000/min/key
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('returns 429 when withApiAuthAndRateLimit enforces 1000 req/min limit', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Rate limit exceeded. Retry after 42 seconds', code: 'RATE_LIMITED' },
          { status: 429, headers: { 'Retry-After': '42' } },
        );
      });

      vi.resetModules();
      const { POST: freshPOST } = await import('../route');

      const response = await freshPOST(createRequest());
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('42');
    });
  });

  // --------------------------------------------------------------------------
  // 7. Database errors (5xx path)
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 when Supabase insert fails', async () => {
      insertCallQueue.push({ data: null, error: { message: 'Connection refused' } });

      const response = await POST(createRequest({ action: 'session.started' }));
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to write audit event');
    });

    it('calls Sentry.captureException on unexpected DB errors', async () => {
      insertCallQueue.push({ data: null, error: { message: 'deadlock detected' } });

      const Sentry = await import('@sentry/nextjs');
      await POST(createRequest({ action: 'session.started' }));

      expect(Sentry.captureException).toHaveBeenCalledOnce();
    });

    it('does not include stack traces or internal error details in 500 response', async () => {
      insertCallQueue.push({ data: null, error: { message: 'internal pg error' } });

      const response = await POST(createRequest({ action: 'session.started' }));
      expect(response.status).toBe(500);

      const body = await response.json();
      // WHY: Never surface raw DB error messages to clients — they can leak
      // schema, query structure, or PII. PII hygiene (OWASP A02:2021).
      expect(body.error).toBe('Failed to write audit event');
      expect(JSON.stringify(body)).not.toContain('internal pg error');
    });
  });
});
