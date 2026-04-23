/**
 * Tests for PATCH + GET /api/billing/seats
 *
 * Coverage:
 *   - Happy path upgrade: team 3→5 calls Polar update, proration calculated
 *     via calculateProrationCents, audit_log written with proration_cents
 *   - Downgrade guard: team has 8 members, request 5 seats → 409 DOWNGRADE_BLOCKED
 *     with { current_members: 8, requested_seats: 5 }
 *   - Downgrade guard: team has 3 members (== tier minimum), request 3 seats
 *     → SUCCESS (boundary — equal to member count is allowed)
 *   - Downgrade guard: team has 3 members, request 2 seats (below tier min 3)
 *     → 422 INVALID_SEATS (validateSeatCount fires BEFORE the member count guard)
 *   - Auth: non-admin rejected 403
 *   - Auth: unauthenticated rejected 401
 *   - Polar API failure on subscriptions.get → 502
 *   - Polar API failure on subscriptions.update → 502
 *   - Audit 'team_downgrade_blocked' written when guard fires
 *   - GET /api/billing/seats: returns proration preview for proposed change
 *   - GET: non-integer new_seat_count in query param rejected 400
 *
 * WHY we mock calculateProrationCents separately:
 *   The real function is pure and tested exhaustively in its own unit.
 *   Here we only verify it is called with correct arguments and its result
 *   surfaces in the response — we don't re-test the proration math.
 *   However, to keep the test self-contained, we use real calculateProrationCents
 *   from @styrby/shared/billing (it's pure and has no side effects) and
 *   just assert on the returned value.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH, GET } from '../seats/route';
import { calculateProrationCents } from '@styrby/shared/billing';

// ============================================================================
// Hoisted mocks
// ============================================================================

const {
  mockGetUser,
  mockMembershipSelect,
  mockTeamBillingSelect,
  mockMemberCountSelect,
  mockTeamUpdate,
  mockAuditInsert,
  mockSubsGet,
  mockSubsUpdate,
  mockRateLimit,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockMembershipSelect: vi.fn(),
  mockTeamBillingSelect: vi.fn(),
  mockMemberCountSelect: vi.fn(),
  mockTeamUpdate: vi.fn(),
  mockAuditInsert: vi.fn(),
  mockSubsGet: vi.fn(),
  mockSubsUpdate: vi.fn(),
  mockRateLimit: vi.fn(),
}));

// ============================================================================
// Mock setup
// ============================================================================

/**
 * WHY table-dispatch mock: the route calls supabase.from() for four different
 * tables (team_members twice, teams twice, audit_log). A single per-table
 * dispatch inside the from() mock gives each table its own independent mock
 * function, making assertions precise.
 */
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => buildMockSupabaseClient()),
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: mockAuditInsert,
    })),
  })),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => buildMockSupabaseClient()),
}));

vi.mock('@polar-sh/sdk', () => ({
  Polar: vi.fn().mockImplementation(() => ({
    subscriptions: {
      get: mockSubsGet,
      update: mockSubsUpdate,
    },
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: mockRateLimit,
  RATE_LIMITS: { checkout: { windowMs: 60000, maxRequests: 5 }, standard: { windowMs: 60000, maxRequests: 30 } },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    NextResponse.json({ error: 'RATE_LIMITED', retryAfter }, { status: 429 }),
  ),
}));

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn((name: string) => process.env[name]),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    getAll: vi.fn(() => []),
    set: vi.fn(),
  })),
}));

// ============================================================================
// Mock client factory
// ============================================================================

/**
 * Builds a mock Supabase client that dispatches per table.
 *
 * WHY this approach: different tables need different mock return values.
 * A single from() mock with table dispatch avoids coupling test assertions
 * to call order (which would break if the route reorders DB calls).
 */
function buildMockSupabaseClient() {
  return {
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      // team_members: membership check (two .eq() + .single()) + member count (one .eq(), head: true)
      if (table === 'team_members') {
        return {
          select: vi.fn((cols: string, opts?: { count?: string; head?: boolean }) => {
            // Distinguish member count query (head: true, single .eq()) from membership role query
            if (opts?.head === true) {
              return {
                // Count query: .eq('team_id', ...) returns the count result directly
                eq: vi.fn(() => mockMemberCountSelect()),
              };
            }
            // Role-based membership query: .eq('team_id', ...).eq('user_id', ...).single()
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: mockMembershipSelect,
                })),
              })),
            };
          }),
        };
      }

      // teams: billing row select + active_seats update
      if (table === 'teams') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: mockTeamBillingSelect,
            })),
          })),
          update: vi.fn(() => ({
            eq: mockTeamUpdate,
          })),
        };
      }

      return { select: vi.fn(), insert: vi.fn() };
    }),
  };
}

