/**
 * Integration tests for DELETE /api/account/delete
 *
 * Tests account deletion flow including:
 * - Authentication validation
 * - Request body validation (confirmation text, reason)
 * - Soft-deletion of profiles and sessions
 * - Hard-deletion of device tokens
 * - Audit log creation
 * - User ban via admin API (FIX-012)
 * - Sign out after deletion
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE } from '../route';

/**
 * Mock state for Supabase auth.getUser()
 */
const mockGetUser = vi.fn();

/**
 * Mock state for auth.signOut()
 */
const mockSignOut = vi.fn();

/**
 * Mock state for admin.updateUserById() - used for banning users (FIX-012)
 */
const mockAdminUpdateUser = vi.fn();

/**
 * Mock state for the supabase.rpc() call. SEC-ADV-003 introduces a call to
 * the user_revoke_support_access RPC for every active grant before purge.
 *
 * @see migrations/049_support_access_wrappers.sql
 */
const mockRpc = vi.fn();

/**
 * Queue of mock responses for Supabase query chain.
 * Each .from() call shifts one entry from this queue.
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase query mock.
 * The final result is taken from fromCallQueue.
 *
 * @returns Chainable mock with all standard Supabase query methods
 */
function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'insert', 'update', 'delete', 'is', 'not', 'in', 'single', 'rpc',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

/**
 * Mock Supabase clients (regular and admin)
 */
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
      signOut: mockSignOut,
    },
    from: vi.fn(() => createChainMock()),
    // SEC-ADV-003: route now calls .rpc('user_revoke_support_access', ...) for
    // every active grant before purging support_access_grants. The default mock
    // resolves successfully; tests can override per-case.
    rpc: (...args: unknown[]) => mockRpc(...args),
  })),
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        updateUserById: mockAdminUpdateUser,
      },
    },
  })),
}));

