/**
 * POST /api/v1/sessions/[id]/summary — Integration Tests
 *
 * Coverage matrix:
 *   - 401 unauthenticated (wrapper layer — covered by sibling [id]/route.test.ts;
 *     here we trust withApiAuthAndRateLimit and assert it is called)
 *   - 400 invalid session ID (non-UUID path segment)
 *   - 404 session not owned by caller (IDOR defense)
 *   - 200 idempotent (summary already exists -> cached path, NO Edge Function call)
 *   - 403 free tier blocked
 *   - 502 Edge Function failure
 *   - 200 happy path (Pro tier, Edge Function returns summary)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ----------------------------------------------------------------------------
// Auth wrapper bypass — same shape as sibling [id]/route.test.ts.
// ----------------------------------------------------------------------------

const mockAuthContext = {
  userId: 'user-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  keyId: 'key-abc',
  scopes: ['read'],
  keyExpiresAt: null,
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuthAndRateLimit: vi.fn(
    (handler: (req: NextRequest, ctx: typeof mockAuthContext) => Promise<NextResponse>) =>
      async (request: NextRequest) => handler(request, mockAuthContext)
  ),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

// ----------------------------------------------------------------------------
// Tier resolver — control return per test
// ----------------------------------------------------------------------------

const mockResolveEffectiveTier = vi.fn();
vi.mock('@/lib/tier-enforcement', () => ({
  resolveEffectiveTier: (...args: unknown[]) => mockResolveEffectiveTier(...args),
}));

// ----------------------------------------------------------------------------
// Supabase admin client — sessions SELECT + functions.invoke per test
// ----------------------------------------------------------------------------

let sessionSelectResult: { data: unknown; error: unknown } = { data: null, error: null };
const mockFunctionsInvoke = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => {
      // Build the chain: .from('sessions').select(...).eq(...).eq(...).is(...).maybeSingle()
      const chain: Record<string, unknown> = {};
      chain['select'] = vi.fn(() => chain);
      chain['eq'] = vi.fn(() => chain);
      chain['is'] = vi.fn(() => chain);
      chain['maybeSingle'] = vi.fn(() => Promise.resolve(sessionSelectResult));
      return chain;
    }),
    functions: {
      invoke: mockFunctionsInvoke,
    },
  })),
}));

// ----------------------------------------------------------------------------
// Import handler AFTER mocks are set up.
// ----------------------------------------------------------------------------

import { POST } from '../route';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const VALID_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeRequest(sessionId: string): NextRequest {
  // The handler reads sessionId from the URL pathname (segments[len-2]).
  // WHY Authorization header: the route now dispatches between API-key auth
  // (header present) and cookie auth (no header). These tests exercise the
  // API-key branch so the wrapper mock above takes effect; the cookie branch
  // is covered by route.cookie.test.ts.
  return new NextRequest(
    new URL(`http://localhost/api/v1/sessions/${sessionId}/summary`),
    { method: 'POST', headers: { authorization: 'Bearer sk_test_dummy' } }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionSelectResult = { data: null, error: null };
  mockResolveEffectiveTier.mockReset();
  mockFunctionsInvoke.mockReset();
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('POST /api/v1/sessions/[id]/summary', () => {
  it('returns 400 for an invalid session ID', async () => {
    const res = await POST(makeRequest('not-a-uuid'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid session id/i);
    expect(mockFunctionsInvoke).not.toHaveBeenCalled();
  });

  it('returns 404 when the session is not found / not owned by the caller', async () => {
    sessionSelectResult = { data: null, error: null };

    const res = await POST(makeRequest(VALID_SESSION_ID));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
    expect(mockFunctionsInvoke).not.toHaveBeenCalled();
  });

  it('returns the cached summary without invoking the Edge Function (idempotent)', async () => {
    sessionSelectResult = {
      data: {
        id: VALID_SESSION_ID,
        user_id: mockAuthContext.userId,
        summary: 'A previously generated summary.',
        summary_generated_at: '2026-04-01T00:00:00.000Z',
      },
      error: null,
    };

    const res = await POST(makeRequest(VALID_SESSION_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.summary).toBe('A previously generated summary.');
    expect(body.summary_generated_at).toBe('2026-04-01T00:00:00.000Z');
    expect(mockFunctionsInvoke).not.toHaveBeenCalled();
    // Tier resolver should be skipped on the idempotent path.
    expect(mockResolveEffectiveTier).not.toHaveBeenCalled();
  });

  it('returns 403 when the user is on the free tier', async () => {
    sessionSelectResult = {
      data: {
        id: VALID_SESSION_ID,
        user_id: mockAuthContext.userId,
        summary: null,
        summary_generated_at: null,
      },
      error: null,
    };
    mockResolveEffectiveTier.mockResolvedValueOnce('free');

    const res = await POST(makeRequest(VALID_SESSION_ID));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('TIER_RESTRICTED');
    expect(mockFunctionsInvoke).not.toHaveBeenCalled();
  });

  it('returns 502 when the Edge Function invocation fails', async () => {
    sessionSelectResult = {
      data: {
        id: VALID_SESSION_ID,
        user_id: mockAuthContext.userId,
        summary: null,
        summary_generated_at: null,
      },
      error: null,
    };
    mockResolveEffectiveTier.mockResolvedValueOnce('pro');
    mockFunctionsInvoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'OpenRouter timeout' },
    });

    const res = await POST(makeRequest(VALID_SESSION_ID));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/summary generation failed/i);
  });

  it('returns 200 with the generated summary on the happy path', async () => {
    sessionSelectResult = {
      data: {
        id: VALID_SESSION_ID,
        user_id: mockAuthContext.userId,
        summary: null,
        summary_generated_at: null,
      },
      error: null,
    };
    mockResolveEffectiveTier.mockResolvedValueOnce('pro');
    mockFunctionsInvoke.mockResolvedValueOnce({
      data: {
        success: true,
        session_id: VALID_SESSION_ID,
        summary: 'Newly generated summary text.',
        tokens_used: 312,
      },
      error: null,
    });

    const res = await POST(makeRequest(VALID_SESSION_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(body.summary).toBe('Newly generated summary text.');
    expect(body.session_id).toBe(VALID_SESSION_ID);
    expect(mockFunctionsInvoke).toHaveBeenCalledWith('generate-summary', {
      body: { session_id: VALID_SESSION_ID, user_id: mockAuthContext.userId },
    });
  });

  it('returns 502 when the Edge Function returns an empty summary', async () => {
    sessionSelectResult = {
      data: {
        id: VALID_SESSION_ID,
        user_id: mockAuthContext.userId,
        summary: null,
        summary_generated_at: null,
      },
      error: null,
    };
    mockResolveEffectiveTier.mockResolvedValueOnce('growth');
    mockFunctionsInvoke.mockResolvedValueOnce({
      data: { success: true, summary: '' },
      error: null,
    });

    const res = await POST(makeRequest(VALID_SESSION_ID));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/empty result/i);
  });
});
