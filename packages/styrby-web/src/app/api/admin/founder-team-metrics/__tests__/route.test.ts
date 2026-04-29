/**
 * Unit tests for the founder-team-metrics API route.
 *
 * WHY: The route sits behind two critical access gates — authentication and
 * the is_admin flag. A regression in either would expose cross-team business
 * intelligence (member counts, churn, subscription tiers) to non-admin users.
 * These tests verify the gates fire before any DB query runs.
 *
 * We also validate the happy-path aggregation logic to ensure churn detection,
 * average team size, and per-team summaries compute correctly given controlled
 * mock data.
 *
 * Boundary testing pattern: mock Supabase client; assert HTTP responses only.
 *
 * @module api/admin/founder-team-metrics/__tests__/route
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock('@/lib/admin', () => ({
  isAdmin: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: null }),
  rateLimitResponse: vi.fn(
    (retryAfter: number) =>
      new Response(JSON.stringify({ error: 'RATE_LIMITED', retryAfter }), { status: 429 }),
  ),
  RATE_LIMITS: {
    sensitive: { windowMs: 60_000, maxRequests: 10 },
    standard: { windowMs: 60_000, maxRequests: 20 },
  },
}));

// WHY mock mfa-gate (H42 Layer 1): the route calls assertAdminMfa(user.id) after
// the isAdmin check. Without this mock the real gate queries the passkeys table
// via createAdminClient which is not set up in the unit test environment.
// Gate behaviour is covered by src/lib/admin/__tests__/mfa-gate.test.ts.
// OWASP A07:2021, SOC 2 CC6.1.
vi.mock('@/lib/admin/mfa-gate', () => ({
  assertAdminMfa: vi.fn().mockResolvedValue(undefined),
  AdminMfaRequiredError: class AdminMfaRequiredError extends Error {
    statusCode = 403 as const;
    code = 'ADMIN_MFA_REQUIRED' as const;
    constructor() {
      super('Admin MFA required');
      this.name = 'AdminMfaRequiredError';
    }
  },
}));

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { rateLimit } from '@/lib/rateLimit';
import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';
import { GET } from '../route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(): Request {
  return new Request('http://localhost/api/admin/founder-team-metrics');
}

/**
 * Configures the user-scoped Supabase client mock.
 *
 * @param user - Authenticated user, or null to simulate no session
 */
function mockSupabaseUser(user: { id: string } | null) {
  (createClient as Mock).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user },
        error: user ? null : new Error('Not authenticated'),
      }),
    },
  });
}

/**
 * Builds a chainable Supabase admin mock for a sequence of from() calls.
 *
 * Each call to adminDb.from(tableName) dequeues the next pre-configured
 * response. The builder is thenable (awaitable at any chain depth) so it
 * works regardless of whether the route ends the chain at .select(), .eq(),
 * .gte(), or .order().
 *
 * WHY thenable builder: Supabase query builders implement PromiseLike, so
 * the route awaits them at whatever method terminates the chain. Our mock
 * must do the same — every builder method returns `this`, and `then` carries
 * the pre-configured response.
 *
 * Queue order matches the route's Promise.all() sequence:
 *   0: teams (.select().order())
 *   1: team_members (.select())
 *   2: subscriptions (.select().eq())
 *   3: audit_log (.select().eq().gte())
 *
 * @param queue - Array of { data, error } objects in call order
 */
function mockAdminClient(
  queue: { data: unknown; error: null | { message: string } }[],
) {
  let callIndex = 0;

  (createAdminClient as Mock).mockReturnValue({
    from: vi.fn().mockImplementation(() => {
      const response = queue[callIndex++] ?? { data: [], error: null };

      // WHY: make the builder a PromiseLike so it resolves when awaited at
      // any terminal method, not just .order(). This mirrors the real Supabase
      // PostgREST builder which is itself a PromiseLike.
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        then: (
          resolve: (value: typeof response) => unknown,
          _reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(response).then(resolve, _reject),
      };

      return builder;
    }),
  });
}

// ---------------------------------------------------------------------------
// Reusable mock data
// ---------------------------------------------------------------------------

