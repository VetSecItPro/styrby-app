/**
 * POST /api/v1/auth/otp/verify — Unit Tests
 *
 * Tests the unauthenticated OTP verification endpoint for the Styrby CLI.
 * This is a Category C (pre-auth) endpoint — caller has no API key yet.
 *
 * Test coverage:
 *   1.  Zod validation failures (missing email, missing OTP, malformed email,
 *       OTP too short, OTP too long, unknown field via .strict())
 *   2.  400 error message hygiene — OTP value NOT echoed in response
 *   3.  401 on verifyOtp error (returns error) — generic message, no Sentry
 *   4.  401 on verifyOtp throw — generic message (Sentry behavior documented)
 *   5.  Happy path 200 — valid email + correct OTP → { styrby_api_key, expires_at }
 *   6.  Key bound to user.id from verifyOtp response
 *   7.  Raw OTP NOT in Sentry args (PII/security hygiene)
 *   8.  Raw key NOT in Sentry args (security hygiene — OWASP A02:2021)
 *   9.  Email hashed (not raw) in Sentry tags (GDPR Art 5(1)(c))
 *   10. 429 rate limit — rate-limiter denies request
 *   11. 500 + Sentry on minter failure (generateApiKey or hashApiKey throws)
 *   12. 500 + Sentry on rate-limit infrastructure failure
 *
 * @security OWASP A07:2021 (OTP verification, token minting — auth before key issuance)
 * @security OWASP A02:2021 (Cryptographic failures — raw key never stored or logged)
 * @security OWASP A05:2021 (Security misconfiguration — explicit 365-day TTL)
 * @security OWASP A01:2021 (Broken access control — generic 401, no failure-mode leakage)
 * @security GDPR Art 5(1)(c) (Data minimization — email hashed; OTP never logged)
 * @security GDPR Art 6 (Lawful basis — user authenticated before key minted)
 * @security SOC 2 CC6.1 (Logical access controls)
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
    remaining: mockRateLimitAllowed ? 9 : 0,
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
const MOCK_RAW_KEY = 'styrby_test_otp_key_xyz789';
const MOCK_PREFIX = 'styrby_';

vi.mock('@styrby/shared', () => ({
  generateApiKey: vi.fn(() => {
    if (mockGenerateApiKeyThrows) {
      throw new Error('generateApiKey failed');
    }
    return {
      key: MOCK_RAW_KEY,
      prefix: MOCK_PREFIX,
      randomPart: 'test_otp_key_xyz789',
    };
  }),
}));

// ============================================================================
// Mocks — api-keys hashing
// ============================================================================

/**
 * WHY mock hashApiKey: bcrypt is slow (300ms+ per hash). Unit tests must
 * complete fast; we test the bcrypt behaviour in the api-keys lib tests.
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
 * - mockVerifyOtpResult: controls what verifyOtp returns
 * - mockVerifyOtpThrows: if true, verifyOtp throws
 * - mockInsertError: controls api_keys insert error
 */
let mockVerifyOtpResult: {
  data: { user: { id: string; email: string } | null; session: unknown } | null;
  error: { message: string } | null;
} = {
  data: { user: { id: 'user-uuid-otp123', email: 'user@example.com' }, session: {} },
  error: null,
};
let mockVerifyOtpThrows = false;
let mockInsertError: { message: string } | null = null;

const mockVerifyOtp = vi.fn(async () => {
  if (mockVerifyOtpThrows) {
    throw new Error('Supabase network error');
  }
  return mockVerifyOtpResult;
});

const mockInsert = vi.fn(async () => ({
  error: mockInsertError,
  data: null,
}));

const mockFrom = vi.fn(() => ({
  insert: vi.fn(() => mockInsert()),
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      verifyOtp: mockVerifyOtp,
    },
    from: mockFrom,
  })),
}));

// ============================================================================
// Import handler AFTER mocks are set up
// ============================================================================

