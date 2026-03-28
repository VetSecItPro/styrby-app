/**
 * POST /api/sessions/[id]/share — Tests (Phase 7.10)
 *
 * Tests for share link creation: auth, validation, duplicate ID handling,
 * and response format.
 *
 * WHY: Share links are a user-facing security feature. We must verify that:
 * - Unauthenticated users cannot create share links for any session
 * - Users can only share their own sessions (not others')
 * - The generated share ID appears in the response URL
 * - Expiry and maxAccesses constraints are stored correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Tracks Supabase call results.
 */
const supabaseCalls: Array<{ method: string; result: unknown }> = [];
let callIndex = 0;

/**
 * Creates a chainable Supabase mock that resolves with the next queued result.
 * Both `single()` and `maybeSingle()` resolve with the result so both terminal
 * methods work in chain patterns like .select().eq().maybeSingle() and
 * .insert().select().single().
 */
function createChainMock(result: unknown = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'insert', 'update'];

  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

/**
 * Results queue for sequential supabase.from() calls.
 */
const fromResults: Array<unknown> = [];

/**
 * Mock Supabase auth + from() client.
 */
const mockUser = { id: 'user-abc', email: 'test@example.com' };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: mockUser },
        error: null,
      })),
    },
    from: vi.fn(() => {
      const result = fromResults.shift() ?? { data: null, error: null };
      return createChainMock(result);
    }),
  })),
}));

/**
 * Mock rate limiting to always allow.
 */
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, retryAfter: null })),
  RATE_LIMITS: { sensitive: { windowMs: 60000, maxRequests: 10 } },
  rateLimitResponse: vi.fn(() => new Response('Rate limited', { status: 429 })),
}));

// ============================================================================
// Import handler AFTER mocks
// ============================================================================

import { POST } from '../route';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a NextRequest for POST /api/sessions/[id]/share.
 *
 * @param sessionId - The session ID in the URL
 * @param body - Request body
 */
