/**
 * POST /api/v1/auth/oauth/callback — Unit Tests
 *
 * Tests the unauthenticated OAuth callback endpoint for the Styrby CLI.
 * This is a Category C (pre-auth) endpoint — caller has no API key yet.
 *
 * Test coverage:
 *   1. Zod validation failures (missing code, oversized state, unknown field)
 *   2. 401 on Supabase exchange error (exchangeCodeForSession returns error)
 *   3. 401 on Supabase exchange throw (exchangeCodeForSession throws)
 *   4. Happy path 200 — valid code+state → key minted → { styrby_api_key, expires_at }
 *   5. Key minted is bound to user.id from Supabase response
 *   6. Key NEVER logged in Sentry (no 'styrby_' substring in captureException args)
 *   7. 429 rate limit — POST with mocked rate limiter denied
 *   8. 500 + Sentry on unexpected error (minter throws)
 *   9. No auth wrapper — handler exported directly as raw async function
 *
 * @security OWASP A07:2021 (token minting — auth before key issuance)
 * @security OWASP A02:2021 (cryptographic failures — hash discipline)
 * @security OWASP A05:2021 (security misconfiguration — TTL enforced)
 * @security OWASP A03:2021 (mass assignment — .strict())
 * @security SOC 2 CC6.1 (logical access controls)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks — Sentry (must be before handler import)
// ============================================================================

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ============================================================================
// Mocks — Rate limiter
// ============================================================================

/**
 * Mutable rate limit state.
 * WHY mutable: most tests want the rate limiter to pass (allowed: true).
 * Only the rate-limit-specific tests flip this to false.
 */
let mockRateLimitAllowed = true;
let mockRateLimitRetryAfter = 30;

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(async () => ({
    allowed: mockRateLimitAllowed,
    remaining: mockRateLimitAllowed ? 4 : 0,
    resetAt: Date.now() + 60_000,
    retryAfter: mockRateLimitAllowed ? undefined : mockRateLimitRetryAfter,
  })),
  rateLimitResponse: vi.fn((retryAfter: number) => {
    const { NextResponse } = require('next/server');
    return NextResponse.json(
      { error: 'RATE_LIMITED', retryAfter },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      }
    );
  }),
  getClientIp: vi.fn(() => '1.2.3.4'),
}));

// ============================================================================
// Mocks — styrby/shared generateApiKey
// ============================================================================

/**
 * Mutable key generation state.
 * WHY mutable: the "500 on minter throw" test needs the mock to throw.
 */
let mockGenerateApiKeyThrows = false;
const MOCK_RAW_KEY = 'styrby_test_raw_key_abc123';
const MOCK_PREFIX = 'styrby_';

vi.mock('@styrby/shared', () => ({
  generateApiKey: vi.fn(() => {
    if (mockGenerateApiKeyThrows) {
      throw new Error('generateApiKey failed');
    }
    return {
      key: MOCK_RAW_KEY,
      prefix: MOCK_PREFIX,
      randomPart: 'test_raw_key_abc123',
    };
  }),
}));

// ============================================================================
// Mocks — api-keys hashing
// ============================================================================

/**
 * WHY mock hashApiKey: bcrypt is slow (300ms+ per hash). Unit tests must
 * complete fast; we test the bcrypt behaviour in the api-keys lib tests.
 * Here we verify that hashApiKey is called and the hash is passed to insert.
 */
const MOCK_HASH = '$2b$12$mockhashvalue';
let mockHashApiKeyThrows = false;

vi.mock('@/lib/api-keys', () => ({
  hashApiKey: vi.fn(async () => {
    if (mockHashApiKeyThrows) {
      throw new Error('hashApiKey failed');
    }
    return MOCK_HASH;
  }),
}));

// ============================================================================
// Mocks — Supabase admin client
// ============================================================================

/**
 * Mutable Supabase mock state.
 * - mockExchangeResult: controls what exchangeCodeForSession returns
 * - mockExchangeThrows: if true, exchangeCodeForSession throws
 * - mockInsertError: controls api_keys insert error
 */
let mockExchangeResult: {
  data: { user: { id: string; email: string } | null; session: unknown } | null;
  error: { message: string } | null;
} = {
  data: { user: { id: 'user-uuid-abc123', email: 'user@example.com' }, session: {} },
  error: null,
};
let mockExchangeThrows = false;
let mockInsertError: { message: string } | null = null;

