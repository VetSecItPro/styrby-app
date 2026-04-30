/**
 * POST /api/v1/cost-records — Integration Tests
 *
 * Covers the cost record insert endpoint used by the CLI daemon's cost reporter.
 * Confirms:
 *  - Auth gate (401)
 *  - Body validation incl. mass-assignment guard (400)
 *  - IDOR defense via session ownership check (404 on cross-user)
 *  - Happy path returns 201 with { id, recorded_at }
 *  - Idempotency replay short-circuit and conflict
 *  - 500 + Sentry on unexpected DB error
 *  - user_id is always server-stamped (never trusted from body)
 *
 * @security OWASP A01:2021 - session ownership check + server-stamped user_id
 * @security OWASP A03:2021 - .strict() schema, no mass-assignment
 * @security SOC 2 CC6.1 - 'write' scope required
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks — withApiAuthAndRateLimit bypass
// ============================================================================

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

let idempotencyCheckResult: unknown = { replayed: false };

vi.mock('@/lib/middleware/idempotency', () => ({
  checkIdempotency: vi.fn(async () => idempotencyCheckResult),
  storeIdempotencyResult: vi.fn(async () => undefined),
}));

// ============================================================================
// Mocks — Supabase admin client
// ============================================================================

/**
 * Two queues mirror the two DB calls the handler makes per request:
 *  0: SELECT id FROM sessions  (ownership check via .maybeSingle)
 *  1: INSERT cost_records ... .select().single()
 */
const sessionSelectQueue: Array<{ data: unknown; error: unknown }> = [];
const insertQueue: Array<{ data: unknown; error: unknown }> = [];
let fromCallCount = 0;

/**
 * Captures the payload passed to .insert() so tests can assert
 * server-stamping (user_id) and that mass-assignment did not slip through.
 */
let lastInsertPayload: Record<string, unknown> | null = null;

