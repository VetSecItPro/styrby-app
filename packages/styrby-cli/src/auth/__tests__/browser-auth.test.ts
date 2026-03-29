/**
 * Tests for auth/browser-auth.ts
 *
 * Covers:
 * - generatePKCE: valid verifier/challenge pair, correct method, base64url encoding
 * - generateState: random, correct length, base64url encoded
 * - buildAuthUrl: all required OAuth parameters present
 * - buildTokenUrl: returns the correct path
 * - exchangeCodeForTokens: success, HTTP error, network error, AuthError re-throw
 * - AuthError: correct type, name, and cause propagation
 *
 * WHY: PKCE and OAuth parameter correctness are security-critical. A wrong
 * challenge or missing state parameter could expose users to auth code
 * interception or CSRF attacks. These tests verify the cryptographic
 * contract without making any real network calls.
 *
 * @module auth/__tests__/browser-auth
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';

// ============================================================================
// Mocks — declared before imports
// ============================================================================

/**
 * Mock the logger to suppress output and avoid import side effects.
 */
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

/**
 * Mock the local-server module — startBrowserAuth is not under test here.
 * The pure functions (generatePKCE, buildAuthUrl, etc.) don't use it.
 */
vi.mock('../local-server', () => ({
  startAuthCallbackServer: vi.fn(),
}));

/**
 * Mock the open package — browser opening is a side effect not tested here.
 */
vi.mock('open', () => ({ default: vi.fn() }));

/**
 * Mock @supabase/supabase-js — only needed for startBrowserAuth (not tested here).
 */
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

// ============================================================================
// Imports — after vi.mock declarations
// ============================================================================

import {
  generatePKCE,
  generateState,
  buildAuthUrl,
  buildTokenUrl,
  exchangeCodeForTokens,
  AuthError,
  type PKCEData,
} from '../browser-auth';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Verify that a string is valid base64url encoding.
 * base64url uses - and _ instead of + and /, with no padding (=).
 *
 * @param value - String to check
 */
function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9\-_]+$/.test(value) && !value.includes('=');
}

/**
 * Compute the expected SHA-256 base64url hash of a verifier.
 * Used to independently verify that generatePKCE's challenge is correct.
 *
 * @param verifier - PKCE code verifier string
 * @returns Expected code challenge
 */
function computeExpectedChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ============================================================================
// generatePKCE
// ============================================================================

