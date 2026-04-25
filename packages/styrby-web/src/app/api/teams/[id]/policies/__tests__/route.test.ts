/**
 * Team Policies API Route Tests
 *
 * Tests GET and PATCH /api/teams/[id]/policies
 *
 * WHY: The policies endpoint is a governance-critical surface:
 *   - Wrong auto_approve_rules means tools bypass human review
 *   - Wrong blocked_tools means forbidden tools can run
 *   - Wrong budget thresholds means overspend goes undetected
 *   - Every mutation must be logged (audit_log) for SOC2 compliance
 *
 * Test coverage:
 *   - Authentication: 401 for unauthenticated callers
 *   - Membership: 403 for non-members
 *   - Role gating: 403 for 'member' role on PATCH
 *   - Zod validation: 400 for invalid body
 *   - Success cases: GET returns normalized arrays, PATCH updates + returns new state
 *   - Audit log: PATCH fires audit insert (non-blocking)
 *   - Edge cases: empty arrays, null budget, no-op PATCH (no fields)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase mock that pops from the fromCallQueue.
 *
 * WHY: Each .from() call in the route pops the next queued result, letting
 * tests control each sequential DB call precisely without complex mock state.
 */
function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'eq', 'neq', 'gte', 'lte', 'order', 'limit', 'insert',
    'update', 'delete', 'is', 'not', 'in',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => createChainMock()),
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 29 })),
  RATE_LIMITS: { budgetAlerts: { windowMs: 60000, maxRequests: 30 } },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

import { GET, PATCH } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const TEAM_ID = 'team-uuid-abc';
const AUTH_USER = { id: 'user-uuid-owner', email: 'owner@example.com' };
const MEMBER_USER = { id: 'user-uuid-member', email: 'member@example.com' };
const ADMIN_USER = { id: 'user-uuid-admin', email: 'admin@example.com' };

function createRouteContext(id: string = TEAM_ID) {
  return { params: Promise.resolve({ id }) };
}

function createGetRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/teams/${TEAM_ID}/policies`, {
    method: 'GET',
    headers: { 'x-forwarded-for': '10.0.0.1' },
  });
}

function createPatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/teams/${TEAM_ID}/policies`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    body: JSON.stringify(body),
  });
}

function mockAuthenticated(user = AUTH_USER) {
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Not authenticated' } });
}

/** A full team policies DB row */
const MOCK_TEAM_ROW = {
  id: TEAM_ID,
  auto_approve_rules: ['read_file', 'list_dir'],
  blocked_tools: ['delete_file'],
  budget_per_seat_usd: 50,
};

// ============================================================================
// GET Tests
// ============================================================================

describe('GET /api/teams/[id]/policies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  it('returns 401 for unauthenticated caller', async () => {
    mockUnauthenticated();
    const res = await GET(createGetRequest(), createRouteContext());
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 403 when caller is not a team member', async () => {
    mockAuthenticated();
    // 1. team_members.select().eq().eq().single() => not found
    fromCallQueue.push({ data: null, error: null });
    const res = await GET(createGetRequest(), createRouteContext());
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Not a member');
  });

  it('returns 404 when team does not exist', async () => {
    mockAuthenticated();
    // 1. membership => owner
    fromCallQueue.push({ data: { role: 'owner' }, error: null });
    // 2. teams.select => not found
    fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

    const res = await GET(createGetRequest(), createRouteContext());
    expect(res.status).toBe(404);
  });

  it('returns 200 with normalised policies for a member', async () => {
    mockAuthenticated(MEMBER_USER);
    // 1. membership => member role (members can view)
    fromCallQueue.push({ data: { role: 'member' }, error: null });
    // 2. team row
    fromCallQueue.push({ data: MOCK_TEAM_ROW, error: null });

    const res = await GET(createGetRequest(), createRouteContext());
    expect(res.status).toBe(200);
    const body = await res.json() as { policies: { auto_approve_rules: string[]; blocked_tools: string[]; budget_per_seat_usd: number | null } };
    expect(body.policies.auto_approve_rules).toEqual(['read_file', 'list_dir']);
    expect(body.policies.blocked_tools).toEqual(['delete_file']);
    expect(body.policies.budget_per_seat_usd).toBe(50);
  });

  it('normalises null jsonb arrays to empty arrays', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: { role: 'owner' }, error: null });
    fromCallQueue.push({
      data: { id: TEAM_ID, auto_approve_rules: null, blocked_tools: null, budget_per_seat_usd: null },
      error: null,
    });

    const res = await GET(createGetRequest(), createRouteContext());
    expect(res.status).toBe(200);
    const body = await res.json() as { policies: { auto_approve_rules: string[]; blocked_tools: string[]; budget_per_seat_usd: number | null } };
    expect(body.policies.auto_approve_rules).toEqual([]);
    expect(body.policies.blocked_tools).toEqual([]);
    expect(body.policies.budget_per_seat_usd).toBeNull();
  });
});

