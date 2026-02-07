/**
 * Teams API Route Integration Tests
 *
 * Tests GET /api/teams and POST /api/teams
 *
 * WHY: Teams are a Power-tier-only feature and the gateway to all team
 * collaboration. Bugs here could let free/pro users create teams (revenue
 * leak), return stale member counts (confusing UI), or fail to enforce
 * tier limits. These tests verify authentication, Zod validation, tier
 * gating, and the RPC + from() query sequencing.
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
 * Each call to supabase.from() creates a new chain mock that will resolve
 * to the next result in this queue when a terminal method is called.
 *
 * WHY: The teams route calls supabase.from() multiple times in sequence
 * (subscriptions for tier check, teams for insert/select). Each call needs
 * different mock data. This queue approach handles the sequencing automatically.
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase query builder mock.
 * Every chainable method (select, eq, in, etc.) returns `this`.
 * Terminal methods (single, then) resolve with the next result from the queue.
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

/** Mock rate limiting to always allow requests */
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

import { GET, POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

function createNextRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/teams', {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const AUTH_USER = { id: 'user-uuid-123', email: 'owner@example.com' };

function mockAuthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: AUTH_USER },
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

describe('Teams API — /api/teams', () => {
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
      const response = await GET();
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('POST returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const req = createNextRequest({ name: 'My Team' });
      const response = await POST(req);
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/teams
  // --------------------------------------------------------------------------

  describe('GET /api/teams', () => {
    it('returns teams list with tier info for authenticated user', async () => {
      mockAuthenticated();

      // rpc('get_user_teams') result
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            team_id: 'team-1',
            team_name: 'Alpha Team',
            team_description: 'First team',
            owner_id: AUTH_USER.id,
            role: 'owner',
            member_count: 3,
            joined_at: '2025-01-01T00:00:00Z',
          },
        ],
        error: null,
      });

      // getUserTier: subscriptions.select().eq().eq().single()
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // teams.select('id, created_at').in('id', teamIds)
      fromCallQueue.push({
        data: [{ id: 'team-1', created_at: '2025-01-01T00:00:00Z' }],
        error: null,
      });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.teams).toHaveLength(1);
      expect(body.teams[0].id).toBe('team-1');
      expect(body.teams[0].name).toBe('Alpha Team');
      expect(body.teams[0].role).toBe('owner');
      expect(body.teams[0].member_count).toBe(3);
      expect(body.tier).toBe('power');
      expect(body.canCreateTeam).toBe(true);
      expect(body.teamLimit).toBe(5);
    });

    it('returns empty teams array when user has no teams', async () => {
      mockAuthenticated();

      // rpc('get_user_teams') returns empty
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      // getUserTier: free tier
      fromCallQueue.push({ data: null, error: null });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.teams).toHaveLength(0);
      expect(body.tier).toBe('free');
      expect(body.canCreateTeam).toBe(false);
      expect(body.teamLimit).toBe(1);
    });

    it('returns canCreateTeam=false for pro tier', async () => {
      mockAuthenticated();

      // WHY: Pro tier has teamMembers: 1 but cannot create teams — only Power can.
      // This verifies the UI gets the correct signal to show upgrade prompts.
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      // getUserTier: pro tier
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.canCreateTeam).toBe(false);
      expect(body.tier).toBe('pro');
      expect(body.teamLimit).toBe(1);
    });

    it('returns 500 when rpc fails', async () => {
      mockAuthenticated();

      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'RPC failed' },
      });

      // getUserTier still resolves
      fromCallQueue.push({ data: null, error: null });

      const response = await GET();
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch teams');
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/teams
  // --------------------------------------------------------------------------

  describe('POST /api/teams', () => {
    it('rejects empty team name', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: '' });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('Team name is required');
    });

    it('rejects team name over 100 characters', async () => {
      mockAuthenticated();
      const req = createNextRequest({ name: 'A'.repeat(101) });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('100 characters');
    });

    it('rejects description over 500 characters', async () => {
      mockAuthenticated();
      const req = createNextRequest({
        name: 'Valid Name',
        description: 'D'.repeat(501),
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('500 characters');
    });

    it('returns 403 for free tier user', async () => {
      mockAuthenticated();

      // getUserTier: free tier
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest({ name: 'My Team' });
      const response = await POST(req);
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('Power plan');
    });

    it('returns 403 for pro tier user', async () => {
      mockAuthenticated();

      // WHY: Pro tier cannot create teams — only Power can. This prevents
      // pro users from accessing team features without upgrading.
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });

      const req = createNextRequest({ name: 'My Team' });
      const response = await POST(req);
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('Power plan');
    });

    it('creates team successfully for power tier user', async () => {
      mockAuthenticated();

      // getUserTier: power tier
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // insert().select().single()
      fromCallQueue.push({
        data: {
          id: 'new-team-id',
          name: 'My Team',
          description: 'A great team',
          owner_id: AUTH_USER.id,
          created_at: '2025-06-01T00:00:00Z',
        },
        error: null,
      });

      const req = createNextRequest({
        name: 'My Team',
        description: 'A great team',
      });
      const response = await POST(req);
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.team).toBeDefined();
      expect(body.team.name).toBe('My Team');
      expect(body.team.owner_id).toBe(AUTH_USER.id);
    });

    it('creates team without optional description', async () => {
      mockAuthenticated();

      // getUserTier: power tier
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // insert().select().single()
      fromCallQueue.push({
        data: {
          id: 'new-team-id',
          name: 'Minimal Team',
          description: null,
          owner_id: AUTH_USER.id,
          created_at: '2025-06-01T00:00:00Z',
        },
        error: null,
      });

      const req = createNextRequest({ name: 'Minimal Team' });
      const response = await POST(req);
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.team.description).toBeNull();
    });

    it('returns 500 when insert fails', async () => {
      mockAuthenticated();

      // getUserTier: power tier
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      // insert fails
      fromCallQueue.push({
        data: null,
        error: { message: 'Database error' },
      });

      const req = createNextRequest({ name: 'My Team' });
      const response = await POST(req);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to create team');
    });
  });
});
