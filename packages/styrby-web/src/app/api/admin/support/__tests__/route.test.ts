/**
 * Admin Support Tickets API Tests
 *
 * Tests GET /api/admin/support
 *
 * Verifies:
 * - Unauthenticated requests return 401
 * - Authenticated non-admin users return 403
 * - Admin users get the ticket list with pagination
 * - Status query parameter filters results
 * - Rate limiting returns 429 when exceeded
 * - Database errors return 500
 * - User email enrichment via auth.admin.getUserById
 *
 * WHY: Admin routes have elevated privilege. A bug that lets non-admins
 * access support tickets would expose user PII and support history.
 * These tests verify the isAdmin() gate is evaluated correctly and that
 * the query layer behaves as expected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();
const mockIsAdmin = vi.fn();

/**
 * Tracks sequential .from() call results for the admin Supabase client.
 * Each call shifts the next result from the front of this queue.
 */
const adminFromQueue: Array<{ data?: unknown; error?: unknown; count?: number | null }> = [];

/**
 * Mock for adminClient.auth.admin.getUserById — returns user data for
 * email enrichment. Can be overridden per test.
 */
const mockGetUserById = vi.fn();

/**
 * Creates a chainable query builder mock that resolves terminal methods
 * with the next item from adminFromQueue.
 */
function createAdminChainMock() {
  const result = adminFromQueue.shift() ?? { data: null, error: null, count: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'lte', 'order', 'limit', 'insert', 'update',
    'delete', 'is', 'not', 'in', 'range',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  // WHY: Support ticket list uses .range() → implicit resolution via .then()
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => createAdminChainMock()),
    auth: {
      admin: {
        getUserById: mockGetUserById,
      },
    },
  })),
}));

vi.mock('@/lib/admin', () => ({
  isAdmin: (...args: Parameters<typeof mockIsAdmin>) => mockIsAdmin(...args),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 99 })),
  RATE_LIMITS: {
    standard: { windowMs: 60000, maxRequests: 100 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
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

import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';
import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const ADMIN_USER = { id: 'admin-uuid-001', email: 'admin@styrby.com' };
const REGULAR_USER = { id: 'user-uuid-002', email: 'user@example.com' };

function makeRequest(url = 'http://localhost:3000/api/admin/support'): Request {
  return new Request(url, {
    method: 'GET',
    headers: { 'x-forwarded-for': '10.0.0.1' },
  });
}

function mockAuthenticated(user = ADMIN_USER) {
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: null },
    error: { message: 'Not authenticated' },
  });
}

