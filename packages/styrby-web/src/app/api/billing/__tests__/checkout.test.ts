/**
 * Tests for POST /api/billing/checkout/team
 *
 * Coverage:
 *   - Happy path: team admin creates checkout → Polar API called with correct
 *     product_id, quantity, metadata, success/cancel URLs → 200 + checkout_url
 *   - Auth: non-admin (role 'member') rejected with 403
 *   - Auth: unauthenticated request rejected with 401
 *   - Auth: Bearer token path (mobile-style, no cookies) succeeds
 *   - Validation: seats below tier minimum rejected 422 (team requires >= 3)
 *   - Validation: unknown tier rejected 400
 *   - Validation: invalid UUID for team_id rejected 400
 *   - Polar API 5xx → 502 Bad Gateway (never 500 — forwarding upstream failure)
 *   - audit_log: 'team_checkout_initiated' written on success
 *   - POLAR_ACCESS_TOKEN never appears in error responses
 *
 * WHY vi.hoisted(): vi.mock() factories are hoisted above all code.
 * Variables declared with `const` would be in the Temporal Dead Zone when
 * the factory runs, causing ReferenceError. vi.hoisted() moves initialisation
 * into the hoisting phase so mocks can reference the variables safely.
 *
 * WHY mock @polar-sh/sdk (not the polar instance from polar.ts):
 *   The route module creates its own `new Polar(...)` at module scope.
 *   Mocking the SDK class means any `new Polar(...)` in the module gets
 *   our mock instance — we never need to import or patch the real polar.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../checkout/team/route';

// ============================================================================
// Hoisted mocks
// ============================================================================

const {
  mockGetUser,
  mockMembershipSelect,
  mockAuditInsert,
  mockCheckoutsCreate,
  mockGetPolarProductId,
  mockRateLimit,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockMembershipSelect: vi.fn(),
  mockAuditInsert: vi.fn(),
  mockCheckoutsCreate: vi.fn(),
  mockGetPolarProductId: vi.fn(),
  mockRateLimit: vi.fn(),
}));

// ── Supabase (user-scoped client) ──────────────────────────────────────────

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'team_members') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: mockMembershipSelect,
              })),
            })),
          })),
        };
      }
      // Fallback (should not be hit in checkout tests)
      return { select: vi.fn(), insert: vi.fn() };
    }),
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: mockAuditInsert,
    })),
  })),
}));

// ── @supabase/ssr (Bearer token path) ─────────────────────────────────────

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'team_members') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: mockMembershipSelect,
              })),
            })),
          })),
        };
      }
      return { select: vi.fn(), insert: vi.fn() };
    }),
  })),
}));

// ── @polar-sh/sdk ─────────────────────────────────────────────────────────

vi.mock('@polar-sh/sdk', () => ({
  Polar: vi.fn().mockImplementation(() => ({
    checkouts: { create: mockCheckoutsCreate },
  })),
}));

// ── polar-env ─────────────────────────────────────────────────────────────

vi.mock('@/lib/polar-env', () => ({
  getPolarProductId: mockGetPolarProductId,
}));

// ── rateLimit ─────────────────────────────────────────────────────────────

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: mockRateLimit,
  RATE_LIMITS: { checkout: { windowMs: 60000, maxRequests: 5 }, standard: { windowMs: 60000, maxRequests: 30 } },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    NextResponse.json({ error: 'RATE_LIMITED', retryAfter }, { status: 429 }),
  ),
}));

// ── config ────────────────────────────────────────────────────────────────

vi.mock('@/lib/config', () => ({
  getAppUrl: vi.fn(() => 'https://styrbyapp.com'),
}));

// ── env ───────────────────────────────────────────────────────────────────

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn((name: string) => process.env[name]),
}));

// ── next/headers (imported transitively by createClient) ──────────────────

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    getAll: vi.fn(() => []),
    set: vi.fn(),
  })),
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a Request for POST /api/billing/checkout/team.
 *
 * @param body - JSON body (not yet stringified)
 * @param bearerToken - Optional Authorization Bearer token (for mobile path)
 */
