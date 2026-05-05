/**
 * POST /api/v1/sessions/[id]/summary — Cookie auth path regression tests
 *
 * The route serves two callers:
 *   1. CLI / programmatic clients — `Authorization: Bearer sk_live_...`
 *   2. Dashboard "Generate summary" button — same-origin fetch with a
 *      Supabase session cookie (no Authorization header).
 *
 * The sibling `route.test.ts` covers (1) by mocking `withApiAuthAndRateLimit`.
 * This file covers (2): we send a request WITHOUT an Authorization header and
 * assert the cookie auth branch validates the user, then dispatches the
 * shared handler with the expected userId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ----------------------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------------------

// We do NOT mock @/middleware/api-auth here — the cookie path bypasses it
// entirely. We DO need to make sure that branch isn't exercised; sending a
// request without an Authorization header guarantees that.

const mockResolveEffectiveTier = vi.fn();
vi.mock('@/lib/tier-enforcement', () => ({
  resolveEffectiveTier: (...args: unknown[]) => mockResolveEffectiveTier(...args),
}));

let sessionSelectResult: { data: unknown; error: unknown } = { data: null, error: null };
const mockFunctionsInvoke = vi.fn();
const mockGetUser = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => {
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
  // Cookie-auth client. Only auth.getUser() is exercised on this path.
  createClient: vi.fn(async () => ({
    auth: {
      getUser: () => mockGetUser(),
    },
  })),
}));

// Import handler AFTER mocks
import { POST } from '../route';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const VALID_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const COOKIE_USER_ID = 'user-cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeCookieRequest(sessionId: string): NextRequest {
  // No Authorization header — selects the cookie-auth branch.
  return new NextRequest(
    new URL(`http://localhost/api/v1/sessions/${sessionId}/summary`),
    { method: 'POST' }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionSelectResult = { data: null, error: null };
  mockResolveEffectiveTier.mockReset();
  mockFunctionsInvoke.mockReset();
  mockGetUser.mockReset();
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('POST /api/v1/sessions/[id]/summary — cookie auth path', () => {
  it('returns 401 when the Supabase session is missing/invalid', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'no session' },
    });

    const res = await POST(makeCookieRequest(VALID_SESSION_ID));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('UNAUTHORIZED');
    expect(mockFunctionsInvoke).not.toHaveBeenCalled();
  });

  it('happy path: cookie session resolves -> 200 with generated summary', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: COOKIE_USER_ID, email: 'dash@example.com' } },
      error: null,
    });
    sessionSelectResult = {
      data: {
        id: VALID_SESSION_ID,
        user_id: COOKIE_USER_ID,
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
        summary: 'Cookie-path generated summary.',
      },
      error: null,
    });

    const res = await POST(makeCookieRequest(VALID_SESSION_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBe('Cookie-path generated summary.');
    expect(body.cached).toBe(false);
    // Confirm the Edge Function was invoked with the user_id resolved from
    // the cookie session — NOT a stray API-key user.
    expect(mockFunctionsInvoke).toHaveBeenCalledWith('generate-summary', {
      body: { session_id: VALID_SESSION_ID, user_id: COOKIE_USER_ID },
    });
  });

  it('cookie path returns idempotent cached summary without invoking Edge Function', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: COOKIE_USER_ID } },
      error: null,
    });
    sessionSelectResult = {
      data: {
        id: VALID_SESSION_ID,
        user_id: COOKIE_USER_ID,
        summary: 'Already generated.',
        summary_generated_at: '2026-04-01T00:00:00.000Z',
      },
      error: null,
    };

    const res = await POST(makeCookieRequest(VALID_SESSION_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.summary).toBe('Already generated.');
    expect(mockFunctionsInvoke).not.toHaveBeenCalled();
  });
});
