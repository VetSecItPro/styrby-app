/**
 * Tests for POST /api/sessions/groups/[groupId]/focus
 *
 * Covers:
 *   - Authentication enforcement (401 when not authenticated)
 *   - Path param validation (400 for non-UUID groupId)
 *   - Body validation (400 for missing/non-UUID sessionId)
 *   - Group ownership check (403 when group not found or wrong user)
 *   - Session membership check (404 when sessionId not in group)
 *   - Happy path (200 with updated group record)
 *   - DB update failure (500)
 *   - Rate limiting (429)
 *
 * Uses the fromCallQueue mock pattern from the established API test suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Supabase mock ──────────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const fromCallQueue: Array<{ data?: unknown; error?: unknown }> = [];

function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const method of [
    'select', 'eq', 'order', 'limit', 'insert', 'update', 'delete',
    'is', 'not', 'single', 'rpc',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain['single'] = vi.fn().mockResolvedValue(result);
  // .then() for audit log fire-and-forget (.insert(...).then(...))
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => createChainMock()),
  })),
}));

// ── Rate limit mock (allow by default) ────────────────────────────────────

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(async () => ({
    allowed: true,
    retryAfter: undefined,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  })),
  RATE_LIMITS: { budgetAlerts: { windowMs: 60_000, maxRequests: 30 } },
  rateLimitResponse: vi.fn(() =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429 })
  ),
}));

// ── Shared apiError mock ───────────────────────────────────────────────────

vi.mock('@styrby/shared', () => ({
  apiError: vi.fn((code: string, message: string, meta?: unknown) => ({
    error: code,
    message,
    ...(meta ?? {}),
  })),
}));

// ── Import handler AFTER mocks ─────────────────────────────────────────────

import { POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const GROUP_ID  = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID   = '33333333-3333-3333-3333-333333333333';

function makeRequest(
  groupId: string,
  body: unknown,
  options: { authHeader?: string } = {}
): NextRequest {
  const url = `http://localhost:3000/api/sessions/groups/${groupId}/focus`;
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.authHeader ? { Authorization: options.authHeader } : {}),
    },
    body: JSON.stringify(body),
  });
}

function makeContext(groupId: string) {
  return { params: Promise.resolve({ groupId }) };
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/sessions/groups/[groupId]/focus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // ── 401 ──────────────────────────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    const req = makeRequest(GROUP_ID, { sessionId: SESSION_ID });
    const res = await POST(req, makeContext(GROUP_ID));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('UNAUTHORIZED');
  });

  it('returns 401 when auth error', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error('JWT expired'),
    });

    const req = makeRequest(GROUP_ID, { sessionId: SESSION_ID });
    const res = await POST(req, makeContext(GROUP_ID));

    expect(res.status).toBe(401);
  });

  // ── 400 ──────────────────────────────────────────────────────────────────

  it('returns 400 when groupId is not a valid UUID', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: USER_ID } },
      error: null,
    });

    const req = makeRequest('not-a-uuid', { sessionId: SESSION_ID });
    const res = await POST(req, makeContext('not-a-uuid'));

    expect(res.status).toBe(400);
  });

  it('returns 400 when sessionId is missing from body', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: USER_ID } },
      error: null,
    });

    const req = makeRequest(GROUP_ID, {});
    const res = await POST(req, makeContext(GROUP_ID));

    expect(res.status).toBe(400);
  });

  it('returns 400 when sessionId is not a valid UUID', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: USER_ID } },
      error: null,
    });

    const req = makeRequest(GROUP_ID, { sessionId: 'not-a-uuid' });
    const res = await POST(req, makeContext(GROUP_ID));

    expect(res.status).toBe(400);
  });

  it('returns 400 when body is missing entirely', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: USER_ID } },
      error: null,
    });

    const url = `http://localhost:3000/api/sessions/groups/${GROUP_ID}/focus`;
    const req = new NextRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No body
    });

    const res = await POST(req, makeContext(GROUP_ID));
    expect(res.status).toBe(400);
  });

  // ── 403 ──────────────────────────────────────────────────────────────────

  it('returns 403 when group is not found', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: USER_ID } },
      error: null,
    });

    // Group lookup returns null
    fromCallQueue.push({ data: null, error: { message: 'No rows' } });

    const req = makeRequest(GROUP_ID, { sessionId: SESSION_ID });
    const res = await POST(req, makeContext(GROUP_ID));

    expect(res.status).toBe(403);
  });

  it('returns 403 when group belongs to a different user', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: USER_ID } },
      error: null,
    });

    // Group query with user_id filter returns nothing (RLS/ownership mismatch)
    fromCallQueue.push({ data: null, error: { message: 'No rows' } });

    const req = makeRequest(GROUP_ID, { sessionId: SESSION_ID });
    const res = await POST(req, makeContext(GROUP_ID));

    expect(res.status).toBe(403);
  });

  // ── 404 ──────────────────────────────────────────────────────────────────

  it('returns 404 when sessionId is not in the group', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: USER_ID } },
      error: null,
    });

    // Group found
    fromCallQueue.push({ data: { id: GROUP_ID, user_id: USER_ID }, error: null });
    // Session not found in group
    fromCallQueue.push({ data: null, error: { message: 'No rows' } });

    const req = makeRequest(GROUP_ID, { sessionId: SESSION_ID });
    const res = await POST(req, makeContext(GROUP_ID));

    expect(res.status).toBe(404);
  });

  // ── 200 (happy path) ─────────────────────────────────────────────────────

  it('returns 200 with updated group fields on success', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: USER_ID } },
      error: null,
    });

    const now = new Date().toISOString();

    // Group found
    fromCallQueue.push({ data: { id: GROUP_ID, user_id: USER_ID }, error: null });
    // Session found in group
    fromCallQueue.push({ data: { id: SESSION_ID, session_group_id: GROUP_ID }, error: null });
    // Group update succeeds
    fromCallQueue.push({
      data: { id: GROUP_ID, active_agent_session_id: SESSION_ID, updated_at: now },
      error: null,
    });

    const req = makeRequest(GROUP_ID, { sessionId: SESSION_ID });
    const res = await POST(req, makeContext(GROUP_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.groupId).toBe(GROUP_ID);
    expect(body.activeSessionId).toBe(SESSION_ID);
    expect(body.updatedAt).toBe(now);
  });

  // ── 500 ──────────────────────────────────────────────────────────────────

  it('returns 500 when the DB update fails', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: USER_ID } },
      error: null,
    });

    // Group found
    fromCallQueue.push({ data: { id: GROUP_ID, user_id: USER_ID }, error: null });
    // Session found in group
    fromCallQueue.push({ data: { id: SESSION_ID, session_group_id: GROUP_ID }, error: null });
    // DB update fails
    fromCallQueue.push({ data: null, error: { message: 'DB error' } });

    const req = makeRequest(GROUP_ID, { sessionId: SESSION_ID });
    const res = await POST(req, makeContext(GROUP_ID));

    expect(res.status).toBe(500);
  });

  // ── 429 ──────────────────────────────────────────────────────────────────

  it('returns 429 when rate limit is exceeded', async () => {
    const { rateLimit } = await import('@/lib/rateLimit');
    vi.mocked(rateLimit).mockResolvedValueOnce({
      allowed: false,
      retryAfter: 30,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });

    const req = makeRequest(GROUP_ID, { sessionId: SESSION_ID });
    const res = await POST(req, makeContext(GROUP_ID));

    expect(res.status).toBe(429);
  });
});