function buildRequest(
  body: Record<string, unknown>,
  bearerToken?: string,
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`;
  }
  return new Request('https://styrbyapp.com/api/billing/checkout/team', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** Standard valid checkout body */
const VALID_BODY = {
  team_id: '11111111-1111-1111-1111-111111111111',
  tier: 'team',
  cycle: 'monthly',
  seats: 5,
};

/** Authenticated user fixture */
const MOCK_USER = { id: 'user-abc', email: 'admin@example.com' };

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/billing/checkout/team', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: rate limit allows
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: null });

    // Default: authenticated user
    mockGetUser.mockResolvedValue({ data: { user: MOCK_USER }, error: null });

    // Default: caller is team owner
    mockMembershipSelect.mockResolvedValue({
      data: { role: 'owner' },
      error: null,
    });

    // Default: product ID resolves
    mockGetPolarProductId.mockReturnValue('polar_prod_team_monthly_abc');

    // Default: Polar checkout succeeds
    mockCheckoutsCreate.mockResolvedValue({
      url: 'https://polar.sh/checkout/session_xyz',
    });

    // Default: audit insert succeeds
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns 200 with checkout_url for a valid team admin request', async () => {
    const req = buildRequest(VALID_BODY);
    const res = await POST(req);
    const json = await res.json() as { checkout_url?: string };

    expect(res.status).toBe(200);
    expect(json.checkout_url).toBe('https://polar.sh/checkout/session_xyz');
  });

  it('calls Polar checkouts.create with correct product_id, quantity, metadata, and URLs', async () => {
    const req = buildRequest({ ...VALID_BODY, tier: 'team', cycle: 'annual', seats: 3 });
    await POST(req);

    expect(mockCheckoutsCreate).toHaveBeenCalledOnce();
    const call = mockCheckoutsCreate.mock.calls[0][0] as Record<string, unknown>;

    expect(call.productId).toBe('polar_prod_team_monthly_abc');
    expect(call.quantity).toBe(3);
    expect(call.metadata).toMatchObject({
      team_id: '11111111-1111-1111-1111-111111111111',
      tier: 'team',
      cycle: 'annual',
      seats: '3',
    });
    expect(call.successUrl).toContain('/dashboard/team/11111111-1111-1111-1111-111111111111');
    expect(call.successUrl).toContain('billing=success');
    expect(call.cancelUrl).toContain('billing');
  });

  it('writes audit_log with action team_checkout_initiated on success', async () => {
    const req = buildRequest(VALID_BODY);
    await POST(req);

    expect(mockAuditInsert).toHaveBeenCalledOnce();
    const insertArg = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(insertArg.action).toBe('team_checkout_initiated');
    expect(insertArg.user_id).toBe('user-abc');
    expect(insertArg.resource_id).toBe(VALID_BODY.team_id);
  });

  // ── Bearer token (mobile) path ─────────────────────────────────────────────

  it('accepts Bearer token auth (mobile path) and returns checkout_url', async () => {
    const req = buildRequest(VALID_BODY, 'eyJtb2JpbGVfdG9rZW4iOiJ0ZXN0In0');
    const res = await POST(req);

    expect(res.status).toBe(200);
    const json = await res.json() as { checkout_url?: string };
    expect(json.checkout_url).toBeDefined();
  });

  // ── Auth failures ──────────────────────────────────────────────────────────

  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } });
    const req = buildRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('UNAUTHORIZED');
  });

  it('returns 403 when caller is a member (not owner/admin)', async () => {
    mockMembershipSelect.mockResolvedValue({
      data: { role: 'member' },
      error: null,
    });
    const req = buildRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(403);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('FORBIDDEN');
  });

  it('returns 403 when caller is not a member of the team', async () => {
    mockMembershipSelect.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const req = buildRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(403);
  });

  // ── Validation failures ────────────────────────────────────────────────────

  it('returns 422 when seats is below tier minimum (team requires >= 3)', async () => {
    const req = buildRequest({ ...VALID_BODY, tier: 'team', seats: 2 });
    const res = await POST(req);

    expect(res.status).toBe(422);
    const json = await res.json() as { error: string; minSeats: number };
    expect(json.error).toBe('INVALID_SEATS');
    expect(json.minSeats).toBe(3);
  });

  it('returns 400 when tier is unknown (not team|business)', async () => {
    const req = buildRequest({ ...VALID_BODY, tier: 'enterprise' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when tier is free (not self-service)', async () => {
    const req = buildRequest({ ...VALID_BODY, tier: 'free' });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 when team_id is not a valid UUID', async () => {
    const req = buildRequest({ ...VALID_BODY, team_id: 'not-a-uuid' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when body is not valid JSON', async () => {
    const req = new Request('https://styrbyapp.com/api/billing/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json {{{',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  // ── Polar API failure → 502 ────────────────────────────────────────────────

  it('returns 502 (not 500) when Polar API throws', async () => {
    mockCheckoutsCreate.mockRejectedValue(new Error('Polar 503 Service Unavailable'));
    const req = buildRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(502);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('UPSTREAM_ERROR');
  });

  it('does not include POLAR_ACCESS_TOKEN in the 502 error response', async () => {
    process.env.POLAR_ACCESS_TOKEN = 'test-placeholder-polar-value-xyz';
    mockCheckoutsCreate.mockRejectedValue(new Error('auth failure'));
    const req = buildRequest(VALID_BODY);
    const res = await POST(req);
    const text = await res.text();

    expect(text).not.toContain('test-placeholder-polar-value-xyz');
    delete process.env.POLAR_ACCESS_TOKEN;
  });

  it('returns 502 when product ID env var is missing', async () => {
    mockGetPolarProductId.mockReturnValue('');
    const req = buildRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(502);
    expect(mockCheckoutsCreate).not.toHaveBeenCalled();
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  it('returns 429 when rate limit is exceeded', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfter: 42 });
    const req = buildRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(429);
  });
});
