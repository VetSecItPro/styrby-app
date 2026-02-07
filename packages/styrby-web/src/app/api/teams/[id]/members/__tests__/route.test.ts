/**
 * Team Members Invitation API Route Integration Tests
 *
 * Tests POST /api/teams/[id]/members
 *
 * WHY: The invitation flow is one of the most complex team operations.
 * It involves: auth check, Zod validation, team existence, role-based
 * permission (owner/admin only), tier-based member limits (counting
 * existing members + pending invites), duplicate member checks via RPC,
 * duplicate pending invite checks, token generation, database insert,
 * and email sending. A bug in any step could allow unauthorized invites,
 * exceed tier limits, send duplicate emails, or create orphaned records.
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

/** Mock email sending — invitation emails should not actually be sent in tests */
vi.mock('@/lib/resend', () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true }),
}));

/** Mock the TeamInvitationEmail React component */
vi.mock('@/emails/team-invitation', () => ({
  default: vi.fn(() => 'TeamInvitationEmail'),
}));

/**
 * Mock crypto.randomBytes for deterministic invitation tokens.
 *
 * WHY: The invitation token is generated with crypto.randomBytes(32).
 * We mock it to return a predictable value so tests are deterministic
 * and we can verify the token is being generated. We use importOriginal
 * to preserve the default export and other crypto methods.
 */
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomBytes: vi.fn(() => ({
      toString: () => 'mock-secure-token-base64url',
    })),
  };
});

import { POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const TEAM_ID = 'team-uuid-abc';
const AUTH_USER = { id: 'user-uuid-123', email: 'owner@example.com' };
const OTHER_USER = { id: 'user-uuid-456', email: 'member@example.com' };

function createRouteContext(id: string = TEAM_ID) {
  return { params: Promise.resolve({ id }) };
}

function createNextRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/teams/${TEAM_ID}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    body: JSON.stringify(body),
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

describe('Team Members Invitation API — /api/teams/[id]/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest({ email: 'new@example.com' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('rejects invalid email', async () => {
      mockAuthenticated();
      const req = createNextRequest({ email: 'not-an-email' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('valid email');
    });

    it('rejects missing email', async () => {
      mockAuthenticated();
      const req = createNextRequest({});
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/teams/[id]/members
  // --------------------------------------------------------------------------

  describe('POST /api/teams/[id]/members', () => {
    it('returns 404 when team not found', async () => {
      mockAuthenticated();

      // teams.select().eq().single() => not found
      fromCallQueue.push({
        data: null,
        error: { code: 'PGRST116', message: 'Not found' },
      });

      const req = createNextRequest({ email: 'new@example.com' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Team not found');
    });

    it('returns 403 when regular member tries to invite', async () => {
      mockAuthenticated(OTHER_USER);

      // WHY: Only owners and admins can invite. Regular members must not be
      // able to add people to teams they joined.

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. membership check — OTHER_USER is 'member' role
      fromCallQueue.push({
        data: { role: 'member' },
        error: null,
      });

      const req = createNextRequest({ email: 'new@example.com' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('owners and admins');
    });

    it('returns 403 when non-member tries to invite', async () => {
      mockAuthenticated(OTHER_USER);

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. membership check — no membership found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest({ email: 'new@example.com' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('owners and admins');
    });

    it('returns 403 when team member limit is reached', async () => {
      mockAuthenticated();

      // WHY: Power tier allows 5 team members. This test verifies that the
      // limit counts both existing members AND pending invitations.

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. membership check — owner
      fromCallQueue.push({
        data: { role: 'owner' },
        error: null,
      });

      // 3. getUserTier => power (limit: 5)
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // 4. member count => 4 existing members
      fromCallQueue.push({ count: 4, error: null });

      // 5. pending invitation count => 1 pending
      fromCallQueue.push({ count: 1, error: null });

      // Total = 4 + 1 = 5, which equals the limit

      const req = createNextRequest({ email: 'new@example.com' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('maximum');
      expect(body.error).toContain('5');
    });

    it('returns 400 when invitee is already a member', async () => {
      mockAuthenticated();

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. membership check — owner
      fromCallQueue.push({ data: { role: 'owner' }, error: null });

      // 3. getUserTier => power
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // 4. member count => 2
      fromCallQueue.push({ count: 2, error: null });

      // 5. pending count => 0
      fromCallQueue.push({ count: 0, error: null });

      // 6. rpc('get_team_members') => includes the invited email
      mockRpc.mockResolvedValueOnce({
        data: [
          { email: 'existing@example.com', user_id: 'some-id' },
          { email: AUTH_USER.email, user_id: AUTH_USER.id },
        ],
        error: null,
      });

      const req = createNextRequest({ email: 'existing@example.com' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('already a member');
    });

    it('returns 400 when pending invitation already exists', async () => {
      mockAuthenticated();

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. membership check — owner
      fromCallQueue.push({ data: { role: 'owner' }, error: null });

      // 3. getUserTier => power
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // 4. member count => 2
      fromCallQueue.push({ count: 2, error: null });

      // 5. pending count => 1
      fromCallQueue.push({ count: 1, error: null });

      // 6. rpc('get_team_members') => no match
      mockRpc.mockResolvedValueOnce({
        data: [{ email: AUTH_USER.email, user_id: AUTH_USER.id }],
        error: null,
      });

      // 7. team_invitations.select().eq().eq().eq().single() => found existing
      fromCallQueue.push({
        data: { id: 'existing-invite-id' },
        error: null,
      });

      const req = createNextRequest({ email: 'pending@example.com' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('already been sent');
    });

    it('creates invitation successfully for owner', async () => {
      mockAuthenticated();

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. membership check — owner
      fromCallQueue.push({ data: { role: 'owner' }, error: null });

      // 3. getUserTier => power
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // 4. member count => 2
      fromCallQueue.push({ count: 2, error: null });

      // 5. pending count => 0
      fromCallQueue.push({ count: 0, error: null });

      // 6. rpc('get_team_members') => no match for invited email
      mockRpc.mockResolvedValueOnce({
        data: [{ email: AUTH_USER.email, user_id: AUTH_USER.id }],
        error: null,
      });

      // 7. no existing pending invite
      fromCallQueue.push({ data: null, error: null });

      // 8. insert invitation => success
      fromCallQueue.push({
        data: {
          id: 'new-invite-id',
          email: 'newbie@example.com',
          role: 'member',
          created_at: '2025-06-01T00:00:00Z',
          expires_at: '2025-06-08T00:00:00Z',
        },
        error: null,
      });

      // 9. inviter profile lookup
      fromCallQueue.push({
        data: { display_name: 'Team Owner' },
        error: null,
      });

      const req = createNextRequest({
        email: 'newbie@example.com',
        role: 'member',
      });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.invitation).toBeDefined();
      expect(body.invitation.email).toBe('newbie@example.com');
      expect(body.invitation.role).toBe('member');
    });

    it('creates invitation successfully for admin', async () => {
      const adminUser = { id: 'admin-uuid-789', email: 'admin@example.com' };
      mockAuthenticated(adminUser);

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. membership check — admin
      fromCallQueue.push({ data: { role: 'admin' }, error: null });

      // 3. getUserTier => power (uses team owner's tier)
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // 4. member count => 2
      fromCallQueue.push({ count: 2, error: null });

      // 5. pending count => 0
      fromCallQueue.push({ count: 0, error: null });

      // 6. rpc('get_team_members') => no match
      mockRpc.mockResolvedValueOnce({
        data: [
          { email: AUTH_USER.email, user_id: AUTH_USER.id },
          { email: adminUser.email, user_id: adminUser.id },
        ],
        error: null,
      });

      // 7. no existing pending invite
      fromCallQueue.push({ data: null, error: null });

      // 8. insert invitation
      fromCallQueue.push({
        data: {
          id: 'new-invite-id',
          email: 'another@example.com',
          role: 'admin',
          created_at: '2025-06-01T00:00:00Z',
          expires_at: '2025-06-08T00:00:00Z',
        },
        error: null,
      });

      // 9. inviter profile
      fromCallQueue.push({
        data: { display_name: 'Admin Person' },
        error: null,
      });

      const req = createNextRequest({
        email: 'another@example.com',
        role: 'admin',
      });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.invitation.role).toBe('admin');
    });

    it('defaults role to member when not specified', async () => {
      mockAuthenticated();

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. membership check — owner
      fromCallQueue.push({ data: { role: 'owner' }, error: null });

      // 3. getUserTier => power
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // 4. member count => 1
      fromCallQueue.push({ count: 1, error: null });

      // 5. pending count => 0
      fromCallQueue.push({ count: 0, error: null });

      // 6. rpc => no match
      mockRpc.mockResolvedValueOnce({
        data: [{ email: AUTH_USER.email, user_id: AUTH_USER.id }],
        error: null,
      });

      // 7. no existing invite
      fromCallQueue.push({ data: null, error: null });

      // 8. insert => role defaults to 'member'
      fromCallQueue.push({
        data: {
          id: 'new-invite-id',
          email: 'default-role@example.com',
          role: 'member',
          created_at: '2025-06-01T00:00:00Z',
          expires_at: '2025-06-08T00:00:00Z',
        },
        error: null,
      });

      // 9. profile
      fromCallQueue.push({ data: { display_name: 'Owner' }, error: null });

      const req = createNextRequest({ email: 'default-role@example.com' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.invitation.role).toBe('member');
    });

    it('returns 500 when invitation insert fails', async () => {
      mockAuthenticated();

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. membership check — owner
      fromCallQueue.push({ data: { role: 'owner' }, error: null });

      // 3. getUserTier => power
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // 4. member count => 1
      fromCallQueue.push({ count: 1, error: null });

      // 5. pending count => 0
      fromCallQueue.push({ count: 0, error: null });

      // 6. rpc => no match
      mockRpc.mockResolvedValueOnce({
        data: [{ email: AUTH_USER.email, user_id: AUTH_USER.id }],
        error: null,
      });

      // 7. no existing invite
      fromCallQueue.push({ data: null, error: null });

      // 8. insert fails
      fromCallQueue.push({
        data: null,
        error: { message: 'Insert failed' },
      });

      const req = createNextRequest({ email: 'fail@example.com' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to create invitation');
    });

    it('handles case-insensitive email matching for existing members', async () => {
      mockAuthenticated();

      // WHY: Email addresses are case-insensitive per RFC 5321. The route
      // lowercases emails before comparison. This test verifies that
      // EXISTING@EXAMPLE.COM matches existing@example.com.

      // 1. team found
      fromCallQueue.push({
        data: { id: TEAM_ID, name: 'Alpha Team', owner_id: AUTH_USER.id },
        error: null,
      });

      // 2. owner membership
      fromCallQueue.push({ data: { role: 'owner' }, error: null });

      // 3. power tier
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // 4. member count => 2
      fromCallQueue.push({ count: 2, error: null });

      // 5. pending count => 0
      fromCallQueue.push({ count: 0, error: null });

      // 6. rpc members include lowercase version
      mockRpc.mockResolvedValueOnce({
        data: [
          { email: 'existing@example.com', user_id: 'some-id' },
          { email: AUTH_USER.email, user_id: AUTH_USER.id },
        ],
        error: null,
      });

      const req = createNextRequest({ email: 'EXISTING@EXAMPLE.COM' });
      const response = await POST(req, createRouteContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('already a member');
    });
  });
});
