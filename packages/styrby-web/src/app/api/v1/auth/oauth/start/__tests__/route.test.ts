/**
 * POST /api/v1/auth/oauth/start — Unit Tests
 *
 * Tests the unauthenticated OAuth initiation endpoint for the Styrby CLI.
 * This is a Category C (pre-auth) endpoint — it MUST NOT be wrapped by
 * withApiAuthAndRateLimit, and rate limiting is per-IP only.
 *
 * Test coverage:
 *   1. Zod validation failures (all required fields, enum values, .strict())
 *   2. Open-redirect defense — OWASP A01:2021 (disallowed redirect_to origin)
 *   3. Happy path — GitHub OAuth with valid localhost redirect
 *   4. Happy path — Google OAuth with valid localhost redirect
 *   5. Rate limit — 429 with Retry-After header
 *   6. Supabase error path — 500 + Sentry.captureException
 *   7. Supabase throw path — 500 + Sentry.captureException
 *   8. No-auth-wrapper assertion — handler exported directly, not via wrapper
 *   9. Rate-limit key prefix — called with 'oauth-start' prefix
 *
 * @security OWASP A01:2021 (open-redirect)
 * @security OWASP A03:2021 (mass-assignment via .strict())
 * @security OWASP A07:2021 (auth flow bridge)
 * @security SOC 2 CC6.1 (access controls)
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
// Mocks — Supabase admin client
// ============================================================================

/**
 * Mutable Supabase mock state.
 * - mockOAuthUrl: the authorization URL returned by signInWithOAuth
 * - mockOAuthError: error object returned (to simulate Supabase error)
 * - mockOAuthThrows: if true, signInWithOAuth throws instead of returning
 */
let mockOAuthUrl: string | null =
  'https://github.com/login/oauth/authorize?client_id=abc&state=csrftoken123&code_challenge=xyz&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback';
let mockOAuthError: { message: string } | null = null;
let mockOAuthThrows = false;

const mockSignInWithOAuth = vi.fn(async () => {
  if (mockOAuthThrows) {
    throw new Error('Supabase network error');
  }
  if (mockOAuthError) {
    return { data: { url: null, provider: 'github' }, error: mockOAuthError };
  }
  return { data: { url: mockOAuthUrl, provider: 'github' }, error: null };
});

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      signInWithOAuth: mockSignInWithOAuth,
    },
  })),
}));

// ============================================================================
// Import handler AFTER mocks are set up
// ============================================================================

import { POST, OAUTH_START_RATE_LIMIT, OAUTH_ALLOWED_REDIRECT_ORIGINS, MAX_REDIRECT_URL_LENGTH, isAllowedRedirectOrigin, extractStateFromAuthUrl } from '../route';
import * as Sentry from '@sentry/nextjs';
import { rateLimit } from '@/lib/rateLimit';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a NextRequest for POST /api/v1/auth/oauth/start.
 *
 * @param body - Request body (will be JSON.stringified).
 * @param ip - Simulated client IP (via X-Forwarded-For).
 */
function makeRequest(body: unknown, ip = '1.2.3.4'): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/auth/oauth/start', {
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
  // Reset to passing state before each test
  mockRateLimitAllowed = true;
  mockRateLimitRetryAfter = 30;
  mockOAuthUrl =
    'https://github.com/login/oauth/authorize?client_id=abc&state=csrftoken123&code_challenge=xyz&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback';
  mockOAuthError = null;
  mockOAuthThrows = false;
});

// ============================================================================
// 1. Zod validation failures
// ============================================================================