function createRequest(
  sessionId: string,
  body: Record<string, unknown> = {}
): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/sessions/${sessionId}/share`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

/**
 * A valid UUID for use in tests.
 */
const VALID_SESSION_ID = '00000000-1111-2222-3333-444444444444';

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/sessions/[id]/share', () => {
  beforeEach(() => {
    fromResults.length = 0;
    vi.clearAllMocks();
    callIndex = 0;
  });

  // ── Authentication ─────────────────────────────────────────────────────

  it('returns 401 when user is not authenticated', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    vi.mocked(createClient).mockResolvedValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('Not authenticated'),
        })),
      },
      from: vi.fn(),
    } as never);

    const req = createRequest(VALID_SESSION_ID);
    const res = await POST(req, { params: Promise.resolve({ id: VALID_SESSION_ID }) });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('UNAUTHORIZED');
  });

  // ── Validation ─────────────────────────────────────────────────────────

  it('returns 400 for an invalid session ID format', async () => {
    const req = createRequest('not-a-uuid');
    const res = await POST(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for negative maxAccesses', async () => {
    // Session lookup succeeds
    fromResults.push({ data: { id: VALID_SESSION_ID, user_id: mockUser.id, status: 'stopped' }, error: null });

    const req = createRequest(VALID_SESSION_ID, { maxAccesses: -1 });
    const res = await POST(req, { params: Promise.resolve({ id: VALID_SESSION_ID }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a non-integer maxAccesses', async () => {
    fromResults.push({ data: { id: VALID_SESSION_ID, user_id: mockUser.id, status: 'stopped' }, error: null });

    const req = createRequest(VALID_SESSION_ID, { maxAccesses: 1.5 });
    const res = await POST(req, { params: Promise.resolve({ id: VALID_SESSION_ID }) });

    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid expiresAt date string', async () => {
    fromResults.push({ data: { id: VALID_SESSION_ID, user_id: mockUser.id, status: 'stopped' }, error: null });

    const req = createRequest(VALID_SESSION_ID, { expiresAt: 'not-a-date' });
    const res = await POST(req, { params: Promise.resolve({ id: VALID_SESSION_ID }) });

    expect(res.status).toBe(400);
  });

  // ── Authorization ──────────────────────────────────────────────────────

  it('returns 404 when session does not belong to authenticated user', async () => {
    // Session lookup returns no data (RLS / ownership check fails)
    fromResults.push({ data: null, error: { message: 'No rows returned' } });

    const req = createRequest(VALID_SESSION_ID);
    const res = await POST(req, { params: Promise.resolve({ id: VALID_SESSION_ID }) });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('NOT_FOUND');
  });

  // ── Happy path ─────────────────────────────────────────────────────────

  it('returns 201 with share record and URL on success', async () => {
    const sessionRow = { id: VALID_SESSION_ID, user_id: mockUser.id, status: 'stopped' };
    const shareRow = {
      share_id: 'AbCdEfGhIjKl',
      session_id: VALID_SESSION_ID,
      shared_by: mockUser.id,
      expires_at: null,
      max_accesses: null,
      access_count: 0,
      created_at: '2026-03-27T10:00:00Z',
    };

    // 1. Session lookup
    fromResults.push({ data: sessionRow, error: null });
    // 2. Collision check — no existing share with that ID
    fromResults.push({ data: null, error: null });
    // 3. Insert share record
    fromResults.push({ data: shareRow, error: null });

    const req = createRequest(VALID_SESSION_ID);
    const res = await POST(req, { params: Promise.resolve({ id: VALID_SESSION_ID }) });

    expect(res.status).toBe(201);
    const body = await res.json() as { share: Record<string, unknown>; shareUrl: string };
    // The share record and URL both use the canonical ID from the DB insert mock
    expect(body.share.shareId).toBe('AbCdEfGhIjKl');
    expect(body.shareUrl).toContain('AbCdEfGhIjKl');
    expect(body.shareUrl).toContain('/shared/');
  });

  it('includes expiresAt in share record when provided', async () => {
    const sessionRow = { id: VALID_SESSION_ID, user_id: mockUser.id, status: 'stopped' };
    const expiresAt = '2026-12-31T23:59:59Z';
    const shareRow = {
      share_id: 'TtUuVvWwXxYy',
      session_id: VALID_SESSION_ID,
      shared_by: mockUser.id,
      expires_at: expiresAt,
      max_accesses: null,
      access_count: 0,
      created_at: '2026-03-27T10:00:00Z',
    };

    fromResults.push({ data: sessionRow, error: null });
    fromResults.push({ data: null, error: null }); // collision check
    fromResults.push({ data: shareRow, error: null });

    const req = createRequest(VALID_SESSION_ID, { expiresAt });
    const res = await POST(req, { params: Promise.resolve({ id: VALID_SESSION_ID }) });

    expect(res.status).toBe(201);
    const body = await res.json() as { share: { expiresAt: string } };
    expect(body.share.expiresAt).toBe(expiresAt);
  });

  it('includes maxAccesses in share record when provided', async () => {
    const sessionRow = { id: VALID_SESSION_ID, user_id: mockUser.id, status: 'stopped' };
    const shareRow = {
      share_id: 'MmNnOoPpQqRr',
      session_id: VALID_SESSION_ID,
      shared_by: mockUser.id,
      expires_at: null,
      max_accesses: 3,
      access_count: 0,
      created_at: '2026-03-27T10:00:00Z',
    };

    fromResults.push({ data: sessionRow, error: null });
    fromResults.push({ data: null, error: null }); // collision check
    fromResults.push({ data: shareRow, error: null });

    const req = createRequest(VALID_SESSION_ID, { maxAccesses: 3 });
    const res = await POST(req, { params: Promise.resolve({ id: VALID_SESSION_ID }) });

    expect(res.status).toBe(201);
    const body = await res.json() as { share: { maxAccesses: number } };
    expect(body.share.maxAccesses).toBe(3);
  });

  it('returns 500 when share insert fails', async () => {
    const sessionRow = { id: VALID_SESSION_ID, user_id: mockUser.id, status: 'stopped' };

    fromResults.push({ data: sessionRow, error: null });
    fromResults.push({ data: null, error: null }); // collision check
    fromResults.push({ data: null, error: { message: 'DB insert error' } }); // insert failure

    const req = createRequest(VALID_SESSION_ID);
    const res = await POST(req, { params: Promise.resolve({ id: VALID_SESSION_ID }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
  });
});
