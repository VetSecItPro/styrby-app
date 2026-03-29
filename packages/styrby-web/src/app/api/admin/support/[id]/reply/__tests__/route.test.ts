/**
 * Admin Support Ticket Reply API Tests
 *
 * Tests POST /api/admin/support/[id]/reply
 *
 * Verifies:
 * - Unauthenticated requests return 401
 * - Non-admin authenticated users return 403
 * - Invalid JSON body returns 400
 * - Missing or empty message returns 400
 * - Message exceeding 5000 characters returns 400
 * - Ticket not found returns 404
 * - Successful reply returns 201 with reply and emailSent flag
 * - Reply is inserted into support_ticket_replies via admin client
 * - Audit log entry is written for every reply
 * - Email is sent to ticket owner (emailSent: true on success)
 * - emailSent is false when ticket owner has no email
 * - Rate limiting returns 429 when exceeded
 *
 * WHY: Replies are sent on behalf of the company to users who filed support
 * tickets. Mistakes here (wrong auth gate, missing audit trail, broken email)
 * directly harm user trust. Comprehensive tests guard against regressions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();
const mockIsAdmin = vi.fn();

/**
 * Queue for sequential admin client from() calls.
 * POST /reply calls:
 * 1. support_tickets (verify ticket exists)
 * 2. support_ticket_replies (insert reply)
 */
const adminFromQueue: Array<{ data?: unknown; error?: unknown }> = [];

/** Tracks audit_log.insert calls */
const mockAuditLogInsert = vi.fn().mockResolvedValue({ data: null, error: null });

/** Tracks getUserById (for looking up ticket owner email) */
const mockGetUserById = vi.fn();

/** Tracks sendSupportReplyEmail calls */
const mockSendSupportReplyEmail = vi.fn();

function createAdminChainMock() {
  const result = adminFromQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'lte', 'order', 'limit', 'update',
    'delete', 'is', 'not', 'in', 'range',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['insert'] = vi.fn().mockReturnValue({
    ...chain,
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue(result),
    }),
  });

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'audit_log') {
        return { insert: mockAuditLogInsert };
      }
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

