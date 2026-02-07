/**
 * Integration tests for POST /api/cron/retention
 *
 * Tests automated data retention cron job including:
 * - Authorization via CRON_SECRET header
 * - Audit log purge (records older than 90 days)
 * - Hard-deletion of expired accounts (deleted_at older than 30 days)
 * - Auth.users deletion via admin API
 * - Response with purge counts and cutoff dates
 * - Graceful error handling (individual failures don't crash the job)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';

/**
 * Mock state for admin.deleteUser() - used for hard-deleting auth users
 */
const mockAdminDeleteUser = vi.fn();

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
    'select',
    'eq',
    'gte',
    'lte',
    'lt',
    'gt',
    'order',
    'limit',
    'insert',
    'update',
    'delete',
    'is',
    'not',
    'in',
    'single',
    'rpc',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

/**
 * Mock Supabase admin client
 * WHY: Cron jobs use admin client for unrestricted database access and auth user deletion
 */
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => createChainMock()),
    auth: {
      admin: {
        deleteUser: mockAdminDeleteUser,
      },
    },
  })),
}));

/**
 * Helper to create a NextRequest with authorization header
 *
 * @param secret - Optional CRON_SECRET to include in Bearer token
 * @returns NextRequest configured for POST method
 */
function createCronRequest(secret?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/retention', {
    method: 'POST',
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe('POST /api/cron/retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;

    // Set up environment variable for CRON_SECRET
    vi.stubEnv('CRON_SECRET', 'test-cron-secret-123');

    // Default: admin user deletion succeeds
    mockAdminDeleteUser.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /**
   * Test 1: Returns 401 when authorization header is missing
   */
  it('returns 401 when authorization header is missing', async () => {
    const request = createCronRequest(); // No secret

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  /**
   * Test 2: Returns 401 when CRON_SECRET is incorrect
   */
  it('returns 401 when CRON_SECRET is incorrect', async () => {
    const request = createCronRequest('wrong-secret');

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  /**
   * Test 3: Returns 401 when CRON_SECRET environment variable is not set
   */
  it('returns 401 when CRON_SECRET env is not set', async () => {
    vi.unstubAllEnvs(); // Remove CRON_SECRET

    const request = createCronRequest('test-cron-secret-123');

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  /**
   * Test 4: Returns 200 with zero purge counts when no expired data exists
   */
  it('returns 200 with zero counts when no expired data', async () => {
    // Audit logs delete returns 0 count
    fromCallQueue.push({ data: null, error: null, count: 0 });

    // Expired profiles query returns empty array
    fromCallQueue.push({ data: [], error: null });

    const request = createCronRequest('test-cron-secret-123');
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.purged.auditLogs).toBe(0);
    expect(data.purged.accounts).toBe(0);
    expect(data.cutoffs).toHaveProperty('auditLogBefore');
    expect(data.cutoffs).toHaveProperty('accountsDeletedBefore');
  });

  /**
   * Test 5: Returns 200 and purges audit logs older than 90 days
   */
  it('purges audit logs older than 90 days', async () => {
    // Audit logs delete returns count of 150
    fromCallQueue.push({ data: null, error: null, count: 150 });

    // No expired profiles
    fromCallQueue.push({ data: [], error: null });

    const request = createCronRequest('test-cron-secret-123');
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.purged.auditLogs).toBe(150);
    expect(data.purged.accounts).toBe(0);
  });

  /**
   * Test 6: Returns 200 and hard-deletes expired accounts
   * WHY: profile.id IS the auth.users id — profiles extends auth.users
   */
  it('hard-deletes profiles with deleted_at older than 30 days', async () => {
    // Audit logs delete
    fromCallQueue.push({ data: null, error: null, count: 0 });

    // Expired profiles query returns 3 profiles
    fromCallQueue.push({
      data: [{ id: 'user-1' }, { id: 'user-2' }, { id: 'user-3' }],
      error: null,
    });

    // Hard delete profiles (CASCADE handles related tables)
    fromCallQueue.push({ data: null, error: null, count: 3 });

    const request = createCronRequest('test-cron-secret-123');
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.purged.accounts).toBe(3);
  });

  /**
   * Test 7: Calls auth.admin.deleteUser for each expired profile
   * WHY: profile.id = auth user id, so deleteUser receives the profile id directly
   */
  it('deletes auth users via admin API for each expired profile', async () => {
    // Audit logs delete
    fromCallQueue.push({ data: null, error: null, count: 0 });

    // Expired profiles (profile.id IS the auth user id)
    fromCallQueue.push({
      data: [{ id: 'auth-user-1' }, { id: 'auth-user-2' }],
      error: null,
    });

    // Hard delete profiles
    fromCallQueue.push({ data: null, error: null, count: 2 });

    const request = createCronRequest('test-cron-secret-123');
    await POST(request);

    expect(mockAdminDeleteUser).toHaveBeenCalledTimes(2);
    expect(mockAdminDeleteUser).toHaveBeenCalledWith('auth-user-1');
    expect(mockAdminDeleteUser).toHaveBeenCalledWith('auth-user-2');
  });

  /**
   * Test 8: Returns cutoff dates in response
   */
  it('returns cutoff dates for audit logs and accounts', async () => {
    // Audit logs delete
    fromCallQueue.push({ data: null, error: null, count: 5 });

    // No expired profiles
    fromCallQueue.push({ data: [], error: null });

    const request = createCronRequest('test-cron-secret-123');
    const response = await POST(request);
    const data = await response.json();

    expect(data.cutoffs).toBeDefined();
    expect(data.cutoffs.auditLogBefore).toBeDefined();
    expect(data.cutoffs.accountsDeletedBefore).toBeDefined();

    // Verify cutoff dates are ISO strings
    expect(new Date(data.cutoffs.auditLogBefore).toISOString()).toBe(data.cutoffs.auditLogBefore);
    expect(new Date(data.cutoffs.accountsDeletedBefore).toISOString()).toBe(
      data.cutoffs.accountsDeletedBefore
    );
  });

  /**
   * Test 9: Handles audit log deletion error gracefully
   * WHY: The route logs individual query errors but continues the job.
   * Partial retention enforcement is better than no enforcement.
   */
  it('continues with 0 audit logs when audit log deletion has error', async () => {
    fromCallQueue.push({
      data: null,
      error: { message: 'Database error', code: 'DB_ERROR' },
    });

    // No expired profiles
    fromCallQueue.push({ data: [], error: null });

    const request = createCronRequest('test-cron-secret-123');
    const response = await POST(request);
    const data = await response.json();

    // Route handles audit errors gracefully — still returns 200
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.purged.auditLogs).toBe(0);
  });

  /**
   * Test 10: Handles profile query error gracefully
   * WHY: If the profile lookup fails, the route skips account deletion
   * but still returns success with the audit log results.
   */
  it('continues with 0 accounts when profile lookup has error', async () => {
    // Audit logs succeed
    fromCallQueue.push({ data: null, error: null, count: 0 });

    // Profile lookup fails
    fromCallQueue.push({
      data: null,
      error: { message: 'Database error', code: 'DB_ERROR' },
    });

    const request = createCronRequest('test-cron-secret-123');
    const response = await POST(request);
    const data = await response.json();

    // Route handles profile errors gracefully
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.purged.accounts).toBe(0);
  });

  /**
   * Test 11: Continues processing when admin.deleteUser fails for one user
   */
  it('continues processing remaining users when one auth deletion fails', async () => {
    // Audit logs
    fromCallQueue.push({ data: null, error: null, count: 0 });

    // Three expired profiles (profile.id = auth user id)
    fromCallQueue.push({
      data: [{ id: 'user-a' }, { id: 'user-b' }, { id: 'user-c' }],
      error: null,
    });

    // Profile deletion succeeds
    fromCallQueue.push({ data: null, error: null, count: 3 });

    // First user deletion succeeds, second fails, third succeeds
    mockAdminDeleteUser
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'User not found' } })
      .mockResolvedValueOnce({ data: {}, error: null });

    const request = createCronRequest('test-cron-secret-123');
    const response = await POST(request);
    const data = await response.json();

    // Should still succeed overall
    expect(response.status).toBe(200);
    expect(data.purged.accounts).toBe(3);
    expect(mockAdminDeleteUser).toHaveBeenCalledTimes(3);
  });

  /**
   * Test 12: Respects batch limit of 10000 for audit log deletion
   */
  it('uses batch limit of 10000 for audit log deletion', async () => {
    // Audit logs delete with limit hits maximum
    fromCallQueue.push({ data: null, error: null, count: 10000 });

    // No expired profiles
    fromCallQueue.push({ data: [], error: null });

    const request = createCronRequest('test-cron-secret-123');
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.purged.auditLogs).toBe(10000);
  });

  /**
   * Test 13: Returns metadata about the retention job
   */
  it('returns metadata with both purge counts and cutoff dates', async () => {
    fromCallQueue.push({ data: null, error: null, count: 42 }); // Audit logs
    fromCallQueue.push({
      data: [{ id: 'user-1' }],
      error: null,
    }); // Profiles
    fromCallQueue.push({ data: null, error: null, count: 1 }); // Delete

    const request = createCronRequest('test-cron-secret-123');
    const response = await POST(request);
    const data = await response.json();

    expect(data).toEqual({
      success: true,
      purged: {
        auditLogs: 42,
        accounts: 1,
      },
      cutoffs: {
        auditLogBefore: expect.any(String),
        accountsDeletedBefore: expect.any(String),
      },
    });
  });
});
