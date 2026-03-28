/**
 * GET /api/shared/[shareId] — Tests (Phase 7.10)
 *
 * Tests for the public shared-session viewer endpoint.
 * Verifies: share lookup, expiry enforcement, access-count enforcement,
 * access count increment, session data shaping, and message data shaping.
 *
 * WHY: This is a public endpoint (no auth required). Security here matters:
 * expired or over-accessed links must never return session data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Results queue for sequential supabase.from() calls.
 */
const fromResults: Array<unknown> = [];

/**
 * Creates a chainable Supabase mock.
 */
function createChainMock(result: unknown = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'update', 'order', 'limit'];

  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
    },
    from: vi.fn(() => {
      const result = fromResults.shift() ?? { data: null, error: null };
      return createChainMock(result);
    }),
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, retryAfter: null })),
  RATE_LIMITS: { standard: { windowMs: 60000, maxRequests: 100 } },
  rateLimitResponse: vi.fn(() => new Response('Rate limited', { status: 429 })),
}));

// ============================================================================
// Import handler AFTER mocks
// ============================================================================

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a GET request for /api/shared/[shareId].
 *
 * @param shareId - The share ID in the URL
 */
function createRequest(shareId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/shared/${shareId}`,
    { method: 'GET' }
  );
}

/**
 * A valid share ID for tests.
 */
const SHARE_ID = 'AbCdEfGhIjKl';

/**
 * A session ID for tests.
 */
const SESSION_ID = '00000000-1111-2222-3333-444444444444';

/**
 * Factory for share rows.
 */
function makeShareRow(overrides: Record<string, unknown> = {}) {
  return {
    share_id: SHARE_ID,
    session_id: SESSION_ID,
    shared_by: 'user-abc',
    expires_at: null,
    max_accesses: null,
    access_count: 0,
    created_at: '2026-03-27T10:00:00Z',
    ...overrides,
  };
}

/**
 * Factory for session rows.
 */
function makeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    title: 'Test Session',
    summary: 'Did some refactoring',
    agent_type: 'claude',
    status: 'stopped',
    total_cost_usd: '0.0042',
    message_count: 10,
    started_at: '2026-03-27T09:00:00Z',
    ended_at: '2026-03-27T10:00:00Z',
    ...overrides,
  };
}

/**
 * Factory for message rows.
 */
function makeMessageRows() {
  return [
    {
      id: 'msg-001',
      sequence_number: 1,
      message_type: 'user_prompt',
      content_encrypted: null,
      encryption_nonce: null,
      duration_ms: null,
      input_tokens: 100,
      output_tokens: 0,
      cache_tokens: 0,
      created_at: '2026-03-27T09:00:05Z',
    },
    {
      id: 'msg-002',
      sequence_number: 2,
      message_type: 'agent_response',
      content_encrypted: 'enc_abc123',
      encryption_nonce: 'nonce_xyz',
      duration_ms: 1200,
      input_tokens: 850,
      output_tokens: 280,
      cache_tokens: 200,
      created_at: '2026-03-27T09:00:06Z',
    },
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/shared/[shareId]', () => {
  beforeEach(() => {
    fromResults.length = 0;
    vi.clearAllMocks();
  });

  // ── Not found ──────────────────────────────────────────────────────────

  it('returns 404 when share link does not exist', async () => {
    fromResults.push({ data: null, error: { message: 'Not found' } });

    const req = createRequest('nonexistent');
    const res = await GET(req, { params: Promise.resolve({ shareId: 'nonexistent' }) });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('NOT_FOUND');
  });

  // ── Expiry ─────────────────────────────────────────────────────────────

  it('returns 410 when share link has expired', async () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1 hour ago
    fromResults.push({ data: makeShareRow({ expires_at: pastDate }), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe('EXPIRED');
  });

  it('allows access when expiresAt is in the future', async () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(); // 1 day from now
    fromResults.push({ data: makeShareRow({ expires_at: futureDate }), error: null });
    fromResults.push({ data: null, error: null }); // access count update
    fromResults.push({ data: makeSessionRow(), error: null });
    fromResults.push({ data: makeMessageRows(), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    expect(res.status).toBe(200);
  });

  it('allows access when expiresAt is null (never expires)', async () => {
    fromResults.push({ data: makeShareRow({ expires_at: null }), error: null });
    fromResults.push({ data: null, error: null }); // access count update
    fromResults.push({ data: makeSessionRow(), error: null });
    fromResults.push({ data: makeMessageRows(), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    expect(res.status).toBe(200);
  });

  // ── Access count ───────────────────────────────────────────────────────

  it('returns 410 when access count has reached max_accesses', async () => {
    fromResults.push({ data: makeShareRow({ max_accesses: 3, access_count: 3 }), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe('EXPIRED');
  });

  it('allows access when access_count is below max_accesses', async () => {
    fromResults.push({ data: makeShareRow({ max_accesses: 5, access_count: 2 }), error: null });
    fromResults.push({ data: null, error: null }); // access count update
    fromResults.push({ data: makeSessionRow(), error: null });
    fromResults.push({ data: makeMessageRows(), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    expect(res.status).toBe(200);
  });

  it('allows access when max_accesses is null (unlimited)', async () => {
    fromResults.push({ data: makeShareRow({ max_accesses: null, access_count: 9999 }), error: null });
    fromResults.push({ data: null, error: null }); // access count update
    fromResults.push({ data: makeSessionRow(), error: null });
    fromResults.push({ data: makeMessageRows(), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    expect(res.status).toBe(200);
  });

  // ── Happy path ─────────────────────────────────────────────────────────

  it('returns 200 with share, session, and messages on success', async () => {
    fromResults.push({ data: makeShareRow(), error: null });
    fromResults.push({ data: null, error: null }); // access count update
    fromResults.push({ data: makeSessionRow(), error: null });
    fromResults.push({ data: makeMessageRows(), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      share: Record<string, unknown>;
      session: Record<string, unknown>;
      messages: unknown[];
    };

    expect(body.share.shareId).toBe(SHARE_ID);
    expect(body.share.sessionId).toBe(SESSION_ID);
    expect(body.session.id).toBe(SESSION_ID);
    expect(body.session.agentType).toBe('claude');
    expect(body.messages).toHaveLength(2);
  });

  it('includes incremented access count in the response', async () => {
    fromResults.push({ data: makeShareRow({ access_count: 4 }), error: null });
    fromResults.push({ data: null, error: null }); // access count update
    fromResults.push({ data: makeSessionRow(), error: null });
    fromResults.push({ data: makeMessageRows(), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    const body = await res.json() as { share: { accessCount: number } };
    expect(body.share.accessCount).toBe(5); // 4 + 1
  });

  it('maps message fields to camelCase correctly', async () => {
    fromResults.push({ data: makeShareRow(), error: null });
    fromResults.push({ data: null, error: null }); // access count update
    fromResults.push({ data: makeSessionRow(), error: null });
    fromResults.push({ data: makeMessageRows(), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    const body = await res.json() as { messages: Array<Record<string, unknown>> };
    const agentMsg = body.messages.find((m) => m.messageType === 'agent_response');

    expect(agentMsg).toBeDefined();
    expect(agentMsg!.sequenceNumber).toBe(2);
    expect(agentMsg!.contentEncrypted).toBe('enc_abc123');
    expect(agentMsg!.encryptionNonce).toBe('nonce_xyz');
    expect(agentMsg!.durationMs).toBe(1200);
    expect(agentMsg!.inputTokens).toBe(850);
    expect(agentMsg!.outputTokens).toBe(280);
    expect(agentMsg!.cacheTokens).toBe(200);
  });

  it('does not expose user_id in the session response', async () => {
    fromResults.push({ data: makeShareRow(), error: null });
    fromResults.push({ data: null, error: null });
    fromResults.push({ data: { ...makeSessionRow(), user_id: 'private-user-id' }, error: null });
    fromResults.push({ data: makeMessageRows(), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    const body = await res.json() as { session: Record<string, unknown> };
    expect(body.session.user_id).toBeUndefined();
    expect(body.session.userId).toBeUndefined();
  });

  it('does not expose sharedBy (user UUID) in the public share response', async () => {
    fromResults.push({ data: makeShareRow({ shared_by: 'secret-user-uuid' }), error: null });
    fromResults.push({ data: null, error: null });
    fromResults.push({ data: makeSessionRow(), error: null });
    fromResults.push({ data: makeMessageRows(), error: null });

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    const body = await res.json() as { share: Record<string, unknown> };
    // SECURITY: sharedBy must be redacted from public endpoint responses
    expect(body.share.sharedBy).toBeUndefined();
    expect(body.share.shared_by).toBeUndefined();
  });

  it('returns 404 when session row is not found after valid share', async () => {
    fromResults.push({ data: makeShareRow(), error: null });
    fromResults.push({ data: null, error: null }); // access count update
    fromResults.push({ data: null, error: { message: 'Not found' } }); // session lookup fails

    const req = createRequest(SHARE_ID);
    const res = await GET(req, { params: Promise.resolve({ shareId: SHARE_ID }) });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('NOT_FOUND');
  });
});
