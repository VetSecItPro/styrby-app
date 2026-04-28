/**
 * Per-Session Retention Override API Route Tests
 *
 * PUT /api/account/retention/session
 *
 * WHY: Validates that the per-session retention override endpoint correctly
 * enforces schema-level mass-assignment protection (OWASP A04:2021). An
 * attacker cannot inject extra fields (e.g. `user_id`, `is_admin`) into the
 * sessions.update() call via a crafted request body.
 *
 * Audit: OWASP A04:2021 — Insecure Design (mass-assignment); OWASP A01:2021
 * — Broken Access Control (session ownership verification).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: { sensitive: { windowMs: 60000, maxRequests: 10 } },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED', retryAfter }), { status: 429 }),
  ),
}));

// ============================================================================
// Helpers
// ============================================================================

const VALID_SESSION_ID = '00000000-0000-0000-0000-000000000001';

function makeRequest(body: object): Request {
  return new Request('http://localhost/api/account/retention/session', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setupAuthUser(userId = 'user-abc') {
  mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
}

function setupSessionFound(sessionId = VALID_SESSION_ID, userId = 'user-abc') {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    single: vi
      .fn()
      .mockResolvedValue({ data: { id: sessionId, user_id: userId }, error: null }),
  };
}

// ============================================================================
// Basic validation tests
// ============================================================================

describe('PUT /api/account/retention/session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('Not authed') });

    const { PUT } = await import('../route');
    const response = await PUT(
      makeRequest({ session_id: VALID_SESSION_ID, retention_override: 'inherit' }),
    );

    expect(response.status).toBe(401);
  });

  it('returns 400 for invalid UUID in session_id', async () => {
    setupAuthUser();

    const { PUT } = await import('../route');
    const response = await PUT(
      makeRequest({ session_id: 'not-a-uuid', retention_override: 'inherit' }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('UUID');
  });

  it('returns 400 for invalid retention_override value', async () => {
    setupAuthUser();

    const { PUT } = await import('../route');
    const response = await PUT(
      makeRequest({ session_id: VALID_SESSION_ID, retention_override: 'pin_days:999' }),
    );

    expect(response.status).toBe(400);
  });

  it('returns 404 when session is not found or owned by another user', async () => {
    setupAuthUser();

    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Row not found' } }),
    }));

    const { PUT } = await import('../route');
    const response = await PUT(
      makeRequest({ session_id: VALID_SESSION_ID, retention_override: 'pin_forever' }),
    );

    expect(response.status).toBe(404);
  });

  it('returns 200 for a valid inherit override', async () => {
    setupAuthUser();

    // Track how many times 'sessions' has been called to distinguish SELECT vs UPDATE
    let sessionsCallCount = 0;
    const sessionMock = setupSessionFound();

    // Update chain: .update().eq().eq() — both .eq() calls must be chainable,
    // with the second resolving the final promise ({ error: null }).
    const secondEqSpy = vi.fn().mockResolvedValue({ error: null });
    const firstEqSpy = vi.fn().mockReturnValue({ eq: secondEqSpy });
    const sessionUpdateChain = {
      update: vi.fn().mockReturnValue({ eq: firstEqSpy }),
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'sessions') {
        sessionsCallCount++;
        // First call is the SELECT ownership check; second is the UPDATE.
        return sessionsCallCount === 1 ? sessionMock : sessionUpdateChain;
      }
      if (table === 'audit_log') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      return {};
    });

    const { PUT } = await import('../route');
    const response = await PUT(
      makeRequest({ session_id: VALID_SESSION_ID, retention_override: 'inherit' }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.retention_override).toBe('inherit');
  });

  // ── OWASP A04:2021 Mass-Assignment Guard ──────────────────────────────────

  /**
   * WHY: Confirms that the .strict() schema rejects any unknown key before the
   * sessions.update() call is reached. An attacker cannot inject `user_id`,
   * `is_admin`, or `tier` alongside a valid session_id to perform privilege
   * escalation or session takeover via mass-assignment.
   */
  it('OWASP A04 — returns 400 and never calls sessions.update() when request includes unknown key is_admin: true', async () => {
    setupAuthUser();

    const sessionUpdateSpy = vi.fn();

    mockFrom.mockImplementation((table: string) => {
      if (table === 'sessions') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: VALID_SESSION_ID, user_id: 'user-abc' },
            error: null,
          }),
          update: sessionUpdateSpy,
        };
      }
      if (table === 'audit_log') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      return {};
    });

    const { PUT } = await import('../route');
    // Malicious payload: valid fields + injected privilege-escalation key
    const response = await PUT(
      makeRequest({
        session_id: VALID_SESSION_ID,
        retention_override: 'pin_forever',
        is_admin: true,
      }),
    );

    expect(response.status).toBe(400);
    // Critical: .update() must NOT have been called — the schema stopped it
    expect(sessionUpdateSpy).not.toHaveBeenCalled();
  });

  it('OWASP A04 — returns 400 and never calls sessions.update() when request includes unknown key user_id targeting another account', async () => {
    setupAuthUser('user-abc');

    const sessionUpdateSpy = vi.fn();

    mockFrom.mockImplementation((table: string) => {
      if (table === 'sessions') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: VALID_SESSION_ID, user_id: 'user-abc' },
            error: null,
          }),
          update: sessionUpdateSpy,
        };
      }
      if (table === 'audit_log') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      return {};
    });

    const { PUT } = await import('../route');
    // Attacker attempts to overwrite user_id on the session row
    const response = await PUT(
      makeRequest({
        session_id: VALID_SESSION_ID,
        retention_override: 'inherit',
        user_id: 'victim-user-id',
      }),
    );

    expect(response.status).toBe(400);
    expect(sessionUpdateSpy).not.toHaveBeenCalled();
  });
});
