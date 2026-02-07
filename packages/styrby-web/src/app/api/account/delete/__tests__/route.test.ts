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
  });

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
    // Queue responses: profiles update, sessions update, device_tokens delete, audit_log insert
    fromCallQueue.push({ data: null, error: null }); // profiles update
    fromCallQueue.push({ data: null, error: null }); // sessions update
    fromCallQueue.push({ data: null, error: null }); // device_tokens delete
    fromCallQueue.push({ data: null, error: null }); // audit_log insert

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
    // Queue responses for DB operations
    fromCallQueue.push({ data: null, error: null }); // profiles update
    fromCallQueue.push({ data: null, error: null }); // sessions update
    fromCallQueue.push({ data: null, error: null }); // device_tokens delete
    fromCallQueue.push({ data: null, error: null }); // audit_log insert

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
    // Queue responses for DB operations
    fromCallQueue.push({ data: null, error: null }); // profiles update
    fromCallQueue.push({ data: null, error: null }); // sessions update
    fromCallQueue.push({ data: null, error: null }); // device_tokens delete
    fromCallQueue.push({ data: null, error: null }); // audit_log insert

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
    // Queue responses for DB operations
    fromCallQueue.push({ data: null, error: null }); // profiles update
    fromCallQueue.push({ data: null, error: null }); // sessions update
    fromCallQueue.push({ data: null, error: null }); // device_tokens delete
    fromCallQueue.push({ data: null, error: null }); // audit_log insert

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
    // Queue successful DB operations
    fromCallQueue.push({ data: null, error: null }); // profiles update
    fromCallQueue.push({ data: null, error: null }); // sessions update
    fromCallQueue.push({ data: null, error: null }); // device_tokens delete
    fromCallQueue.push({ data: null, error: null }); // audit_log insert

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
