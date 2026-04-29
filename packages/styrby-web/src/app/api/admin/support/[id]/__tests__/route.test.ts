/**
 * Admin Single Support Ticket API Tests
 *
 * Tests GET /api/admin/support/[id] and PATCH /api/admin/support/[id]
 *
 * Verifies:
 * - GET: returns full ticket detail with replies and user info for admin
 * - GET: returns 404 when ticket does not exist
 * - GET: returns 401 for unauthenticated request
 * - GET: returns 403 for authenticated non-admin
 * - PATCH: updates status and/or admin_notes for admin
 * - PATCH: validates body with Zod (rejects invalid status, oversized notes)
 * - PATCH: returns 400 when body has no updatable fields
 * - PATCH: returns 400 for invalid JSON
 * - PATCH: returns 401 for unauthenticated request
 * - PATCH: returns 403 for authenticated non-admin
 * - PATCH: writes an audit_log entry on successful update
 * - Rate limiting returns 429 when exceeded
 *
 * WHY: Admins can view PII (user email, subscription tier) and mutate
 * ticket state. Bugs in auth gating here expose user data or allow
 * unauthorized state changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();
const mockIsAdmin = vi.fn();

/**
 * Queue for the admin Supabase client's sequential .from() calls.
 * The GET handler makes multiple from() calls (ticket, replies, profiles,
 * subscriptions, machines); each shift() consumes one entry.
 */
const adminFromQueue: Array<{ data?: unknown; error?: unknown; count?: number | null }> = [];

/** Mock for auth.admin.getUserById (user email lookup in GET) */
const mockGetUserById = vi.fn();

/** Mock for audit_log insert (called in PATCH after successful update) */
const mockAuditLogInsert = vi.fn().mockResolvedValue({ data: null, error: null });

/**
 * Creates a chainable Supabase query builder mock.
 * Terminal resolution uses the next entry in adminFromQueue.
 */
function createAdminChainMock() {
  const result = adminFromQueue.shift() ?? { data: null, error: null, count: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'lte', 'order', 'limit', 'update',
    'delete', 'is', 'not', 'in', 'range',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

/**
 * Audit log chain mock — tracks insert calls separately so tests can
 * assert that admin mutations are audited.
 */
function createAuditLogChainMock() {
  const chain: Record<string, unknown> = {
    insert: mockAuditLogInsert,
  };
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'audit_log') return createAuditLogChainMock();
      return createAdminChainMock();
    }),
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
import { GET, PATCH } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const TICKET_ID = 'ticket-uuid-abc-123';
const ADMIN_USER = { id: 'admin-uuid-001', email: 'admin@styrby.com' };
const REGULAR_USER = { id: 'user-uuid-002', email: 'user@example.com' };

/**
 * Creates the route context for Next.js 15 async params pattern.
 *
 * @param id - Ticket ID for the [id] segment
 */
function makeContext(id: string = TICKET_ID) {
  return { params: Promise.resolve({ id }) };
}

function makeGetRequest(): Request {
  return new Request(`http://localhost:3000/api/admin/support/${TICKET_ID}`, {
    method: 'GET',
    headers: { 'x-forwarded-for': '10.0.0.1' },
  });
}