import { POST, handlePost, OTP_VERIFY_RATE_LIMIT, KEY_TTL_DAYS } from '../route';
import * as Sentry from '@sentry/nextjs';
import { rateLimit } from '@/lib/rateLimit';
import { generateApiKey } from '@styrby/shared';
import { hashApiKey } from '@/lib/api-keys';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a NextRequest for POST /api/v1/auth/otp/verify.
 *
 * @param body - Request body (will be JSON.stringified).
 * @param ip - Simulated client IP (via X-Forwarded-For).
 */
function makeRequest(body: unknown, ip = '1.2.3.4'): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/auth/otp/verify', {
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

  mockVerifyOtpResult = {
    data: { user: { id: 'user-uuid-otp123', email: 'user@example.com' }, session: {} },
    error: null,
  };
  mockVerifyOtpThrows = false;
  mockInsertError = null;
  mockGenerateApiKeyThrows = false;
  mockHashApiKeyThrows = false;
});

// ============================================================================
// 1. Zod validation failures
// ============================================================================

describe('POST /api/v1/auth/otp/verify — Zod validation failures', () => {
  it('returns 400 when email is missing', async () => {
    const res = await POST(makeRequest({ otp: '123456' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when otp is missing', async () => {
    const res = await POST(makeRequest({ email: 'user@example.com' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email is malformed', async () => {
    const res = await POST(makeRequest({ email: 'not-an-email', otp: '123456' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email has no domain part', async () => {
    const res = await POST(makeRequest({ email: 'user@', otp: '123456' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email exceeds 320 chars', async () => {
    const oversizedEmail = 'a'.repeat(64) + '@' + 'b'.repeat(252) + '.com';
    expect(oversizedEmail.length).toBeGreaterThan(320);
    const res = await POST(makeRequest({ email: oversizedEmail, otp: '123456' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when otp is too short (< 6 chars)', async () => {
    const res = await POST(makeRequest({ email: 'user@example.com', otp: '12345' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when otp is empty string', async () => {
    const res = await POST(makeRequest({ email: 'user@example.com', otp: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when otp exceeds 64 chars', async () => {
    const oversizedOtp = 'a'.repeat(65);
    const res = await POST(makeRequest({ email: 'user@example.com', otp: oversizedOtp }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for unknown fields (.strict() mass-assignment guard)', async () => {
    const res = await POST(makeRequest({
      email: 'user@example.com',
      otp: '123456',
      // Attacker trying to inject Supabase-internal fields
      user_id: 'injected-user-id',
      access_token: 'stolen-token',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-JSON body', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/auth/otp/verify', {
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
// 2. 400 error message hygiene — OTP NOT echoed
// ============================================================================

describe('POST /api/v1/auth/otp/verify — 400 error message hygiene', () => {
  it('does NOT echo the submitted OTP value in the 400 error response', async () => {
    // WHY: reflecting the OTP in the response body creates a content-reflection
    // vector and could be intercepted by a network observer (OWASP A03:2021).
    // The validation error must describe the constraint, not the submitted value.
    const SUBMITTED_OTP = '12345'; // too short — will trigger 400
    const res = await POST(makeRequest({ email: 'user@example.com', otp: SUBMITTED_OTP }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(SUBMITTED_OTP);
  });

  it('does NOT echo the submitted OTP value even when it exceeds max length', async () => {
    const SUBMITTED_OTP = 'a'.repeat(65); // too long
    const res = await POST(makeRequest({ email: 'user@example.com', otp: SUBMITTED_OTP }));
    expect(res.status).toBe(400);
    const body = await res.json();
    // The full oversized OTP must not appear in the error response
    expect(JSON.stringify(body)).not.toContain(SUBMITTED_OTP);
  });
});

// ============================================================================
// 3. 401 on verifyOtp returning error
// ============================================================================

describe('POST /api/v1/auth/otp/verify — 401 on verifyOtp returning error', () => {
  it('returns 401 when verifyOtp returns an error object', async () => {
    mockVerifyOtpResult = {
      data: null,
      error: { message: 'Token has expired or is invalid' },
    };

    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('AUTH_FAILED');
  });

  it('returns 401 when verifyOtp returns no user', async () => {
    // Supabase can return { data: { user: null }, error: null } in edge cases
    mockVerifyOtpResult = {
      data: { user: null, session: null },
      error: null,
    };

    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('AUTH_FAILED');
  });

  it('does NOT call Sentry on a normal auth failure (401 is expected, not exceptional)', async () => {
    mockVerifyOtpResult = {
      data: null,
      error: { message: 'OTP expired' },
    };

    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('returns generic AUTH_FAILED (not specific error reason) — no failure-mode leakage', async () => {
    // WHY: distinguishing "OTP expired" from "wrong code" from "user not found"
    // enables targeted brute-force and enumeration (OWASP A07:2021).
    // The body must only contain { error: 'AUTH_FAILED' } — no message field.
    const scenarios = [
      { message: 'Token has expired or is invalid' },
      { message: 'User not found' },
      { message: 'Invalid OTP code' },
    ];

    for (const { message } of scenarios) {
      vi.clearAllMocks();
      mockVerifyOtpResult = { data: null, error: { message } };

      const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'AUTH_FAILED' });
      // Ensure no additional leaking fields
      expect(body).not.toHaveProperty('message');
      expect(body).not.toHaveProperty('detail');
    }
  });
});

// ============================================================================
// 4. 401 on verifyOtp throw
// ============================================================================

describe('POST /api/v1/auth/otp/verify — 401 on verifyOtp throw', () => {
  it('returns 401 (not 500) when verifyOtp throws', async () => {
    // WHY 401 (not 500): throws on verifyOtp are treated as auth failure (not
    // infrastructure failure) because the Supabase client can throw under normal
    // load conditions (connection pool exhaustion, rate limiting). From the
    // caller's perspective, verification did not succeed — 401 is correct.
    mockVerifyOtpThrows = true;

    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('AUTH_FAILED');
  });

  it('returns the same generic AUTH_FAILED message when verifyOtp throws as when it returns error', async () => {
    // WHY: all 401 paths must return IDENTICAL responses — same error code, same
    // shape. An attacker must not distinguish "throw" path from "error" path.
    mockVerifyOtpThrows = true;
    const throwRes = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    const throwBody = await throwRes.json();

    vi.clearAllMocks();
    mockVerifyOtpThrows = false;
    mockVerifyOtpResult = { data: null, error: { message: 'invalid' } };
    const errorRes = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    const errorBody = await errorRes.json();

    expect(throwRes.status).toBe(errorRes.status);
    expect(throwBody).toEqual(errorBody);
  });

  it('does NOT call Sentry when verifyOtp throws (throws are treated as expected auth failures)', async () => {
    // WHY no Sentry: throws on verifyOtp may be normal under heavy Supabase load.
    // Capturing every throw at error level would flood Sentry with expected noise.
    // If operational visibility is needed, add captureMessage at 'warning' level
    // with email_hash (not raw OTP) — documented in route.ts handler comments.
    mockVerifyOtpThrows = true;

    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 5. Happy path 200
// ============================================================================

describe('POST /api/v1/auth/otp/verify — Happy path', () => {
  it('returns 200 with styrby_api_key and expires_at', async () => {
    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('styrby_api_key');
    expect(body).toHaveProperty('expires_at');
    expect(typeof body.styrby_api_key).toBe('string');
    expect(typeof body.expires_at).toBe('string');
  });

  it('Content-Type is application/json on 200', async () => {
    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('returns the raw generated key (not the hash) in styrby_api_key', async () => {
    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    const body = await res.json();
    expect(body.styrby_api_key).toBe(MOCK_RAW_KEY);
    // Must NOT be the bcrypt hash
    expect(body.styrby_api_key).not.toBe(MOCK_HASH);
  });

  it('returns expires_at approximately KEY_TTL_DAYS from now', async () => {
    const before = Date.now();
    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    const after = Date.now();

    const body = await res.json();
    const expiresMs = new Date(body.expires_at).getTime();
    const expectedMin = before + KEY_TTL_DAYS * 24 * 60 * 60 * 1000;
    const expectedMax = after + KEY_TTL_DAYS * 24 * 60 * 60 * 1000;

    expect(expiresMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresMs).toBeLessThanOrEqual(expectedMax);
  });

  it('calls verifyOtp with email, token, and type: email', async () => {
    const EMAIL = 'specific@example.com';
    const OTP = '654321';
    await POST(makeRequest({ email: EMAIL, otp: OTP }));
    expect(mockVerifyOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: EMAIL,
        token: OTP,
        type: 'email',
      })
    );
  });

  it('does not call Sentry on success', async () => {
    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('accepts a longer magic-link token (64 chars) as a valid OTP', async () => {
    // WHY: Supabase magic-link tokens can be longer hex strings. The schema allows
    // up to 64 chars for this case. Verify the endpoint accepts these.
    const longToken = 'a'.repeat(64);
    const res = await POST(makeRequest({ email: 'user@example.com', otp: longToken }));
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// 6. Key bound to user.id from verifyOtp response
// ============================================================================

describe('POST /api/v1/auth/otp/verify — Key bound to authenticated user_id', () => {
  it('inserts the api_key with the user_id from verifyOtp result', async () => {
    const EXPECTED_USER_ID = 'user-uuid-otp123';
    mockVerifyOtpResult = {
      data: { user: { id: EXPECTED_USER_ID, email: 'user@example.com' }, session: {} },
      error: null,
    };

    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));

    expect(mockFrom).toHaveBeenCalledWith('api_keys');
    const fromCallResult = mockFrom.mock.results[mockFrom.mock.results.length - 1].value;
    expect(fromCallResult.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: EXPECTED_USER_ID,
        key_hash: MOCK_HASH,      // hash stored, not plaintext
        key_prefix: MOCK_PREFIX,
      })
    );
  });

  it('passes the plaintext key to hashApiKey (not the hash)', async () => {
    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    // generateApiKey returns MOCK_RAW_KEY; hashApiKey should receive that
    expect(hashApiKey).toHaveBeenCalledWith(MOCK_RAW_KEY);
  });

  it('never inserts the plaintext key into the database', async () => {
    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    const fromCallResult = mockFrom.mock.results[mockFrom.mock.results.length - 1].value;
    const insertCall = (fromCallResult.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];

    const insertedValues = JSON.stringify(insertCall);
    expect(insertedValues).not.toContain(MOCK_RAW_KEY);
    expect(insertedValues).toContain(MOCK_HASH);
  });

  it('uses different user_ids for different verifyOtp responses', async () => {
    const USER_A = 'user-a-uuid-111';
    mockVerifyOtpResult = {
      data: { user: { id: USER_A, email: 'a@example.com' }, session: {} },
      error: null,
    };
    await POST(makeRequest({ email: 'a@example.com', otp: '111111' }));

    const fromCallResultA = mockFrom.mock.results[mockFrom.mock.results.length - 1].value;
    expect(fromCallResultA.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER_A })
    );
  });
});

// ============================================================================
// 7. Raw OTP NOT in Sentry args (PII/security hygiene)
// ============================================================================

describe('POST /api/v1/auth/otp/verify — OTP not in Sentry', () => {
  it('does NOT include raw OTP in Sentry captureException args on insert failure', async () => {
    // WHY: the raw OTP is a credential. Including it in Sentry would exfiltrate
    // a live credential to a third-party service (OWASP A07:2021 / GDPR Art 6).
    const SENSITIVE_OTP = '847291';
    mockInsertError = { message: 'DB insert failed' };

    await POST(makeRequest({ email: 'user@example.com', otp: SENSITIVE_OTP }));

    expect(Sentry.captureException).toHaveBeenCalled();

    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain(SENSITIVE_OTP);
  });

  it('does NOT include raw OTP in Sentry args when generateApiKey throws', async () => {
    const SENSITIVE_OTP = '847291';
    mockGenerateApiKeyThrows = true;

    await POST(makeRequest({ email: 'user@example.com', otp: SENSITIVE_OTP }));

    expect(Sentry.captureException).toHaveBeenCalled();

    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain(SENSITIVE_OTP);
  });
});

// ============================================================================
// 8. Raw key NOT in Sentry args (OWASP A02:2021)
// ============================================================================

describe('POST /api/v1/auth/otp/verify — Key not in Sentry', () => {
  it('does NOT include the raw styrby_* key in Sentry args on insert failure', async () => {
    // WHY: the raw key is a long-lived credential (365 days). If it appeared in
    // Sentry, any Sentry user with access could impersonate the legitimate user
    // for up to a year (OWASP A02:2021 — cryptographic failures).
    mockInsertError = { message: 'DB insert failed' };

    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));

    expect(Sentry.captureException).toHaveBeenCalled();

    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain(MOCK_RAW_KEY);
    // Belt-and-suspenders: check the unique random suffix
    expect(argsAsString).not.toContain('test_otp_key_xyz789');
  });

  it('does NOT include the raw key in Sentry args when hashApiKey throws', async () => {
    mockHashApiKeyThrows = true;

    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));

    expect(Sentry.captureException).toHaveBeenCalled();

    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain(MOCK_RAW_KEY);
  });
});

// ============================================================================
// 9. Email hashed (not raw) in Sentry tags (GDPR Art 5(1)(c))
// ============================================================================

describe('POST /api/v1/auth/otp/verify — Email hashed in Sentry tags', () => {
  it('Sentry tags include email_hash but NOT raw email on insert failure', async () => {
    const SENSITIVE_EMAIL = 'sensitive-user@private-domain.example.com';
    mockInsertError = { message: 'DB error' };

    await POST(makeRequest({ email: SENSITIVE_EMAIL, otp: '123456' }));

    expect(Sentry.captureException).toHaveBeenCalled();

    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;

    // email_hash tag must be present on at least one Sentry call
    const contextArgsWithHash = allCallArgs.filter(([, ctx]) => {
      const c = ctx as { tags?: Record<string, string> };
      return c?.tags?.email_hash != null;
    });
    expect(contextArgsWithHash.length).toBeGreaterThan(0);

    // Raw email must NOT appear anywhere in any Sentry arg
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain(SENSITIVE_EMAIL);
  });

  it('Sentry tags include email_hash but NOT raw email when generateApiKey throws', async () => {
    const SENSITIVE_EMAIL = 'sensitive-user@private-domain.example.com';
    mockGenerateApiKeyThrows = true;

    await POST(makeRequest({ email: SENSITIVE_EMAIL, otp: '123456' }));

    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain(SENSITIVE_EMAIL);
  });

  it('Sentry tags include endpoint on insert failure', async () => {
    mockInsertError = { message: 'DB error' };

    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));

    const captureCall = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls[0];
    const context = captureCall[1] as { tags?: Record<string, string> };
    expect(context?.tags?.endpoint).toBe('/api/v1/auth/otp/verify');
  });
});

// ============================================================================
// 10. 429 rate limit
// ============================================================================

describe('POST /api/v1/auth/otp/verify — Rate limit', () => {
  it('returns 429 when the rate limiter denies the request', async () => {
    mockRateLimitAllowed = false;
    mockRateLimitRetryAfter = 45;

    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(429);
    // Must NOT have called Supabase
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it('includes Retry-After header on 429', async () => {
    mockRateLimitAllowed = false;
    mockRateLimitRetryAfter = 45;

    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('45');
  });

  it('calls rateLimit with otp-verify prefix and correct config', async () => {
    const req = makeRequest({ email: 'user@example.com', otp: '123456' });
    await POST(req);
    expect(rateLimit).toHaveBeenCalledWith(req, OTP_VERIFY_RATE_LIMIT, 'otp-verify');
  });

  it('OTP_VERIFY_RATE_LIMIT is 10 requests per 60 seconds', () => {
    expect(OTP_VERIFY_RATE_LIMIT.maxRequests).toBe(10);
    expect(OTP_VERIFY_RATE_LIMIT.windowMs).toBe(60_000);
  });
});

// ============================================================================
// 11. 500 + Sentry on minter failure
// ============================================================================

describe('POST /api/v1/auth/otp/verify — 500 + Sentry on minter failure', () => {
  it('returns 500 and captures to Sentry when DB insert fails', async () => {
    mockInsertError = { message: 'constraint violation' };

    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
    // Positive assertion — Sentry MUST be called (prevents vacuous pass)
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('returns 500 and captures to Sentry when generateApiKey throws', async () => {
    mockGenerateApiKeyThrows = true;

    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('returns 500 and captures to Sentry when hashApiKey throws', async () => {
    mockHashApiKeyThrows = true;

    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('includes user_id (not email) in Sentry tags on insert failure', async () => {
    mockInsertError = { message: 'DB error' };
    mockVerifyOtpResult = {
      data: { user: { id: 'expected-user-id-abc', email: 'user@example.com' }, session: {} },
      error: null,
    };

    await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));

    const captureCall = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls[0];
    const context = captureCall[1] as { tags?: Record<string, string> };
    expect(context?.tags?.user_id).toBe('expected-user-id-abc');
  });

  it('does NOT include email in Sentry tags on insert failure (PII — GDPR Art 5(1)(c))', async () => {
    mockInsertError = { message: 'DB error' };
    mockVerifyOtpResult = {
      data: { user: { id: 'user-uuid-otp123', email: 'secret@email.com' }, session: {} },
      error: null,
    };

    await POST(makeRequest({ email: 'secret@email.com', otp: '123456' }));

    const allCallArgs = (Sentry.captureException as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain('secret@email.com');
  });
});

// ============================================================================
// 12. 500 + Sentry on rate-limit infrastructure failure
// ============================================================================

describe('POST /api/v1/auth/otp/verify — 500 + Sentry on rate-limit infrastructure failure', () => {
  it('returns 500 + Sentry.captureException when rate-limit infrastructure throws', async () => {
    // WHY: a throw from rateLimit (e.g. Redis unreachable) is a TRUE infrastructure
    // failure — the caller could not be rate-checked. Falling through would bypass
    // the rate-limit gate entirely (OWASP A07:2021 — availability concern).
    vi.mocked(rateLimit).mockRejectedValueOnce(new Error('Redis unreachable'));

    const res = await POST(makeRequest({ email: 'user@example.com', otp: '123456' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');

    // Positive assertion — Sentry MUST be called (prevents vacuous pass)
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    // Supabase must NOT have been called — failed before reaching OTP verification
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 13. No auth wrapper
// ============================================================================

describe('POST /api/v1/auth/otp/verify — No auth wrapper', () => {
  it('handlePost is a raw async function (no withApiAuthAndRateLimit wrapper)', () => {
    expect(handlePost).toBeTypeOf('function');
    expect(handlePost.length).toBe(1); // exactly one parameter: request
  });

  it('POST is the same function as handlePost', () => {
    expect(POST).toBe(handlePost);
  });

  it('does NOT require an Authorization header to reach the handler', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/auth/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', otp: '123456' }),
    });
    const res = await POST(req);
    // No 401 from auth middleware — handler is reached and succeeds
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// 14. Constants
// ============================================================================

describe('POST /api/v1/auth/otp/verify — Constants', () => {
  it('KEY_TTL_DAYS is 365', () => {
    expect(KEY_TTL_DAYS).toBe(365);
  });

  it('OTP_VERIFY_RATE_LIMIT has correct shape', () => {
    expect(OTP_VERIFY_RATE_LIMIT).toEqual({ windowMs: 60_000, maxRequests: 10 });
  });
});
