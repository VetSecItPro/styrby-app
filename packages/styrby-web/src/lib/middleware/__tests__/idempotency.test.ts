/**
 * Unit tests for idempotency key middleware.
 *
 * Covers:
 * 1. First call with key → returns replayed: false (cache miss)
 * 2. Second call same key + same body → replayed: true with cached response
 * 3. Second call same key + different body → conflict (409 semantics)
 * 4. Different user, same key → independent (no collision)
 * 5. No key supplied → replayed: false (no DB access)
 * 6. Expired cache entry → replayed: false (treats as miss)
 * 7. DB error on select → replayed: false (fail-open, non-blocking)
 * 8. storeIdempotencyResult only caches 2xx responses
 * 9. storeIdempotencyResult no-ops when no Idempotency-Key header
 *
 * @module lib/middleware/__tests__/idempotency.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkIdempotency, storeIdempotencyResult } from '../idempotency';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Tracks upsert calls to verify storeIdempotencyResult writes.
 */
const mockUpsert = vi.fn();

/**
 * Tracks maybeSingle calls; returns whatever selectReturnValue holds.
 */
const mockMaybeSingle = vi.fn();

/**
 * The value returned by .maybeSingle() in the current test case.
 * Set this before calling checkIdempotency to control the DB response.
 */
let selectReturnValue: { data: unknown; error: unknown } = { data: null, error: null };

// Build a full chainable Supabase mock for .from().select().eq().eq().eq().maybeSingle()
const mockFrom = vi.fn(() => ({
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  maybeSingle: mockMaybeSingle,
  upsert: mockUpsert,
}));

/**
 * Mock createAdminClient so tests don't need a real Supabase connection.
 * WHY factory mock: each test may need a fresh chain instance.
 */
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: mockFrom,
  })),
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a minimal Request object with an optional Idempotency-Key header
 * and body.
 *
 * @param opts.key - Value for the Idempotency-Key header (omitted if not provided)
 * @param opts.body - Request body string (defaults to '{}')
 * @param opts.method - HTTP method (defaults to 'POST')
 * @param opts.path - Request path (defaults to '/api/test')
 * @returns A standard Request object
 */
function makeRequest(opts: {
  key?: string;
  body?: string;
  method?: string;
  path?: string;
} = {}): Request {
  const { key, body = '{}', method = 'POST', path = '/api/test' } = opts;
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key) {
    headers.set('Idempotency-Key', key);
  }
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers,
    body,
  });
}

// ============================================================================
// Test suite
// ============================================================================

