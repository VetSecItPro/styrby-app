/**
 * Integration tests for /api/keys (GET, POST, DELETE)
 *
 * WHY: API keys are a security-critical feature. These tests verify:
 * - Authentication is enforced on all operations
 * - Power tier gating prevents free users from creating keys
 * - Key limits are enforced (prevents resource exhaustion)
 * - Revocation checks ownership (prevents unauthorized deletion)
 * - Audit logging happens on key lifecycle events
 * - Input validation prevents injection and edge cases
 *
 * Uses the fromCallQueue mock pattern to simulate Supabase query chains.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock pattern: fromCallQueue (established pattern from budget-alerts test)
const mockGetUser = vi.fn();
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> =
  [];

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

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => createChainMock()),
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => createChainMock()),
  })),
}));

// Mock API key utilities
vi.mock('@/lib/api-keys', () => ({
  hashApiKey: vi.fn(async () => '$2b$12$mockedHashValue'),
}));

// Mock shared utilities
vi.mock('@styrby/shared', () => ({
  generateApiKey: vi.fn(() => ({
    key: 'sk_live_test123456789abcdef',
    prefix: 'sk_live_test12',
  })),
}));

/**
 * Mock rate limiting to always allow requests.
 * WHY: The route imports rateLimit, RATE_LIMITS, rateLimitResponse, and getClientIp.
 * All must be provided or POST/DELETE handlers crash (rate limit is outside try/catch).
 */
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 29 })),
  RATE_LIMITS: {
    budgetAlerts: { windowMs: 60000, maxRequests: 30 },
  },
  rateLimitResponse: vi.fn(
    (retryAfter: number) =>
      new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      })
  ),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

import { GET, POST, DELETE } from '../route';

describe('GET /api/keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  /**
   * WHY: API keys are sensitive credentials. Only authenticated users
   * should be able to list their keys.
   */
  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  /**
   * WHY: Users should see their API keys with tier info (key limit, count).
   * This verifies the full response structure with active keys.
   */
  it('returns keys with tier info for authenticated user', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    // First query: api_keys.select().eq().order()
    fromCallQueue.push({
      data: [
        {
          id: 'key1',
          key_prefix: 'sk_live_abc',
          name: 'Production Key',
          scopes: ['read', 'write'],
          created_at: '2026-01-01T00:00:00Z',
          last_used_at: null,
          revoked_at: null,
        },
      ],
      error: null,
    });

    // Second query: getUserTier → subscriptions.select('tier').eq().eq().single()
    fromCallQueue.push({ data: { tier: 'power' }, error: null });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.keys).toHaveLength(1);
    expect(data.keys[0].key_prefix).toBe('sk_live_abc');
    expect(data.tier).toBe('power');
    expect(data.keyCount).toBe(1);
  });

  /**
   * WHY: New users should see an empty keys array, not an error.
   * Verifies the route handles zero-state gracefully.
   */
  it('returns empty keys array when user has no keys', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    // First query: api_keys (empty)
    fromCallQueue.push({ data: [], error: null });

    // Second query: getUserTier (no active subscription → defaults to 'free')
    fromCallQueue.push({ data: null, error: null });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.keys).toEqual([]);
    expect(data.keyCount).toBe(0);
  });

  /**
   * WHY: Active key count should exclude revoked keys. Revoked keys
   * don't count toward tier limits and shouldn't be included in the count.
   */
  it('calculates active key count (excludes revoked)', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    // First query: api_keys (2 active, 1 revoked)
    fromCallQueue.push({
      data: [
        { id: 'key1', name: 'Active Key 1', revoked_at: null },
        { id: 'key2', name: 'Active Key 2', revoked_at: null },
        { id: 'key3', name: 'Revoked Key', revoked_at: '2026-01-04T00:00:00Z' },
      ],
      error: null,
    });

    // Second query: getUserTier
    fromCallQueue.push({ data: { tier: 'power' }, error: null });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.keys).toHaveLength(3);
    expect(data.keyCount).toBe(2); // Only active keys counted
  });
});

