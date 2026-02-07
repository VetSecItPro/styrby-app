/**
 * GET /api/v1/sessions/[id]/messages — Integration Tests
 *
 * Tests the session messages endpoint which returns paginated, filterable
 * E2E-encrypted message data for an API-key-authenticated user.
 *
 * WHY: Messages contain encrypted user/agent conversation data. The handler
 * first verifies session ownership before returning messages. This two-step
 * check prevents IDOR — a user cannot enumerate another user's messages
 * even if they know a valid session ID.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks — withApiAuth bypass
// ============================================================================

const mockAuthContext = {
  userId: 'test-user-123',
  keyId: 'key-id-456',
  scopes: ['read'],
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuth: vi.fn((handler: Function) => {
    return async (request: NextRequest) => handler(request, mockAuthContext);
  }),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

// ============================================================================
// Mocks — Supabase
// ============================================================================

const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'range', 'insert', 'update', 'delete', 'is', 'not', 'in',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    from: vi.fn(() => createChainMock()),
    rpc: vi.fn(),
  })),
}));

// ============================================================================
// Import route handler AFTER mocks
// ============================================================================

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const VALID_SESSION_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Creates a NextRequest for the messages endpoint.
 * URL format: /api/v1/sessions/[id]/messages
 *
 * @param sessionId - The session ID in the URL path
 * @param params - URL query parameters
 * @returns A NextRequest for GET /api/v1/sessions/[id]/messages
 */
function createRequest(
  sessionId: string,
  params: Record<string, string> = {}
): NextRequest {
  const url = new URL(`http://localhost:3000/api/v1/sessions/${sessionId}/messages`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer sk_live_test_key',
    },
  });
}

/**
 * Factory for mock message rows.
 *
 * @param overrides - Fields to override on the default message
 * @returns A message object matching the SELECT columns
 */
function mockMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-001',
    sequence_number: 1,
    parent_message_id: null,
    message_type: 'user_prompt',
    content_encrypted: 'base64-encrypted-content',
    encryption_nonce: 'base64-nonce',
    risk_level: null,
    permission_granted: null,
    tool_name: null,
    duration_ms: null,
    input_tokens: 500,
    output_tokens: 0,
    cache_tokens: 0,
    metadata: null,
    created_at: '2025-01-15T10:01:00Z',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/v1/sessions/[id]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuth } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuth).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 }
        );
      });

      vi.resetModules();
      const { GET: freshGET } = await import('../route');

      const response = await freshGET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Session ownership verification
  // --------------------------------------------------------------------------

  describe('session ownership', () => {
    it('returns 404 when session does not belong to user', async () => {
      // WHY: The handler first does a session ownership check. If the session
      // doesn't exist or belongs to another user, it returns 404 before
      // ever querying messages. This prevents IDOR attacks.
      fromCallQueue.push({ data: null, error: null }); // session lookup → null

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Session not found');
    });

    it('returns 400 for invalid session ID (not 36 chars)', async () => {
      const response = await GET(createRequest('short-id'));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid session ID');
    });
  });

  // --------------------------------------------------------------------------
  // Success cases
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    it('returns messages with pagination object', async () => {
      const messages = [
        mockMessage({ id: 'msg-001', sequence_number: 1 }),
        mockMessage({ id: 'msg-002', sequence_number: 2, message_type: 'agent_response' }),
      ];

      // 1. Session ownership check → found
      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      // 2. Messages query
      fromCallQueue.push({ data: messages, error: null, count: 2 });

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.messages).toHaveLength(2);
      expect(body.pagination).toEqual({
        total: 2,
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    });

    it('respects limit and offset parameters', async () => {
      const messages = [mockMessage({ id: 'msg-011', sequence_number: 11 })];

      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      fromCallQueue.push({ data: messages, error: null, count: 30 });

      const response = await GET(createRequest(VALID_SESSION_ID, { limit: '10', offset: '10' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.pagination.limit).toBe(10);
      expect(body.pagination.offset).toBe(10);
      // WHY: 30 total > 10 + 10 = 20, so hasMore is true
      expect(body.pagination.hasMore).toBe(true);
    });

    it('filters by message type', async () => {
      const messages = [
        mockMessage({ id: 'msg-003', message_type: 'tool_use', tool_name: 'file_edit' }),
      ];

      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      fromCallQueue.push({ data: messages, error: null, count: 1 });

      const response = await GET(createRequest(VALID_SESSION_ID, { type: 'tool_use' }));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].message_type).toBe('tool_use');
    });

    it('returns empty array for session with no messages', async () => {
      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      fromCallQueue.push({ data: [], error: null, count: 0 });

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.messages).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(body.pagination.hasMore).toBe(false);
    });

    it('returns encrypted content fields without decryption', async () => {
      // WHY: Messages are E2E encrypted. The API returns content_encrypted
      // and encryption_nonce as-is — decryption happens client-side.
      const messages = [
        mockMessage({
          content_encrypted: 'encrypted-payload-base64',
          encryption_nonce: 'nonce-base64',
        }),
      ];

      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      fromCallQueue.push({ data: messages, error: null, count: 1 });

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.messages[0].content_encrypted).toBe('encrypted-payload-base64');
      expect(body.messages[0].encryption_nonce).toBe('nonce-base64');
    });
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    it('returns 400 for invalid message type', async () => {
      // WHY: The Zod schema only allows specific message types.
      // Invalid types fail parse before the DB query runs.
      const response = await GET(createRequest(VALID_SESSION_ID, { type: 'invalid_type' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for limit exceeding 200', async () => {
      const response = await GET(createRequest(VALID_SESSION_ID, { limit: '201' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for negative offset', async () => {
      const response = await GET(createRequest(VALID_SESSION_ID, { offset: '-1' }));
      expect(response.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // Database errors
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 when messages query fails', async () => {
      fromCallQueue.push({ data: { id: VALID_SESSION_ID }, error: null });
      fromCallQueue.push({ data: null, error: { message: 'Connection timeout' } });

      const response = await GET(createRequest(VALID_SESSION_ID));
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch messages');
    });
  });
});