const mockExchangeCodeForSession = vi.fn(async () => {
  if (mockExchangeThrows) {
    throw new Error('Supabase network error');
  }
  return mockExchangeResult;
});

const mockInsert = vi.fn(async () => ({
  error: mockInsertError,
  data: null,
}));

// The insert mock chain: .from('api_keys').insert({...}) — Supabase returns a
// thenable with .select() and .single(), but this endpoint only calls .insert()
// without chaining select/single. We mock the chained shape defensively.
const mockFrom = vi.fn(() => ({
  insert: vi.fn(() => mockInsert()),
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
    },
    from: mockFrom,
  })),
}));

// ============================================================================
// Import handler AFTER mocks are set up
// ============================================================================

import { POST, OAUTH_CALLBACK_RATE_LIMIT, KEY_TTL_DAYS } from '../route';
import * as Sentry from '@sentry/nextjs';
import { rateLimit } from '@/lib/rateLimit';
import { generateApiKey } from '@styrby/shared';
import { hashApiKey } from '@/lib/api-keys';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a NextRequest for POST /api/v1/auth/oauth/callback.
 *
 * @param body - Request body (will be JSON.stringified).
 * @param ip - Simulated client IP (via X-Forwarded-For).
 */
function makeRequest(body: unknown, ip = '1.2.3.4'): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/auth/oauth/callback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify(body),
  });
}

// ============================================================================
// Test setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();

  // Reset to passing state
  mockRateLimitAllowed = true;
  mockRateLimitRetryAfter = 30;

  mockExchangeResult = {
    data: { user: { id: 'user-uuid-abc123', email: 'user@example.com' }, session: {} },
    error: null,
  };
  mockExchangeThrows = false;
  mockInsertError = null;
  mockGenerateApiKeyThrows = false;
  mockHashApiKeyThrows = false;
});

// ============================================================================
// 1. Zod validation failures
// ============================================================================