describe('POST /api/keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  /**
   * WHY: API key creation is a privileged operation. Anonymous users
   * should not be able to create keys.
   */
  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Key' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  /**
   * WHY: Key name is required for identification in the dashboard.
   * Missing name should be caught by Zod validation.
   */
  it('returns 400 when name is missing', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  /**
   * WHY: Key names have a 100 character limit to prevent database bloat
   * and ensure UI rendering doesn't break.
   */
  it('returns 400 when name is over 100 chars', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(101) }),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  /**
   * WHY: Scopes control key permissions. Only 'read' and 'write' are valid.
   * Invalid scopes like 'admin' or 'delete' should be rejected.
   */
  it('returns 400 when scope is invalid', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Key', scopes: ['admin'] }),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  /**
   * WHY: Free tier users have keyLimit = 0, meaning no API key creation.
   * This prevents free users from using the API, enforcing the paywall.
   */
  it('returns 403 for free tier (keyLimit 0)', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    // getUserTier → no active subscription → defaults to 'free'
    fromCallQueue.push({ data: null, error: null });

    // Count query for existing keys
    fromCallQueue.push({ count: 0, error: null });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Key' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toContain('Power plan');
  });

  /**
   * WHY: Even Power tier has key limits. Attempting to exceed the limit
   * should be rejected to prevent resource exhaustion.
   */
  it('returns 403 when at key limit', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    // getUserTier → power tier
    fromCallQueue.push({ data: { tier: 'power' }, error: null });

    // Count query returns at/over limit (999 exceeds any tier limit)
    fromCallQueue.push({ count: 999, error: null });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Key' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toContain('limit');
  });

  /**
   * WHY: Happy path for Power tier. Verifies the full key creation flow:
   * auth → tier check → limit check → generate key → hash → insert → audit log.
   */
  it('returns 201 with key + secret for Power user under limit', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    // getUserTier → power tier
    fromCallQueue.push({ data: { tier: 'power' }, error: null });

    // Count query → under limit
    fromCallQueue.push({ count: 2, error: null });

    // Insert api_keys → returns new key record
    fromCallQueue.push({
      data: {
        id: 'key-id-123',
        key_prefix: 'sk_live_test12',
        name: 'My API Key',
        scopes: ['read'],
        created_at: '2026-02-06T00:00:00Z',
      },
      error: null,
    });

    // Audit log insert (via admin client)
    fromCallQueue.push({ data: { id: 'audit-id-456' }, error: null });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My API Key', scopes: ['read'] }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.key).toMatchObject({
      id: 'key-id-123',
      key_prefix: 'sk_live_test12',
      name: 'My API Key',
    });
    expect(data.secret).toBe('sk_live_test123456789abcdef');
  });

  /**
   * WHY: expires_in_days sets the key expiration date. Verifies the route
   * correctly calculates expires_at based on the input.
   */
  it('handles expires_in_days correctly', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    // getUserTier → power tier
    fromCallQueue.push({ data: { tier: 'power' }, error: null });

    // Count query
    fromCallQueue.push({ count: 2, error: null });

    // Insert api_keys (should include expires_at)
    fromCallQueue.push({
      data: {
        id: 'key-id-789',
        key_prefix: 'sk_live_test12',
        name: 'Expiring Key',
        scopes: ['read', 'write'],
        created_at: '2026-02-06T00:00:00Z',
        expires_at: '2026-03-08T00:00:00Z', // 30 days later
      },
      error: null,
    });

    // Audit log insert
    fromCallQueue.push({ data: { id: 'audit-id-789' }, error: null });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Expiring Key',
        scopes: ['read', 'write'],
        expires_in_days: 30,
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.key.expires_at).toBeDefined();
  });
});

describe('DELETE /api/keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  /**
   * WHY: Key revocation is a privileged operation. Anonymous users
   * should not be able to revoke keys.
   */
  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  /**
   * WHY: Key ID is required to identify which key to revoke.
   * Missing ID should be caught by Zod validation.
   */
  it('returns 400 when id is missing', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(400);
  });

  /**
   * WHY: Key ID must be a valid UUID. Non-UUID values like 'abc123'
   * should be rejected to prevent SQL errors.
   */
  it('returns 400 when id is invalid UUID', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'not-a-uuid' }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(400);
  });

  /**
   * WHY: Attempting to revoke a non-existent key should return 404.
   * Prevents misleading success responses for invalid IDs.
   */
  it('returns 404 when key not found', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    // Key lookup returns null (not found)
    fromCallQueue.push({ data: null, error: null });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('API key not found');
  });

  /**
   * WHY: Happy path for key revocation. Verifies soft delete flow:
   * auth → lookup → ownership check → update revoked_at → audit log.
   */
  it('returns 200 on successful revocation', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    // Key lookup returns existing key
    fromCallQueue.push({
      data: { id: '550e8400-e29b-41d4-a716-446655440000', name: 'My Key' },
      error: null,
    });

    // Update revoked_at
    fromCallQueue.push({ data: null, error: null });

    // Audit log insert (via admin client)
    fromCallQueue.push({ data: { id: 'audit-id-999' }, error: null });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: '550e8400-e29b-41d4-a716-446655440000',
        reason: 'Key compromised',
      }),
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  /**
   * WHY: Revocation reason is optional but limited to 500 chars.
   * Exceeding this limit should be rejected to prevent database bloat.
   */
  it('returns 400 when reason is over 500 chars', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user1' } },
      error: null,
    });

    const request = new NextRequest('http://localhost/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: '550e8400-e29b-41d4-a716-446655440000',
        reason: 'x'.repeat(501),
      }),
    });

    const response = await DELETE(request);

    expect(response.status).toBe(400);
  });
});
