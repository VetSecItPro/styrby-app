/**
 * POST /api/v1/auth/otp/send — Unit Tests
 *
 * Tests the unauthenticated OTP send endpoint for the Styrby CLI.
 * This is a Category C (pre-auth) endpoint — caller has no API key yet.
 *
 * Test coverage:
 *   1. Zod validation failures (missing email, malformed, oversized, unknown field)
 *   2. 200 happy path — valid email → { ok: true }
 *   3. 200 + Sentry on Supabase error (signInWithOtp returns error)
 *   4. 200 + Sentry on Supabase throw (signInWithOtp throws)
 *   5. Email enumeration defense — response is identical for success + Supabase error
 *   6. 429 rate limit — rate-limiter denies request
 *   7. No raw email in Sentry (PII hygiene — GDPR Art 5(1)(c))
 *
 * @security OWASP A07:2021 (OTP send initiation)
 * @security OWASP A01:2021 (Broken Access Control — enumeration defense)
 * @security GDPR Art 5(1)(c) (Data minimization — email not in Sentry)
 * @security GDPR Art 6 (Lawful basis — user-initiated OTP)
 * @security SOC 2 CC6.1 (Logical access controls — rate-limited pre-auth gate)
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
    remaining: mockRateLimitAllowed ? 2 : 0,
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
// Mocks — Supabase admin client
// ============================================================================

/**
 * Mutable Supabase mock state.
 * - mockOtpResult: controls what signInWithOtp returns
 * - mockOtpThrows: if true, signInWithOtp throws
 */
let mockOtpResult: { data: unknown; error: { message: string } | null } = {
  data: {},
  error: null,
};
let mockOtpThrows = false;

const mockSignInWithOtp = vi.fn(async () => {
  if (mockOtpThrows) {
    throw new Error('Supabase network error');
  }
  return mockOtpResult;
});

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      signInWithOtp: mockSignInWithOtp,
    },
  })),
}));

// ============================================================================
// Import handler AFTER mocks are set up
// ============================================================================

import { POST, handlePost, OTP_SEND_RATE_LIMIT, MAX_EMAIL_LENGTH } from '../route';
import * as Sentry from '@sentry/nextjs';
import { rateLimit } from '@/lib/rateLimit';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a NextRequest for POST /api/v1/auth/otp/send.
 *
 * @param body - Request body (will be JSON.stringified).
 * @param ip - Simulated client IP (via X-Forwarded-For).
 */
function makeRequest(body: unknown, ip = '1.2.3.4'): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/auth/otp/send', {
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

  mockOtpResult = { data: {}, error: null };
  mockOtpThrows = false;
});

// ============================================================================
// 1. Zod validation failures
// ============================================================================

