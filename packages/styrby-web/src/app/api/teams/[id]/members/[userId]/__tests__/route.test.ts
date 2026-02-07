/**
 * Team Member Management API Route Integration Tests
 *
 * Tests PATCH and DELETE /api/teams/[id]/members/[userId]
 *
 * WHY: Role changes and member removal have complex tiered permissions:
 * - Only owners can change roles (prevents privilege escalation by admins)
 * - Owners can remove anyone, admins can only remove members, members can
 *   only remove themselves
 * - Owner role cannot be modified or removed (must transfer or delete team)
 *
 * Bugs here could allow privilege escalation (admin promotes self to owner),
 * unauthorized removal (member kicks admin), or orphaning a team (removing
 * the owner). These tests exercise every permission boundary.
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

import { PATCH, DELETE } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const TEAM_ID = 'team-uuid-abc';
const OWNER_USER = { id: 'owner-uuid-111', email: 'owner@example.com' };
const ADMIN_USER = { id: 'admin-uuid-222', email: 'admin@example.com' };
const MEMBER_USER = { id: 'member-uuid-333', email: 'member@example.com' };
const OTHER_MEMBER = { id: 'member-uuid-444', email: 'other@example.com' };

function createRouteContext(
  id: string = TEAM_ID,
  userId: string = MEMBER_USER.id
) {
  return { params: Promise.resolve({ id, userId }) };
}

function createNextRequest(
  body?: Record<string, unknown>,
  method: string = 'PATCH'
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/teams/${TEAM_ID}/members/${MEMBER_USER.id}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '10.0.0.1',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  );
}

function mockAuthenticated(user = OWNER_USER) {
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

describe('Team Member Management API — /api/teams/[id]/members/[userId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('PATCH returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest({ role: 'admin' });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(401);
    });

    it('DELETE returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(req, createRouteContext());
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // PATCH /api/teams/[id]/members/[userId]
  // --------------------------------------------------------------------------

  describe('PATCH /api/teams/[id]/members/[userId]', () => {
    it('rejects invalid role value', async () => {
      mockAuthenticated();
      const req = createNextRequest({ role: 'superadmin' });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('admin');
    });

    it('rejects owner as a role value', async () => {
      // WHY: The 'owner' role is not assignable via this endpoint. Ownership
      // transfer is a separate, more complex operation.
      mockAuthenticated();
      const req = createNextRequest({ role: 'owner' });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(400);
    });

    it('returns 404 when team not found', async () => {
      mockAuthenticated();

      // teams.select('owner_id').eq().single() => not found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest({ role: 'admin' });
      const response = await PATCH(req, createRouteContext());
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Team not found');
    });

    it('returns 403 when non-owner tries to change role', async () => {
      mockAuthenticated(ADMIN_USER);

      // WHY: Admins cannot change roles — this prevents privilege escalation
      // where an admin could promote themselves to owner.
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      const req = createNextRequest({ role: 'admin' });
      const response = await PATCH(
        req,
        createRouteContext(TEAM_ID, MEMBER_USER.id)
      );
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('owner');
    });

    it('returns 400 when owner tries to change own role', async () => {
      mockAuthenticated(OWNER_USER);

      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      const req = createNextRequest({ role: 'member' });
      // Target userId === authenticated user's id
      const response = await PATCH(
        req,
        createRouteContext(TEAM_ID, OWNER_USER.id)
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('your own role');
    });

    it('returns 404 when target member not found in team', async () => {
      mockAuthenticated(OWNER_USER);

      // 1. team found, owned by current user
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. target member not found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest({ role: 'admin' });
      const response = await PATCH(
        req,
        createRouteContext(TEAM_ID, 'nonexistent-user-id')
      );
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toContain('Member not found');
    });

    it('returns 400 when trying to modify owner member role', async () => {
      mockAuthenticated(OWNER_USER);

      // WHY: The owner's role in team_members is 'owner'. This cannot be
      // changed — ownership transfer is a separate operation.

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. target member found with role 'owner'
      // (This is a different user who has role 'owner' in team_members — edge case)
      fromCallQueue.push({
        data: { id: 'mem-owner', role: 'owner' },
        error: null,
      });

      const req = createNextRequest({ role: 'admin' });
      // Use a different userId to pass the self-check
      const response = await PATCH(
        req,
        createRouteContext(TEAM_ID, 'another-owner-uuid')
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain("owner's role");
    });

    it('successfully promotes member to admin', async () => {
      mockAuthenticated(OWNER_USER);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. target member found with role 'member'
      fromCallQueue.push({
        data: { id: 'mem-333', role: 'member' },
        error: null,
      });

      // 3. update().eq().select().single() => updated
      fromCallQueue.push({
        data: {
          id: 'mem-333',
          user_id: MEMBER_USER.id,
          role: 'admin',
          updated_at: '2025-06-02T00:00:00Z',
        },
        error: null,
      });

      const req = createNextRequest({ role: 'admin' });
      const response = await PATCH(
        req,
        createRouteContext(TEAM_ID, MEMBER_USER.id)
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.member.role).toBe('admin');
      expect(body.member.user_id).toBe(MEMBER_USER.id);
    });

    it('successfully demotes admin to member', async () => {
      mockAuthenticated(OWNER_USER);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. target is admin
      fromCallQueue.push({
        data: { id: 'mem-222', role: 'admin' },
        error: null,
      });

      // 3. update
      fromCallQueue.push({
        data: {
          id: 'mem-222',
          user_id: ADMIN_USER.id,
          role: 'member',
          updated_at: '2025-06-02T00:00:00Z',
        },
        error: null,
      });

      const req = createNextRequest({ role: 'member' });
      const response = await PATCH(
        req,
        createRouteContext(TEAM_ID, ADMIN_USER.id)
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.member.role).toBe('member');
    });

    it('returns 500 when update fails', async () => {
      mockAuthenticated(OWNER_USER);

      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      fromCallQueue.push({
        data: { id: 'mem-333', role: 'member' },
        error: null,
      });

      fromCallQueue.push({
        data: null,
        error: { message: 'Update failed' },
      });

      const req = createNextRequest({ role: 'admin' });
      const response = await PATCH(
        req,
        createRouteContext(TEAM_ID, MEMBER_USER.id)
      );
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to update member');
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /api/teams/[id]/members/[userId]
  // --------------------------------------------------------------------------

  describe('DELETE /api/teams/[id]/members/[userId]', () => {
    it('returns 404 when team not found', async () => {
      mockAuthenticated(OWNER_USER);

      // teams.select('owner_id').eq().single() => not found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, MEMBER_USER.id)
      );
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Team not found');
    });

    it('returns 400 when trying to remove the team owner', async () => {
      mockAuthenticated(OWNER_USER);

      // WHY: Removing the owner would orphan the team. The owner must
      // transfer ownership or delete the team instead.
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, OWNER_USER.id)
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('owner cannot be removed');
    });

    it('returns 403 when non-member tries to remove someone', async () => {
      const outsider = { id: 'outsider-uuid-999', email: 'outsider@example.com' };
      mockAuthenticated(outsider);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => not found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, MEMBER_USER.id)
      );
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('not a member');
    });

    it('returns 403 when admin tries to remove another admin', async () => {
      mockAuthenticated(ADMIN_USER);

      // WHY: Admin can only remove members, not other admins. This prevents
      // horizontal privilege conflicts. Only the owner can remove admins.

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => admin
      fromCallQueue.push({
        data: { role: 'admin' },
        error: null,
      });

      // 3. target member => also admin
      const otherAdmin = { id: 'other-admin-uuid-555', email: 'admin2@example.com' };
      fromCallQueue.push({
        data: { id: 'mem-555', role: 'admin' },
        error: null,
      });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, otherAdmin.id)
      );
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('permission');
    });

    it('returns 403 when regular member tries to remove another member', async () => {
      mockAuthenticated(MEMBER_USER);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => member
      fromCallQueue.push({
        data: { role: 'member' },
        error: null,
      });

      // 3. target member => also member
      fromCallQueue.push({
        data: { id: 'mem-444', role: 'member' },
        error: null,
      });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, OTHER_MEMBER.id)
      );
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('permission');
    });

    it('returns 404 when target member not found in team', async () => {
      mockAuthenticated(OWNER_USER);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => owner
      fromCallQueue.push({
        data: { role: 'owner' },
        error: null,
      });

      // 3. target member => not found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, 'nonexistent-uuid')
      );
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toContain('Member not found');
    });

    it('owner removes a member successfully', async () => {
      mockAuthenticated(OWNER_USER);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => owner
      fromCallQueue.push({
        data: { role: 'owner' },
        error: null,
      });

      // 3. target member found
      fromCallQueue.push({
        data: { id: 'mem-333', role: 'member' },
        error: null,
      });

      // 4. delete => success
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, MEMBER_USER.id)
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it('owner removes an admin successfully', async () => {
      mockAuthenticated(OWNER_USER);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => owner
      fromCallQueue.push({
        data: { role: 'owner' },
        error: null,
      });

      // 3. target member => admin
      fromCallQueue.push({
        data: { id: 'mem-222', role: 'admin' },
        error: null,
      });

      // 4. delete => success
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, ADMIN_USER.id)
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it('admin removes a regular member successfully', async () => {
      mockAuthenticated(ADMIN_USER);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => admin
      fromCallQueue.push({
        data: { role: 'admin' },
        error: null,
      });

      // 3. target member => member (not admin)
      fromCallQueue.push({
        data: { id: 'mem-333', role: 'member' },
        error: null,
      });

      // 4. delete => success
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, MEMBER_USER.id)
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it('member removes themselves (leave team) successfully', async () => {
      mockAuthenticated(MEMBER_USER);

      // WHY: Any member can remove themselves from a team (leave). This is
      // an important self-service action — users should not need to ask the
      // owner to remove them.

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => member
      fromCallQueue.push({
        data: { role: 'member' },
        error: null,
      });

      // 3. target member = self
      fromCallQueue.push({
        data: { id: 'mem-333', role: 'member' },
        error: null,
      });

      // 4. delete => success
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, MEMBER_USER.id)
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it('admin removes themselves (leave team) successfully', async () => {
      mockAuthenticated(ADMIN_USER);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => admin
      fromCallQueue.push({
        data: { role: 'admin' },
        error: null,
      });

      // 3. target member = self (admin)
      fromCallQueue.push({
        data: { id: 'mem-222', role: 'admin' },
        error: null,
      });

      // 4. delete => success
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, ADMIN_USER.id)
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it('returns 500 when delete fails', async () => {
      mockAuthenticated(OWNER_USER);

      // 1. team found
      fromCallQueue.push({
        data: { owner_id: OWNER_USER.id },
        error: null,
      });

      // 2. current user's membership => owner
      fromCallQueue.push({
        data: { role: 'owner' },
        error: null,
      });

      // 3. target member found
      fromCallQueue.push({
        data: { id: 'mem-333', role: 'member' },
        error: null,
      });

      // 4. delete fails
      fromCallQueue.push({
        data: null,
        error: { message: 'Delete failed' },
      });

      const req = createNextRequest(undefined, 'DELETE');
      const response = await DELETE(
        req,
        createRouteContext(TEAM_ID, MEMBER_USER.id)
      );
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to remove member');
    });
  });
});