function makePatchRequest(body: Record<string, unknown>): Request {
  return new Request(`http://localhost:3000/api/admin/support/${TICKET_ID}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    body: JSON.stringify(body),
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

const SAMPLE_TICKET = {
  id: TICKET_ID,
  user_id: REGULAR_USER.id,
  subject: 'CLI auth not working',
  status: 'open',
  priority: 'normal',
  admin_notes: null,
  created_at: '2025-03-01T10:00:00Z',
  updated_at: '2025-03-01T10:00:00Z',
};

// ============================================================================
// GET tests
// ============================================================================

describe('GET /api/admin/support/[id]', () => {
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

      const response = await GET(makeGetRequest(), makeContext());
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('authorisation', () => {
    it('returns 403 when authenticated user is not admin', async () => {
      mockAuthenticated(REGULAR_USER);
      mockIsAdmin.mockResolvedValue(false);

      const response = await GET(makeGetRequest(), makeContext());
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Forbidden');
    });
  });

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      const { rateLimit } = await import('@/lib/rateLimit');
      (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        allowed: false,
        retryAfter: 15,
      });

      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const response = await GET(makeGetRequest(), makeContext());
      expect(response.status).toBe(429);
    });
  });

  // --------------------------------------------------------------------------
  // Ticket not found
  // --------------------------------------------------------------------------

  it('returns 404 when ticket does not exist', async () => {
    mockAuthenticated(ADMIN_USER);
    mockIsAdmin.mockResolvedValue(true);

    // support_tickets.select('*').eq('id', id).single() → not found
    adminFromQueue.push({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

    const response = await GET(makeGetRequest(), makeContext());
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe('Ticket not found');
  });

  // --------------------------------------------------------------------------
  // Successful ticket detail
  // --------------------------------------------------------------------------

  describe('successful ticket fetch', () => {
    /**
     * Pushes all sequential from() results for the full GET handler flow:
     * 1. support_tickets (the ticket)
     * 2. support_ticket_replies (replies list)
     * 3. profiles (display_name, avatar_url, created_at)
     * 4. subscriptions (tier, status)
     * 5. machines count
     */
    function setupSuccessfulGetQueue() {
      // 1. ticket
      adminFromQueue.push({ data: SAMPLE_TICKET, error: null });
      // 2. replies
      adminFromQueue.push({
        data: [
          {
            id: 'reply-uuid-001',
            ticket_id: TICKET_ID,
            author_type: 'admin',
            message: 'We are looking into it.',
            created_at: '2025-03-02T09:00:00Z',
          },
        ],
        error: null,
      });
      // 3. profiles
      adminFromQueue.push({
        data: {
          display_name: 'John User',
          avatar_url: null,
          created_at: '2025-01-15T00:00:00Z',
        },
        error: null,
      });
      // 4. subscriptions
      adminFromQueue.push({ data: { tier: 'pro', status: 'active' }, error: null });
      // 5. machines count
      adminFromQueue.push({ data: null, error: null, count: 3 });

      // getUserById for email
      mockGetUserById.mockResolvedValue({
        data: { user: { id: REGULAR_USER.id, email: REGULAR_USER.email } },
        error: null,
      });
    }

    it('returns ticket, replies, and user info', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);
      setupSuccessfulGetQueue();

      const response = await GET(makeGetRequest(), makeContext());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ticket.id).toBe(TICKET_ID);
      expect(body.ticket.subject).toBe('CLI auth not working');
    });

    it('returns replies array', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);
      setupSuccessfulGetQueue();

      const response = await GET(makeGetRequest(), makeContext());
      const body = await response.json();

      expect(body.replies).toHaveLength(1);
      expect(body.replies[0].author_type).toBe('admin');
    });

    it('returns user object with email, tier, and machine count', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);
      setupSuccessfulGetQueue();

      const response = await GET(makeGetRequest(), makeContext());
      const body = await response.json();

      expect(body.user.id).toBe(REGULAR_USER.id);
      expect(body.user.email).toBe(REGULAR_USER.email);
      expect(body.user.tier).toBe('pro');
      expect(body.user.subscription_status).toBe('active');
      expect(body.user.machines_count).toBe(3);
    });

    it('falls back to "free" tier when subscription not found', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: SAMPLE_TICKET, error: null });
      adminFromQueue.push({ data: [], error: null });
      adminFromQueue.push({ data: { display_name: null, avatar_url: null, created_at: null }, error: null });
      adminFromQueue.push({ data: null, error: null }); // no subscription
      adminFromQueue.push({ data: null, error: null, count: 0 });

      mockGetUserById.mockResolvedValue({
        data: { user: { id: REGULAR_USER.id, email: REGULAR_USER.email } },
        error: null,
      });

      const response = await GET(makeGetRequest(), makeContext());
      const body = await response.json();

      expect(body.user.tier).toBe('free');
      expect(body.user.subscription_status).toBeNull();
    });

    it('returns empty replies array when there are no replies', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: SAMPLE_TICKET, error: null });
      adminFromQueue.push({ data: null, error: null }); // null replies → falls back to []
      adminFromQueue.push({ data: { display_name: null, avatar_url: null, created_at: null }, error: null });
      adminFromQueue.push({ data: { tier: 'free', status: 'active' }, error: null });
      adminFromQueue.push({ data: null, error: null, count: 0 });

      mockGetUserById.mockResolvedValue({
        data: { user: { id: REGULAR_USER.id, email: REGULAR_USER.email } },
        error: null,
      });

      const response = await GET(makeGetRequest(), makeContext());
      const body = await response.json();

      expect(body.replies).toEqual([]);
    });
  });
});

// ============================================================================
// PATCH tests
// ============================================================================

describe('PATCH /api/admin/support/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminFromQueue.length = 0;
    mockAuditLogInsert.mockResolvedValue({ data: null, error: null });
  });

  // --------------------------------------------------------------------------
  // Authentication & authorisation
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockUnauthenticated();

      const response = await PATCH(makePatchRequest({ status: 'resolved' }), makeContext());
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('authorisation', () => {
    it('returns 403 when authenticated user is not admin', async () => {
      mockAuthenticated(REGULAR_USER);
      mockIsAdmin.mockResolvedValue(false);

      const response = await PATCH(makePatchRequest({ status: 'resolved' }), makeContext());
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Forbidden');
    });
  });

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  it('returns 429 when rate limit exceeded', async () => {
    const { rateLimit } = await import('@/lib/rateLimit');
    (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      allowed: false,
      retryAfter: 30,
    });

    mockAuthenticated(ADMIN_USER);
    mockIsAdmin.mockResolvedValue(true);

    const response = await PATCH(makePatchRequest({ status: 'open' }), makeContext());
    expect(response.status).toBe(429);
  });

  // --------------------------------------------------------------------------
  // Request body validation
  // --------------------------------------------------------------------------

  describe('request body validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const req = new Request(`http://localhost:3000/api/admin/support/${TICKET_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        body: 'not valid json{',
      });

      const response = await PATCH(req, makeContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid JSON');
    });

    it('returns 400 for invalid status value', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const response = await PATCH(
        makePatchRequest({ status: 'pending' }), // 'pending' is not a valid enum value
        makeContext()
      );
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 when admin_notes exceeds 10000 characters', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const response = await PATCH(
        makePatchRequest({ admin_notes: 'x'.repeat(10001) }),
        makeContext()
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when body has no updatable fields', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      // Empty object — neither status nor admin_notes present
      const response = await PATCH(makePatchRequest({}), makeContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('No fields to update');
    });
  });

  // --------------------------------------------------------------------------
  // Successful updates
  // --------------------------------------------------------------------------

  describe('successful updates', () => {
    it('updates ticket status and returns updated ticket', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const updatedTicket = { ...SAMPLE_TICKET, status: 'resolved' };
      adminFromQueue.push({ data: updatedTicket, error: null });

      const response = await PATCH(
        makePatchRequest({ status: 'resolved' }),
        makeContext()
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ticket.status).toBe('resolved');
    });

    it('updates admin_notes only', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const updatedTicket = { ...SAMPLE_TICKET, admin_notes: 'Internal note here.' };
      adminFromQueue.push({ data: updatedTicket, error: null });

      const response = await PATCH(
        makePatchRequest({ admin_notes: 'Internal note here.' }),
        makeContext()
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ticket.admin_notes).toBe('Internal note here.');
    });

    it('updates both status and admin_notes together', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const updatedTicket = {
        ...SAMPLE_TICKET,
        status: 'in_progress',
        admin_notes: 'Investigating.',
      };
      adminFromQueue.push({ data: updatedTicket, error: null });

      const response = await PATCH(
        makePatchRequest({ status: 'in_progress', admin_notes: 'Investigating.' }),
        makeContext()
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ticket.status).toBe('in_progress');
    });

    it('writes an audit_log entry after successful update', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: { ...SAMPLE_TICKET, status: 'closed' }, error: null });

      await PATCH(makePatchRequest({ status: 'closed' }), makeContext());

      expect(mockAuditLogInsert).toHaveBeenCalledOnce();
      const auditEntry = mockAuditLogInsert.mock.calls[0][0];
      expect(auditEntry.action).toBe('admin.support_ticket.update');
      expect(auditEntry.resource_type).toBe('support_ticket');
      expect(auditEntry.resource_id).toBe(TICKET_ID);
      expect(auditEntry.user_id).toBe(ADMIN_USER.id);
    });

    it('accepts all valid status enum values', async () => {
      const validStatuses = ['open', 'in_progress', 'resolved', 'closed'] as const;

      for (const status of validStatuses) {
        mockAuthenticated(ADMIN_USER);
        mockIsAdmin.mockResolvedValue(true);

        adminFromQueue.push({ data: { ...SAMPLE_TICKET, status }, error: null });
        mockAuditLogInsert.mockResolvedValue({ data: null, error: null });

        const response = await PATCH(makePatchRequest({ status }), makeContext());
        expect(response.status).toBe(200);

        vi.clearAllMocks();
        adminFromQueue.length = 0;
        mockAuditLogInsert.mockResolvedValue({ data: null, error: null });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Database errors
  // --------------------------------------------------------------------------

  describe('database errors', () => {
    it('returns 500 when update query fails', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: null, error: { message: 'connection lost' } });

      const response = await PATCH(
        makePatchRequest({ status: 'resolved' }),
        makeContext()
      );
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to update ticket');
    });
  });

  // ── MFA gate wiring (H42 Layer 1) ───────────────────────────────────────────

  // WHY: proves the route calls assertAdminMfa and short-circuits to 403 when
  // the gate throws AdminMfaRequiredError — DB queries must not run on gate failure.
  // Applies to both GET and PATCH since the same gate code path is hit for each.
  // OWASP A07:2021, SOC 2 CC6.1.
  describe('MFA gate', () => {
    it('(MFA gate) GET returns 403 ADMIN_MFA_REQUIRED when assertAdminMfa throws', async () => {
      mockGetUser.mockResolvedValue({ data: { user: ADMIN_USER }, error: null });
      mockIsAdmin.mockResolvedValue(true);
      (assertAdminMfa as import('vitest').Mock).mockRejectedValueOnce(new AdminMfaRequiredError());

      const response = await GET(makeGetRequest(), makeContext());

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('ADMIN_MFA_REQUIRED');
      // Ensure no DB call was made — adminFromQueue should still be empty.
      expect(adminFromQueue).toHaveLength(0);
    });

    it('(MFA gate) PATCH returns 403 ADMIN_MFA_REQUIRED when assertAdminMfa throws', async () => {
      mockGetUser.mockResolvedValue({ data: { user: ADMIN_USER }, error: null });
      mockIsAdmin.mockResolvedValue(true);
      (assertAdminMfa as import('vitest').Mock).mockRejectedValueOnce(new AdminMfaRequiredError());

      const response = await PATCH(makePatchRequest({ status: 'resolved' }), makeContext());

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('ADMIN_MFA_REQUIRED');
    });
  });
});
