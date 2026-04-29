/**
 * DELETE /api/v1/sessions/groups/[id] — Integration Tests
 *
 * Tests the session group deletion endpoint used by the CLI's
 * multiAgentOrchestrator when tearing down a multi-agent workflow group.
 *
 * WHY: The IDOR defense (404 on owner mismatch) is the critical security
 * control tested here. A regression that returns 403 instead of 404 would
 * enable session group enumeration across users. These tests are the
 * automated gate. OWASP A01:2021.
 *
 * @security OWASP A01:2021 (Broken Access Control / IDOR)
 * @security OWASP A07:2021 (Identification and Authentication Failures)
 * @security SOC 2 CC6.1 (Logical Access Controls)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks — withApiAuthAndRateLimit bypass
// ============================================================================

/**
 * Default auth context injected by the mocked middleware.
 * WHY: v1 routes use API key auth (withApiAuthAndRateLimit), not cookie auth.
 * Mocking the middleware allows testing handler logic in isolation.
 */
const mockAuthContext = {
  userId: 'owner-user-uuid-001',
  keyId: 'key-id-xyz',
  scopes: ['write'],
  keyExpiresAt: null,
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuthAndRateLimit: vi.fn((handler: Function) => {
    return async (request: NextRequest) => handler(request, mockAuthContext);
  }),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

// ============================================================================
// Mocks — Sentry
// ============================================================================

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

// ============================================================================
// Mocks — Supabase admin client
// ============================================================================

/**
 * Controls what the .single() call on the SELECT returns.
 * Reset in beforeEach to simulate "group not found" by default.
 *
 * WHY two separate queues (fetch vs delete): the route makes two DB calls:
 * 1. SELECT user_id to verify ownership
 * 2. DELETE to remove the row
 * We need independent control over each.
 */
const selectQueue: Array<{ data: unknown; error: unknown }> = [];
const deleteQueue: Array<{ error: unknown }> = [];

function createSupabaseMock() {
  return {
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};

      // SELECT chain: .from().select().eq().single()
      chain['select'] = vi.fn(() => chain);
      chain['eq'] = vi.fn(() => chain);
      chain['single'] = vi.fn(() => Promise.resolve(selectQueue.shift() ?? { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }));

      // DELETE chain: .from().delete().eq('id', id).eq('user_id', userId)
      // Two .eq() calls — each returns the next link; the second resolves.
      chain['delete'] = vi.fn(() => {
        const delChain: Record<string, unknown> = {};
        const delChain2: Record<string, unknown> = {};
        // Second .eq() resolves with the queued delete result
        delChain2['eq'] = vi.fn(() =>
          Promise.resolve(deleteQueue.shift() ?? { error: null }),
        );
        // First .eq() returns the second chain link
        delChain['eq'] = vi.fn(() => delChain2);
        return delChain;
      });

      return chain;
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => createSupabaseMock()),
}));

// ============================================================================
// Import route handler AFTER mocks
// ============================================================================

import { DELETE } from '../route';

// ============================================================================
// Helpers
// ============================================================================

const VALID_GROUP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const VALID_BASE_URL = `http://localhost:3000/api/v1/sessions/groups/${VALID_GROUP_ID}`;

/**
 * Creates a NextRequest for DELETE /api/v1/sessions/groups/[id].
 *
 * @param id - The group ID path param (embedded in the URL)
 * @param headers - Additional request headers
 * @returns A NextRequest with the DELETE method
 */