vi.mock('@/lib/resend', () => ({
  sendSupportReplyEmail: (...args: unknown[]) => mockSendSupportReplyEmail(...args),
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

import { POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const TICKET_ID = 'ticket-uuid-reply-001';
const ADMIN_USER = { id: 'admin-uuid-001', email: 'admin@styrby.com' };
const REGULAR_USER = { id: 'user-uuid-002', email: 'user@example.com' };

const SAMPLE_TICKET = {
  id: TICKET_ID,
  user_id: REGULAR_USER.id,
  subject: 'My CLI keeps crashing',
};

const SAMPLE_REPLY = {
  id: 'reply-uuid-001',
  ticket_id: TICKET_ID,
  author_type: 'admin',
  author_id: ADMIN_USER.id,
  message: 'We have identified the issue and will release a fix soon.',
  created_at: '2025-03-05T14:00:00Z',
};

/**
 * Creates the Next.js 15 async params route context.
 *
 * @param id - Ticket ID for the [id] dynamic segment
 */
function makeContext(id: string = TICKET_ID) {
  return { params: Promise.resolve({ id }) };
}

function makePostRequest(body: Record<string, unknown>): Request {
  return new Request(
    `http://localhost:3000/api/admin/support/${TICKET_ID}/reply`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '10.0.0.1',
      },
      body: JSON.stringify(body),
    }
  );
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

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/admin/support/[id]/reply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminFromQueue.length = 0;
    mockAuditLogInsert.mockResolvedValue({ data: null, error: null });

    // Default: email sends successfully
    mockSendSupportReplyEmail.mockResolvedValue({ success: true });
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockUnauthenticated();

      const response = await POST(
        makePostRequest({ message: 'Hello' }),
        makeContext()
      );
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 401 when auth.getUser returns an error', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'JWT malformed' },
      });

      const response = await POST(
        makePostRequest({ message: 'Hello' }),
        makeContext()
      );
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Authorisation
  // --------------------------------------------------------------------------

  describe('authorisation', () => {
    it('returns 403 when authenticated user is not admin', async () => {
      mockAuthenticated(REGULAR_USER);
      mockIsAdmin.mockResolvedValue(false);

      const response = await POST(
        makePostRequest({ message: 'A reply from a non-admin.' }),
        makeContext()
      );
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toBe('Forbidden');
    });

    it('calls isAdmin with the authenticated user ID', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(false);

      await POST(makePostRequest({ message: 'Hello' }), makeContext());

      expect(mockIsAdmin).toHaveBeenCalledWith(ADMIN_USER.id);
    });
  });

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      const { rateLimit } = await import('@/lib/rateLimit');
      (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        allowed: false,
        retryAfter: 45,
      });

      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const response = await POST(
        makePostRequest({ message: 'Hello' }),
        makeContext()
      );
      expect(response.status).toBe(429);
    });
  });

  // --------------------------------------------------------------------------
  // Request body validation
  // --------------------------------------------------------------------------

  describe('request body validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const req = new Request(
        `http://localhost:3000/api/admin/support/${TICKET_ID}/reply`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-forwarded-for': '10.0.0.1',
          },
          body: '{invalid json',
        }
      );

      const response = await POST(req, makeContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid JSON');
    });

    it('returns 400 when message is missing', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const response = await POST(makePostRequest({}), makeContext());
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('Message is required');
    });

    it('returns 400 when message is an empty string', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const response = await POST(makePostRequest({ message: '' }), makeContext());
      expect(response.status).toBe(400);
    });

    it('returns 400 when message exceeds 5000 characters', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      const response = await POST(
        makePostRequest({ message: 'x'.repeat(5001) }),
        makeContext()
      );
      expect(response.status).toBe(400);
    });

    it('accepts a message at exactly 5000 characters (boundary)', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      // ticket lookup
      adminFromQueue.push({ data: SAMPLE_TICKET, error: null });
      // reply insert
      adminFromQueue.push({ data: { ...SAMPLE_REPLY, message: 'x'.repeat(5000) }, error: null });

      mockGetUserById.mockResolvedValue({
        data: { user: { id: REGULAR_USER.id, email: REGULAR_USER.email } },
        error: null,
      });

      const response = await POST(
        makePostRequest({ message: 'x'.repeat(5000) }),
        makeContext()
      );
      expect(response.status).toBe(201);
    });
  });

  // --------------------------------------------------------------------------
  // Ticket not found
  // --------------------------------------------------------------------------

  it('returns 404 when ticket does not exist', async () => {
    mockAuthenticated(ADMIN_USER);
    mockIsAdmin.mockResolvedValue(true);

    // support_tickets lookup → not found
    adminFromQueue.push({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

    const response = await POST(
      makePostRequest({ message: 'Hello, can you help?' }),
      makeContext()
    );
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe('Ticket not found');
  });

  // --------------------------------------------------------------------------
  // Successful reply
  // --------------------------------------------------------------------------

  describe('successful reply', () => {
    function setupSuccessfulPost() {
      // 1. ticket lookup
      adminFromQueue.push({ data: SAMPLE_TICKET, error: null });
      // 2. reply insert
      adminFromQueue.push({ data: SAMPLE_REPLY, error: null });

      // getUserById for email notification
      mockGetUserById.mockResolvedValue({
        data: { user: { id: REGULAR_USER.id, email: REGULAR_USER.email } },
        error: null,
      });
    }

    it('returns 201 with the new reply', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);
      setupSuccessfulPost();

      const response = await POST(
        makePostRequest({ message: 'We have identified the issue and will release a fix soon.' }),
        makeContext()
      );
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.reply).toBeDefined();
      expect(body.reply.id).toBe(SAMPLE_REPLY.id);
      expect(body.reply.author_type).toBe('admin');
    });

    it('returns emailSent: true when email is delivered', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);
      setupSuccessfulPost();

      mockSendSupportReplyEmail.mockResolvedValue({ success: true });

      const response = await POST(
        makePostRequest({ message: 'Your issue has been resolved.' }),
        makeContext()
      );
      const body = await response.json();

      expect(body.emailSent).toBe(true);
    });

    it('returns emailSent: false when sendSupportReplyEmail fails', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);
      setupSuccessfulPost();

      mockSendSupportReplyEmail.mockResolvedValue({ success: false });

      const response = await POST(
        makePostRequest({ message: 'Your issue is being looked at.' }),
        makeContext()
      );
      const body = await response.json();

      expect(body.emailSent).toBe(false);
    });

    it('returns emailSent: false when ticket owner has no email', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: SAMPLE_TICKET, error: null });
      adminFromQueue.push({ data: SAMPLE_REPLY, error: null });

      // getUserById returns user with no email
      mockGetUserById.mockResolvedValue({
        data: { user: { id: REGULAR_USER.id, email: '' } },
        error: null,
      });

      const response = await POST(
        makePostRequest({ message: 'Hi there.' }),
        makeContext()
      );
      const body = await response.json();

      // Email cannot be sent without an address
      expect(mockSendSupportReplyEmail).not.toHaveBeenCalled();
      expect(body.emailSent).toBe(false);
    });

    it('returns emailSent: false when getUserById returns no user', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      adminFromQueue.push({ data: SAMPLE_TICKET, error: null });
      adminFromQueue.push({ data: SAMPLE_REPLY, error: null });

      mockGetUserById.mockResolvedValue({ data: { user: null }, error: null });

      const response = await POST(
        makePostRequest({ message: 'Checking in.' }),
        makeContext()
      );
      const body = await response.json();

      expect(body.emailSent).toBe(false);
    });

    it('calls sendSupportReplyEmail with correct parameters', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);
      setupSuccessfulPost();

      const message = 'We have resolved your issue.';

      await POST(makePostRequest({ message }), makeContext());

      expect(mockSendSupportReplyEmail).toHaveBeenCalledWith({
        email: REGULAR_USER.email,
        subject: SAMPLE_TICKET.subject,
        message,
        ticketId: TICKET_ID,
      });
    });

    it('writes an audit_log entry for every reply', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);
      setupSuccessfulPost();

      const message = 'Audited reply message.';
      await POST(makePostRequest({ message }), makeContext());

      expect(mockAuditLogInsert).toHaveBeenCalledOnce();
      const auditEntry = mockAuditLogInsert.mock.calls[0][0];
      expect(auditEntry.action).toBe('admin.support_ticket.reply');
      expect(auditEntry.resource_type).toBe('support_ticket');
      expect(auditEntry.resource_id).toBe(TICKET_ID);
      expect(auditEntry.user_id).toBe(ADMIN_USER.id);
      expect(auditEntry.metadata.message_length).toBe(message.length);
    });
  });

  // --------------------------------------------------------------------------
  // Database errors
  // --------------------------------------------------------------------------

  describe('database errors', () => {
    it('returns 500 when reply insert fails', async () => {
      mockAuthenticated(ADMIN_USER);
      mockIsAdmin.mockResolvedValue(true);

      // Ticket found
      adminFromQueue.push({ data: SAMPLE_TICKET, error: null });
      // Insert fails
      adminFromQueue.push({ data: null, error: { message: 'insert failed' } });

      const response = await POST(
        makePostRequest({ message: 'Try to insert this.' }),
        makeContext()
      );
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to add reply');
    });
  });
});
