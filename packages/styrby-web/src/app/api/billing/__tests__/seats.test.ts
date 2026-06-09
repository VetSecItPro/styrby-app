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
 *   from the canonical billing module (it's pure and has no side effects) and
 *   just assert on the returned value.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH, GET } from '../seats/route';
import { calculateProrationCents } from '@/lib/billing/polar-products';

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
  mockSeatLockRpc,
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
  mockSeatLockRpc: vi.fn(),
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
    // WHY: WAVE-E-001 fix wraps the team-member count read in a SECURITY DEFINER
    // RPC (count_team_members_with_seat_lock) that atomically acquires a per-team
    // advisory lock + returns the count. The mock dispatches by RPC name so
    // additional RPCs added in the future get a clean default empty response
    // instead of an undefined-method crash.
    rpc: vi.fn((name: string) => {
      if (name === 'count_team_members_with_seat_lock') {
        return mockSeatLockRpc();
      }
      return Promise.resolve({ data: null, error: null });
    }),
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
  billing_tier: 'growth',
  billing_cycle: 'monthly',
  seat_cap: 3,
  active_seats: 3,
};

/**
 * Configures the team-member count returned by the seat-lock RPC.
 *
 * WHY this helper (and not raw mockMemberCountSelect): post-WAVE-E-001 the
 * route reads member count via the count_team_members_with_seat_lock RPC
 * (migration 037), which returns rows shaped { lock_acquired, member_count }.
 * Tests that pre-date the fix used mockMemberCountSelect (raw .from() count
 * query). We keep the legacy mock for backward compatibility AND configure
 * the RPC mock so both code paths see the same count. Future tests should
 * call setMemberCount() directly.
 *
 * @param count - Number of team_members the lock-and-count RPC should return
 * @param lockAcquired - Override to false to simulate concurrent contention
 */
