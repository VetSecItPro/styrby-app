/**
 * Bookmarks API Route Tests
 *
 * Tests GET, POST, DELETE /api/bookmarks.
 *
 * WHY: Bookmark creation is tier-gated (Free: 5, Pro: 50, Power: -1 unlimited).
 * Regressions here could allow free users to exceed their limit or let the
 * duplicate-bookmark 409 path silently degrade to 500.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();

const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'order', 'limit', 'insert', 'delete', 'single',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
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
  RATE_LIMITS: {
    budgetAlerts: { windowMs: 60000, maxRequests: 30 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

// Mock TIERS from polar.ts to provide bookmark limits
vi.mock('@/lib/polar', () => ({
  TIERS: {
    free: { limits: { bookmarks: 5 } },
    pro: { limits: { bookmarks: 50 } },
    power: { limits: { bookmarks: -1 } },
  },
}));

import { GET, POST, DELETE } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const AUTH_USER = { id: 'user-bookmark-123', email: 'test@example.com' };
const VALID_SESSION_ID = '00000000-0000-0000-0000-000000000001';

function mockAuthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: AUTH_USER }, error: null });
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Unauthorized' } });
}

function makeRequest(method: string, body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/bookmarks', {
    method,
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('Bookmarks API', () => {
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
      const res = await GET();
      expect(res.status).toBe(401);
    });

    it('POST returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const res = await POST(makeRequest('POST', { session_id: VALID_SESSION_ID }));
      expect(res.status).toBe(401);
    });

    it('DELETE returns 401 when unauthenticated', async () => {
      mockUnauthenticated();
      const res = await DELETE(makeRequest('DELETE', { session_id: VALID_SESSION_ID }));
      expect(res.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/bookmarks
  // --------------------------------------------------------------------------

  describe('GET /api/bookmarks', () => {
    it('returns bookmarks with tier and limit info', async () => {
      mockAuthenticated();
      // 1. session_bookmarks select
      fromCallQueue.push({ data: [{ id: 'bm-1', session_id: VALID_SESSION_ID, note: null, created_at: '2026-01-01T00:00:00Z' }], error: null });
      // 2. subscriptions lookup (getUserTier)
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });
      fromCallQueue.push({ data: [], error: null }); // SEC-ADV-004: empty team_members

      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bookmarks).toHaveLength(1);
      expect(body.tier).toBe('pro');
      expect(body.bookmarkLimit).toBe(50);
      expect(body.bookmarkCount).toBe(1);
    });

    it('returns empty bookmarks for new user on free tier', async () => {
      mockAuthenticated();
      fromCallQueue.push({ data: [], error: null });
      fromCallQueue.push({ data: null, error: null }); // no subscription → free
      fromCallQueue.push({ data: [], error: null }); // SEC-ADV-004: empty team_members

      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bookmarks).toHaveLength(0);
      expect(body.tier).toBe('free');
      expect(body.bookmarkLimit).toBe(5);
    });

    it('returns 500 on DB error', async () => {
      mockAuthenticated();
      fromCallQueue.push({ data: null, error: { message: 'connection refused' } });

      const res = await GET();
      expect(res.status).toBe(500);
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/bookmarks
  // --------------------------------------------------------------------------

  describe('POST /api/bookmarks — input validation', () => {
    it('rejects missing session_id', async () => {
      mockAuthenticated();
      const res = await POST(makeRequest('POST', { note: 'some note' }));
      expect(res.status).toBe(400);
    });

    it('rejects non-UUID session_id', async () => {
      mockAuthenticated();
      const res = await POST(makeRequest('POST', { session_id: 'not-a-uuid' }));
      expect(res.status).toBe(400);
    });

    it('rejects note longer than 500 chars', async () => {
      mockAuthenticated();
      const res = await POST(makeRequest('POST', { session_id: VALID_SESSION_ID, note: 'x'.repeat(501) }));
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/bookmarks — tier enforcement', () => {
    it('returns 403 when free user is at bookmark limit (5/5)', async () => {
      mockAuthenticated();
      // getUserTier → free
      fromCallQueue.push({ data: null, error: null });
      fromCallQueue.push({ data: [], error: null }); // SEC-ADV-004: empty team_members
      // count → 5 (at limit)
      fromCallQueue.push({ count: 5, error: null });

      const res = await POST(makeRequest('POST', { session_id: VALID_SESSION_ID }));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Free plan');
    });

    it('allows pro user to exceed 50 bookmarks (Phase 5: pro is now unlimited)', async () => {
      // Phase 5: TIERS.pro.limits.bookmarks = -1 (post-rename Pro inherits the
      // old Power feature set, including unlimited bookmarks).
      mockAuthenticated();
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });
      fromCallQueue.push({ data: [], error: null }); // SEC-ADV-004: empty team_members
      fromCallQueue.push({ count: 999, error: null });
      fromCallQueue.push({ data: { id: 'bm-new', session_id: VALID_SESSION_ID }, error: null });

      const res = await POST(makeRequest('POST', { session_id: VALID_SESSION_ID }));
      expect(res.status).toBe(201);
    });

    it('allows growth user to exceed 50 bookmarks (unlimited)', async () => {
      mockAuthenticated();
      // Use legacy `'power'` to also exercise the LEGACY_TIER_ALIASES path.
      fromCallQueue.push({ data: { tier: 'power' }, error: null });
      fromCallQueue.push({ data: [], error: null });
      fromCallQueue.push({ count: 999, error: null });
      fromCallQueue.push({ data: { id: 'bm-new', session_id: VALID_SESSION_ID }, error: null });

      const res = await POST(makeRequest('POST', { session_id: VALID_SESSION_ID }));
      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/bookmarks — success and conflicts', () => {
    it('creates bookmark and returns 201', async () => {
      mockAuthenticated();
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });
      fromCallQueue.push({ data: [], error: null }); // SEC-ADV-004: empty team_members
      fromCallQueue.push({ count: 1, error: null });
      fromCallQueue.push({ data: { id: 'bm-created', session_id: VALID_SESSION_ID, note: 'key session' }, error: null });

      const res = await POST(makeRequest('POST', { session_id: VALID_SESSION_ID, note: 'key session' }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.bookmark).toBeDefined();
    });

    it('returns 409 when session is already bookmarked', async () => {
      mockAuthenticated();
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });
      fromCallQueue.push({ data: [], error: null }); // SEC-ADV-004: empty team_members
      fromCallQueue.push({ count: 1, error: null });
      fromCallQueue.push({ data: null, error: { code: '23505', message: 'unique violation' } });

      const res = await POST(makeRequest('POST', { session_id: VALID_SESSION_ID }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Session is already bookmarked');
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /api/bookmarks
  // --------------------------------------------------------------------------

  describe('DELETE /api/bookmarks', () => {
    it('rejects missing session_id', async () => {
      mockAuthenticated();
      const res = await DELETE(makeRequest('DELETE', {}));
      expect(res.status).toBe(400);
    });

    it('rejects non-UUID session_id', async () => {
      mockAuthenticated();
      const res = await DELETE(makeRequest('DELETE', { session_id: 'bad-id' }));
      expect(res.status).toBe(400);
    });

    it('returns 404 when bookmark does not exist', async () => {
      mockAuthenticated();
      // existence check → not found
      fromCallQueue.push({ data: null, error: null });

      const res = await DELETE(makeRequest('DELETE', { session_id: VALID_SESSION_ID }));
      expect(res.status).toBe(404);
    });

    it('deletes bookmark and returns success', async () => {
      mockAuthenticated();
      // existence check → found
      fromCallQueue.push({ data: { id: 'bm-1' }, error: null });
      // delete → success
      fromCallQueue.push({ data: null, error: null });

      const res = await DELETE(makeRequest('DELETE', { session_id: VALID_SESSION_ID }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('POST returns 429 when rate limited', async () => {
      const { rateLimit } = await import('@/lib/rateLimit');
      vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 30, remaining: 0, resetAt: Date.now() + 30000 });
      mockAuthenticated();

      const res = await POST(makeRequest('POST', { session_id: VALID_SESSION_ID }));
      expect(res.status).toBe(429);
    });
  });
});