describe('generatePKCE', () => {
  it('returns an object with verifier, challenge, and method', () => {
    const pkce = generatePKCE();

    expect(typeof pkce.verifier).toBe('string');
    expect(typeof pkce.challenge).toBe('string');
    expect(pkce.method).toBe('S256');
  });

  it('verifier is base64url encoded (no +, /, or =)', () => {
    const pkce = generatePKCE();

    expect(isBase64Url(pkce.verifier)).toBe(true);
  });

  it('challenge is base64url encoded (no +, /, or =)', () => {
    const pkce = generatePKCE();

    expect(isBase64Url(pkce.challenge)).toBe(true);
  });

  it('verifier has at least 43 characters (RFC 7636 minimum)', () => {
    // RFC 7636 §4.1: verifier length must be between 43 and 128 characters
    const pkce = generatePKCE();

    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('challenge is the correct SHA-256 hash of the verifier', () => {
    const pkce = generatePKCE();
    const expected = computeExpectedChallenge(pkce.verifier);

    expect(pkce.challenge).toBe(expected);
  });

  it('method is always S256', () => {
    // Test multiple calls to ensure it never deviates
    for (let i = 0; i < 10; i++) {
      expect(generatePKCE().method).toBe('S256');
    }
  });

  it('each call produces a different verifier (randomness)', () => {
    const pkces = Array.from({ length: 20 }, () => generatePKCE());
    const verifiers = new Set(pkces.map((p) => p.verifier));

    expect(verifiers.size).toBe(20);
  });

  it('each call produces a different challenge (follows from unique verifier)', () => {
    const pkces = Array.from({ length: 20 }, () => generatePKCE());
    const challenges = new Set(pkces.map((p) => p.challenge));

    expect(challenges.size).toBe(20);
  });

  it('verifier and challenge are different strings', () => {
    const pkce = generatePKCE();

    // They represent different things; the challenge is a hash of the verifier
    expect(pkce.verifier).not.toBe(pkce.challenge);
  });
});

// ============================================================================
// generateState
// ============================================================================

describe('generateState', () => {
  it('returns a non-empty string', () => {
    const state = generateState();

    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(0);
  });

  it('is base64url encoded (no +, /, or =)', () => {
    const state = generateState();

    // crypto.randomBytes(16).toString('base64url') is always valid base64url
    expect(isBase64Url(state)).toBe(true);
  });

  it('has length compatible with 16 random bytes (base64url of 16 bytes = 22 chars)', () => {
    const state = generateState();

    // Base64 of 16 bytes = ceil(16 * 4/3) = 22 chars without padding
    expect(state.length).toBeGreaterThanOrEqual(20);
    expect(state.length).toBeLessThanOrEqual(24);
  });

  it('produces unique values on each call', () => {
    const states = Array.from({ length: 50 }, () => generateState());
    const unique = new Set(states);

    expect(unique.size).toBe(50);
  });
});

// ============================================================================
// buildAuthUrl
// ============================================================================

describe('buildAuthUrl', () => {
  const SUPABASE_URL = 'https://akmtmxunjhsgldjztdtt.supabase.co';
  const REDIRECT_URI = 'http://127.0.0.1:52280/callback';
  const PKCE: PKCEData = {
    verifier: 'test-verifier-abc123',
    challenge: 'test-challenge-xyz789',
    method: 'S256',
  };
  const STATE = 'random-state-token';

  it('starts with the Supabase auth endpoint path', () => {
    const url = buildAuthUrl(SUPABASE_URL, REDIRECT_URI, PKCE, STATE);

    expect(url.startsWith(`${SUPABASE_URL}/auth/v1/authorize?`)).toBe(true);
  });

  it('includes redirect_to parameter', () => {
    const url = buildAuthUrl(SUPABASE_URL, REDIRECT_URI, PKCE, STATE);
    const params = new URL(url).searchParams;

    expect(params.get('redirect_to')).toBe(REDIRECT_URI);
  });

  it('includes flow_type=pkce', () => {
    const url = buildAuthUrl(SUPABASE_URL, REDIRECT_URI, PKCE, STATE);
    const params = new URL(url).searchParams;

    expect(params.get('flow_type')).toBe('pkce');
  });

  it('includes code_challenge matching the PKCE challenge', () => {
    const url = buildAuthUrl(SUPABASE_URL, REDIRECT_URI, PKCE, STATE);
    const params = new URL(url).searchParams;

    expect(params.get('code_challenge')).toBe(PKCE.challenge);
  });

  it('includes code_challenge_method=S256', () => {
    const url = buildAuthUrl(SUPABASE_URL, REDIRECT_URI, PKCE, STATE);
    const params = new URL(url).searchParams;

    expect(params.get('code_challenge_method')).toBe('S256');
  });

  it('includes the state parameter for CSRF protection', () => {
    const url = buildAuthUrl(SUPABASE_URL, REDIRECT_URI, PKCE, STATE);
    const params = new URL(url).searchParams;

    expect(params.get('state')).toBe(STATE);
  });

  it('includes provider parameter when provider is specified', () => {
    const url = buildAuthUrl(SUPABASE_URL, REDIRECT_URI, PKCE, STATE, 'github');
    const params = new URL(url).searchParams;

    expect(params.get('provider')).toBe('github');
  });

  it('omits provider parameter when provider is not specified', () => {
    const url = buildAuthUrl(SUPABASE_URL, REDIRECT_URI, PKCE, STATE);
    const params = new URL(url).searchParams;

    expect(params.get('provider')).toBeNull();
  });

  it('produces a valid parseable URL', () => {
    const url = buildAuthUrl(SUPABASE_URL, REDIRECT_URI, PKCE, STATE, 'github');

    expect(() => new URL(url)).not.toThrow();
  });
});

// ============================================================================
// buildTokenUrl
// ============================================================================

describe('buildTokenUrl', () => {
  it('returns the Supabase token endpoint path', () => {
    const url = buildTokenUrl('https://test.supabase.co');

    expect(url).toBe('https://test.supabase.co/auth/v1/token');
  });

  it('works with different Supabase project URLs', () => {
    expect(buildTokenUrl('https://abc123.supabase.co')).toBe(
      'https://abc123.supabase.co/auth/v1/token'
    );
    expect(buildTokenUrl('https://xyz789.supabase.co')).toBe(
      'https://xyz789.supabase.co/auth/v1/token'
    );
  });
});

// ============================================================================
// exchangeCodeForTokens
// ============================================================================

describe('exchangeCodeForTokens', () => {
  const SUPABASE_URL = 'https://test.supabase.co';
  const CODE = 'auth-code-abc123';
  const VERIFIER = 'pkce-verifier-xyz';
  const REDIRECT_URI = 'http://127.0.0.1:52280/callback';

  /**
   * Successful token response from Supabase.
   */
  const SUCCESS_RESPONSE = {
    access_token: 'eyJhbGciOiJIUzI1NiJ9.access',
    refresh_token: 'refresh-token-abc',
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: 'user-uuid-001',
      email: 'test@example.com',
      user_metadata: {
        full_name: 'Test User',
        avatar_url: 'https://avatars.github.com/u/12345',
      },
    },
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns mapped AuthResult on successful token exchange', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => SUCCESS_RESPONSE,
    } as Response);

    const result = await exchangeCodeForTokens(SUPABASE_URL, CODE, VERIFIER, REDIRECT_URI);

    expect(result.accessToken).toBe(SUCCESS_RESPONSE.access_token);
    expect(result.refreshToken).toBe(SUCCESS_RESPONSE.refresh_token);
    expect(result.expiresIn).toBe(3600);
    expect(result.tokenType).toBe('bearer');
    expect(result.user.id).toBe('user-uuid-001');
    expect(result.user.email).toBe('test@example.com');
    expect(result.user.name).toBe('Test User');
    expect(result.user.avatarUrl).toBe('https://avatars.github.com/u/12345');
  });

  it('uses "name" field from user_metadata when full_name is absent', async () => {
    const responseWithName = {
      ...SUCCESS_RESPONSE,
      user: {
        ...SUCCESS_RESPONSE.user,
        user_metadata: { name: 'GitHub User', avatar_url: undefined },
      },
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => responseWithName,
    } as Response);

    const result = await exchangeCodeForTokens(SUPABASE_URL, CODE, VERIFIER, REDIRECT_URI);

    expect(result.user.name).toBe('GitHub User');
  });

  it('sets user.id to empty string when user is absent in response', async () => {
    const responseWithoutUser = {
      ...SUCCESS_RESPONSE,
      user: undefined,
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => responseWithoutUser,
    } as Response);

    const result = await exchangeCodeForTokens(SUPABASE_URL, CODE, VERIFIER, REDIRECT_URI);

    expect(result.user.id).toBe('');
  });

  it('sends POST to the correct token URL', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => SUCCESS_RESPONSE,
    } as Response);

    await exchangeCodeForTokens(SUPABASE_URL, CODE, VERIFIER, REDIRECT_URI);

    expect(fetch).toHaveBeenCalledWith(
      `${SUPABASE_URL}/auth/v1/token`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends application/x-www-form-urlencoded content type', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => SUCCESS_RESPONSE,
    } as Response);

    await exchangeCodeForTokens(SUPABASE_URL, CODE, VERIFIER, REDIRECT_URI);

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('throws AuthError with type "invalid_code" when response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'invalid_grant',
    } as Response);

    const err = await exchangeCodeForTokens(SUPABASE_URL, CODE, VERIFIER, REDIRECT_URI).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).type).toBe('invalid_code');
  });

  it('error message includes HTTP status code on failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'unauthorized',
    } as Response);

    const err = await exchangeCodeForTokens(SUPABASE_URL, CODE, VERIFIER, REDIRECT_URI).catch(
      (e: unknown) => e
    );

    expect((err as AuthError).message).toContain('401');
  });

  it('throws AuthError with type "network_error" on fetch exception', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const err = await exchangeCodeForTokens(SUPABASE_URL, CODE, VERIFIER, REDIRECT_URI).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).type).toBe('network_error');
  });

  it('re-throws AuthError directly without wrapping', async () => {
    // Force an AuthError by making the response not ok
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'error',
    } as Response);

    const err = await exchangeCodeForTokens(SUPABASE_URL, CODE, VERIFIER, REDIRECT_URI).catch(
      (e: unknown) => e
    );

    // The error should be the original AuthError, not double-wrapped
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).type).toBe('invalid_code');
  });
});

// ============================================================================
// AuthError
// ============================================================================

describe('AuthError', () => {
  it('has name "AuthError"', () => {
    const err = new AuthError('timeout', 'Request timed out');

    expect(err.name).toBe('AuthError');
  });

  it('is instanceof Error', () => {
    const err = new AuthError('cancelled', 'User cancelled');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AuthError);
  });

  it('preserves the type field', () => {
    const types = ['timeout', 'cancelled', 'invalid_code', 'network_error', 'server_error'] as const;

    for (const type of types) {
      const err = new AuthError(type, 'message');
      expect(err.type).toBe(type);
    }
  });

  it('preserves the message', () => {
    const err = new AuthError('timeout', 'Connection timed out after 2 minutes');

    expect(err.message).toBe('Connection timed out after 2 minutes');
  });

  it('stores the cause when provided', () => {
    const cause = new TypeError('fetch failed');
    const err = new AuthError('network_error', 'Network error', cause);

    expect(err.cause).toBe(cause);
  });

  it('cause is undefined when not provided', () => {
    const err = new AuthError('server_error', 'Server error');

    expect(err.cause).toBeUndefined();
  });
});
