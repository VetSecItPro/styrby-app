/**
 * POST /api/sessions/[id]/replay — Tests (Phase 3.3)
 *
 * Covers:
 *   - Happy path: authenticated owner creates token, gets URL back
 *   - Unauthenticated request → 401
 *   - Invalid body (bad duration) → 400
 *   - Session not found → 404
 *   - Session owned by another user → 403
 *   - Rate limit exceeded → 429
 *
 * WHY: The replay token creation endpoint is security-sensitive. A bug here
 * could allow users to create replay tokens for sessions they don't own,
 * leaking (scrubbed) session content to unauthorized viewers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mock infrastructure
// ============================================================================

/**
 * Creates a chainable Supabase mock that resolves with the queued result.
 */
function createChainMock(result: unknown = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const terminalResult = result;

  const methods = ['select', 'eq', 'is', 'insert', 'update', 'lt', 'order'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }

  chain['single']      = vi.fn().mockResolvedValue(terminalResult);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(terminalResult);
  chain['then']        = (resolve: (v: unknown) => unknown) => Promise.resolve(terminalResult).then(resolve);

  return chain;
}

const fromResults: Array<unknown> = [];
let fromCallIndex = 0;

const mockUser = { id: 'user-abc', email: 'test@example.com' };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: mockUser },
        error: null,
      })),
    },
    from: vi.fn(() => {
      const result = fromResults[fromCallIndex++] ?? { data: null, error: null };
      return createChainMock(result);
    }),
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, retryAfter: 0 })),
  rateLimitResponse: vi.fn(() => new Response('Rate limited', { status: 429 })),
  RATE_LIMITS: { sensitive: { windowMs: 60000, maxRequests: 10 } },
}));

vi.mock('@/lib/config', () => ({
  getAppUrl: vi.fn(() => 'https://styrbyapp.com'),
}));

// ============================================================================
// Helpers
// ============================================================================

async function makeRequest(sessionId: string, body: unknown): Promise<Response> {
  const { POST } = await import('../route');
  const req = new NextRequest(`https://styrbyapp.com/api/sessions/${sessionId}/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const params = { params: Promise.resolve({ id: sessionId }) };
  return POST(req as unknown as Request, params);
}

const validBody = {
  duration: '24h',
  maxViews: 10,
  scrubMask: { secrets: true, file_paths: false, commands: false },
};

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/sessions/[id]/replay', () => {
  beforeEach(() => {
    fromResults.length = 0;
    fromCallIndex = 0;
    vi.clearAllMocks();
  });

  it('returns 401 when user is not authenticated', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    vi.mocked(createClient).mockResolvedValueOnce({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: new Error('not auth') })),
      },
      from: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await makeRequest('session-123', validBody);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('UNAUTHORIZED');
  });

  it('returns 400 for invalid duration', async () => {
    const res = await makeRequest('session-123', {
      ...validBody,
      duration: 'forever', // not a valid enum value
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid maxViews', async () => {
    const res = await makeRequest('session-123', {
      ...validBody,
      maxViews: 999, // not in 1 | 5 | 10 | 'unlimited'
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when session does not exist', async () => {
    // sessions.select → null
    fromResults.push({ data: null, error: null });

    const res = await makeRequest('nonexistent-session', validBody);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
  });

  it('returns 403 when session belongs to another user', async () => {
    // sessions.select → different owner
    fromResults.push({
      data: { id: 'session-123', user_id: 'other-user-id' },
      error: null,
    });

    const res = await makeRequest('session-123', validBody);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
  });

  it('returns 429 when rate limit is exceeded', async () => {
    const { rateLimit, rateLimitResponse } = await import('@/lib/rateLimit');
    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 60, remaining: 0, resetAt: Date.now() + 60000 });
    vi.mocked(rateLimitResponse).mockReturnValueOnce(
      new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429 })
    );

    const res = await makeRequest('session-123', validBody);
    expect(res.status).toBe(429);
  });

  it('returns 201 with token and URL for valid request', async () => {
    const sessionId = 'session-abc';

    // sessions.select → owned by mockUser
    fromResults.push({ data: { id: sessionId, user_id: mockUser.id }, error: null });
    // profiles.select → found
    fromResults.push({ data: { id: mockUser.id }, error: null });
    // insert → created token row
    fromResults.push({
      data: {
        id: 'token-uuid-123',
        session_id: sessionId,
        created_by: mockUser.id,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        max_views: 10,
        views_used: 0,
        scrub_mask: { secrets: true, file_paths: false, commands: false },
        revoked_at: null,
        created_at: new Date().toISOString(),
      },
      error: null,
    });
    // audit_log insert → success
    fromResults.push({ data: null, error: null });

    const res = await makeRequest(sessionId, validBody);
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.token).toBeDefined();
    expect(json.token.id).toBe('token-uuid-123');
    expect(json.token.scrubMask.secrets).toBe(true);
    expect(json.url).toContain('https://styrbyapp.com/replay/');
    // Raw token should be 96 hex chars
    const rawToken = json.url.split('/replay/')[1];
    expect(rawToken).toMatch(/^[a-f0-9]{96}$/);
  });

  it('returns 201 with unlimited maxViews for "unlimited" input', async () => {
    const sessionId = 'session-unlimited';
    fromResults.push({ data: { id: sessionId, user_id: mockUser.id }, error: null });
    fromResults.push({ data: { id: mockUser.id }, error: null });
    fromResults.push({
      data: {
        id: 'token-uuid-456',
        session_id: sessionId,
        created_by: mockUser.id,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        max_views: null,
        views_used: 0,
        scrub_mask: { secrets: true, file_paths: false, commands: false },
        revoked_at: null,
        created_at: new Date().toISOString(),
      },
      error: null,
    });
    fromResults.push({ data: null, error: null });

    const res = await makeRequest(sessionId, { ...validBody, maxViews: 'unlimited' });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.token.maxViews).toBeNull();
  });
});
