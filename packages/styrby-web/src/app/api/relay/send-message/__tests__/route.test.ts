/**
 * Send Message API Route Integration Tests
 *
 * Tests POST /api/relay/send-message
 *
 * WHY: This endpoint handles encrypted user messages and enforces budget hard stops.
 * Bugs here could allow messages to ended sessions, bypass E2E encryption requirements,
 * or fail to enforce hard_stop budget alerts (letting users spend beyond limits).
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
 * WHY: The send-message route calls supabase.from() multiple times (sessions table,
 * budget_alerts table, cost_records table). Each call needs different mock data.
 * This queue approach handles the sequencing automatically.
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase query builder mock.
 * Every chainable method (select, eq, gte, etc.) returns `this`.
 * Terminal methods (single, then) resolve with the next result from the queue.
 */
function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  // Chainable methods return the chain itself
  for (const method of ['select', 'eq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit', 'insert', 'update', 'delete', 'is', 'not', 'in']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  // Terminal methods resolve with the queued result
  chain['single'] = vi.fn().mockResolvedValue(result);
  // Make the chain thenable for await without .single()
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

function createNextRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/relay/send-message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    body: JSON.stringify(body),
  });
}

const AUTH_USER = { id: 'user-uuid-123', email: 'test@example.com' };
const SESSION_ID = '00000000-0000-0000-0000-000000000001';
const VALID_ENCRYPTED_CONTENT = 'encrypted_content_base64_example';
const VALID_NONCE = 'nonce_base64_example';

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

describe('POST /api/relay/send-message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // Authentication
  // --------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticated();
    const req = createNextRequest({
      sessionId: SESSION_ID,
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe('UNAUTHORIZED');
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  it('returns 400 for missing sessionId', async () => {
    mockAuthenticated();
    const req = createNextRequest({
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-UUID sessionId', async () => {
    mockAuthenticated();
    const req = createNextRequest({
      sessionId: 'not-a-uuid',
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid session ID');
  });

  it('returns 400 for missing content_encrypted', async () => {
    mockAuthenticated();
    const req = createNextRequest({
      sessionId: SESSION_ID,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    // Zod returns "Required" for missing required fields
    expect(body.message).toBe('Required');
  });

  it('returns 400 for missing encryption_nonce', async () => {
    mockAuthenticated();
    const req = createNextRequest({
      sessionId: SESSION_ID,
      content_encrypted: VALID_ENCRYPTED_CONTENT,
    });
    const response = await POST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    // Zod returns "Required" for missing required fields
    expect(body.message).toBe('Required');
  });

  // --------------------------------------------------------------------------
  // Session Access Control
  // --------------------------------------------------------------------------

  it('returns 403 when session not found', async () => {
    mockAuthenticated();

    // sessions.select().eq().eq().single() → not found
    fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

    const req = createNextRequest({
      sessionId: SESSION_ID,
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe('FORBIDDEN');
    expect(body.message).toContain('Session not found or access denied');
  });

  it('returns 403 when session belongs to different user (RLS)', async () => {
    mockAuthenticated();

    // FIX-025: Explicit user_id filter should catch this, but RLS also enforces it
    // sessions.select().eq(id).eq(user_id).single() → null (no rows)
    fromCallQueue.push({ data: null, error: null });

    const req = createNextRequest({
      sessionId: SESSION_ID,
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe('FORBIDDEN');
  });

  // --------------------------------------------------------------------------
  // Session Status Validation
  // --------------------------------------------------------------------------

  it('returns 400 when session status is "ended"', async () => {
    mockAuthenticated();

    // sessions.select().eq().eq().single() → ended session
    fromCallQueue.push({
      data: { id: SESSION_ID, status: 'ended', user_id: AUTH_USER.id },
      error: null,
    });

    const req = createNextRequest({
      sessionId: SESSION_ID,
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Cannot send messages to an ended session');
  });

  it('returns 400 when session status is "error"', async () => {
    mockAuthenticated();

    // sessions.select().eq().eq().single() → error status
    fromCallQueue.push({
      data: { id: SESSION_ID, status: 'error', user_id: AUTH_USER.id },
      error: null,
    });

    const req = createNextRequest({
      sessionId: SESSION_ID,
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  // --------------------------------------------------------------------------
  // Budget Hard Stop (FIX-034)
  // --------------------------------------------------------------------------

  it('returns 403 BUDGET_EXCEEDED when hard_stop threshold is met', async () => {
    mockAuthenticated();

    // 1. sessions.select().eq().eq().single() → active session
    fromCallQueue.push({
      data: { id: SESSION_ID, status: 'running', user_id: AUTH_USER.id },
      error: null,
    });

    // 2. budget_alerts.select().eq().eq().eq().limit() → 1 hard_stop alert
    fromCallQueue.push({
      data: [{ id: 'alert-1', threshold_usd: 10, period: 'daily' }],
      error: null,
    });

    // 3. cost_records.select().eq().gte().limit() → total spend $10.50 (exceeds threshold)
    fromCallQueue.push({
      data: [
        { cost_usd: 5.00 },
        { cost_usd: 3.50 },
        { cost_usd: 2.00 },
      ],
      error: null,
    });

    const req = createNextRequest({
      sessionId: SESSION_ID,
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe('BUDGET_EXCEEDED');
    expect(body.message).toContain('Budget hard stop limit reached');
  });

  it('returns 200 when no hard_stop alerts exist', async () => {
    mockAuthenticated();

    // 1. sessions.select().eq().eq().single() → active session
    fromCallQueue.push({
      data: { id: SESSION_ID, status: 'running', user_id: AUTH_USER.id },
      error: null,
    });

    // 2. budget_alerts.select().eq().eq().eq().limit() → no hard_stop alerts
    fromCallQueue.push({
      data: [],
      error: null,
    });

    // 3. rpc('insert_session_message') → success
    mockRpc.mockResolvedValue({
      data: [{ id: 'new-message-id' }],
      error: null,
    });

    const req = createNextRequest({
      sessionId: SESSION_ID,
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.id).toBe('new-message-id');
  });

  // --------------------------------------------------------------------------
  // Success Cases
  // --------------------------------------------------------------------------

  it('returns 200 success with message ID when all validations pass', async () => {
    mockAuthenticated();

    // 1. sessions.select().eq().eq().single() → active session
    fromCallQueue.push({
      data: { id: SESSION_ID, status: 'idle', user_id: AUTH_USER.id },
      error: null,
    });

    // 2. budget_alerts.select().eq().eq().eq().limit() → no alerts
    fromCallQueue.push({
      data: [],
      error: null,
    });

    // 3. rpc('insert_session_message') → success
    mockRpc.mockResolvedValue({
      data: [{ id: 'msg-12345' }],
      error: null,
    });

    const req = createNextRequest({
      sessionId: SESSION_ID,
      content_encrypted: VALID_ENCRYPTED_CONTENT,
      encryption_nonce: VALID_NONCE,
    });
    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.id).toBe('msg-12345');

    // Verify RPC was called with correct parameters
    expect(mockRpc).toHaveBeenCalledWith('insert_session_message', {
      p_session_id: SESSION_ID,
      p_message_type: 'user_prompt',
      p_content_encrypted: VALID_ENCRYPTED_CONTENT,
      p_encryption_nonce: VALID_NONCE,
      p_metadata: expect.objectContaining({
        source: 'web',
        timestamp: expect.any(String),
      }),
    });
  });
});