const TEAMS = [
  { id: 'team-1', name: 'Alpha Squad', owner_id: 'owner-1', created_at: '2026-01-01T00:00:00Z' },
  { id: 'team-2', name: 'Beta Corps', owner_id: 'owner-2', created_at: '2026-02-01T00:00:00Z' },
];

const MEMBER_ROWS = [
  { team_id: 'team-1' },
  { team_id: 'team-1' },
  { team_id: 'team-1' },
  { team_id: 'team-2' },
  { team_id: 'team-2' },
];

const SUBSCRIPTIONS = [
  { user_id: 'owner-1', tier: 'team' },
  { user_id: 'owner-2', tier: 'power' },
];

const NO_CHURN: { resource_id: string }[] = [];

// ---------------------------------------------------------------------------
// Auth + rate-limit gates
// ---------------------------------------------------------------------------

describe('GET /api/admin/founder-team-metrics — access gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY: clearAllMocks resets mockResolvedValue set in the module vi.mock() factory;
    // re-establish the default allow behavior before each test.
    (rateLimit as Mock).mockResolvedValue({ allowed: true, retryAfter: null });
  });

  it('returns 401 when user is not authenticated', async () => {
    mockSupabaseUser(null);
    (isAdmin as Mock).mockResolvedValue(false);

    const res = await GET(makeRequest() as never);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 403 when user is authenticated but not admin', async () => {
    mockSupabaseUser({ id: 'user-123' });
    (isAdmin as Mock).mockResolvedValue(false);

    const res = await GET(makeRequest() as never);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('returns 429 when rate limited', async () => {
    (rateLimit as Mock).mockResolvedValue({ allowed: false, retryAfter: 30 });

    const res = await GET(makeRequest() as never);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('RATE_LIMITED');
  });

  it('does not call createAdminClient for non-admin users', async () => {
    mockSupabaseUser({ id: 'attacker' });
    (isAdmin as Mock).mockResolvedValue(false);

    await GET(makeRequest() as never);

    // WHY: Service-role client must never run for non-admins; prevents privilege escalation.
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('does not call createAdminClient when unauthenticated', async () => {
    mockSupabaseUser(null);
    (isAdmin as Mock).mockResolvedValue(false);

    await GET(makeRequest() as never);

    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy-path aggregation
// ---------------------------------------------------------------------------

describe('GET /api/admin/founder-team-metrics — aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (rateLimit as Mock).mockResolvedValue({ allowed: true, retryAfter: null });
    mockSupabaseUser({ id: 'admin-user' });
    (isAdmin as Mock).mockResolvedValue(true);
  });

  /**
   * Mounts the admin client with a fixed queue matching the route's
   * Promise.all() call order: teams → team_members → subscriptions → audit_log.
   *
   * WHY this ordering matters: the route calls these four queries in parallel
   * but the mock dequeues based on call order of .from(). The test assertions
   * must match the implementation's query sequence.
   */
  function setupSuccessQueue(overrides: {
    teams?: typeof TEAMS;
    members?: typeof MEMBER_ROWS;
    subs?: typeof SUBSCRIPTIONS;
    churn?: typeof NO_CHURN;
  } = {}) {
    mockAdminClient([
      { data: overrides.teams ?? TEAMS, error: null },
      { data: overrides.members ?? MEMBER_ROWS, error: null },
      { data: overrides.subs ?? SUBSCRIPTIONS, error: null },
      { data: overrides.churn ?? NO_CHURN, error: null },
    ]);
  }

  it('returns 200 with correct top-level counts', async () => {
    setupSuccessQueue();

    const res = await GET(makeRequest() as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team_count).toBe(2);
    // 3 members in team-1, 2 in team-2 → total 5, avg 2.5
    expect(body.avg_team_size).toBe(2.5);
    expect(body.churned_teams_30d).toBe(0);
    expect(body.churn_rate_per_team_30d).toBe(0);
  });

  it('includes per-team summaries with correct member counts', async () => {
    setupSuccessQueue();

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    expect(body.teams).toHaveLength(2);
    const alpha = body.teams.find((t: { team_name: string }) => t.team_name === 'Alpha Squad');
    const beta = body.teams.find((t: { team_name: string }) => t.team_name === 'Beta Corps');

    expect(alpha.member_count).toBe(3);
    expect(alpha.owner_tier).toBe('team');
    expect(alpha.had_churn_30d).toBe(false);

    expect(beta.member_count).toBe(2);
    expect(beta.owner_tier).toBe('power');
    expect(beta.had_churn_30d).toBe(false);
  });

  it('flags teams that had churn in last 30d', async () => {
    setupSuccessQueue({
      churn: [{ resource_id: 'team-1' }],
    });

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    expect(body.churned_teams_30d).toBe(1);
    // 1 churned out of 2 teams = 0.5
    expect(body.churn_rate_per_team_30d).toBe(0.5);

    const alpha = body.teams.find((t: { team_name: string }) => t.team_name === 'Alpha Squad');
    const beta = body.teams.find((t: { team_name: string }) => t.team_name === 'Beta Corps');
    expect(alpha.had_churn_30d).toBe(true);
    expect(beta.had_churn_30d).toBe(false);
  });

  it('returns churn_rate_per_team_30d = null when there are no teams', async () => {
    setupSuccessQueue({
      teams: [],
      members: [],
      subs: [],
      churn: [],
    });

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    expect(body.team_count).toBe(0);
    expect(body.avg_team_size).toBe(0);
    expect(body.churn_rate_per_team_30d).toBeNull();
    expect(body.teams).toHaveLength(0);
  });

  it('defaults owner_tier to "free" when owner has no active subscription', async () => {
    setupSuccessQueue({
      subs: [], // no active subscriptions
    });

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    for (const team of body.teams) {
      expect(team.owner_tier).toBe('free');
    }
  });

  it('defaults member_count to 0 for teams with no members', async () => {
    setupSuccessQueue({
      members: [], // no members at all
    });

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    for (const team of body.teams) {
      expect(team.member_count).toBe(0);
    }
    expect(body.avg_team_size).toBe(0);
  });

  it('rounds avg_team_size to 2 decimal places', async () => {
    // 3 teams, 1 member each + 1 extra = 4 total → 4/3 = 1.333...
    setupSuccessQueue({
      teams: [
        { id: 't1', name: 'T1', owner_id: 'o1', created_at: '2026-01-01T00:00:00Z' },
        { id: 't2', name: 'T2', owner_id: 'o2', created_at: '2026-01-01T00:00:00Z' },
        { id: 't3', name: 'T3', owner_id: 'o3', created_at: '2026-01-01T00:00:00Z' },
      ],
      members: [
        { team_id: 't1' },
        { team_id: 't2' },
        { team_id: 't3' },
        { team_id: 't1' }, // extra for t1
      ],
    });

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    // 4 members / 3 teams = 1.3333... → rounds to 1.33
    expect(body.avg_team_size).toBe(1.33);
  });

  it('includes computed_at as a valid ISO 8601 timestamp', async () => {
    setupSuccessQueue();

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    expect(typeof body.computed_at).toBe('string');
    expect(() => new Date(body.computed_at).toISOString()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('GET /api/admin/founder-team-metrics — error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (rateLimit as Mock).mockResolvedValue({ allowed: true, retryAfter: null });
    mockSupabaseUser({ id: 'admin-user' });
    (isAdmin as Mock).mockResolvedValue(true);
  });

  it('returns 500 when createAdminClient throws', async () => {
    (createAdminClient as Mock).mockImplementation(() => {
      throw new Error('DB connection refused');
    });

    const res = await GET(makeRequest() as never);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
  });

  // ── MFA gate wiring (H42 Layer 1) ───────────────────────────────────────────

  // WHY: proves the route calls assertAdminMfa and short-circuits to 403 when
  // the gate throws AdminMfaRequiredError — DB queries must not run on gate failure.
  // OWASP A07:2021, SOC 2 CC6.1.
  it('(MFA gate) returns 403 ADMIN_MFA_REQUIRED and skips DB queries when assertAdminMfa throws', async () => {
    mockSupabaseUser({ id: 'admin-1' });
    (isAdmin as import('vitest').Mock).mockResolvedValue(true);
    (assertAdminMfa as import('vitest').Mock).mockRejectedValueOnce(new AdminMfaRequiredError());

    const res = await GET(makeRequest() as never);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('ADMIN_MFA_REQUIRED');
    // The admin DB client must not have been used.
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