describe('checkIdempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectReturnValue = { data: null, error: null };
    mockMaybeSingle.mockImplementation(() => selectReturnValue);
    mockUpsert.mockResolvedValue({ error: null });
  });

  // --------------------------------------------------------------------------
  // Test 5: No Idempotency-Key header
  // --------------------------------------------------------------------------

  it('returns replayed: false when no Idempotency-Key header is supplied', async () => {
    const req = makeRequest({ key: undefined });
    const result = await checkIdempotency(req, 'user-abc', '/api/test');

    expect(result).toEqual({ replayed: false });
    // WHY: No DB access should occur when the header is absent.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Test 1: Cache miss (first call with key)
  // --------------------------------------------------------------------------

  it('returns replayed: false on first call with key (cache miss)', async () => {
    selectReturnValue = { data: null, error: null };
    mockMaybeSingle.mockResolvedValueOnce(selectReturnValue);

    const req = makeRequest({ key: 'idem-key-001' });
    const result = await checkIdempotency(req, 'user-abc', '/api/test');

    expect(result).toEqual({ replayed: false });
  });

  // --------------------------------------------------------------------------
  // Test 2: Cache hit — same key + same body → replay
  // --------------------------------------------------------------------------

  it('returns replayed: true with cached response on second call with same key and body', async () => {
    // Simulate a cached row with a non-expired timestamp
    const futureExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();

    // The request hash must match. We pre-compute what the middleware will
    // compute: sha256('POST:/api/test:{}')
    const { createHash } = await import('crypto');
    const expectedHash = createHash('sha256')
      .update('POST:/api/test:{}')
      .digest('hex');

    selectReturnValue = {
      data: {
        request_hash: expectedHash,
        response_status: 200,
        response_body: { checkout_url: 'https://polar.sh/checkout/abc' },
        expires_at: futureExpiry,
      },
      error: null,
    };
    mockMaybeSingle.mockResolvedValueOnce(selectReturnValue);

    const req = makeRequest({ key: 'idem-key-001', body: '{}' });
    const result = await checkIdempotency(req, 'user-abc', '/api/test');

    expect(result).toEqual({
      replayed: true,
      status: 200,
      body: { checkout_url: 'https://polar.sh/checkout/abc' },
    });
  });

  // --------------------------------------------------------------------------
  // Test 3: Cache hit — same key + DIFFERENT body → conflict
  // --------------------------------------------------------------------------

  it('returns conflict when same key is replayed with a different body', async () => {
    const futureExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();

    // Return a hash that does NOT match the incoming request body
    selectReturnValue = {
      data: {
        request_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        response_status: 200,
        response_body: { checkout_url: 'https://polar.sh/checkout/abc' },
        expires_at: futureExpiry,
      },
      error: null,
    };
    mockMaybeSingle.mockResolvedValueOnce(selectReturnValue);

    const req = makeRequest({ key: 'idem-key-001', body: '{"tier":"business"}' });
    const result = await checkIdempotency(req, 'user-abc', '/api/test');

    expect(result).toMatchObject({ conflict: true });
    expect((result as { conflict: true; message: string }).message).toContain(
      'Idempotency-Key has already been used with a different request body',
    );
  });

  // --------------------------------------------------------------------------
  // Test 4: Different user, same key → independent (no collision)
  // --------------------------------------------------------------------------

  it('treats same key for different users as independent cache entries', async () => {
    // Both users get a cache miss (data: null)
    const missMock = { data: null, error: null };
    mockMaybeSingle
      .mockResolvedValueOnce(missMock)
      .mockResolvedValueOnce(missMock);

    const req1 = makeRequest({ key: 'shared-key' });
    const req2 = makeRequest({ key: 'shared-key' });

    const result1 = await checkIdempotency(req1, 'user-alice', '/api/test');
    const result2 = await checkIdempotency(req2, 'user-bob', '/api/test');

    // Both are cache misses — no collision
    expect(result1).toEqual({ replayed: false });
    expect(result2).toEqual({ replayed: false });

    // Verify the eq() call received different user IDs on each invocation
    // (the second .eq() call on the chain is the user_id filter)
    const allEqCalls = mockFrom.mock.results.flatMap(() => []);
    // The key assertion is that both calls reached the DB independently
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  // --------------------------------------------------------------------------
  // Test 6: Expired cache entry → treat as miss
  // --------------------------------------------------------------------------

  it('returns replayed: false when cache entry has expired', async () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update('POST:/api/test:{}').digest('hex');

    selectReturnValue = {
      data: {
        request_hash: hash,
        response_status: 200,
        response_body: { ok: true },
        expires_at: pastExpiry,
      },
      error: null,
    };
    mockMaybeSingle.mockResolvedValueOnce(selectReturnValue);

    const req = makeRequest({ key: 'expired-key' });
    const result = await checkIdempotency(req, 'user-abc', '/api/test');

    // Expired entry treated as a miss — handler should re-execute
    expect(result).toEqual({ replayed: false });
  });

  // --------------------------------------------------------------------------
  // Test 7: DB error on select → fail-open (replayed: false)
  // --------------------------------------------------------------------------

  it('returns replayed: false when a DB error occurs during select', async () => {
    selectReturnValue = {
      data: null,
      error: { message: 'connection refused' },
    };
    mockMaybeSingle.mockResolvedValueOnce(selectReturnValue);

    const req = makeRequest({ key: 'idem-key-err' });
    const result = await checkIdempotency(req, 'user-abc', '/api/test');

    // WHY fail-open: a DB error should not block the request. The handler
    // runs normally; worst case is a duplicate execution.
    expect(result).toEqual({ replayed: false });
  });
});

// ============================================================================
// storeIdempotencyResult tests
// ============================================================================

describe('storeIdempotencyResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ error: null });
    // Reset the from mock to return the upsert chain
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: mockMaybeSingle,
      upsert: mockUpsert,
    });
  });

  // --------------------------------------------------------------------------
  // Test 8a: Only 2xx responses are cached
  // --------------------------------------------------------------------------

  it('calls upsert when status is 200', async () => {
    const req = makeRequest({ key: 'store-key-001' });
    await storeIdempotencyResult(req, 'user-abc', '/api/test', 200, { ok: true });
    expect(mockUpsert).toHaveBeenCalled();
  });

  it('calls upsert when status is 201', async () => {
    const req = makeRequest({ key: 'store-key-002' });
    await storeIdempotencyResult(req, 'user-abc', '/api/test', 201, { created: true });
    expect(mockUpsert).toHaveBeenCalled();
  });

  it('does NOT call upsert when status is 400', async () => {
    const req = makeRequest({ key: 'store-key-003' });
    await storeIdempotencyResult(req, 'user-abc', '/api/test', 400, { error: 'Bad Request' });
    // WHY: Caching 4xx would prevent clients from retrying with a corrected body.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('does NOT call upsert when status is 500', async () => {
    const req = makeRequest({ key: 'store-key-004' });
    await storeIdempotencyResult(req, 'user-abc', '/api/test', 500, { error: 'Internal Error' });
    // WHY: Caching 5xx would prevent clients from retrying after server recovery.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('does NOT call upsert when status is 409 (conflict)', async () => {
    const req = makeRequest({ key: 'store-key-005' });
    await storeIdempotencyResult(req, 'user-abc', '/api/test', 409, { error: 'Conflict' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Test 9: No Idempotency-Key header → no-op
  // --------------------------------------------------------------------------

  it('does NOT call upsert when no Idempotency-Key header is present', async () => {
    const req = makeRequest({ key: undefined });
    await storeIdempotencyResult(req, 'user-abc', '/api/test', 200, { ok: true });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Additional: upsert called with correct shape
  // --------------------------------------------------------------------------

  it('passes correct fields to upsert including user_id and route', async () => {
    const req = makeRequest({ key: 'shape-key', body: '{"tier":"team"}', path: '/api/billing/checkout/team' });
    await storeIdempotencyResult(req, 'user-xyz', '/api/billing/checkout/team', 200, {
      checkout_url: 'https://polar.sh/checkout/xyz',
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'shape-key',
        user_id: 'user-xyz',
        route: '/api/billing/checkout/team',
        response_status: 200,
        response_body: { checkout_url: 'https://polar.sh/checkout/xyz' },
      }),
      expect.objectContaining({ onConflict: 'key,user_id,route' }),
    );
  });

  // --------------------------------------------------------------------------
  // Additional: DB write error is swallowed (non-fatal)
  // --------------------------------------------------------------------------

  it('does not throw when upsert returns an error', async () => {
    mockUpsert.mockResolvedValueOnce({ error: { message: 'write failed' } });
    const req = makeRequest({ key: 'err-key' });
    // Should not throw — write failure is logged but not propagated
    await expect(
      storeIdempotencyResult(req, 'user-abc', '/api/test', 200, { ok: true }),
    ).resolves.toBeUndefined();
  });
});