describe('POST /api/v1/auth/otp/send — Zod validation failures', () => {
  it('returns 400 when email is missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email is not a valid email address', async () => {
    const res = await POST(makeRequest({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email has no domain part', async () => {
    const res = await POST(makeRequest({ email: 'user@' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it(`returns 400 when email exceeds ${MAX_EMAIL_LENGTH} chars`, async () => {
    // 321 chars: 64-char local-part + '@' + 256-char domain
    const oversizedEmail = 'a'.repeat(64) + '@' + 'b'.repeat(252) + '.com';
    expect(oversizedEmail.length).toBeGreaterThan(MAX_EMAIL_LENGTH);
    const res = await POST(makeRequest({ email: oversizedEmail }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for unknown fields (.strict() mass-assignment guard)', async () => {
    const res = await POST(makeRequest({
      email: 'user@example.com',
      // Attacker trying to inject Supabase-internal options
      shouldCreateUser: false,
      captchaToken: 'bypass-captcha',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-JSON body', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/auth/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' },
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('does NOT echo the submitted email in the 400 error message', async () => {
    const suspiciousEmail = 'attacker@evil.com';
    const res = await POST(makeRequest({ email: suspiciousEmail, extra_field: 'injected' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    // Error message must describe the field name, not the value
    expect(JSON.stringify(body)).not.toContain(suspiciousEmail);
  });
});

// ============================================================================
// 2. Happy path 200
// ============================================================================

describe('POST /api/v1/auth/otp/send — Happy path', () => {
  it('returns 200 with { ok: true } for a valid email', async () => {
    const res = await POST(makeRequest({ email: 'user@example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('Content-Type is application/json', async () => {
    const res = await POST(makeRequest({ email: 'user@example.com' }));
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('calls signInWithOtp with the email from the request body', async () => {
    const EMAIL = 'specific@example.com';
    await POST(makeRequest({ email: EMAIL }));
    expect(mockSignInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: EMAIL })
    );
  });

  it('calls signInWithOtp with shouldCreateUser: true (mirrors CLI behaviour)', async () => {
    await POST(makeRequest({ email: 'user@example.com' }));
    expect(mockSignInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ shouldCreateUser: true }),
      })
    );
  });

  it('does not call Sentry on success', async () => {
    await POST(makeRequest({ email: 'user@example.com' }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 3. 200 + Sentry on Supabase error
// ============================================================================

describe('POST /api/v1/auth/otp/send — 200 + Sentry when signInWithOtp returns error', () => {
  it('still returns 200 + { ok: true } when Supabase returns an error', async () => {
    mockOtpResult = { data: null, error: { message: 'Email rate limit exceeded' } };

    const res = await POST(makeRequest({ email: 'user@example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('calls Sentry.captureMessage (not captureException) on Supabase error', async () => {
    mockOtpResult = { data: null, error: { message: 'Email rate limit exceeded' } };

    await POST(makeRequest({ email: 'user@example.com' }));
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('calls Sentry.captureMessage at info level on Supabase error', async () => {
    mockOtpResult = { data: null, error: { message: 'some error' } };

    await POST(makeRequest({ email: 'user@example.com' }));
    const captureCall = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const context = captureCall[1] as { level?: string };
    expect(context?.level).toBe('info');
  });
});

// ============================================================================
// 4. 200 + Sentry on Supabase throw
// ============================================================================

describe('POST /api/v1/auth/otp/send — 200 + Sentry when signInWithOtp throws', () => {
  it('still returns 200 + { ok: true } when signInWithOtp throws', async () => {
    mockOtpThrows = true;

    const res = await POST(makeRequest({ email: 'user@example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('calls Sentry.captureMessage when signInWithOtp throws', async () => {
    mockOtpThrows = true;

    await POST(makeRequest({ email: 'user@example.com' }));
    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
  });

  it('calls Sentry.captureMessage at warning level when signInWithOtp throws', async () => {
    mockOtpThrows = true;

    await POST(makeRequest({ email: 'user@example.com' }));
    const captureCall = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const context = captureCall[1] as { level?: string };
    expect(context?.level).toBe('warning');
  });
});

// ============================================================================
// 5. Email enumeration defense — response invariance
// ============================================================================

describe('POST /api/v1/auth/otp/send — Email enumeration defense (response invariance)', () => {
  it('returns identical status + body for success vs Supabase error', async () => {
    // Request 1: Supabase succeeds
    mockOtpResult = { data: {}, error: null };
    const successRes = await POST(makeRequest({ email: 'user1@example.com' }));
    const successBody = await successRes.json();

    // Request 2: Supabase returns error (simulating email-not-found or rate-limit)
    mockOtpResult = { data: null, error: { message: 'User not found' } };
    const errorRes = await POST(makeRequest({ email: 'user2@example.com' }));
    const errorBody = await errorRes.json();

    // Responses MUST be identical — no information leakage (OWASP A01:2021)
    expect(successRes.status).toBe(errorRes.status);
    expect(successBody).toEqual(errorBody);
  });

  it('returns identical status + body for success vs signInWithOtp throw', async () => {
    // Request 1: Supabase succeeds
    mockOtpResult = { data: {}, error: null };
    const successRes = await POST(makeRequest({ email: 'user1@example.com' }));
    const successBody = await successRes.json();

    // Request 2: Supabase throws
    mockOtpThrows = true;
    const throwRes = await POST(makeRequest({ email: 'user2@example.com' }));
    const throwBody = await throwRes.json();

    expect(successRes.status).toBe(throwRes.status);
    expect(successBody).toEqual(throwBody);
  });

  it('response body is always exactly { ok: true } regardless of Supabase outcome', async () => {
    const scenarios: Array<() => void> = [
      // Success
      () => { mockOtpResult = { data: {}, error: null }; },
      // Error response
      () => { mockOtpResult = { data: null, error: { message: 'error' } }; },
      // Throw
      () => { mockOtpThrows = true; mockOtpResult = { data: null, error: null }; },
    ];

    for (const setup of scenarios) {
      vi.clearAllMocks();
      mockOtpThrows = false;
      setup();

      const res = await POST(makeRequest({ email: 'user@example.com' }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
    }
  });
});

// ============================================================================
// 6. 429 rate limit
// ============================================================================

describe('POST /api/v1/auth/otp/send — Rate limit', () => {
  it('returns 429 when the rate limiter denies the request', async () => {
    mockRateLimitAllowed = false;
    mockRateLimitRetryAfter = 45;

    const res = await POST(makeRequest({ email: 'user@example.com' }));
    expect(res.status).toBe(429);
    // Must NOT have called Supabase
    expect(mockSignInWithOtp).not.toHaveBeenCalled();
  });

  it('includes Retry-After header on 429', async () => {
    mockRateLimitAllowed = false;
    mockRateLimitRetryAfter = 45;

    const res = await POST(makeRequest({ email: 'user@example.com' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('45');
  });

  it('calls rateLimit with otp-send prefix and correct config', async () => {
    const req = makeRequest({ email: 'user@example.com' });
    await POST(req);
    expect(rateLimit).toHaveBeenCalledWith(req, OTP_SEND_RATE_LIMIT, 'otp-send');
  });

  it('OTP_SEND_RATE_LIMIT is 3 requests per 60 seconds', () => {
    expect(OTP_SEND_RATE_LIMIT.maxRequests).toBe(3);
    expect(OTP_SEND_RATE_LIMIT.windowMs).toBe(60_000);
  });
});

// ============================================================================
// 7. Email NOT in Sentry (PII hygiene — GDPR Art 5(1)(c))
// ============================================================================

describe('POST /api/v1/auth/otp/send — Email not in Sentry (PII hygiene)', () => {
  it('does NOT include raw email in Sentry captureMessage args on Supabase error', async () => {
    const SENSITIVE_EMAIL = 'sensitive-user@private-domain.example.com';
    mockOtpResult = { data: null, error: { message: 'rate limit' } };

    await POST(makeRequest({ email: SENSITIVE_EMAIL }));

    expect(Sentry.captureMessage).toHaveBeenCalledOnce();

    // Inspect ALL arguments across all Sentry calls for the raw email string
    const allCallArgs = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain(SENSITIVE_EMAIL);
  });

  it('does NOT include raw email in Sentry args when signInWithOtp throws', async () => {
    const SENSITIVE_EMAIL = 'sensitive-user@private-domain.example.com';
    mockOtpThrows = true;

    await POST(makeRequest({ email: SENSITIVE_EMAIL }));

    expect(Sentry.captureMessage).toHaveBeenCalledOnce();

    const allCallArgs = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls;
    const argsAsString = JSON.stringify(allCallArgs);
    expect(argsAsString).not.toContain(SENSITIVE_EMAIL);
  });

  it('Sentry tags include email_hash (for correlation) but NOT raw email', async () => {
    const SENSITIVE_EMAIL = 'sensitive-user@private-domain.example.com';
    mockOtpResult = { data: null, error: { message: 'error' } };

    await POST(makeRequest({ email: SENSITIVE_EMAIL }));

    const captureCall = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const context = captureCall[1] as { tags?: Record<string, string> };

    // email_hash must be present (for correlation)
    expect(context?.tags?.email_hash).toBeDefined();
    expect(typeof context?.tags?.email_hash).toBe('string');

    // Raw email must NOT be present anywhere in context
    expect(JSON.stringify(context)).not.toContain(SENSITIVE_EMAIL);
  });

  it('Sentry tags include endpoint name', async () => {
    mockOtpResult = { data: null, error: { message: 'error' } };

    await POST(makeRequest({ email: 'user@example.com' }));

    const captureCall = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const context = captureCall[1] as { tags?: Record<string, string> };
    expect(context?.tags?.endpoint).toBe('/api/v1/auth/otp/send');
  });
});

// ============================================================================
// 8. No auth wrapper
// ============================================================================

describe('POST /api/v1/auth/otp/send — No auth wrapper', () => {
  it('handlePost is a raw async function (no withApiAuthAndRateLimit wrapper)', () => {
    expect(handlePost).toBeTypeOf('function');
    expect(handlePost.length).toBe(1); // exactly one parameter: request
  });

  it('POST is the same function as handlePost', () => {
    expect(POST).toBe(handlePost);
  });

  it('does NOT require an Authorization header to reach the handler', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/auth/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    const res = await POST(req);
    // No 401 from auth middleware — handler is reached and responds 200
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// 9. Constants
// ============================================================================

describe('POST /api/v1/auth/otp/send — Constants', () => {
  it('MAX_EMAIL_LENGTH is 320 (RFC 5321)', () => {
    expect(MAX_EMAIL_LENGTH).toBe(320);
  });
});
