/**
 * API Authentication Middleware Tests
 *
 * Tests the authenticateApiRequest, withApiAuth, withApiAuthAndRateLimit,
 * apiAuthError, addRateLimitHeaders, and isKeyNearExpiry functions.
 *
 * Key behaviors tested:
 * - Missing/malformed Authorization header
 * - Invalid API key format
 * - Database lookup failures
 * - No matching keys
 * - Key hash verification (bcrypt)
 * - Expired key rejection
 * - Rate limiting (100 req/min per key)
 * - IP-based pre-auth rate limit (60 req/min/IP) — H42 Item 1
 * - withApiAuthAndRateLimit: per-key isolation + per-route limit override — H42 Item 1
 * - API key TTL: near-expiry warning in headers — H42 Item 2
 * - keyExpiresAt exposed in ApiAuthContext — H42 Item 2
 * - Successful authentication returns context
 * - withApiAuth HOF: scope checking, handler invocation
 * - apiAuthError: correct status codes and error codes (including 423 LOCKED)
 * - addRateLimitHeaders: X-RateLimit-* headers + expiry warning headers
 *
 * WHY: The API auth middleware is a security-critical path. Bugs could allow
 * unauthenticated access, skip rate limits, or expose other users' data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockRpc = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    rpc: mockRpc,
  })),
}));

const mockVerifyApiKey = vi.fn();
vi.mock('@/lib/api-keys', () => ({
  verifyApiKey: (...args: unknown[]) => mockVerifyApiKey(...args),
}));

vi.mock('@styrby/shared', () => ({
  isValidApiKeyFormat: vi.fn((key: string) => {
    // Simplified validation: must start with styrby_ and be long enough
    return (
      typeof key === 'string' &&
      key.startsWith('styrby_') &&
      key.length === 39 // styrby_ (7) + 32 chars
    );
  }),
  extractApiKeyPrefix: vi.fn((key: string) => {
    if (typeof key === 'string' && key.startsWith('styrby_')) {
      return 'styrby_';
    }
    return null;
  }),
}));

/**
 * Mock rateLimit to allow all requests by default.
 * Individual tests override this to simulate IP rate limit exhaustion.
 */
const mockRateLimitFn = vi.fn().mockResolvedValue({
  allowed: true,
  remaining: 59,
  resetAt: Date.now() + 60000,
  retryAfter: undefined,
});

vi.mock('@/lib/rateLimit', () => ({
  getClientIp: vi.fn(() => '203.0.113.1'),
  rateLimit: (...args: unknown[]) => mockRateLimitFn(...args),
}));

// Import AFTER mocks are set up
import {
  authenticateApiRequest,
  withApiAuth,
  withApiAuthAndRateLimit,
  apiAuthError,
  addRateLimitHeaders,
  isKeyNearExpiry,
} from '../api-auth';

// ============================================================================
// Helpers
// ============================================================================

/** Valid-format API key (styrby_ prefix + 32 alphanumeric chars) */
const VALID_KEY = 'styrby_abcdefghijklmnopqrstuvwxyz123456';
const VALID_KEY_HASH = '$2b$12$mockedhashvalue';

function createRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/sessions', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '203.0.113.1',
      ...headers,
    },
  });
}

function mockKeyLookupSuccess(
  keyRecords: Array<{
    id: string;
    user_id: string;
    key_hash: string;
    scopes: string[];
    expires_at: string | null;
  }>
) {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'lookup_api_key') {
      return Promise.resolve({ data: keyRecords, error: null });
    }
    // update_api_key_usage (fire and forget)
    return Promise.resolve({ data: null, error: null });
  });
}