describe('POST /api/v1/auth/oauth/callback — Zod validation failures', () => {
  it('returns 400 when code is missing', async () => {
    const res = await POST(makeRequest({ state: 'somestate123' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when state is missing', async () => {
    const res = await POST(makeRequest({ code: 'somecode123' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when code is empty string', async () => {
    const res = await POST(makeRequest({ code: '', state: 'somestate123' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when state is empty string', async () => {
    const res = await POST(makeRequest({ code: 'somecode123', state: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when code exceeds 2048 chars', async () => {
    const oversizedCode = 'x'.repeat(2049);
    const res = await POST(makeRequest({ code: oversizedCode, state: 'somestate123' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when state exceeds 2048 chars', async () => {
    const oversizedState = 's'.repeat(2049);
    const res = await POST(makeRequest({ code: 'somecode123', state: oversizedState }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for unknown fields (.strict() mass-assignment guard)', async () => {
    const res = await POST(makeRequest({
      code: 'somecode123',
      state: 'somestate123',
      user_id: 'injected-user-id',   // attacker trying to inject user_id
      access_token: 'stolen-token',  // attacker trying to bypass exchange
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-JSON body', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/auth/oauth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' },
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });
});

// ============================================================================
// 2. 401 on Supabase exchange error
// ============================================================================

describe('POST /api/v1/auth/oauth/callback — 401 on Supabase exchange error', () => {
  it('returns 401 when exchangeCodeForSession returns an error', async () => {
    mockExchangeResult = {
      data: null,
      error: { message: 'code has already been used' },
    };

    const res = await POST(makeRequest({ code: 'expired-code', state: 'state123' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('AUTH_FAILED');
    // WHY: do NOT distinguish specific failure modes (OWASP A07:2021 info leakage)
    expect(body).not.toHaveProperty('message');
  });

  it('does NOT call Sentry on a normal auth failure (401 is expected, not exceptional)', async () => {
    mockExchangeResult = {
      data: null,
      error: { message: 'invalid code' },
    };

    await POST(makeRequest({ code: 'bad-code', state: 'state123' }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('returns 401 when exchange succeeds but user is null', async () => {
    mockExchangeResult = {
      data: { user: null, session: {} },
      error: null,
    };

    const res = await POST(makeRequest({ code: 'code123', state: 'state123' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('AUTH_FAILED');
  });
});

// ============================================================================
// 3. 401 on Supabase exchange throw
// ============================================================================

describe('POST /api/v1/auth/oauth/callback — 401 on Supabase exchange throw', () => {
  it('returns 401 when exchangeCodeForSession throws (network error, etc.)', async () => {
    mockExchangeThrows = true;

    const res = await POST(makeRequest({ code: 'code123', state: 'state123' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('AUTH_FAILED');
  });

  it('does NOT call Sentry when exchange throws (auth errors are expected)', async () => {
    mockExchangeThrows = true;

    await POST(makeRequest({ code: 'code123', state: 'state123' }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4. Happy path 200
// ============================================================================

describe('POST /api/v1/auth/oauth/callback — Happy path', () => {
  it('returns 200 with styrby_api_key and expires_at', async () => {
    const res = await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(body).toHaveProperty('styrby_api_key');
    expect(body).toHaveProperty('expires_at');
    expect(typeof body.styrby_api_key).toBe('string');
    expect(typeof body.expires_at).toBe('string');
  });

  it('returns the raw generated key (not the hash) in styrby_api_key', async () => {
    const res = await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));
    const body = await res.json();
    // The mock generateApiKey returns MOCK_RAW_KEY
    expect(body.styrby_api_key).toBe(MOCK_RAW_KEY);
    // Must NOT be the bcrypt hash
    expect(body.styrby_api_key).not.toBe(MOCK_HASH);
  });

  it('returns expires_at approximately KEY_TTL_DAYS from now', async () => {
    const before = Date.now();
    const res = await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));
    const after = Date.now();

    const body = await res.json();
    const expiresMs = new Date(body.expires_at).getTime();
    const expectedMin = before + KEY_TTL_DAYS * 24 * 60 * 60 * 1000;
    const expectedMax = after + KEY_TTL_DAYS * 24 * 60 * 60 * 1000;

    expect(expiresMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresMs).toBeLessThanOrEqual(expectedMax);
  });

  it('calls exchangeCodeForSession with the code from the request body', async () => {
    const CODE = 'specific-auth-code-xyz';
    await POST(makeRequest({ code: CODE, state: 'some-state' }));
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith(CODE);
  });

  it('does not call Sentry on success', async () => {
    await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 5. Key bound to user.id from Supabase response
// ============================================================================

describe('POST /api/v1/auth/oauth/callback — Key bound to authenticated user_id', () => {
  it('inserts the api_key with the user_id from exchangeCodeForSession result', async () => {
    const EXPECTED_USER_ID = 'user-uuid-abc123';
    mockExchangeResult = {
      data: { user: { id: EXPECTED_USER_ID, email: 'user@example.com' }, session: {} },
      error: null,
    };

    await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));

    // Verify the insert call includes the correct user_id
    expect(mockFrom).toHaveBeenCalledWith('api_keys');
    const fromCallResult = mockFrom.mock.results[mockFrom.mock.results.length - 1].value;
    expect(fromCallResult.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: EXPECTED_USER_ID,
        key_hash: MOCK_HASH,         // hash, not plaintext
        key_prefix: MOCK_PREFIX,
      })
    );
  });

  it('passes the plaintext key to hashApiKey (not the hash to the API)', async () => {
    await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));
    // generateApiKey returns MOCK_RAW_KEY; hashApiKey should receive that
    expect(hashApiKey).toHaveBeenCalledWith(MOCK_RAW_KEY);
  });

  it('never inserts the plaintext key into the database', async () => {
    await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));
    const fromCallResult = mockFrom.mock.results[mockFrom.mock.results.length - 1].value;
    const insertCall = (fromCallResult.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // The inserted record must not contain the plaintext key
    const insertedValues = JSON.stringify(insertCall);
    expect(insertedValues).not.toContain(MOCK_RAW_KEY);
    // But it must contain the hash
    expect(insertedValues).toContain(MOCK_HASH);
  });
});

// ============================================================================
// 6. Key NEVER logged in Sentry
// ============================================================================

describe('POST /api/v1/auth/oauth/callback — Key not in Sentry on 5xx', () => {
  it('does NOT include the raw styrby_* key in Sentry captureException args on insert failure', async () => {
    // Force the DB insert to fail so Sentry is called
    mockInsertError = { message: 'DB insert failed' };

    await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));

    expect(Sentry.captureException).toHaveBeenCalled();

    // Inspect ALL arguments across ALL Sentry.captureException calls for the
    // raw key string. If it appears anywhere, we have a key-in-Sentry leak.
    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain(MOCK_RAW_KEY);
    // Also confirm no 'styrby_' prefix appears (belt-and-suspenders)
    // NOTE: MOCK_PREFIX is 'styrby_' — only match if followed by the key chars
    expect(argsAsString).not.toContain(MOCK_RAW_KEY.slice(8)); // unique random suffix
  });

  it('does NOT include the raw key in Sentry args when generateApiKey throws', async () => {
    mockGenerateApiKeyThrows = true;

    await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));

    // generateApiKey threw before key was assigned — Sentry should still be called
    expect(Sentry.captureException).toHaveBeenCalled();

    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    // No plaintext key could appear since generateApiKey threw before creating one
    expect(argsAsString).not.toContain('styrby_test_raw_key');
  });

  it('does NOT include email in Sentry tags (PII hygiene — GDPR Art 6)', async () => {
    mockInsertError = { message: 'DB insert failed' };
    mockExchangeResult = {
      data: { user: { id: 'user-uuid-abc123', email: 'secret@email.com' }, session: {} },
      error: null,
    };

    await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));

    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain('secret@email.com');
  });
});

// ============================================================================
// 7. 429 rate limit
// ============================================================================

describe('POST /api/v1/auth/oauth/callback — Rate limit', () => {
  it('returns 429 when the rate limiter denies the request', async () => {
    mockRateLimitAllowed = false;
    mockRateLimitRetryAfter = 45;

    const res = await POST(makeRequest({ code: 'code123', state: 'state123' }));
    expect(res.status).toBe(429);
    // Must NOT have called Supabase
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('includes Retry-After header on 429', async () => {
    mockRateLimitAllowed = false;
    mockRateLimitRetryAfter = 45;

    const res = await POST(makeRequest({ code: 'code123', state: 'state123' }));
    expect(res.status).toBe(429);
    // rateLimitResponse mock sets Retry-After via rateLimitResponse function
    expect(res.headers.get('Retry-After')).toBe('45');
  });

  it('calls rateLimit with oauth-callback prefix and correct config', async () => {
    const req = makeRequest({ code: 'code123', state: 'state123' });
    await POST(req);
    expect(rateLimit).toHaveBeenCalledWith(req, OAUTH_CALLBACK_RATE_LIMIT, 'oauth-callback');
  });

  it('OAUTH_CALLBACK_RATE_LIMIT is 5 requests per 60 seconds', () => {
    expect(OAUTH_CALLBACK_RATE_LIMIT.maxRequests).toBe(5);
    expect(OAUTH_CALLBACK_RATE_LIMIT.windowMs).toBe(60_000);
  });
});

// ============================================================================
// 8. 500 + Sentry on unexpected errors
// ============================================================================

describe('POST /api/v1/auth/oauth/callback — 500 + Sentry on unexpected error', () => {
  it('returns 500 and captures to Sentry when DB insert fails', async () => {
    mockInsertError = { message: 'constraint violation' };

    const res = await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('returns 500 and captures to Sentry when generateApiKey throws', async () => {
    mockGenerateApiKeyThrows = true;

    const res = await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('returns 500 and captures to Sentry when hashApiKey throws', async () => {
    mockHashApiKeyThrows = true;

    const res = await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('includes user_id (not email) in Sentry tags on insert failure (operationally needed)', async () => {
    mockInsertError = { message: 'DB error' };

    await POST(makeRequest({ code: 'valid-code', state: 'valid-state' }));

    const captureCall = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls[0];
    const context = captureCall[1] as { tags?: Record<string, string> };
    expect(context?.tags?.user_id).toBe('user-uuid-abc123');
  });
});

// ============================================================================
// 9. No auth wrapper
// ============================================================================

describe('POST /api/v1/auth/oauth/callback — No auth wrapper', () => {
  it('is exported as a raw async function (no withApiAuthAndRateLimit wrapper)', () => {
    // The handler must be a plain async function — unauthenticated callers
    // must reach this endpoint without a styrby_* API key.
    expect(POST).toBeTypeOf('function');
    expect(POST.length).toBe(1); // exactly one parameter: request
  });

  it('does NOT require an Authorization header to reach the handler', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/auth/oauth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'valid-code', state: 'valid-state' }),
    });
    const res = await POST(req);
    // No 401 from auth middleware — handler is reached
    expect(res.status).toBe(200);
  });
});