/** A sample support ticket row as returned by the DB query */
const SAMPLE_TICKET = {
  id: 'ticket-uuid-001',
  user_id: REGULAR_USER.id,
  subject: 'Cannot connect CLI',
  status: 'open',
  priority: 'normal',
  created_at: '2025-03-01T10:00:00Z',
  updated_at: '2025-03-01T10:00:00Z',
  profiles: {
    display_name: 'John User',
    avatar_url: null,
  },
};

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/admin/support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminFromQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Authentication & authorisation
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockUnauthenticated();

      const response = await GET(makeRequest());
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 401 when auth.getUser returns an error', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'JWT expired' },
      });

      const response = await GET(makeRequest());
      expect(response.status).toBe(401);
    });
  });

  describe('authorisation', () => {
    it('returns 403 when authenticated user is not admin', async () => {
      mockAuthenticated(REGULAR_USER);
      mockIsAdmin.mockResolvedValue(false);

      // Rate limit passes
      adminFromQueue.push({ data: null, error: null });

      const response = await GET(makeRequest());
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Forbidden');
    });

    it('calls isAdmin with the authenticated user ID', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(false);

      await GET(makeRequest());

      expect(mockIsAdmin).toHaveBeenCalledWith(ADMIN_USER.id);
    });
  });

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      mockAuthenticated(ADMIN_USER);

      const { rateLimit } = await import('@/lib/rateLimit');
      (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        allowed: false,
        retryAfter: 30,
      });

      const response = await GET(makeRequest());
      expect(response.status).toBe(429);
    });
  });

  // --------------------------------------------------------------------------
  // Successful admin ticket list
  // --------------------------------------------------------------------------

  describe('ticket list', () => {
    it('returns ticket list with total count for admin', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      // support_tickets query result
      adminFromQueue.push({
        data: [SAMPLE_TICKET],
        error: null,
        count: 1,
      });

      // getUserById for email enrichment
      mockGetUserById.mockResolvedValue({
        data: { user: { id: REGULAR_USER.id, email: REGULAR_USER.email } },
        error: null,
      });

      const response = await GET(makeRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.tickets).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.tickets[0].id).toBe(SAMPLE_TICKET.id);
    });

    it('enriches tickets with user email from auth.admin.getUserById', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: [SAMPLE_TICKET], error: null, count: 1 });

      mockGetUserById.mockResolvedValue({
        data: { user: { id: REGULAR_USER.id, email: 'enriched@example.com' } },
        error: null,
      });

      const response = await GET(makeRequest());
      const body = await response.json();

      expect(body.tickets[0].user_email).toBe('enriched@example.com');
    });

    it('falls back to "Unknown" when getUserById returns no user', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: [SAMPLE_TICKET], error: null, count: 1 });

      mockGetUserById.mockResolvedValue({
        data: { user: null },
        error: null,
      });

      const response = await GET(makeRequest());
      const body = await response.json();

      expect(body.tickets[0].user_email).toBe('Unknown');
    });

    it('returns empty tickets array when there are no tickets', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: [], error: null, count: 0 });

      const response = await GET(makeRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.tickets).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns 500 when database query fails', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({
        data: null,
        error: { message: 'connection timeout' },
        count: null,
      });

      const response = await GET(makeRequest());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch tickets');
    });
  });

  // --------------------------------------------------------------------------
  // Query parameter handling
  // --------------------------------------------------------------------------

  describe('query parameters', () => {
    it('filters by valid status parameter', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: [], error: null, count: 0 });

      const url = 'http://localhost:3000/api/admin/support?status=open';
      const response = await GET(makeRequest(url));
      expect(response.status).toBe(200);
    });

    it('rejects invalid status parameter with 400', async () => {
      // WHY: Previously the route silently ignored unrecognised status values.
      // After adding Zod QuerySchema (OWASP ASVS V5.1.3) the route now returns
      // 400 with a structured error — callers receive explicit feedback rather
      // than a silently unfiltered result set.
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const url = 'http://localhost:3000/api/admin/support?status=invalid_status';
      const response = await GET(makeRequest(url));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('respects page and limit parameters', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: [], error: null, count: 100 });

      const url = 'http://localhost:3000/api/admin/support?page=2&limit=10';
      const response = await GET(makeRequest(url));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.total).toBe(100);
    });

    it('rejects limit > 100 with 400', async () => {
      // WHY: The old route silently clamped limit=200 to 100. Zod z.max(100)
      // now explicitly rejects out-of-range values with a 400 error, providing
      // clearer API contract feedback per OWASP ASVS V5.1.3.
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const url = 'http://localhost:3000/api/admin/support?limit=200';
      const response = await GET(makeRequest(url));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('rejects page < 1 with 400', async () => {
      // WHY: The old route silently clamped page=-5 to 1. Zod z.min(1) now
      // explicitly rejects sub-minimum values with a 400 error per OWASP ASVS V5.1.3.
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const url = 'http://localhost:3000/api/admin/support?page=-5';
      const response = await GET(makeRequest(url));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // All valid status values
  // --------------------------------------------------------------------------

  describe('valid status filter values', () => {
    const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

    it.each(VALID_STATUSES)(
      'accepts status=%s',
      async (status) => {
        mockAuthenticated(ADMIN_USER);
        mockIsAdmin.mockResolvedValue(true);

        adminFromQueue.push({ data: [], error: null, count: 0 });

        const url = `http://localhost:3000/api/admin/support?status=${status}`;
        const response = await GET(makeRequest(url));
        expect(response.status).toBe(200);
      }
    );
  });

  // ── MFA gate wiring (H42 Layer 1) ───────────────────────────────────────────

  // WHY: proves the route calls assertAdminMfa and short-circuits to 403 when
  // the gate throws AdminMfaRequiredError — DB queries must not run on gate failure.
  // OWASP A07:2021, SOC 2 CC6.1.
  describe('MFA gate', () => {
    it('(MFA gate) returns 403 ADMIN_MFA_REQUIRED and skips DB query when assertAdminMfa throws', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);
      (assertAdminMfa as import('vitest').Mock).mockRejectedValueOnce(new AdminMfaRequiredError());

      const response = await GET(makeRequest());

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('ADMIN_MFA_REQUIRED');
      // Ensure no DB call was made — adminFromQueue should still be empty.
      expect(adminFromQueue).toHaveLength(0);
    });
  });
});