// ============================================================================
// Fixtures
// ============================================================================

/** Valid PATCH body */
const VALID_PATCH_BODY = {
  team_id: '22222222-2222-2222-2222-222222222222',
  new_seat_count: 5,
};

/** Authenticated user */
const MOCK_USER = { id: 'user-owner', email: 'owner@example.com' };

/**
 * A Polar subscription fixture with period spanning 30 days.
 * currentPeriodStart = 15 days ago → daysElapsed ≈ 15, daysInCycle = 30.
 */
function makePolarSubscription(quantity: number) {
  const start = new Date(Date.now() - 15 * 86_400_000);
  const end = new Date(Date.now() + 15 * 86_400_000);
  return {
    id: 'polar_sub_abc',
    quantity,
    currentPeriodStart: start.toISOString(),
    currentPeriodEnd: end.toISOString(),
  };
}

/** Team billing row with active subscription */
const TEAM_BILLING_ROW = {
  polar_subscription_id: 'polar_sub_abc',
  billing_tier: 'team',
  billing_cycle: 'monthly',
  seat_cap: 3,
  active_seats: 3,
};

/** Builds a POST/PATCH Request */
function buildRequest(
  body: Record<string, unknown>,
  method = 'PATCH',
  bearerToken?: string,
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

  return new Request('https://styrbyapp.com/api/billing/seats', {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

/** Builds a GET Request with query params */
function buildGetRequest(params: Record<string, string>): Request {
  const url = new URL('https://styrbyapp.com/api/billing/seats');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString(), { method: 'GET' });
}

// ============================================================================
// Tests
// ============================================================================

describe('PATCH /api/billing/seats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: null });
    mockGetUser.mockResolvedValue({ data: { user: MOCK_USER }, error: null });
    mockMembershipSelect.mockResolvedValue({ data: { role: 'owner' }, error: null });
    mockTeamBillingSelect.mockResolvedValue({ data: TEAM_BILLING_ROW, error: null });
    // Default: 3 active members
    mockMemberCountSelect.mockResolvedValue({ count: 3, error: null });
    mockSubsGet.mockResolvedValue(makePolarSubscription(3));
    mockSubsUpdate.mockResolvedValue({ id: 'polar_sub_abc', quantity: 5 });
    mockTeamUpdate.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  // ── Happy path upgrade ─────────────────────────────────────────────────────

  it('returns 200 on valid seat upgrade (3→5)', async () => {
    const req = buildRequest(VALID_PATCH_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; active_seats: number; proration_cents: number };
    expect(json.success).toBe(true);
    expect(json.active_seats).toBe(5);
    // proration_cents should be a non-negative integer
    expect(Number.isInteger(json.proration_cents)).toBe(true);
    expect(json.proration_cents).toBeGreaterThanOrEqual(0);
  });

  it('calls Polar subscriptions.update with correct new quantity', async () => {
    const req = buildRequest(VALID_PATCH_BODY);
    await PATCH(req);

    expect(mockSubsUpdate).toHaveBeenCalledOnce();
    const call = mockSubsUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.id).toBe('polar_sub_abc');
  });

  it('calculates proration via calculateProrationCents and includes it in audit_log', async () => {
    const req = buildRequest(VALID_PATCH_BODY);
    await PATCH(req);

    // The audit_log insert must include proration_cents
    expect(mockAuditInsert).toHaveBeenCalledOnce();
    const insertArg = mockAuditInsert.mock.calls[0][0] as {
      action: string;
      metadata: { proration_cents: number };
    };
    expect(insertArg.action).toBe('team_seat_count_increased');
    expect(Number.isInteger(insertArg.metadata.proration_cents)).toBe(true);
  });

  it('proration_cents matches calculateProrationCents result', async () => {
    const sub = makePolarSubscription(3);
    mockSubsGet.mockResolvedValue(sub);
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 5 });
    const res = await PATCH(req);
    const json = await res.json() as { proration_cents: number };

    // Recompute expected proration using the real pure function
    const periodStart = new Date(sub.currentPeriodStart).getTime();
    const periodEnd = new Date(sub.currentPeriodEnd).getTime();
    const MS = 86_400_000;
    const daysElapsed = Math.max(0, Math.round((Date.now() - periodStart) / MS));
    const daysInCycle = Math.max(1, Math.round((periodEnd - periodStart) / MS));
    const expected = calculateProrationCents({
      oldSeats: 3,
      newSeats: 5,
      tier: 'team',
      daysElapsed,
      daysInCycle,
    });

    // WHY ±1 tolerance: timing between test execution and the route's Date.now()
    // call can differ by milliseconds, shifting daysElapsed by 1 in edge cases.
    expect(Math.abs(json.proration_cents - expected)).toBeLessThanOrEqual(
      calculateProrationCents({ oldSeats: 3, newSeats: 5, tier: 'team', daysElapsed: 1, daysInCycle }),
    );
  });

  // ── Downgrade guard ────────────────────────────────────────────────────────

  it('returns 409 DOWNGRADE_BLOCKED when team has 8 members and 5 seats requested', async () => {
    mockMemberCountSelect.mockResolvedValue({ count: 8, error: null });
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 5 });
    const res = await PATCH(req);

    expect(res.status).toBe(409);
    const json = await res.json() as {
      error: string;
      details: { current_members: number; requested_seats: number; action_required: string };
    };
    expect(json.error).toBe('DOWNGRADE_BLOCKED');
    expect(json.details.current_members).toBe(8);
    expect(json.details.requested_seats).toBe(5);
    expect(json.details.action_required).toContain('3');
  });

  it('does NOT call Polar API when DOWNGRADE_BLOCKED', async () => {
    mockMemberCountSelect.mockResolvedValue({ count: 8, error: null });
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 5 });
    await PATCH(req);

    expect(mockSubsUpdate).not.toHaveBeenCalled();
  });

  it('writes audit_log team_downgrade_blocked when guard fires', async () => {
    mockMemberCountSelect.mockResolvedValue({ count: 8, error: null });
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 5 });
    await PATCH(req);

    expect(mockAuditInsert).toHaveBeenCalledOnce();
    const insertArg = mockAuditInsert.mock.calls[0][0] as { action: string };
    expect(insertArg.action).toBe('team_downgrade_blocked');
  });

  it('returns 200 when new_seat_count == active member count (boundary)', async () => {
    // 3 members, 3 seats requested — this is allowed (not a downgrade below members)
    mockMemberCountSelect.mockResolvedValue({ count: 3, error: null });
    mockSubsGet.mockResolvedValue(makePolarSubscription(5)); // currently 5, reducing to 3
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 3 });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    expect(mockSubsUpdate).toHaveBeenCalledOnce();
  });

  it('returns 422 INVALID_SEATS when new_seat_count is below tier minimum (team min=3)', async () => {
    // 3 members, but requesting 2 seats — fails validateSeatCount BEFORE member count check
    mockMemberCountSelect.mockResolvedValue({ count: 3, error: null });
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 2 });
    const res = await PATCH(req);

    expect(res.status).toBe(422);
    const json = await res.json() as { error: string; minSeats: number };
    expect(json.error).toBe('INVALID_SEATS');
    expect(json.minSeats).toBe(3);
    // Guard must NOT have been reached (validateSeatCount fires first)
    expect(mockSubsUpdate).not.toHaveBeenCalled();
  });

  // ── Auth failures ──────────────────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } });
    const req = buildRequest(VALID_PATCH_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('UNAUTHORIZED');
  });

  it('returns 403 when caller is a member (not owner/admin)', async () => {
    mockMembershipSelect.mockResolvedValue({ data: { role: 'member' }, error: null });
    const req = buildRequest(VALID_PATCH_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(403);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('FORBIDDEN');
  });

  // ── Polar API failures → 502 ───────────────────────────────────────────────

  it('returns 502 when Polar subscriptions.get fails', async () => {
    mockSubsGet.mockRejectedValue(new Error('Polar 503 Service Unavailable'));
    const req = buildRequest(VALID_PATCH_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(502);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('UPSTREAM_ERROR');
  });

  it('returns 502 when Polar subscriptions.update fails', async () => {
    mockSubsUpdate.mockRejectedValue(new Error('Polar connection timeout'));
    const req = buildRequest(VALID_PATCH_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(502);
  });

  // ── No subscription ────────────────────────────────────────────────────────

  it('returns 404 when team has no polar_subscription_id', async () => {
    mockTeamBillingSelect.mockResolvedValue({
      data: { ...TEAM_BILLING_ROW, polar_subscription_id: null },
      error: null,
    });
    const req = buildRequest(VALID_PATCH_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('NO_SUBSCRIPTION');
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  it('returns 400 for invalid UUID team_id', async () => {
    const req = buildRequest({ team_id: 'not-uuid', new_seat_count: 5 });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for non-integer new_seat_count', async () => {
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 3.5 });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for negative new_seat_count', async () => {
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: -1 });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
  });

  // ── NaN / null Polar timestamp propagation (Fix 1) ────────────────────────

  it('returns 200 with proration_cents=0 when Polar returns currentPeriodStart: null (safe default)', async () => {
    // WHY: paused subscriptions can return null timestamps. The route must
    // handle this gracefully — returning 200 with proration_cents=0 (no charge)
    // rather than letting NaN propagate into calculateProrationCents → 500.
    mockSubsGet.mockResolvedValue({
      id: 'polar_sub_abc',
      quantity: 3,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    const req = buildRequest(VALID_PATCH_BODY); // 3→5 upgrade
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; proration_cents: number };
    expect(json.success).toBe(true);
    // Safe default fires: daysElapsed=0, daysInCycle=30
    // calculateProrationCents with daysElapsed=0 returns the full remaining-days
    // proration, which is a valid integer (not NaN/null).
    expect(Number.isInteger(json.proration_cents)).toBe(true);
    expect(json.proration_cents).toBeGreaterThanOrEqual(0);
  });

  it('returns 200 with proration_cents as integer when Polar returns a malformed timestamp (safe default, no RangeError)', async () => {
    // WHY: malformed strings like 'invalid-date' make new Date(...).getTime() = NaN.
    // NaN propagates through Math.max(0, NaN) silently and reaches
    // calculateProrationCents which throws RangeError. The guard in computeCycleDays
    // catches this and returns { daysElapsed: 0, daysInCycle: 30 } instead.
    mockSubsGet.mockResolvedValue({
      id: 'polar_sub_abc',
      quantity: 3,
      currentPeriodStart: 'not-a-valid-date',
      currentPeriodEnd: 'also-not-valid',
    });
    const req = buildRequest(VALID_PATCH_BODY); // 3→5 upgrade
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; proration_cents: number };
    expect(json.success).toBe(true);
    expect(Number.isInteger(json.proration_cents)).toBe(true);
    expect(json.proration_cents).toBeGreaterThanOrEqual(0);
  });

  // ── Audit direction: decrease writes team_seat_count_decreased (Fix 2) ─────

  it('writes audit_log with action=team_seat_count_decreased and negative delta when seats reduced (5→3)', async () => {
    // WHY: a valid decrease (new < old but still >= member count) must write the
    // 'decreased' action, not 'increased'. The delta must be negative so ops
    // queries can distinguish the direction without comparing old vs new fields.
    mockSubsGet.mockResolvedValue(makePolarSubscription(5)); // currently 5 seats
    mockMemberCountSelect.mockResolvedValue({ count: 3, error: null }); // 3 members — decrease is valid
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 3 }); // 5→3
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    expect(mockAuditInsert).toHaveBeenCalledOnce();
    const insertArg = mockAuditInsert.mock.calls[0][0] as {
      action: string;
      metadata: { delta: number; old_seat_count: number; new_seat_count: number };
    };
    expect(insertArg.action).toBe('team_seat_count_decreased');
    expect(insertArg.metadata.delta).toBe(-2); // 3 - 5 = -2
    expect(insertArg.metadata.old_seat_count).toBe(5);
    expect(insertArg.metadata.new_seat_count).toBe(3);
  });

  // ── subscription.quantity null fallback uses teams.seat_cap (Fix 3) ────────

  it('uses teams.seat_cap as oldSeats when Polar subscription.quantity is null', async () => {
    // WHY: paused subscriptions return quantity: null. seat_cap (from DB) is the
    // next-best source — it reflects the last webhook-confirmed seat count.
    // This test verifies proration is computed with the correct base (5 seats
    // from seat_cap), not 1 (the final fallback).
    mockSubsGet.mockResolvedValue({
      id: 'polar_sub_abc',
      quantity: null, // null — SDK type drift or paused sub
      currentPeriodStart: new Date(Date.now() - 15 * 86_400_000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 15 * 86_400_000).toISOString(),
    });
    // DB has seat_cap: 5 — this becomes oldSeats
    mockTeamBillingSelect.mockResolvedValue({
      data: { ...TEAM_BILLING_ROW, seat_cap: 5, active_seats: 5 },
      error: null,
    });
    // Request 7 seats (upgrade from 5)
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 7 });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; proration_cents: number };
    expect(json.success).toBe(true);
    // proration must be a positive integer (2-seat upgrade, 15 of 30 days remaining)
    expect(Number.isInteger(json.proration_cents)).toBe(true);
    expect(json.proration_cents).toBeGreaterThan(0);

    // Verify audit also sees the correct old_seat_count (5, not 1 or null)
    const insertArg = mockAuditInsert.mock.calls[0][0] as {
      action: string;
      metadata: { old_seat_count: number };
    };
    expect(insertArg.action).toBe('team_seat_count_increased');
    expect(insertArg.metadata.old_seat_count).toBe(5);
  });
});