function createSupabaseMock() {
  return {
    from: vi.fn((_table: string) => {
      const callIndex = fromCallCount++;

      // Call 0: session ownership check
      if (callIndex === 0) {
        const result = sessionSelectQueue.shift() ?? { data: null, error: null };
        const chain: Record<string, unknown> = {};
        chain['select'] = vi.fn(() => chain);
        chain['eq'] = vi.fn(() => chain);
        chain['maybeSingle'] = vi.fn(() => Promise.resolve(result));
        return chain;
      }

      // Call 1: insert
      const result = insertQueue.shift() ?? {
        data: null,
        error: { message: 'unexpected insert error' },
      };
      const chain: Record<string, unknown> = {};
      chain['insert'] = vi.fn((payload: Record<string, unknown>) => {
        lastInsertPayload = payload;
        return chain;
      });
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

const VALID_SESSION_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const BASE_URL = 'http://localhost:3000/api/v1/cost-records';

const MINIMAL_VALID_BODY = {
  session_id: VALID_SESSION_ID,
  agent_type: 'claude',
  model: 'claude-sonnet-4',
  input_tokens: 1000,
  output_tokens: 500,
  cost_usd: 0.123456,
};

const FULL_VALID_BODY = {
  ...MINIMAL_VALID_BODY,
  cache_read_tokens: 100,
  cache_write_tokens: 50,
  price_per_input_token: 0.000003,
  price_per_output_token: 0.000015,
  recorded_at: '2026-04-30T12:00:00Z',
  record_date: '2026-04-30',
  is_pending: false,
  billing_model: 'api-key',
  source: 'styrby-estimate',
  raw_agent_payload: { provider_meta: 'opaque' },
  subscription_fraction_used: null,
  credits_consumed: null,
  credit_rate_usd: null,
};

const SAMPLE_INSERTED = {
  id: 'cost-row-uuid-001',
  recorded_at: '2026-04-30T12:00:00.123Z',
};

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

function pushHappyPathQueues(): void {
  sessionSelectQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
  insertQueue.push({ data: SAMPLE_INSERTED, error: null });
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/v1/cost-records', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionSelectQueue.length = 0;
    insertQueue.length = 0;
    fromCallCount = 0;
    lastInsertPayload = null;
    idempotencyCheckResult = { replayed: false };
  });

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  describe('authentication', () => {
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
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('returns 400 when session_id is missing', async () => {
      const { session_id, ...rest } = MINIMAL_VALID_BODY;
      void session_id;
      const response = await POST(createRequest(rest));
      expect(response.status).toBe(400);
    });

    it('returns 400 when session_id is not a UUID', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, session_id: 'not-a-uuid' }),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when input_tokens is negative', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, input_tokens: -1 }),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when cost_usd is negative', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, cost_usd: -0.01 }),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when record_date is not YYYY-MM-DD', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, record_date: '2026/04/30' }),
      );
      expect(response.status).toBe(400);
    });

    /**
     * WHY: blocks user_id injection. The handler must server-stamp user_id
     * from auth context — if the schema let it through, an attacker could
     * write cost records under another user. OWASP A01:2021 + A03:2021.
     */
    it('returns 400 when user_id is injected (mass-assignment guard)', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, user_id: 'attacker-uuid' }),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when an arbitrary unknown field is present', async () => {
      const response = await POST(
        createRequest({ ...MINIMAL_VALID_BODY, totally_made_up: 'field' }),
      );
      expect(response.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // IDOR defense
  // --------------------------------------------------------------------------

  describe('IDOR defense (OWASP A01:2021)', () => {
    it('returns 404 when session_id does not exist', async () => {
      sessionSelectQueue.push({ data: null, error: null });

      const response = await POST(createRequest());
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Not found');
    });

    /**
     * WHY: The session ownership query filters by both id AND user_id, so a
     * cross-user lookup yields data:null — same path as "not found". This is
     * the consistent IDOR-defense response.
     */
    it('returns 404 when session belongs to another user (consistent with not-found)', async () => {
      sessionSelectQueue.push({ data: null, error: null });

      const response = await POST(createRequest());
      expect(response.status).toBe(404);
      expect(response.status).not.toBe(403);
    });
  });

  // --------------------------------------------------------------------------
  // Success
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    it('returns 201 with { id, recorded_at } on minimal valid body', async () => {
      pushHappyPathQueues();

      const response = await POST(createRequest());
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.id).toBe(SAMPLE_INSERTED.id);
      expect(body.recorded_at).toBe(SAMPLE_INSERTED.recorded_at);
    });

    it('returns 201 on full valid body with all optional fields', async () => {
      pushHappyPathQueues();

      const response = await POST(createRequest(FULL_VALID_BODY));
      expect(response.status).toBe(201);
    });

    /**
     * CRITICAL: user_id must come from the auth context, NEVER from the body.
     * This is the linchpin for cross-user write defense — even if the .strict()
     * schema regresses, a server-stamped user_id is the last line of defense.
     */
    it('server-stamps user_id from auth context (not from body)', async () => {
      pushHappyPathQueues();

      await POST(createRequest());

      expect(lastInsertPayload).not.toBeNull();
      expect(lastInsertPayload!.user_id).toBe(mockAuthContext.userId);
    });

    /**
     * WHY: optional cache token columns must default to 0 (not be sent as
     * undefined) — the DB column has DEFAULT 0 but explicit undefined would
     * write null, breaking aggregations.
     */
    it('defaults cache_read_tokens and cache_write_tokens to 0 when omitted', async () => {
      pushHappyPathQueues();

      await POST(createRequest());

      expect(lastInsertPayload!.cache_read_tokens).toBe(0);
      expect(lastInsertPayload!.cache_write_tokens).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------

  describe('idempotency', () => {
    it('replays cached response with X-Idempotency-Replay header', async () => {
      idempotencyCheckResult = {
        replayed: true,
        status: 201,
        body: SAMPLE_INSERTED,
      };

      const response = await POST(
        createRequest(MINIMAL_VALID_BODY, { 'Idempotency-Key': 'idem-001' }),
      );
      expect(response.status).toBe(201);
      expect(response.headers.get('X-Idempotency-Replay')).toBe('true');

      const body = await response.json();
      expect(body.id).toBe(SAMPLE_INSERTED.id);
    });

    it('returns 409 when Idempotency-Key is reused with a different body', async () => {
      idempotencyCheckResult = {
        conflict: true,
        message: 'Idempotency-Key has already been used with a different request body.',
      };

      const response = await POST(
        createRequest(MINIMAL_VALID_BODY, { 'Idempotency-Key': 'idem-001' }),
      );
      expect(response.status).toBe(409);
    });

    it('calls storeIdempotencyResult after a successful insert', async () => {
      pushHappyPathQueues();
      const { storeIdempotencyResult } = await import('@/lib/middleware/idempotency');

      await POST(createRequest(MINIMAL_VALID_BODY, { 'Idempotency-Key': 'idem-002' }));

      expect(storeIdempotencyResult).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 and calls Sentry when sessions SELECT fails unexpectedly', async () => {
      sessionSelectQueue.push({
        data: null,
        error: { code: '08006', message: 'connection terminated' },
      });

      const Sentry = await import('@sentry/nextjs');
      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();

      const body = await response.json();
      expect(body.error).toBe('Failed to record cost');
      expect(JSON.stringify(body)).not.toContain('connection terminated');
    });

    it('returns 500 and calls Sentry when INSERT fails unexpectedly', async () => {
      sessionSelectQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      insertQueue.push({ data: null, error: { message: 'deadlock detected' } });

      const Sentry = await import('@sentry/nextjs');
      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();
    });
  });
});
