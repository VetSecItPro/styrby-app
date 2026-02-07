/**
 * Team Detail API Route Integration Tests
 *
 * Tests GET, PATCH, DELETE /api/teams/[id]
 *
 * WHY: These routes gate access to individual team data and allow owners
 * to modify or delete teams. Bugs here could leak team data to non-members,
 * let non-owners rename/delete teams (authorization bypass), or fail to
 * cascade-delete associated records. The RouteContext with async params
 * is a Next.js 15 pattern that is easy to get wrong in tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();
const mockRpc = vi.fn();

/**
 * Tracks sequential .from() call results.
 * Each call to supabase.from() shifts the next result from this queue.
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase query builder mock.
 */
function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'lte', 'order', 'limit', 'insert', 'update',
    'delete', 'is', 'not', 'in',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => createChainMock()),
    rpc: mockRpc,
  })),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 29 })),
  RATE_LIMITS: {
    budgetAlerts: { windowMs: 60000, maxRequests: 30 },
    sensitive: { windowMs: 60000, maxRequests: 10 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

import { GET, PATCH, DELETE } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const TEAM_ID = 'team-uuid-abc';
const AUTH_USER = { id: 'user-uuid-123', email: 'owner@example.com' };
const OTHER_USER = { id: 'user-uuid-456', email: 'member@example.com' };

function createRouteContext(id: string = TEAM_ID) {
  return { params: Promise.resolve({ id }) };
}

function createNextRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/teams/${TEAM_ID}`, {
    method: body ? 'PATCH' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function mockAuthenticated(user = AUTH_USER) {
  mockGetUser.mockResolvedValue({
    data: { user },
    error: null,
  });
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: null },
    error: { message: 'Not authenticated' },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('Team Detail API — /api/teams/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('GET returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest();
      const response = await GET(req, createRouteContext());
      expect(response.status).toBe(401);
    });

    it('PATCH returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest({ name: 'Updated' });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(401);
    });

    it('DELETE returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest();
      const response = await DELETE(req, createRouteContext());
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/teams/[id]
  // --------------------------------------------------------------------------

  describe('GET /api/teams/[id]', () => {
    it('returns 404 when team not found (PGRST116)', async () => {
      mockAuthenticated();

      // teams.select('*').eq('id', teamId).single() => not found
      fromCallQueue.push({
        data: null,
        error: { code: 'PGRST116', message: 'Not found' },
      });

      const req = createNextRequest();
      const response = await GET(req, createRouteContext());
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toContain('not found');
    });

    it('returns team with members and pending invitations for owner', async () => {
      mockAuthenticated();

      // 1. teams.select('*').eq().single() => team data
      fromCallQueue.push({
        data: {
          id: TEAM_ID,
          name: 'Alpha Team',
          description: 'The best team',
          owner_id: AUTH_USER.id,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-02T00:00:00Z',
        },
        error: null,
      });

      // 2. rpc('get_team_members', { p_team_id }) => member list
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            member_id: 'mem-1',
            user_id: AUTH_USER.id,
            role: 'owner',
            display_name: 'Owner Person',
            email: AUTH_USER.email,
            avatar_url: null,
            joined_at: '2025-01-01T00:00:00Z',
          },
          {
            member_id: 'mem-2',
            user_id: OTHER_USER.id,
            role: 'member',
            display_name: 'Member Person',
            email: OTHER_USER.email,
            avatar_url: null,
            joined_at: '2025-01-03T00:00:00Z',
          },
        ],
        error: null,
      });

      // 3. team_invitations.select().eq().eq().order() => pending invites (owner sees these)
      fromCallQueue.push({
        data: [
          {
            id: 'inv-1',
            email: 'invited@example.com',
            role: 'member',
            created_at: '2025-01-04T00:00:00Z',
            expires_at: '2025-01-11T00:00:00Z',
          },
        ],
        error: null,
      });

      const req = createNextRequest();
      const response = await GET(req, createRouteContext());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.team.id).toBe(TEAM_ID);
      expect(body.team.name).toBe('Alpha Team');
      expect(body.members).toHaveLength(2);
      expect(body.members[0].role).toBe('owner');
      expect(body.currentUserRole).toBe('owner');
      expect(body.pendingInvitations).toHaveLength(1);
      expect(body.pendingInvitations[0].email).toBe('invited@example.com');
    });

    it('returns team with members and pending invitations for admin', async () => {
      // WHY: Admins should also see pending invitations so they can manage
      // invites they sent. Only regular members are excluded.
      const adminUser = { id: 'admin-uuid-789', email: 'admin@example.com' };
      mockAuthenticated(adminUser);

      // 1. team data
      fromCallQueue.push({
        data: {
          id: TEAM_ID,
          name: 'Alpha Team',
          description: null,
          owner_id: AUTH_USER.id,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
        error: null,
      });

      // 2. rpc members — admin user is 'admin' role
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            member_id: 'mem-1',
            user_id: AUTH_USER.id,
            role: 'owner',
            display_name: 'Owner',
            email: AUTH_USER.email,
            avatar_url: null,
            joined_at: '2025-01-01T00:00:00Z',
          },
          {
            member_id: 'mem-3',
            user_id: adminUser.id,
            role: 'admin',
            display_name: 'Admin',
            email: adminUser.email,
            avatar_url: null,
            joined_at: '2025-01-02T00:00:00Z',
          },
        ],
        error: null,
      });

      // 3. pending invitations — admin can see these
      fromCallQueue.push({
        data: [
          {
            id: 'inv-2',
            email: 'pending@example.com',
            role: 'member',
            created_at: '2025-01-05T00:00:00Z',
            expires_at: '2025-01-12T00:00:00Z',
          },
        ],
        error: null,
      });

      const req = createNextRequest();
      const response = await GET(req, createRouteContext());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.currentUserRole).toBe('admin');
      expect(body.pendingInvitations).toHaveLength(1);
    });

    it('returns team without pending invitations for regular member', async () => {
      // WHY: Regular members should not see pending invitations — that is
      // admin-level info. The pendingInvitations array should be empty.
      mockAuthenticated(OTHER_USER);

      // 1. team data
      fromCallQueue.push({
        data: {
          id: TEAM_ID,
          name: 'Alpha Team',
          description: null,
          owner_id: AUTH_USER.id,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
        error: null,
      });

      // 2. rpc members — OTHER_USER is 'member' role
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            member_id: 'mem-1',
            user_id: AUTH_USER.id,
            role: 'owner',
            display_name: 'Owner',
            email: AUTH_USER.email,
            avatar_url: null,
            joined_at: '2025-01-01T00:00:00Z',
          },
          {
            member_id: 'mem-2',
            user_id: OTHER_USER.id,
            role: 'member',
            display_name: 'Member',
            email: OTHER_USER.email,
            avatar_url: null,
            joined_at: '2025-01-03T00:00:00Z',
          },
        ],
        error: null,
      });

      // No pending invitations query should be made for a regular member,
      // but the empty array is the expected output if it does execute.

      const req = createNextRequest();
      const response = await GET(req, createRouteContext());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.currentUserRole).toBe('member');
      expect(body.pendingInvitations).toHaveLength(0);
    });

    it('returns 500 when rpc get_team_members fails', async () => {
      mockAuthenticated();

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. rpc fails
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'RPC failure' },
      });

      const req = createNextRequest();
      const response = await GET(req, createRouteContext());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch team members');
    });
  });

  // --------------------------------------------------------------------------
  // PATCH /api/teams/[id]
  // --------------------------------------------------------------------------

  describe('PATCH /api/teams/[id]', () => {
    it('rejects invalid name (over 100 chars)', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: 'N'.repeat(101) });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('100 characters');
    });

    it('rejects description over 500 chars', async () => {
      mockAuthenticated();
      const req = createNextRequest({ description: 'D'.repeat(501) });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(400);
    });

    it('returns 404 when team not found', async () => {
      mockAuthenticated();

      // teams.select('owner_id').eq().single() => not found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest({ name: 'Updated' });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Team not found');
    });

    it('returns 403 when non-owner tries to update', async () => {
      mockAuthenticated(OTHER_USER);

      // teams.select('owner_id').eq().single() => owned by someone else
      fromCallQueue.push({
        data: { owner_id: AUTH_USER.id },
        error: null,
      });

      const req = createNextRequest({ name: 'Hijacked' });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('owner');
    });

    it('returns 400 when no fields to update', async () => {
      mockAuthenticated();

      // WHY: Sending an empty body (no name or description) should not trigger
      // a database update. The route validates that at least one field is present.
      fromCallQueue.push({
        data: { owner_id: AUTH_USER.id },
        error: null,
      });

      const req = createNextRequest({});
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('No fields');
    });

    it('updates team name successfully', async () => {
      mockAuthenticated();

      // 1. team lookup => found, owned by user
      fromCallQueue.push({
        data: { owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. update().eq().select().single() => updated team
      fromCallQueue.push({
        data: {
          id: TEAM_ID,
          name: 'Renamed Team',
          description: null,
          owner_id: AUTH_USER.id,
          updated_at: '2025-06-02T00:00:00Z',
        },
        error: null,
      });

      const req = createNextRequest({ name: 'Renamed Team' });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.team.name).toBe('Renamed Team');
    });

    it('updates description to null (clear it)', async () => {
      mockAuthenticated();

      // 1. team lookup
      fromCallQueue.push({
        data: { owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. update with null description
      fromCallQueue.push({
        data: {
          id: TEAM_ID,
          name: 'Team',
          description: null,
          owner_id: AUTH_USER.id,
        },
        error: null,
      });

      const req = createNextRequest({ description: null });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.team.description).toBeNull();
    });

    it('returns 500 when update fails', async () => {
      mockAuthenticated();

      fromCallQueue.push({
        data: { owner_id: AUTH_USER.id },
        error: null,
      });

      fromCallQueue.push({
        data: null,
        error: { message: 'Update failed' },
      });

      const req = createNextRequest({ name: 'Updated' });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to update team');
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /api/teams/[id]
  // --------------------------------------------------------------------------

  describe('DELETE /api/teams/[id]', () => {
    it('returns 404 when team not found', async () => {
      mockAuthenticated();

      // teams.select('owner_id').eq().single() => not found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest();
      const response = await DELETE(req, createRouteContext());
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Team not found');
    });

    it('returns 403 when non-owner tries to delete', async () => {
      mockAuthenticated(OTHER_USER);

      fromCallQueue.push({
        data: { owner_id: AUTH_USER.id },
        error: null,
      });

      const req = createNextRequest();
      const response = await DELETE(req, createRouteContext());
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('owner');
    });

    it('deletes team successfully (CASCADE)', async () => {
      mockAuthenticated();

      // 1. team lookup => found, owned by user
      fromCallQueue.push({
        data: { owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. delete().eq() => success
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest();
      const response = await DELETE(req, createRouteContext());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it('returns 500 when delete fails', async () => {
      mockAuthenticated();

      fromCallQueue.push({
        data: { owner_id: AUTH_USER.id },
        error: null,
      });

      fromCallQueue.push({
        data: null,
        error: { message: 'Delete failed' },
      });

      const req = createNextRequest();
      const response = await DELETE(req, createRouteContext());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to delete team');
    });
  });
});
