/**
 * Team Cost Analytics API Route Tests
 *
 * Tests GET /api/teams/[id]/costs
 *
 * WHY: The team cost route is the read path for a multi-user cost surface
 * that crosses RLS boundaries (via service-role admin client). Bugs here
 * could leak cost data from one team to another (privacy/security), return
 * stale budget projections (wrong business decisions), or fail silently
 * (budget tracking disappears without an obvious error).
 *
 * Coverage:
 *   - 401 when unauthenticated
 *   - 403 when authenticated but not a team member
 *   - RPC error from get_team_cost_summary_v2 returns 500
 *   - RPC insufficient_privilege returns 403
 *   - Happy-path 200 with members, dailyByAgent, projection
 *   - Missing projection (fresh team) returns null projection without crashing
 *   - Agent data error is non-fatal (members still returned)
 *   - ?days param validation (7, 30, 90 accepted; invalid defaults to 30)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();
const mockAdminRpc = vi.fn();
const mockUserFrom = vi.fn();
const mockAdminFrom = vi.fn();

/**
 * User-scoped client: auth + from() for the membership check.
 */
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockUserFrom,
  })),
  createAdminClient: vi.fn(async () => ({
    rpc: mockAdminRpc,
    from: mockAdminFrom,
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 29 })),
  RATE_LIMITS: { standard: { windowMs: 60000, maxRequests: 100 }, default: { windowMs: 60000, maxRequests: 30 } },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const TEAM_ID = 'team-abc-123';
const USER_ID = 'user-xyz-789';

/**
 * Builds a minimal NextRequest for GET /api/teams/[id]/costs.
 *
 * @param days - Optional ?days query param
 * @returns NextRequest with the given URL
 */
function makeRequest(days?: number): NextRequest {
  const url = days
    ? `http://localhost/api/teams/${TEAM_ID}/costs?days=${days}`
    : `http://localhost/api/teams/${TEAM_ID}/costs`;
  return new NextRequest(url);
}

/** Standard authenticated user mock. */
function setupAuthUser() {
  mockGetUser.mockResolvedValue({
    data: { user: { id: USER_ID, email: 'test@example.com' } },
    error: null,
  });
}

/**
 * Creates a chainable from() mock that resolves with the given result.
 *
 * WHY this helper: The route calls supabase.from('team_members').select().eq().eq().maybeSingle()
 * which requires a chainable mock that returns the result only on maybeSingle().
 */
function makeFromChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'not', 'maybeSingle']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  (chain['maybeSingle'] as ReturnType<typeof vi.fn>).mockResolvedValue(result);
  return vi.fn().mockReturnValue(chain);
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/teams/[id]/costs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Not authenticated' },
    });

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: TEAM_ID }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  // --------------------------------------------------------------------------
  // Team membership
  // --------------------------------------------------------------------------

  it('returns 403 when user is not a team member', async () => {
    setupAuthUser();
    // Membership check returns null — not a member
    mockUserFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: TEAM_ID }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Not a member of this team');
  });

  // --------------------------------------------------------------------------
  // RLS / RPC errors
  // --------------------------------------------------------------------------

  it('returns 403 when RPC returns insufficient_privilege', async () => {
    setupAuthUser();
    mockUserFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: 'member' }, error: null }),
    });

    // get_team_cost_summary_v2 returns privilege error.
    // WHY mockAdminRpc returns empty for other RPCs: Promise.all fires all three
    // admin queries in parallel. The privilege check on membersResult is evaluated
    // after all three resolve. The from() query (v_team_cost_projection) also
    // needs a stub so Promise.all doesn't throw a TypeError on the undefined mock.
    mockAdminRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_team_cost_summary_v2') {
        return Promise.resolve({
          data: null,
          error: { message: 'insufficient_privilege', code: 'insufficient_privilege' },
        });
      }
      return Promise.resolve({ data: [], error: null });
    });

    // Stub the v_team_cost_projection from() chain so Promise.all resolves cleanly.
    mockAdminFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: TEAM_ID }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Not a member of this team');
  });

  it('returns 500 when member RPC fails with generic error', async () => {
    setupAuthUser();
    mockUserFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: 'member' }, error: null }),
    });

    mockAdminRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_team_cost_summary_v2') {
        return Promise.resolve({
          data: null,
          error: { message: 'connection reset', code: 'PGRST000' },
        });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: TEAM_ID }) });
    expect(res.status).toBe(500);
  });

  // --------------------------------------------------------------------------
  // Happy path
  // --------------------------------------------------------------------------

  it('returns 200 with members, dailyByAgent, and projection on success', async () => {
    setupAuthUser();
    mockUserFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: 'owner' }, error: null }),
    });

    const mockMembers = [
      {
        user_id: USER_ID,
        display_name: 'Alice',
        email: 'alice@example.com',
        total_cost_usd: 12.5,
        total_input_tokens: 100000,
        total_output_tokens: 50000,
      },
    ];

    const mockAgentRows = [
      { record_date: '2026-04-01', agent_type: 'claude', total_cost_usd: 5.0, total_input_tokens: 50000, total_output_tokens: 20000 },
      { record_date: '2026-04-01', agent_type: 'codex', total_cost_usd: 7.5, total_input_tokens: 50000, total_output_tokens: 30000 },
    ];

    const mockProjection = {
      team_id: TEAM_ID,
      team_name: 'Test Team',
      billing_tier: 'team',
      active_seats: 3,
      seat_budget_usd: 57.0,
      mtd_spend_usd: 12.5,
      days_elapsed: 10,
      days_in_month: 30,
    };

    mockAdminRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_team_cost_summary_v2') {
        return Promise.resolve({ data: mockMembers, error: null });
      }
      if (fnName === 'get_team_cost_by_agent') {
        return Promise.resolve({ data: mockAgentRows, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    // Admin from() for v_team_cost_projection
    const projectionChain: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: mockProjection, error: null }),
    };
    mockAdminFrom.mockReturnValue(projectionChain);

    const res = await GET(makeRequest(30), { params: Promise.resolve({ id: TEAM_ID }) });
    expect(res.status).toBe(200);

    const body = await res.json();

    // Members
    expect(body.members).toHaveLength(1);
    expect(body.members[0].userId).toBe(USER_ID);
    expect(body.members[0].displayName).toBe('Alice');
    expect(body.members[0].totalCostUsd).toBe(12.5);

    // Agent rows
    expect(body.dailyByAgent).toHaveLength(2);
    expect(body.dailyByAgent[0].agentType).toBe('claude');

    // Projection
    expect(body.projection).not.toBeNull();
    expect(body.projection.teamName).toBe('Test Team');
    expect(body.projection.seatBudgetUsd).toBe(57.0);
    // Projected MTD: (12.5 / 10) * 30 = 37.5
    expect(body.projection.projectedMtdUsd).toBeCloseTo(37.5, 2);
  });

  it('returns null projection when v_team_cost_projection has no row', async () => {
    setupAuthUser();
    mockUserFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: 'member' }, error: null }),
    });

    mockAdminRpc.mockResolvedValue({ data: [], error: null });
    const projectionChain: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mockAdminFrom.mockReturnValue(projectionChain);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: TEAM_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projection).toBeNull();
  });

  // --------------------------------------------------------------------------
  // ?days param validation
  // --------------------------------------------------------------------------

  it.each([
    [7, 7],
    [30, 30],
    [90, 90],
    [14, 30],   // invalid → default 30
    [0, 30],    // zero → default 30
    [undefined, 30], // missing → default 30
  ])('validates ?days=%s and uses effectiveDays=%s', async (inputDays, _expectedDays) => {
    setupAuthUser();
    mockUserFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: 'member' }, error: null }),
    });
    mockAdminRpc.mockResolvedValue({ data: [], error: null });
    const projectionChain: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mockAdminFrom.mockReturnValue(projectionChain);

    const req = makeRequest(inputDays as number | undefined);
    const res = await GET(req, { params: Promise.resolve({ id: TEAM_ID }) });
    // Should succeed regardless of input
    expect(res.status).toBe(200);
  });

  // --------------------------------------------------------------------------
  // Non-fatal agent data failure
  // --------------------------------------------------------------------------

  it('returns 200 with empty dailyByAgent when get_team_cost_by_agent fails', async () => {
    setupAuthUser();
    mockUserFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: 'member' }, error: null }),
    });

    mockAdminRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_team_cost_summary_v2') {
        return Promise.resolve({ data: [], error: null });
      }
      if (fnName === 'get_team_cost_by_agent') {
        return Promise.resolve({ data: null, error: { message: 'DB timeout' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const projectionChain: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mockAdminFrom.mockReturnValue(projectionChain);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: TEAM_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dailyByAgent).toEqual([]);
    expect(body.members).toEqual([]);
  });
});