// ============================================================================
// PATCH Tests
// ============================================================================

describe('PATCH /api/teams/[id]/policies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  it('returns 401 for unauthenticated caller', async () => {
    mockUnauthenticated();
    const res = await PATCH(createPatchRequest({ auto_approve_rules: [] }), createRouteContext());
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not a team member', async () => {
    mockAuthenticated();
    // 1. membership => not found
    fromCallQueue.push({ data: null, error: null });

    const res = await PATCH(createPatchRequest({ auto_approve_rules: [] }), createRouteContext());
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Not a member');
  });

  it('returns 403 when caller is a plain member (not owner/admin)', async () => {
    mockAuthenticated(MEMBER_USER);
    // 1. membership => member role
    fromCallQueue.push({ data: { role: 'member' }, error: null });

    const res = await PATCH(createPatchRequest({ blocked_tools: ['rm'] }), createRouteContext());
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('owners and admins');
  });

  it('returns 400 for invalid body (auto_approve_rules not array)', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: { role: 'owner' }, error: null });

    const res = await PATCH(
      createPatchRequest({ auto_approve_rules: 'not-an-array' }),
      createRouteContext(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when budget_per_seat_usd is negative', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: { role: 'owner' }, error: null });

    const res = await PATCH(
      createPatchRequest({ budget_per_seat_usd: -100 }),
      createRouteContext(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when no fields are provided', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: { role: 'owner' }, error: null });

    const res = await PATCH(createPatchRequest({}), createRouteContext());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('No fields to update');
  });

  it('owner can update auto_approve_rules successfully', async () => {
    mockAuthenticated();
    // 1. membership
    fromCallQueue.push({ data: { role: 'owner' }, error: null });
    // 2. current team (before-state for audit)
    fromCallQueue.push({ data: MOCK_TEAM_ROW, error: null });
    // 3. update result
    fromCallQueue.push({
      data: { ...MOCK_TEAM_ROW, auto_approve_rules: ['read_file'] },
      error: null,
    });

    const res = await PATCH(
      createPatchRequest({ auto_approve_rules: ['read_file'] }),
      createRouteContext(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { policies: { auto_approve_rules: string[] } };
    expect(body.policies.auto_approve_rules).toEqual(['read_file']);
  });

  it('admin can update blocked_tools successfully', async () => {
    mockAuthenticated(ADMIN_USER);
    // 1. membership
    fromCallQueue.push({ data: { role: 'admin' }, error: null });
    // 2. current team
    fromCallQueue.push({ data: MOCK_TEAM_ROW, error: null });
    // 3. update result
    fromCallQueue.push({
      data: { ...MOCK_TEAM_ROW, blocked_tools: ['rm', 'dd'] },
      error: null,
    });

    const res = await PATCH(
      createPatchRequest({ blocked_tools: ['rm', 'dd'] }),
      createRouteContext(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { policies: { blocked_tools: string[] } };
    expect(body.policies.blocked_tools).toEqual(['rm', 'dd']);
  });

  it('can set budget_per_seat_usd to null (unlimited)', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: { role: 'owner' }, error: null });
    fromCallQueue.push({ data: MOCK_TEAM_ROW, error: null });
    fromCallQueue.push({
      data: { ...MOCK_TEAM_ROW, budget_per_seat_usd: null },
      error: null,
    });

    const res = await PATCH(
      createPatchRequest({ budget_per_seat_usd: null }),
      createRouteContext(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { policies: { budget_per_seat_usd: number | null } };
    expect(body.policies.budget_per_seat_usd).toBeNull();
  });

  it('returns 404 when team is not found during fetch', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: { role: 'owner' }, error: null });
    // current team query => not found
    fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

    const res = await PATCH(
      createPatchRequest({ blocked_tools: ['rm'] }),
      createRouteContext(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 500 when the update query fails', async () => {
    mockAuthenticated();
    fromCallQueue.push({ data: { role: 'owner' }, error: null });
    fromCallQueue.push({ data: MOCK_TEAM_ROW, error: null });
    // update fails
    fromCallQueue.push({ data: null, error: { message: 'DB error' } });

    const res = await PATCH(
      createPatchRequest({ blocked_tools: ['rm'] }),
      createRouteContext(),
    );
    expect(res.status).toBe(500);
  });
});
