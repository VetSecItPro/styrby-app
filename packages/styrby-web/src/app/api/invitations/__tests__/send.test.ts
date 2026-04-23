/**
 * Tests for POST /api/invitations/send
 *
 * This route is a thin proxy to the Unit A edge function (teams-invite).
 * It forwards the caller's JWT and propagates status codes (402, 429, etc.).
 *
 * Coverage:
 *   - Happy path: 200 from edge fn propagated
 *   - Unauthorized (no session): 401
 *   - No active session (cookie-based, getSession returns null): 401
 *   - Cookie-based auth: getSession access_token forwarded (not Authorization header)
 *   - Non-admin caller: 403 (propagated from edge fn)
 *   - Seat cap hit: 402 with overageInfo propagated
 *   - Rate limited: 429 propagated
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockGetSession = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser, getSession: mockGetSession },
  })),
}));

// Override global fetch for the edge function call.
// WHY: The send route calls fetch() to proxy to the edge function.
// We intercept at the global level so the route uses our mock.
global.fetch = mockFetch as typeof fetch;

// Set required env vars so the route doesn't return 500 due to missing config.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/invitations/send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer test-jwt-token',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/invitations/send', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: user authenticated + session with access_token
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'admin@example.com' } },
      error: null,
    });
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
      error: null,
    });

    const mod = await import('../send/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const req = createRequest({ team_id: 'team-1', email: 'a@b.com', role: 'member' });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when user exists but session has no access_token (stale cookie)', async () => {
    // WHY: The route now reads session.access_token to forward to the edge function.
    // If getSession returns null (e.g., token rotation race), we must return 401
    // rather than forwarding the anon key (which would cause the edge fn to 401).
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'admin@example.com' } },
      error: null,
    });
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const req = createRequest({ team_id: 'team-1', email: 'a@b.com', role: 'member' });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('forwards access_token from cookie session (not Authorization header) to edge function', async () => {
    // WHY: Browser users send cookies, not Authorization headers. The route must
    // call getSession() to extract the access_token from the cookie-backed session
    // and forward it. This test verifies the forwarded Authorization header uses
    // the session token, not the incoming Authorization header or the anon key.
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'cookie-session-token' } },
      error: null,
    });

    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ invitation_id: 'inv-1', expires_at: '2026-04-23T00:00:00Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    // Request WITHOUT Authorization header (simulates a browser cookie-only request)
    const req = new NextRequest('http://localhost:3000/api/invitations/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 'team-1', email: 'newmember@example.com', role: 'member' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // Verify edge function received the session access_token
    const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((fetchInit.headers as Record<string, string>)['Authorization']).toBe('Bearer cookie-session-token');
  });

  it('propagates 200 success from edge function', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ invitation_id: 'inv-1', expires_at: '2026-04-23T00:00:00Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const req = createRequest({ team_id: 'team-1', email: 'newmember@example.com', role: 'member' });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.invitation_id).toBe('inv-1');
  });

  it('propagates 402 when seat cap is hit', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'SEAT_CAP_EXCEEDED',
          upgradeCta: '/billing/add-seat?team=team-1',
          currentSeats: 3,
          seatCap: 3,
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    );

    const req = createRequest({ team_id: 'team-1', email: 'newmember@example.com', role: 'member' });
    const res = await POST(req);
    expect(res.status).toBe(402);

    const body = await res.json();
    expect(body.error).toBe('SEAT_CAP_EXCEEDED');
    expect(body.upgradeCta).toContain('/billing/add-seat');
  });

  it('propagates 429 when rate limited', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'RATE_LIMITED', resetAt: Date.now() + 3600_000 }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );

    const req = createRequest({ team_id: 'team-1', email: 'newmember@example.com', role: 'member' });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it('propagates 403 when caller is not team admin', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'FORBIDDEN', message: 'Only team owners and admins can send invitations' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );

    const req = createRequest({ team_id: 'team-1', email: 'other@example.com', role: 'member' });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});