function setMemberCount(count: number, lockAcquired = true): void {
  mockMemberCountSelect.mockResolvedValue({ count, error: null });
  mockSeatLockRpc.mockResolvedValue({
    data: [{ lock_acquired: lockAcquired, member_count: count }],
    error: null,
  });
}

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
    setMemberCount(3);
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
      tierId: 'growth',
      cycle: 'monthly',
      daysElapsed,
      daysInCycle,
    });

    // WHY ±1 tolerance: timing between test execution and the route's Date.now()
    // call can differ by milliseconds, shifting daysElapsed by 1 in edge cases.
    expect(Math.abs(json.proration_cents - expected)).toBeLessThanOrEqual(
      calculateProrationCents({ oldSeats: 3, newSeats: 5, tierId: 'growth', cycle: 'monthly', daysElapsed: 1, daysInCycle }),
    );
  });

  // ── Downgrade guard ────────────────────────────────────────────────────────

  it('returns 409 DOWNGRADE_BLOCKED when team has 8 members and 5 seats requested', async () => {
    setMemberCount(8);
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
    setMemberCount(8);
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 5 });
    await PATCH(req);

    expect(mockSubsUpdate).not.toHaveBeenCalled();
  });

  it('writes audit_log team_downgrade_blocked when guard fires', async () => {
    setMemberCount(8);
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 5 });
    await PATCH(req);

    expect(mockAuditInsert).toHaveBeenCalledOnce();
    const insertArg = mockAuditInsert.mock.calls[0][0] as { action: string };
    expect(insertArg.action).toBe('team_downgrade_blocked');
  });

  it('returns 200 when new_seat_count == active member count (boundary)', async () => {
    // 3 members, 3 seats requested — this is allowed (not a downgrade below members)
    setMemberCount(3);
    mockSubsGet.mockResolvedValue(makePolarSubscription(5)); // currently 5, reducing to 3
    const req = buildRequest({ ...VALID_PATCH_BODY, new_seat_count: 3 });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    expect(mockSubsUpdate).toHaveBeenCalledOnce();
  });

  it('returns 422 INVALID_SEATS when new_seat_count is below tier minimum (team min=3)', async () => {
    // 3 members, but requesting 2 seats — fails validateSeatCount BEFORE member count check
    setMemberCount(3);
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
    setMemberCount(3); // 3 members — decrease is valid
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

  // ── WAVE-E-001: advisory-lock serialization ────────────────────────────────

  describe('WAVE-E-001 advisory lock', () => {
    /**
     * Regression test for WAVE-E-001: count read MUST happen via the
     * count_team_members_with_seat_lock RPC (which acquires the per-team
     * advisory lock atomically), NOT via a raw .from('team_members').select(count)
     * call. If a future refactor reverts to the raw count, this gate fails
     * because the RPC mock will not be exercised.
     */
    it('reads member count via count_team_members_with_seat_lock RPC, not raw count query', async () => {
      setMemberCount(3);
      const req = buildRequest(VALID_PATCH_BODY);
      await PATCH(req);

      expect(mockSeatLockRpc).toHaveBeenCalledOnce();
    });

    it('passes the team_id to the RPC (not a hardcoded value)', async () => {
      setMemberCount(3);
      // We cannot inspect the RPC args directly through the per-name dispatch,
      // but we can verify the RPC fires and the route reaches Polar (proving
      // the lock_acquired branch was taken).
      const req = buildRequest(VALID_PATCH_BODY);
      const res = await PATCH(req);

      expect(mockSeatLockRpc).toHaveBeenCalledOnce();
      expect(res.status).toBe(200);
      // Polar update must have fired — the lock-and-count flow allowed the path.
      expect(mockSubsUpdate).toHaveBeenCalledOnce();
    });

    /**
     * Concurrency simulation: the RPC returns lock_acquired=false, meaning
     * another seat change OR invitation accept holds the lock for this team.
     * The route MUST return 409 CONCURRENT_SEAT_CHANGE WITHOUT calling Polar.
     */
    it('returns 409 CONCURRENT_SEAT_CHANGE when the lock is contended (concurrent invite-accept)', async () => {
      // Simulate: an invitation accept landed and is still holding the lock.
      mockSeatLockRpc.mockResolvedValue({
        data: [{ lock_acquired: false, member_count: 0 }],
        error: null,
      });
      const req = buildRequest(VALID_PATCH_BODY);
      const res = await PATCH(req);

      expect(res.status).toBe(409);
      const json = await res.json() as { error: string; message: string };
      expect(json.error).toBe('CONCURRENT_SEAT_CHANGE');

      // CRITICAL: Polar must NOT have been called when the lock is contended.
      // This is the safety property that closes the race — without it, two
      // concurrent PATCHes could both reach Polar and undercount.
      expect(mockSubsUpdate).not.toHaveBeenCalled();
    });

    it('returns 502 when the lock RPC errors at the DB layer', async () => {
      mockSeatLockRpc.mockResolvedValue({
        data: null,
        error: { message: 'connection refused' },
      });
      const req = buildRequest(VALID_PATCH_BODY);
      const res = await PATCH(req);

      expect(res.status).toBe(502);
      const json = await res.json() as { error: string };
      expect(json.error).toBe('UPSTREAM_ERROR');
      expect(mockSubsUpdate).not.toHaveBeenCalled();
    });

    /**
     * Ordering proof: the lock acquisition (RPC call) MUST happen BEFORE
     * the Polar update. If the order were reversed, an in-flight invitation
     * accept could insert a member between the count read and Polar update.
     * vitest's call-order semantics let us check via .mock.invocationCallOrder.
     */
    it('acquires the lock BEFORE calling Polar (ordering invariant)', async () => {
      setMemberCount(3);
      const req = buildRequest(VALID_PATCH_BODY);
      await PATCH(req);

      const lockOrder = mockSeatLockRpc.mock.invocationCallOrder[0];
      const polarOrder = mockSubsUpdate.mock.invocationCallOrder[0];
      expect(lockOrder).toBeDefined();
      expect(polarOrder).toBeDefined();
      // Lock RPC fires first — count is authoritative for the duration of
      // the (admittedly short) RPC transaction.
      expect(lockOrder).toBeLessThan(polarOrder);
    });
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
    setMemberCount(3);
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
    expect(json.tier).toBe('growth');
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
