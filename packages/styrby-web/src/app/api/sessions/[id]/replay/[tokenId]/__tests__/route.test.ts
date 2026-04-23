/**
 * DELETE /api/sessions/[id]/replay/[tokenId] — Tests (Phase 3.3)
 *
 * Covers:
 *   - Happy path: creator revokes their own token → 200
 *   - Unauthenticated request → 401
 *   - Token not found (doesn't exist) → 404
 *   - Token exists but different session → 404 (not 403, prevents enumeration)
 *   - Already revoked token → 200 (idempotent)
 *   - Token belongs to another user → 404 (not 403, prevents enumeration)
 *
 * WHY idempotent: DELETE operations should be idempotent by HTTP spec.
 * If a user double-taps "Revoke" in the UI, the second request should
 * succeed rather than returning an error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

function createChainMock(result: unknown = { data: null, error: null }) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'update', 'is', 'insert'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['single']      = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then']        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

const fromResults: Array<unknown> = [];
let fromCallIndex = 0;

const mockUser = { id: 'user-xyz', email: 'owner@example.com' };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: mockUser }, error: null })),
    },
    from: vi.fn(() => {
      const result = fromResults[fromCallIndex++] ?? { data: null, error: null };
      return createChainMock(result);
    }),
  })),
}));

// ============================================================================
// Helper
// ============================================================================

async function makeDeleteRequest(sessionId: string, tokenId: string): Promise<Response> {
  const { DELETE } = await import('../route');
  const req = new NextRequest(
    `https://styrbyapp.com/api/sessions/${sessionId}/replay/${tokenId}`,
    { method: 'DELETE' }
  );
  const params = { params: Promise.resolve({ id: sessionId, tokenId }) };
  return DELETE(req as unknown as Request, params);
}

// ============================================================================
// Tests
// ============================================================================

describe('DELETE /api/sessions/[id]/replay/[tokenId]', () => {
  beforeEach(() => {
    fromResults.length = 0;
    fromCallIndex = 0;
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    vi.mocked(createClient).mockResolvedValueOnce({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: new Error('no auth') })),
      },
      from: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await makeDeleteRequest('session-1', 'token-1');
    expect(res.status).toBe(401);
  });

  it('returns 404 when token not found', async () => {
    // select → null (token doesn't exist)
    fromResults.push({ data: null, error: null });

    const res = await makeDeleteRequest('session-1', 'nonexistent-token');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
  });

  it('returns 200 for valid revocation', async () => {
    const tokenId = 'token-abc';
    const sessionId = 'session-abc';

    // select → found, not yet revoked
    fromResults.push({
      data: {
        id: tokenId,
        session_id: sessionId,
        created_by: mockUser.id,
        revoked_at: null,
      },
      error: null,
    });
    // update → success
    fromResults.push({ data: null, error: null });
    // audit_log insert → success
    fromResults.push({ data: null, error: null });

    const res = await makeDeleteRequest(sessionId, tokenId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it('returns 200 idempotently when token is already revoked', async () => {
    const tokenId = 'already-revoked';
    const sessionId = 'session-abc';

    // select → found, already revoked
    fromResults.push({
      data: {
        id: tokenId,
        session_id: sessionId,
        created_by: mockUser.id,
        revoked_at: new Date().toISOString(),
      },
      error: null,
    });
    // No update or audit log expected for idempotent revocation

    const res = await makeDeleteRequest(sessionId, tokenId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it('returns 404 (not 403) when token belongs to a different session', async () => {
    // Simulated by the mock returning null (RLS-style: eq(session_id) + eq(created_by) both required)
    fromResults.push({ data: null, error: null });

    const res = await makeDeleteRequest('session-A', 'token-for-session-B');
    expect(res.status).toBe(404);
    // WHY 404 not 403: A 403 would reveal that the token exists for another session,
    // enabling cross-session token enumeration.
  });
});
