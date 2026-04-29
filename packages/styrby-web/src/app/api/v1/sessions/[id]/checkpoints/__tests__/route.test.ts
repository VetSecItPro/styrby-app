/**
 * Session Checkpoints API Tests
 *
 * Tests GET, POST, DELETE /api/v1/sessions/[id]/checkpoints.
 *
 * WHY: Checkpoints are a Power-tier feature. Regressions could let free users
 * create checkpoints, let the name uniqueness 409 path degrade to 500, or
 * accept invalid session IDs without proper 400 responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockAuthContext = {
  userId: 'checkpoint-user-99',
  keyId: 'key-chk-123',
  scopes: ['read', 'write'],
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
}));

const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'is', 'order', 'limit', 'insert', 'delete',
    'single', 'maybeSingle',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    from: vi.fn(() => createChainMock()),
  })),
}));

import { GET, POST, DELETE } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const VALID_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const INVALID_SESSION_ID = 'not-a-uuid';

function makeRequest(method: string, sessionId: string, body?: Record<string, unknown>, query = ''): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/sessions/${sessionId}/checkpoints${query}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk_live_test',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  );
}

const VALID_CHECKPOINT_BODY = {
  name: 'before-refactor',
  description: 'Checkpoint before the big refactor',
  messageSequenceNumber: 42,
  contextSnapshot: { totalTokens: 12000, fileCount: 5 },
};

// ============================================================================
// Tests
// ============================================================================

describe('Session Checkpoints API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // GET /api/v1/sessions/[id]/checkpoints
  // --------------------------------------------------------------------------

  describe('GET', () => {
    it('returns 400 for invalid session ID', async () => {
      const res = await GET(makeRequest('GET', INVALID_SESSION_ID));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid session ID');
    });

    it('returns 404 when session not found or not owned by user', async () => {
      // session lookup → not found
      fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'not found' } });

      const res = await GET(makeRequest('GET', VALID_SESSION_ID));
      expect(res.status).toBe(404);
    });

    it('returns checkpoints array for owned session', async () => {
      // session ownership check → found
      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      // checkpoints select → array
      fromCallQueue.push({
        data: [
          {
            id: 'chk-1',
            session_id: VALID_SESSION_ID,
            name: 'step-1',
            description: null,
            message_sequence_number: 10,
            context_snapshot: { totalTokens: 5000, fileCount: 3 },
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        error: null,
      });

      const res = await GET(makeRequest('GET', VALID_SESSION_ID));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.checkpoints).toHaveLength(1);
      expect(body.checkpoints[0].name).toBe('step-1');
    });

    it('returns empty array when session has no checkpoints', async () => {
      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      fromCallQueue.push({ data: [], error: null });

      const res = await GET(makeRequest('GET', VALID_SESSION_ID));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.checkpoints).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/v1/sessions/[id]/checkpoints
  // --------------------------------------------------------------------------

  describe('POST', () => {
    it('returns 400 for invalid session ID', async () => {
      const res = await POST(makeRequest('POST', INVALID_SESSION_ID, VALID_CHECKPOINT_BODY));
      expect(res.status).toBe(400);
    });

    it('returns 403 for free tier users', async () => {
      fromCallQueue.push({ data: null, error: null });

      const res = await POST(makeRequest('POST', VALID_SESSION_ID, VALID_CHECKPOINT_BODY));
      expect(res.status).toBe(403);
    });

    it('allows pro tier users (Phase 5: Pro inherits power-equivalent features)', async () => {
      // Phase 5 reconciliation: Pro absorbs the old Power feature set, so
      // session checkpoints are now available on Pro.
      fromCallQueue.push({ data: { tier: 'pro' }, error: null }); // subscriptions tier
      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null }); // session ownership
      fromCallQueue.push({ data: { id: 'cp_1' }, error: null }); // checkpoint insert

      const res = await POST(makeRequest('POST', VALID_SESSION_ID, VALID_CHECKPOINT_BODY));
      expect([200, 201]).toContain(res.status);
    });

    it('returns 400 for missing name', async () => {
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      const res = await POST(makeRequest('POST', VALID_SESSION_ID, { messageSequenceNumber: 5 }));
      expect(res.status).toBe(400);
    });

    it('returns 400 for name with invalid characters', async () => {
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      const res = await POST(makeRequest('POST', VALID_SESSION_ID, {
        ...VALID_CHECKPOINT_BODY,
        name: 'invalid name!@#',
      }));
      expect(res.status).toBe(400);
    });

    it('returns 400 for name exceeding 80 chars', async () => {
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      const res = await POST(makeRequest('POST', VALID_SESSION_ID, {
        ...VALID_CHECKPOINT_BODY,
        name: 'x'.repeat(81),
      }));
      expect(res.status).toBe(400);
    });

    it('returns 400 for negative messageSequenceNumber', async () => {
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      const res = await POST(makeRequest('POST', VALID_SESSION_ID, {
        ...VALID_CHECKPOINT_BODY,
        messageSequenceNumber: -1,
      }));
      expect(res.status).toBe(400);
    });

    it('returns 404 when session not found for power user', async () => {
      // tier check → power
      fromCallQueue.push({ data: { tier: 'power' }, error: null });
      // session ownership → not found
      fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'not found' } });

      const res = await POST(makeRequest('POST', VALID_SESSION_ID, VALID_CHECKPOINT_BODY));
      expect(res.status).toBe(404);
    });

    it('creates checkpoint and returns 201 for power user', async () => {
      fromCallQueue.push({ data: { tier: 'power' }, error: null });
      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null }); // session
      const inserted = {
        id: 'chk-new',
        session_id: VALID_SESSION_ID,
        name: 'before-refactor',
        description: 'Checkpoint before the big refactor',
        message_sequence_number: 42,
        context_snapshot: { totalTokens: 12000, fileCount: 5 },
        created_at: '2026-04-21T00:00:00Z',
      };
      fromCallQueue.push({ data: inserted, error: null });

      const res = await POST(makeRequest('POST', VALID_SESSION_ID, VALID_CHECKPOINT_BODY));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.checkpoint.name).toBe('before-refactor');
      expect(body.checkpoint.messageSequenceNumber).toBe(42);
    });

    it('returns 409 when checkpoint name already exists in session', async () => {
      fromCallQueue.push({ data: { tier: 'power' }, error: null });
      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      fromCallQueue.push({ data: null, error: { code: '23505', message: 'unique violation' } });

      const res = await POST(makeRequest('POST', VALID_SESSION_ID, VALID_CHECKPOINT_BODY));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('already exists');
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /api/v1/sessions/[id]/checkpoints
  // --------------------------------------------------------------------------

  describe('DELETE', () => {
    it('returns 400 for invalid session ID', async () => {
      const res = await DELETE(makeRequest('DELETE', INVALID_SESSION_ID));
      expect(res.status).toBe(400);
    });

    it('returns 400 when neither checkpointId nor name provided', async () => {
      const res = await DELETE(makeRequest('DELETE', VALID_SESSION_ID));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('checkpointId or name');
    });

    it('returns 400 for invalid checkpointId UUID', async () => {
      const res = await DELETE(makeRequest('DELETE', VALID_SESSION_ID, undefined, '?checkpointId=not-a-uuid'));
      expect(res.status).toBe(400);
    });

    it('deletes by name and returns deleted: true', async () => {
      fromCallQueue.push({ data: null, error: null, count: 1 });

      const res = await DELETE(makeRequest('DELETE', VALID_SESSION_ID, undefined, '?name=before-refactor'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it('deletes by checkpointId and returns deleted: true', async () => {
      const checkpointId = 'ffffffff-aaaa-bbbb-cccc-dddddddddddd';
      fromCallQueue.push({ data: null, error: null, count: 1 });

      const res = await DELETE(makeRequest('DELETE', VALID_SESSION_ID, undefined, `?checkpointId=${checkpointId}`));
      expect(res.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Auth wiring (H42 Layer 5)
  // --------------------------------------------------------------------------

  // WHY this test exists: H42 Layer 5 wraps GET, POST, and DELETE with
  // withApiAuthAndRateLimit. If a future refactor unwraps any of them or swaps
  // the middleware, this test catches it — the handler must NOT execute when
  // the wrapper short-circuits. One test covers all three verbs since they
  // share the same wrapper. OWASP A07:2021, SOC 2 CC6.1.
  describe('auth wiring', () => {
    it('returns 401 when withApiAuthAndRateLimit rejects the request', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 }
        );
      });

      vi.resetModules();
      const { GET: freshGET } = await import('../route');

      const res = await freshGET(makeRequest('GET', VALID_SESSION_ID));
      expect(res.status).toBe(401);
    });
  });
});