describe('POST /api/v1/auth/oauth/start — Zod validation failures', () => {
  it('returns 400 when provider is missing', async () => {
    const res = await POST(makeRequest({ redirect_to: 'http://localhost:12345/callback' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when provider is an invalid enum value', async () => {
    const res = await POST(makeRequest({ provider: 'bitbucket', redirect_to: 'http://localhost:12345/callback' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when redirect_to is missing', async () => {
    const res = await POST(makeRequest({ provider: 'github' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when redirect_to is not a URL', async () => {
    const res = await POST(makeRequest({ provider: 'github', redirect_to: 'not-a-url' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when redirect_to exceeds MAX_REDIRECT_URL_LENGTH', async () => {
    const longUrl = `http://localhost:12345/${'a'.repeat(MAX_REDIRECT_URL_LENGTH + 1)}`;
    const res = await POST(makeRequest({ provider: 'github', redirect_to: longUrl }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for unknown fields (.strict() mass-assignment guard)', async () => {
    const res = await POST(makeRequest({
      provider: 'github',
      redirect_to: 'http://localhost:12345/callback',
      state: 'injected-state',       // attacker trying to override PKCE state
      code_challenge: 'evil-value',  // attacker trying to override PKCE challenge
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });
});

// ============================================================================
// 2. Open-redirect defense (OWASP A01:2021)
// ============================================================================

describe('POST /api/v1/auth/oauth/start — Open-redirect defense', () => {
  it('returns 400 for a disallowed redirect_to origin', async () => {
    const res = await POST(makeRequest({
      provider: 'github',
      redirect_to: 'https://attacker.com/steal-code',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('REDIRECT_NOT_ALLOWED');
    // Security: must NOT echo the rejected URL back in the response
    expect(JSON.stringify(body)).not.toContain('attacker.com');
  });

  it('returns 400 for a redirect_to that looks similar but is not in allowlist', async () => {
    // Homograph / subdomain confusion: styrbyapp.com.evil.com
    const res = await POST(makeRequest({
      provider: 'github',
      redirect_to: 'https://styrbyapp.com.evil.com/callback',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('REDIRECT_NOT_ALLOWED');
  });

  it('returns 400 for http on a production domain (styrbyapp.com must be https)', async () => {
    const res = await POST(makeRequest({
      provider: 'github',
      redirect_to: 'http://styrbyapp.com/callback',  // http, not https
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('REDIRECT_NOT_ALLOWED');
  });
});

// ============================================================================
// 3. Happy path — GitHub
// ============================================================================

describe('POST /api/v1/auth/oauth/start — Happy path (GitHub)', () => {
  it('returns 200 with authorization_url and state for GitHub', async () => {
    const res = await POST(makeRequest({
      provider: 'github',
      redirect_to: 'http://localhost:12345/callback',
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('authorization_url');
    expect(typeof body.authorization_url).toBe('string');
    expect(body.authorization_url).toContain('github.com');
    // state extracted from authorization URL
    expect(body).toHaveProperty('state');
    expect(body.state).toBe('csrftoken123');
  });

  it('calls signInWithOAuth with provider:github and the correct redirectTo', async () => {
    const redirectTo = 'http://localhost:12345/callback';
    await POST(makeRequest({ provider: 'github', redirect_to: redirectTo }));
    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        options: expect.objectContaining({ redirectTo }),
      })
    );
  });
});

// ============================================================================
// 4. Happy path — Google
// ============================================================================

describe('POST /api/v1/auth/oauth/start — Happy path (Google)', () => {
  it('returns 200 with authorization_url and state for Google', async () => {
    mockOAuthUrl =
      'https://accounts.google.com/o/oauth2/auth?client_id=xyz&state=googlestate456&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback';

    const res = await POST(makeRequest({
      provider: 'google',
      redirect_to: 'http://localhost:12345/callback',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorization_url).toContain('google.com');
    expect(body.state).toBe('googlestate456');
  });

  it('calls signInWithOAuth with provider:google', async () => {
    mockOAuthUrl = 'https://accounts.google.com/o/oauth2/auth?state=gs789';
    await POST(makeRequest({ provider: 'google', redirect_to: 'http://localhost:9090/cb' }));
    expect(mockSignInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' })
    );
  });
});

// ============================================================================
// 5. Rate limit — 429
// ============================================================================

describe('POST /api/v1/auth/oauth/start — Rate limit', () => {
  it('returns 429 when the rate limiter denies the request', async () => {
    mockRateLimitAllowed = false;
    mockRateLimitRetryAfter = 45;

    const res = await POST(makeRequest({
      provider: 'github',
      redirect_to: 'http://localhost:12345/callback',
    }));
    expect(res.status).toBe(429);
    // Should NOT have called Supabase
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });

  it('calls rateLimit with the oauth-start prefix and the original request', async () => {
    const req = makeRequest({ provider: 'github', redirect_to: 'http://localhost:12345/callback' });
    await POST(req);
    expect(rateLimit).toHaveBeenCalledWith(req, OAUTH_START_RATE_LIMIT, 'oauth-start');
  });
});

// ============================================================================
// 6. Supabase auth error — 500 + Sentry
// ============================================================================

describe('POST /api/v1/auth/oauth/start — Supabase error', () => {
  it('returns 500 and captures to Sentry when signInWithOAuth returns an error', async () => {
    mockOAuthError = { message: 'provider not configured' };

    const res = await POST(makeRequest({
      provider: 'github',
      redirect_to: 'http://localhost:12345/callback',
    }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('returns 500 and captures when signInWithOAuth returns null url with no error', async () => {
    mockOAuthUrl = null;
    mockOAuthError = null;

    const res = await POST(makeRequest({
      provider: 'github',
      redirect_to: 'http://localhost:12345/callback',
    }));
    expect(res.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// 7. Supabase throw — 500 + Sentry
// ============================================================================

describe('POST /api/v1/auth/oauth/start — Supabase throw', () => {
  it('returns 500 and captures to Sentry when signInWithOAuth throws', async () => {
    mockOAuthThrows = true;

    const res = await POST(makeRequest({
      provider: 'github',
      redirect_to: 'http://localhost:12345/callback',
    }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// 8. No auth wrapper — handler exported directly
// ============================================================================

describe('POST /api/v1/auth/oauth/start — No auth wrapper', () => {
  it('is exported as a raw async function (no withApiAuthAndRateLimit wrapper)', () => {
    // The handler must be a plain async function, not wrapped by the auth
    // middleware. Unauthenticated callers must reach this endpoint without
    // needing a styrby_* API key.
    //
    // If POST were wrapped by withApiAuthAndRateLimit, the mock for that
    // middleware would intercept calls. Since we do NOT mock withApiAuthAndRateLimit
    // here (unlike authenticated endpoint tests), an unauthenticated call still
    // returning 200 proves the handler is not wrapped.
    expect(POST).toBeTypeOf('function');
    // The function signature accepts a NextRequest and returns a Promise — this
    // is the raw Next.js route handler signature.
    expect(POST.length).toBe(1); // exactly one parameter: request
  });

  it('does NOT require an API key header to succeed', async () => {
    // Call with no Authorization header — must still get 200
    const req = new NextRequest('http://localhost:3000/api/v1/auth/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', redirect_to: 'http://localhost:12345/callback' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// 9. Rate-limit key prefix
// ============================================================================

describe('POST /api/v1/auth/oauth/start — Rate-limit key prefix', () => {
  it("passes 'oauth-start' as the prefix so IP buckets are isolated from other endpoints", async () => {
    const req = makeRequest({ provider: 'github', redirect_to: 'http://localhost:12345/callback' });
    await POST(req);
    // Third argument to rateLimit must be 'oauth-start'
    const calls = (rateLimit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe('oauth-start');
  });
});

// ============================================================================
// Unit tests for helper functions
// ============================================================================

describe('isAllowedRedirectOrigin', () => {
  it('allows localhost with any port', () => {
    expect(isAllowedRedirectOrigin(new URL('http://localhost:12345/cb'))).toBe(true);
    expect(isAllowedRedirectOrigin(new URL('http://localhost:3000/cb'))).toBe(true);
    expect(isAllowedRedirectOrigin(new URL('http://localhost/cb'))).toBe(true);
  });

  it('allows 127.0.0.1 with any port', () => {
    expect(isAllowedRedirectOrigin(new URL('http://127.0.0.1:9000/cb'))).toBe(true);
  });

  it('allows https://styrbyapp.com', () => {
    expect(isAllowedRedirectOrigin(new URL('https://styrbyapp.com/callback'))).toBe(true);
  });

  it('rejects http://styrbyapp.com (must be https)', () => {
    expect(isAllowedRedirectOrigin(new URL('http://styrbyapp.com/callback'))).toBe(false);
  });

  it('allows Vercel preview deployments', () => {
    expect(isAllowedRedirectOrigin(new URL('https://styrby-abc123-vetsecitpro.vercel.app/cb'))).toBe(true);
  });

  it('rejects attacker.com', () => {
    expect(isAllowedRedirectOrigin(new URL('https://attacker.com/steal'))).toBe(false);
  });

  it('rejects a homograph lookalike (styrbyapp.com.evil.com)', () => {
    expect(isAllowedRedirectOrigin(new URL('https://styrbyapp.com.evil.com/cb'))).toBe(false);
  });
});

describe('extractStateFromAuthUrl', () => {
  it('extracts the state parameter from a URL', () => {
    expect(extractStateFromAuthUrl(
      'https://github.com/login/oauth/authorize?client_id=x&state=abc123&code_challenge=y'
    )).toBe('abc123');
  });

  it('returns undefined when there is no state parameter', () => {
    expect(extractStateFromAuthUrl(
      'https://github.com/login/oauth/authorize?client_id=x'
    )).toBeUndefined();
  });

  it('returns undefined for an invalid URL', () => {
    expect(extractStateFromAuthUrl('not-a-url')).toBeUndefined();
  });
});