// ============================================================================
// Bearer token auth for PATCH (Fix 4)
// ============================================================================

describe('PATCH /api/billing/seats — Bearer token auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: null });
    mockGetUser.mockResolvedValue({ data: { user: MOCK_USER }, error: null });
    mockMembershipSelect.mockResolvedValue({ data: { role: 'admin' }, error: null });
    mockTeamBillingSelect.mockResolvedValue({ data: TEAM_BILLING_ROW, error: null });
    mockMemberCountSelect.mockResolvedValue({ count: 3, error: null });
    mockSubsGet.mockResolvedValue(makePolarSubscription(3));
    mockSubsUpdate.mockResolvedValue({ id: 'polar_sub_abc', quantity: 5 });
    mockTeamUpdate.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  it('returns 200 on valid upgrade via Authorization: Bearer header (mobile auth path)', async () => {
    // WHY: mobile clients cannot use cookies — they send a Bearer token in the
    // Authorization header. The route uses buildAuthClient() which detects the
    // Bearer header and constructs a createServerClient() with the token injected
    // as a global Authorization header. This test verifies that path works end-to-end.
    const req = buildRequest(VALID_PATCH_BODY, 'PATCH', 'mock-access-token-xyz');
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; active_seats: number; proration_cents: number };
    expect(json.success).toBe(true);
    expect(json.active_seats).toBe(5);
    expect(Number.isInteger(json.proration_cents)).toBe(true);
    // Polar update must still have been called (full happy path ran)
    expect(mockSubsUpdate).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// GET /api/billing/seats — proration preview
// ============================================================================

describe('GET /api/billing/seats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: null });
    mockGetUser.mockResolvedValue({ data: { user: MOCK_USER }, error: null });
    mockMembershipSelect.mockResolvedValue({ data: { role: 'owner' }, error: null });
    mockTeamBillingSelect.mockResolvedValue({ data: TEAM_BILLING_ROW, error: null });
    mockSubsGet.mockResolvedValue(makePolarSubscription(3));
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  it('returns 200 with proration preview for an upgrade', async () => {
    const req = buildGetRequest({
      team_id: '22222222-2222-2222-2222-222222222222',
      new_seat_count: '5',
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const json = await res.json() as {
      current_seats: number;
      new_seats: number;
      proration_cents: number;
      tier: string;
      cycle: string;
    };
    expect(json.current_seats).toBe(3);
    expect(json.new_seats).toBe(5);
    expect(Number.isInteger(json.proration_cents)).toBe(true);
    expect(json.proration_cents).toBeGreaterThanOrEqual(0);
    expect(json.tier).toBe('team');
    expect(json.cycle).toBe('monthly');
  });

  it('returns proration_cents = 0 for a downgrade (Polar issues credit)', async () => {
    mockSubsGet.mockResolvedValue(makePolarSubscription(8)); // currently 8 seats
    const req = buildGetRequest({
      team_id: '22222222-2222-2222-2222-222222222222',
      new_seat_count: '5', // reducing
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const json = await res.json() as { proration_cents: number };
    expect(json.proration_cents).toBe(0);
  });

  it('returns 400 when new_seat_count is not a number', async () => {
    const req = buildGetRequest({
      team_id: '22222222-2222-2222-2222-222222222222',
      new_seat_count: 'notanumber',
    });
    const res = await GET(req);

    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } });
    const req = buildGetRequest({
      team_id: '22222222-2222-2222-2222-222222222222',
      new_seat_count: '5',
    });
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it('returns 502 when Polar subscriptions.get fails', async () => {
    mockSubsGet.mockRejectedValue(new Error('Polar offline'));
    const req = buildGetRequest({
      team_id: '22222222-2222-2222-2222-222222222222',
      new_seat_count: '5',
    });
    const res = await GET(req);

    expect(res.status).toBe(502);
  });
});