function createRequest(
  id: string = VALID_GROUP_ID,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/sessions/groups/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer sk_live_test_key',
      ...headers,
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('DELETE /api/v1/sessions/groups/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    deleteQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // 1. Auth middleware wiring
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    /**
     * WHY: Proves the route is wired to withApiAuthAndRateLimit. A refactor
     * that accidentally bypasses the wrapper would allow unauthenticated
     * deletion of any group. OWASP A07:2021, SOC 2 CC6.1.
     */
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () => {
        return NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 },
        );
      });

      vi.resetModules();
      const { DELETE: freshDELETE } = await import('../route');

      const response = await freshDELETE(createRequest());
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Missing Authorization header');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Path param validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    /**
     * WHY: A non-UUID id must be rejected before it reaches the DB layer.
     * Passing raw strings into Postgres UUID columns causes an ugly 500 error
     * from the driver. OWASP A03:2021 injection guard.
     */
    it('returns 400 when id is not a valid UUID', async () => {
      const response = await DELETE(createRequest('not-a-uuid'));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid id');
    });

    it('returns 400 when id is an empty string', async () => {
      const response = await DELETE(createRequest(''));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid id');
    });

    it('returns 400 when id contains SQL-injection-style content', async () => {
      const response = await DELETE(createRequest("'; DROP TABLE agent_session_groups; --"));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe('Invalid id');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Not found
  // --------------------------------------------------------------------------

  describe('not found', () => {
    /**
     * WHY: Group does not exist — PGRST116 from the SELECT → 404.
     * Must not leak whether the group exists or was owned by another user.
     * OWASP A01:2021 IDOR defense.
     */
    it('returns 404 when the group does not exist', async () => {
      // selectQueue is empty → mock returns PGRST116 by default
      const response = await DELETE(createRequest());
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Not found');
    });

    it('returns 404 with same error message whether group is missing or wrong owner', async () => {
      // Simulate "group exists but owned by a different user"
      selectQueue.push({
        data: { user_id: 'different-user-uuid-999' }, // not mockAuthContext.userId
        error: null,
      });

      const response = await DELETE(createRequest());
      expect(response.status).toBe(404);

      const body = await response.json();
      // WHY same message: IDOR defense — caller cannot distinguish "not found"
      // from "belongs to someone else". OWASP A01:2021.
      expect(body.error).toBe('Not found');
    });
  });

  // --------------------------------------------------------------------------
  // 4. IDOR defense — owner mismatch returns 404, not 403
  // --------------------------------------------------------------------------

  describe('IDOR defense (OWASP A01:2021)', () => {
    /**
     * WHY: Returning 403 would confirm that the resource exists (just not
     * accessible). An attacker could enumerate group IDs by probing for 403
     * responses. A consistent 404 provides no existence signal. CC6.1.
     */
    it('returns 404 (not 403) when group belongs to a different user', async () => {
      selectQueue.push({
        data: { user_id: 'attacker-cannot-see-this-uuid' },
        error: null,
      });

      const response = await DELETE(createRequest());
      // Must be 404, never 403
      expect(response.status).toBe(404);
      expect(response.status).not.toBe(403);
    });

    it('does not expose the real owner user_id in the 404 response body', async () => {
      selectQueue.push({
        data: { user_id: 'victim-user-uuid-secret' },
        error: null,
      });

      const response = await DELETE(createRequest());
      const body = await response.json();

      expect(JSON.stringify(body)).not.toContain('victim-user-uuid-secret');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Happy path
  // --------------------------------------------------------------------------

  describe('success cases', () => {
    /**
     * WHY Content-Type assertion: ensures callers can safely parse the response
     * as JSON. A future middleware change stripping Content-Type would cause
     * silent parse failures in CLI clients.
     */
    it('returns 200 with { deleted: true, id } when group exists and owner matches', async () => {
      // SELECT returns the group owned by the authenticated user
      selectQueue.push({
        data: { user_id: mockAuthContext.userId },
        error: null,
      });
      // DELETE succeeds
      deleteQueue.push({ error: null });

      const response = await DELETE(createRequest(VALID_GROUP_ID));
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);

      const body = await response.json();
      expect(body.deleted).toBe(true);
      expect(body.id).toBe(VALID_GROUP_ID);
    });

    it('returns deleted: true (not deleted: false) on success', async () => {
      selectQueue.push({
        data: { user_id: mockAuthContext.userId },
        error: null,
      });
      deleteQueue.push({ error: null });

      const response = await DELETE(createRequest());
      const body = await response.json();
      expect(body.deleted).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Database error — 500 + Sentry
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    /**
     * WHY: Unexpected DB errors (deadlocks, connectivity loss) must be
     * captured in Sentry and surface a sanitized message. Raw DB errors
     * must never reach the caller — they may contain schema or PII details.
     * OWASP A02:2021.
     */
    it('returns 500 and calls Sentry when SELECT query fails unexpectedly', async () => {
      // Return a non-PGRST116 error (unexpected server-side failure)
      selectQueue.push({
        data: null,
        error: { code: '08006', message: 'Connection terminated unexpectedly' },
      });

      const Sentry = await import('@sentry/nextjs');
      const response = await DELETE(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();

      const body = await response.json();
      expect(body.error).toBe('Failed to delete session group');
      // Must not contain raw DB error message
      expect(JSON.stringify(body)).not.toContain('Connection terminated');
    });

    it('returns 500 and calls Sentry when DELETE query fails unexpectedly', async () => {
      // Ownership check passes
      selectQueue.push({
        data: { user_id: mockAuthContext.userId },
        error: null,
      });
      // DELETE fails
      deleteQueue.push({ error: { message: 'deadlock detected' } });

      const Sentry = await import('@sentry/nextjs');
      const response = await DELETE(createRequest());

      expect(response.status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledOnce();

      const body = await response.json();
      expect(body.error).toBe('Failed to delete session group');
      expect(JSON.stringify(body)).not.toContain('deadlock detected');
    });

    it('does not include internal DB error details in 500 response', async () => {
      selectQueue.push({
        data: null,
        error: { code: '57014', message: 'query_canceled: internal pg error' },
      });

      const response = await DELETE(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(JSON.stringify(body)).not.toContain('query_canceled');
    });
  });

  // --------------------------------------------------------------------------
  // 7. Content-Type on all 200 responses
  // --------------------------------------------------------------------------

  describe('response headers', () => {
    it('sets Content-Type: application/json on 200 response', async () => {
      selectQueue.push({
        data: { user_id: mockAuthContext.userId },
        error: null,
      });
      deleteQueue.push({ error: null });

      const response = await DELETE(createRequest());
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });
  });

  // --------------------------------------------------------------------------
  // 8. DELETE query routes through the Supabase client (smoke: OWASP A03:2021)
  // --------------------------------------------------------------------------

  describe('query safety', () => {
    /**
     * WHY: Confirms the handler routes the DELETE through the Supabase client
     * (i.e. createAdminClient was called and .from('agent_session_groups') was
     * invoked). This is a smoke test — it does NOT assert the exact argument
     * values passed to .eq(), because the mock chain creates a new spy instance
     * on each .delete() call, making inter-call spy capture unreliable at this
     * abstraction layer. The actual parameterization safety comes from the
     * supabase-js client itself, which always uses pg prepared statements.
     * OWASP A03:2021.
     */
    it('routes DELETE through Supabase client on agent_session_groups table', async () => {
      selectQueue.push({
        data: { user_id: mockAuthContext.userId },
        error: null,
      });
      deleteQueue.push({ error: null });

      const { createAdminClient } = await import('@/lib/supabase/server');

      await DELETE(createRequest(VALID_GROUP_ID));

      // Verify createAdminClient was called (mock was invoked — not bypassed)
      expect(createAdminClient).toHaveBeenCalled();

      // Verify .from() was called with the correct table name — confirms the
      // handler didn't string-interpolate a raw SQL fragment instead of using
      // the query builder.
      const mockInstance = vi.mocked(createAdminClient).mock.results[0]?.value;
      expect(mockInstance.from).toHaveBeenCalledWith('agent_session_groups');
    });
  });
});