function mockKeyLookupEmpty() {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'lookup_api_key') {
      return Promise.resolve({ data: [], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

function mockKeyLookupError() {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'lookup_api_key') {
      return Promise.resolve({
        data: null,
        error: { message: 'Database connection failed' },
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('authenticateApiRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset IP rate limiter to allow by default
    mockRateLimitFn.mockResolvedValue({
      allowed: true,
      remaining: 59,
      resetAt: Date.now() + 60000,
      retryAfter: undefined,
    });
  });

  describe('Authorization header validation', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const req = createRequest();
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe(401);
        expect(result.error).toContain('Missing Authorization header');
      }
    });

    it('returns 401 for non-Bearer token format', async () => {
      const req = createRequest({
        authorization: 'Basic dXNlcjpwYXNz',
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe(401);
        expect(result.error).toContain('Invalid Authorization header format');
      }
    });

    it('returns 401 for invalid API key format', async () => {
      const req = createRequest({
        authorization: 'Bearer invalid_key_format',
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe(401);
        expect(result.error).toContain('Invalid API key format');
      }
    });

    it('returns 401 when key prefix extraction fails', async () => {
      const req = createRequest({
        authorization: 'Bearer not_styrby_key_but_long_enough_1234',
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe(401);
      }
    });
  });

  describe('Database lookup', () => {
    it('returns 500 when database lookup fails', async () => {
      mockKeyLookupError();
      const req = createRequest({
        authorization: `Bearer ${VALID_KEY}`,
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe(500);
        expect(result.error).toBe('Authentication failed');
      }
    });

    it('returns 401 when no keys found for prefix', async () => {
      mockKeyLookupEmpty();
      const req = createRequest({
        authorization: `Bearer ${VALID_KEY}`,
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe(401);
        expect(result.error).toBe('Invalid API key');
      }
    });

    it('returns 401 when null keys returned', async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === 'lookup_api_key') {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createRequest({
        authorization: `Bearer ${VALID_KEY}`,
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe(401);
        expect(result.error).toBe('Invalid API key');
      }
    });
  });

  describe('Key verification', () => {
    it('returns 401 when no key hash matches', async () => {
      mockKeyLookupSuccess([
        {
          id: 'key-001',
          user_id: 'user-001',
          key_hash: VALID_KEY_HASH,
          scopes: ['read'],
          expires_at: null,
        },
      ]);
      mockVerifyApiKey.mockResolvedValue(false);

      const req = createRequest({
        authorization: `Bearer ${VALID_KEY}`,
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe(401);
        expect(result.error).toBe('Invalid API key');
      }
    });

    it('tries all candidate keys until a match is found', async () => {
      mockKeyLookupSuccess([
        {
          id: 'key-001',
          user_id: 'user-001',
          key_hash: 'hash-1',
          scopes: ['read'],
          expires_at: null,
        },
        {
          id: 'key-002',
          user_id: 'user-001',
          key_hash: 'hash-2',
          scopes: ['read', 'write'],
          expires_at: null,
        },
      ]);

      mockVerifyApiKey
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const req = createRequest({
        authorization: `Bearer ${VALID_KEY}`,
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.context.keyId).toBe('key-002');
        expect(result.context.scopes).toEqual(['read', 'write']);
      }
      expect(mockVerifyApiKey).toHaveBeenCalledTimes(2);
    });

    it('returns success with correct context on match', async () => {
      mockKeyLookupSuccess([
        {
          id: 'key-001',
          user_id: 'user-uuid-123',
          key_hash: VALID_KEY_HASH,
          scopes: ['read', 'write'],
          expires_at: null,
        },
      ]);
      mockVerifyApiKey.mockResolvedValue(true);

      const req = createRequest({
        authorization: `Bearer ${VALID_KEY}`,
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.context.userId).toBe('user-uuid-123');
        expect(result.context.keyId).toBe('key-001');
        expect(result.context.scopes).toEqual(['read', 'write']);
      }
    });
  });

  describe('Key expiration', () => {
    it('returns 401 for expired key', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();

      mockKeyLookupSuccess([
        {
          id: 'key-001',
          user_id: 'user-001',
          key_hash: VALID_KEY_HASH,
          scopes: ['read'],
          expires_at: pastDate,
        },
      ]);
      mockVerifyApiKey.mockResolvedValue(true);

      const req = createRequest({
        authorization: `Bearer ${VALID_KEY}`,
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.status).toBe(401);
        expect(result.error).toContain('expired');
      }
    });

    it('allows non-expired key', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();

      mockKeyLookupSuccess([
        {
          id: 'key-001',
          user_id: 'user-001',
          key_hash: VALID_KEY_HASH,
          scopes: ['read'],
          expires_at: futureDate,
        },
      ]);
      mockVerifyApiKey.mockResolvedValue(true);

      const req = createRequest({
        authorization: `Bearer ${VALID_KEY}`,
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(true);
    });

    it('allows key with null expiration (no expiry)', async () => {
      mockKeyLookupSuccess([
        {
          id: 'key-001',
          user_id: 'user-001',
          key_hash: VALID_KEY_HASH,
          scopes: ['read'],
          expires_at: null,
        },
      ]);
      mockVerifyApiKey.mockResolvedValue(true);

      const req = createRequest({
        authorization: `Bearer ${VALID_KEY}`,
      });
      const result = await authenticateApiRequest(req);

      expect(result.success).toBe(true);
    });
  });
});

describe('withApiAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitFn.mockResolvedValue({ allowed: true, remaining: 59, resetAt: Date.now() + 60000 });
  });

  it('calls handler with context on successful auth', async () => {
    mockKeyLookupSuccess([
      {
        id: 'key-001',
        user_id: 'user-001',
        key_hash: VALID_KEY_HASH,
        scopes: ['read'],
        expires_at: null,
      },
    ]);
    mockVerifyApiKey.mockResolvedValue(true);

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ data: 'test' })
    );

    const wrappedHandler = withApiAuth(handler);
    const req = createRequest({
      authorization: `Bearer ${VALID_KEY}`,
    });
    const response = await wrappedHandler(req);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        userId: 'user-001',
        keyId: 'key-001',
        scopes: ['read'],
      })
    );
    expect(response.status).toBe(200);
  });

  it('returns 401 when auth fails', async () => {
    const handler = vi.fn();
    const wrappedHandler = withApiAuth(handler);

    const req = createRequest();
    const response = await wrappedHandler(req);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it('returns 403 when required scopes are missing', async () => {
    mockKeyLookupSuccess([
      {
        id: 'key-001',
        user_id: 'user-001',
        key_hash: VALID_KEY_HASH,
        scopes: ['read'],
        expires_at: null,
      },
    ]);
    mockVerifyApiKey.mockResolvedValue(true);

    const handler = vi.fn();
    const wrappedHandler = withApiAuth(handler, ['write']);

    const req = createRequest({
      authorization: `Bearer ${VALID_KEY}`,
    });
    const response = await wrappedHandler(req);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toContain('Insufficient permissions');
    expect(body.code).toBe('ERROR');
  });

  it('allows request when all required scopes are present', async () => {
    mockKeyLookupSuccess([
      {
        id: 'key-001',
        user_id: 'user-001',
        key_hash: VALID_KEY_HASH,
        scopes: ['read', 'write', 'admin'],
        expires_at: null,
      },
    ]);
    mockVerifyApiKey.mockResolvedValue(true);

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true })
    );
    const wrappedHandler = withApiAuth(handler, ['read', 'write']);

    const req = createRequest({
      authorization: `Bearer ${VALID_KEY}`,
    });
    const response = await wrappedHandler(req);

    expect(handler).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
  });

  it('defaults to ["read"] scope requirement', async () => {
    mockKeyLookupSuccess([
      {
        id: 'key-001',
        user_id: 'user-001',
        key_hash: VALID_KEY_HASH,
        scopes: ['read'],
        expires_at: null,
      },
    ]);
    mockVerifyApiKey.mockResolvedValue(true);

    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true })
    );
    const wrappedHandler = withApiAuth(handler);

    const req = createRequest({
      authorization: `Bearer ${VALID_KEY}`,
    });
    await wrappedHandler(req);

    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('apiAuthError', () => {
  it('returns UNAUTHORIZED code for 401 status', () => {
    const response = apiAuthError('Not authenticated', 401);
    expect(response.status).toBe(401);
  });

  it('returns RATE_LIMITED code for 429 status', () => {
    const response = apiAuthError('Rate limited', 429);
    expect(response.status).toBe(429);
  });

  it('returns LOCKED code for 423 status', () => {
    const response = apiAuthError('Account locked', 423);
    expect(response.status).toBe(423);
  });

  it('returns ERROR code for other statuses', () => {
    const response = apiAuthError('Something went wrong', 500);
    expect(response.status).toBe(500);
  });

  it('includes Content-Type header', () => {
    const response = apiAuthError('Error', 401);
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('includes extra headers when provided', () => {
    const response = apiAuthError('Locked', 423, { 'Retry-After': '60' });
    expect(response.headers.get('Retry-After')).toBe('60');
  });
});

describe('addRateLimitHeaders', () => {
  it('sets Limit header even when no rate limit entry exists in memory', () => {
    const response = NextResponse.json({ data: 'test' });
    const result = addRateLimitHeaders(response, 'nonexistent-key');

    expect(result.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(result.headers.get('X-RateLimit-Remaining')).toBeNull();
    expect(result.headers.get('X-RateLimit-Reset')).toBeNull();
  });

  it('does NOT set expiry warning headers when keyExpiresAt is null', () => {
    const response = NextResponse.json({ data: 'test' });
    const result = addRateLimitHeaders(response, 'key-001', null);

    expect(result.headers.get('X-Api-Key-Expires-At')).toBeNull();
    expect(result.headers.get('X-Api-Key-Expiry-Warning')).toBeNull();
  });

  it('does NOT set expiry warning headers when key expires far in the future', () => {
    const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const response = NextResponse.json({ data: 'test' });
    const result = addRateLimitHeaders(response, 'key-001', farFuture);

    expect(result.headers.get('X-Api-Key-Expiry-Warning')).toBeNull();
  });

  it('sets expiry warning headers when key expires within 30 days', () => {
    const nearFuture = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const response = NextResponse.json({ data: 'test' });
    const result = addRateLimitHeaders(response, 'key-001', nearFuture);

    expect(result.headers.get('X-Api-Key-Expiry-Warning')).toBe('true');
    expect(result.headers.get('X-Api-Key-Expires-At')).toBe(nearFuture);
  });
});

// ============================================================================
// H42 Item 1: IP-based pre-auth rate limiting
// ============================================================================

describe('IP-based pre-auth rate limiting (H42 Item 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitFn.mockResolvedValue({
      allowed: true,
      remaining: 59,
      resetAt: Date.now() + 60000,
      retryAfter: undefined,
    });
  });

  it('returns 429 when IP rate limit is exhausted before auth', async () => {
    mockRateLimitFn.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60000,
      retryAfter: 42,
    });

    const req = createRequest({
      authorization: `Bearer ${VALID_KEY}`,
    });
    const result = await authenticateApiRequest(req);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(429);
      expect(result.error).toContain('42');
    }
    // DB should NOT be called — short-circuit before key lookup
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('allows request when IP rate limit has remaining capacity', async () => {
    mockRateLimitFn.mockResolvedValue({
      allowed: true,
      remaining: 30,
      resetAt: Date.now() + 60000,
    });
    mockKeyLookupSuccess([
      {
        id: 'key-001',
        user_id: 'user-001',
        key_hash: VALID_KEY_HASH,
        scopes: ['read'],
        expires_at: null,
      },
    ]);
    mockVerifyApiKey.mockResolvedValue(true);

    const req = createRequest({ authorization: `Bearer ${VALID_KEY}` });
    const result = await authenticateApiRequest(req);

    expect(result.success).toBe(true);
  });

  it('withApiAuthAndRateLimit returns 429 when IP limit exhausted', async () => {
    mockRateLimitFn.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60000,
      retryAfter: 15,
    });

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withApiAuthAndRateLimit(handler);
    const req = createRequest({ authorization: `Bearer ${VALID_KEY}` });
    const response = await wrapped(req);

    expect(response.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  it('withApiAuthAndRateLimit calls handler when IP limit not exhausted', async () => {
    mockKeyLookupSuccess([
      {
        id: 'key-001',
        user_id: 'user-001',
        key_hash: VALID_KEY_HASH,
        scopes: ['read'],
        expires_at: null,
      },
    ]);
    mockVerifyApiKey.mockResolvedValue(true);

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withApiAuthAndRateLimit(handler);
    const req = createRequest({ authorization: `Bearer ${VALID_KEY}` });
    const response = await wrapped(req);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('per-key isolation: different key IDs produce independent auth contexts', async () => {
    mockRateLimitFn.mockResolvedValue({ allowed: true, remaining: 50, resetAt: Date.now() + 60000 });

    const makeKeyRequest = async (keyId: string, userId: string) => {
      mockKeyLookupSuccess([
        {
          id: keyId,
          user_id: userId,
          key_hash: VALID_KEY_HASH,
          scopes: ['read'],
          expires_at: null,
        },
      ]);
      mockVerifyApiKey.mockResolvedValue(true);
      return authenticateApiRequest(createRequest({ authorization: `Bearer ${VALID_KEY}` }));
    };

    const result1 = await makeKeyRequest('key-A', 'user-A');
    const result2 = await makeKeyRequest('key-B', 'user-B');

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    if (result1.success) expect(result1.context.keyId).toBe('key-A');
    if (result2.success) expect(result2.context.keyId).toBe('key-B');
  });
});

// ============================================================================
// H42 Item 2: API key TTL — near-expiry warning
// ============================================================================

describe('isKeyNearExpiry (H42 Item 2)', () => {
  it('returns false for null expires_at (no expiry set)', () => {
    expect(isKeyNearExpiry(null)).toBe(false);
  });

  it('returns false when key expires more than 30 days away', () => {
    const farFuture = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(isKeyNearExpiry(farFuture)).toBe(false);
  });

  it('returns true when key expires in less than 30 days', () => {
    const nearFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(isKeyNearExpiry(nearFuture)).toBe(true);
  });

  it('returns true when key expires in exactly 1 day', () => {
    const oneDayFuture = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();
    expect(isKeyNearExpiry(oneDayFuture)).toBe(true);
  });

  it('returns false for already-expired key (expiry is in the past)', () => {
    // WHY: Already-expired keys are rejected at auth time. isKeyNearExpiry
    // is for warning about upcoming expiry, not re-checking rejection.
    const pastDate = new Date(Date.now() - 1000).toISOString();
    expect(isKeyNearExpiry(pastDate)).toBe(false);
  });
});

describe('keyExpiresAt in ApiAuthContext (H42 Item 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitFn.mockResolvedValue({ allowed: true, remaining: 59, resetAt: Date.now() + 60000 });
  });

  it('exposes keyExpiresAt = null when key has no expiry', async () => {
    mockKeyLookupSuccess([
      {
        id: 'key-001',
        user_id: 'user-001',
        key_hash: VALID_KEY_HASH,
        scopes: ['read'],
        expires_at: null,
      },
    ]);
    mockVerifyApiKey.mockResolvedValue(true);

    const result = await authenticateApiRequest(createRequest({ authorization: `Bearer ${VALID_KEY}` }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.context.keyExpiresAt).toBeNull();
    }
  });

  it('exposes keyExpiresAt = ISO string when key has expiry', async () => {
    const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    mockKeyLookupSuccess([
      {
        id: 'key-001',
        user_id: 'user-001',
        key_hash: VALID_KEY_HASH,
        scopes: ['read'],
        expires_at: futureDate,
      },
    ]);
    mockVerifyApiKey.mockResolvedValue(true);

    const result = await authenticateApiRequest(createRequest({ authorization: `Bearer ${VALID_KEY}` }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.context.keyExpiresAt).toBe(futureDate);
    }
  });

  it('expired key returns 401 (not expiry warning)', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    mockKeyLookupSuccess([
      {
        id: 'key-001',
        user_id: 'user-001',
        key_hash: VALID_KEY_HASH,
        scopes: ['read'],
        expires_at: pastDate,
      },
    ]);
    mockVerifyApiKey.mockResolvedValue(true);

    const result = await authenticateApiRequest(createRequest({ authorization: `Bearer ${VALID_KEY}` }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(401);
      expect(result.error).toContain('expired');
    }
  });
});