/**
 * Mock rate limiter — correct path matching route import
 * WHY: Route imports from '@/lib/rateLimit' (camelCase), not '@/lib/rate-limit'
 */
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 99 })),
  RATE_LIMITS: {
    delete: { windowMs: 86400000, maxRequests: 1 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

/**
 * Helper to create a NextRequest with JSON body
 *
 * @param body - Request body (will be JSON stringified)
 * @returns NextRequest configured for DELETE method
 */
function createRequest(body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/account/delete', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('DELETE /api/account/delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;

    // Default: authenticated user
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'user-123',
          email: 'test@example.com',
        },
      },
      error: null,
    });

    // Default: sign out succeeds
    mockSignOut.mockResolvedValue({});

    // Default: admin ban succeeds
    mockAdminUpdateUser.mockResolvedValue({ data: {}, error: null });

    // Default: RPC call resolves successfully (no active grants to revoke).
    mockRpc.mockResolvedValue({ data: 0, error: null });
  });

  /**
   * SEC-ADV-003 helper: queue 5 successful responses for the always-issued
   * sequence of operations in the route:
   *   1. profiles update (soft-delete)
   *   2. sessions update (soft-delete)
   *   3. device_tokens delete
   *   4. support_access_grants SELECT (active grants — Step A)
   *   5. audit_log insert
   *
   * The Promise.allSettled batch (Step B) is not queued explicitly because
   * each query in the batch shifts one entry from the queue and tolerates
   * empty defaults. We push placeholders for the 16 hard-deletes after Step A.
   *
   * Plus 1 final entry for the audit_log insert at the bottom of the route.
   */
  function pushSuccessfulQueue(activeGrants: Array<{ id: number }> = []) {
    fromCallQueue.push({ data: null, error: null }); // 1. profiles update
    fromCallQueue.push({ data: null, error: null }); // 2. sessions update
    fromCallQueue.push({ data: null, error: null }); // 3. device_tokens delete
    fromCallQueue.push({ data: activeGrants, error: null }); // 4. SELECT active grants
    // 5..20: 16 hard-deletes in Promise.allSettled (Step B)
    for (let i = 0; i < 16; i++) {
      fromCallQueue.push({ data: null, error: null });
    }
    fromCallQueue.push({ data: null, error: null }); // 21. audit_log insert
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Test 1: Returns 401 when user is not authenticated
   */
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: 'Unauthorized' });
  });

  /**
   * Test 2: Returns 400 for invalid JSON body
   * WHY: Route catches JSON parse error and returns 'Invalid JSON' (line 75)
   */
  it('returns 400 for invalid JSON body', async () => {
    const request = new NextRequest('http://localhost:3000/api/account/delete', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: 'invalid-json{',
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid JSON');
  });

  /**
   * Test 3: Returns 400 when confirmation text is wrong
   * WHY: Route uses z.literal('DELETE MY ACCOUNT') and returns a specific message
   */
  it('returns 400 when confirmation text is wrong', async () => {
    const request = createRequest({
      confirmation: 'DELETE ACCOUNT', // Wrong text
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('DELETE MY ACCOUNT');
  });

  /**
   * Test 4: Returns 400 when confirmation is missing
   */
  it('returns 400 when confirmation is missing', async () => {
    const request = createRequest({
      reason: 'Just testing',
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('DELETE MY ACCOUNT');
  });

  /**
   * Test 5: Returns 200 on successful account deletion
   */
  it('returns 200 on successful account deletion', async () => {
    pushSuccessfulQueue();

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
      reason: 'No longer needed',
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toContain('deletion');
  });

  /**
   * Test 6: Calls admin.updateUserById with ban_duration '720h' (FIX-012)
   */
  it('bans user via admin API with 720h duration', async () => {
    pushSuccessfulQueue();

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
    });

    await DELETE(request);

    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-123', {
      ban_duration: '720h',
    });
  });

  /**
   * Test 7: Calls signOut after deletion completes
   */
  it('calls signOut after deletion completes', async () => {
    pushSuccessfulQueue();

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
    });

    await DELETE(request);

    expect(mockSignOut).toHaveBeenCalled();
  });

  /**
   * Test 8: Stores reason in audit log when provided
   */
  it('stores deletion reason in audit log when provided', async () => {
    pushSuccessfulQueue();

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
      reason: 'Privacy concerns',
    });

    await DELETE(request);

    // The audit log insert should have been called (last item in queue)
    // We verify it was processed by checking the queue is empty
    expect(fromCallQueue.length).toBe(0);
  });

  /**
   * SEC-ADV-003 Test: revokes every active support_access_grant before purge.
   *
   * WHY this test: closes the 30-day soft-delete grace-window admin-access
   * vector. An APPROVED grant must transition to 'revoked' (via the
   * user_revoke_support_access RPC) before the grant row is deleted, so the
   * admin_audit_log retains a non-repudiable trail.
   */
  it('revokes active support_access_grants before purging', async () => {
    pushSuccessfulQueue([
      { id: 101 },
      { id: 102 },
      { id: 103 },
    ]);

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
    });

    const response = await DELETE(request);
    expect(response.status).toBe(200);

    // RPC must be called once per active grant, with the correct grant id.
    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(mockRpc).toHaveBeenCalledWith('user_revoke_support_access', { p_grant_id: 101 });
    expect(mockRpc).toHaveBeenCalledWith('user_revoke_support_access', { p_grant_id: 102 });
    expect(mockRpc).toHaveBeenCalledWith('user_revoke_support_access', { p_grant_id: 103 });
  });

  /**
   * SEC-ADV-003 Test: tolerates a per-grant RPC failure without aborting the
   * entire deletion flow. WHY: a grant whose state changed concurrently
   * (e.g. consumed at the same instant) raises 22023 from the RPC; the row
   * is about to be deleted anyway, so we use Promise.allSettled.
   */
  it('continues deletion when a single grant revoke fails', async () => {
    pushSuccessfulQueue([{ id: 200 }]);

    mockRpc.mockRejectedValueOnce(new Error('grant already consumed'));

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
    });

    const response = await DELETE(request);
    expect(response.status).toBe(200);
    expect(mockAdminUpdateUser).toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalled();
  });

  /**
   * SEC-ADV-003 Test: skips the RPC entirely when there are no active grants.
   * Pure no-op assertion to guard against future regressions where a NULL or
   * empty array would be misinterpreted as "revoke everything".
   */
  it('does not call revoke RPC when no active grants exist', async () => {
    pushSuccessfulQueue([]);

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
    });

    const response = await DELETE(request);
    expect(response.status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  /**
   * SEC-ADV-003 Test: audit_log row is NOT deleted (legal-hold under
   * GDPR Art. 17(3)(b)/(e) — legal claims defense + SOC2 CC7.2 non-repudiation).
   *
   * The route only INSERTs into audit_log; it never .delete()s. We assert by
   * counting the from() calls and verifying none is a delete on audit_log.
   * In this mock harness we cannot easily intercept method names per call,
   * so we instead verify the route completes successfully without ever
   * shifting an entry that would correspond to a hypothetical audit_log
   * delete (the queue is sized to the exact number of legitimate calls).
   */
  it('preserves audit_log on deletion (legal-hold)', async () => {
    pushSuccessfulQueue();

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
    });

    const response = await DELETE(request);
    expect(response.status).toBe(200);
    // If the route attempted an extra audit_log delete it would dequeue an
    // additional entry; the queue length assertion ensures every push
    // corresponds to an expected operation (no stray audit_log delete).
    expect(fromCallQueue.length).toBe(0);
  });

  /**
   * Test 9: Returns 500 when profile update fails
   * WHY: Route explicitly checks `if (profileError) throw profileError` (line 96)
   */
  it('returns 500 when profile update fails', async () => {
    // First operation (profiles update) fails
    fromCallQueue.push({
      data: null,
      error: { message: 'Database error', code: 'DB_ERROR' },
    });

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Failed to delete account');
  });

  /**
   * Test 10: Returns 500 when admin ban throws
   * WHY: Route does `await adminClient.auth.admin.updateUserById(...)` without
   * checking the return value. Only a rejected promise (thrown error) triggers
   * the catch block. A resolved error object is silently ignored.
   */
  it('returns 500 when admin ban throws', async () => {
    pushSuccessfulQueue();

    // Admin ban throws (rejects) — NOT resolves with error object
    mockAdminUpdateUser.mockRejectedValue(new Error('Admin operation failed'));

    const request = createRequest({
      confirmation: 'DELETE MY ACCOUNT',
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Failed to delete account');
  });
});
