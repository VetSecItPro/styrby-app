/**
 * GET /api/v1/account — Tests
 *
 * Identity endpoint that the CLI uses to display "logged in as X, tier Y,
 * MFA Z, key expires Q". Replaces direct auth.getUser() callsites in
 * packages/styrby-cli/src/commands/privacy.ts:320 and commands/cloud.ts:218.
 *
 * WHY comprehensive coverage here: this endpoint returns PII (email) and
 * determines how the CLI presents account status. Any regression that returns
 * wrong-user data, leaks extra PII, or fails to default tier/MFA correctly
 * creates both a UX and compliance defect.
 *
 * @security OWASP A01:2021 — user identity locked to auth context
 * @security OWASP A07:2021 — auth enforced by withApiAuthAndRateLimit
 * @security GDPR Art. 15  — right of access: user reads their own data
 * @security SOC 2 CC6.1   — logical access controls tested
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

// ============================================================================
// Mocks — withApiAuthAndRateLimit bypass
// ============================================================================

/**
 * Default auth context injected by the mocked middleware.
 * WHY: v1 routes use API key auth, not cookie auth. Mock allows testing the
 * handler logic directly without live key validation.
 */
const mockAuthContext = {
  userId: 'test-user-uuid-123',
  keyId: 'key-id-abc456',
  scopes: ['read'],
  keyExpiresAt: '2027-01-01T00:00:00.000Z',
};

vi.mock('@/middleware/api-auth', () => ({
  withApiAuthAndRateLimit: vi.fn(
    (handler: (req: NextRequest, ctx: typeof mockAuthContext) => Promise<NextResponse>) => {
      return async (request: NextRequest) => handler(request, mockAuthContext);
    },
  ),
  addRateLimitHeaders: vi.fn((response: NextResponse) => response),
  ApiAuthContext: {},
}));

// ============================================================================
// Mocks — Sentry
// ============================================================================

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ============================================================================
// Mocks — Supabase admin client
// ============================================================================

/**
 * Controls the response for auth.admin.getUserById per test.
 * Default: a valid user row.
 */
let mockGetUserByIdResult: { data: { user: { id: string; email: string; created_at: string } | null }; error: null | { message: string } } = {
  data: {
    user: {
      id: 'test-user-uuid-123',
      email: 'test@example.com',
      created_at: '2026-01-01T00:00:00.000Z',
    },
  },
  error: null,
};

/**
 * Controls the response for subscriptions query per test.
 * Default: a subscription row with tier 'pro'.
 */
let mockSubscriptionResult: { data: { tier: string } | null; error: null | { message: string; code?: string } } = {
  data: { tier: 'pro' },
  error: null,
};

/**
 * Controls the response for passkeys query per test.
 * Default: one passkey row (mfa_enrolled = true).
 */
let mockPasskeyResult: { data: { id: string }[] | null; error: null | { message: string } } = {
  data: [{ id: 'passkey-row-1' }],
  error: null,
};

/**
 * Mock chain factory for the subscriptions query (.select.eq.maybeSingle).
 */
function createSubscriptionChain() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(mockSubscriptionResult),
  };
  return chain;
}

/**
 * Mock chain factory for the passkeys query (.select.eq.limit).
 */
function createPasskeyChain() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(mockPasskeyResult),
  };
  return chain;
}

/**
 * Creates a mock Supabase admin client. The `from` mock alternates between
 * returning the subscriptions chain and passkeys chain based on table name.
 */
function createMockAdminClient() {
  return {
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue(mockGetUserByIdResult),
      },
    },
    from: vi.fn((table: string) => {
      if (table === 'subscriptions') return createSubscriptionChain();
      if (table === 'passkeys') return createPasskeyChain();
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

let mockAdminClientInstance = createMockAdminClient();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => mockAdminClientInstance),
}));

// ============================================================================
// Import route handler AFTER mocks
// ============================================================================

import { GET } from '../route';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a NextRequest for GET /api/v1/account.
 *
 * @param headers - Additional request headers
 */
function createRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/account', {
    method: 'GET',
    headers: {
      Authorization: 'Bearer styrby_live_test_key',
      ...headers,
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/v1/account', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset to happy-path defaults
    mockGetUserByIdResult = {
      data: {
        user: {
          id: 'test-user-uuid-123',
          email: 'test@example.com',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      },
      error: null,
    };
    mockSubscriptionResult = { data: { tier: 'pro' }, error: null };
    mockPasskeyResult = { data: [{ id: 'passkey-row-1' }], error: null };
    mockAdminClientInstance = createMockAdminClient();
  });

  // --------------------------------------------------------------------------
  // 1. Auth middleware wiring
  // --------------------------------------------------------------------------

  describe('authentication', () => {
    /**
     * WHY: proves the route is wired to withApiAuthAndRateLimit. If a future
     * refactor bypasses the wrapper, this gate fails before any data is exposed.
     * OWASP A07:2021.
     */
    it('returns 401 when auth middleware rejects the request', async () => {
      const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
      vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () =>
        NextResponse.json(
          { error: 'Missing Authorization header', code: 'UNAUTHORIZED' },
          { status: 401 },
        ),
      );

      // WHY vi.resetModules() + fresh import: withApiAuthAndRateLimit is called
      // at module evaluation time (wraps the handler in the GET export). Without
      // re-importing the route module, the mockImplementationOnce override would
      // not take effect on the already-evaluated GET export. A fresh module
      // ensures the mock runs during the route's wrapper invocation.
      vi.resetModules();
      const { GET: freshGET } = await import('../route');
      const response = await freshGET(createRequest());
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Missing Authorization header');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Happy path — user with subscription + passkey
  // --------------------------------------------------------------------------

  describe('200 happy path', () => {
    it('returns 200 with all 6 fields populated for user with subscription and passkey', async () => {
      const response = await GET(createRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.user_id).toBe('test-user-uuid-123');
      expect(body.email).toBe('test@example.com');
      expect(body.tier).toBe('pro');
      expect(body.created_at).toBe('2026-01-01T00:00:00.000Z');
      expect(body.mfa_enrolled).toBe(true);
      expect(body.key_expires_at).toBe('2027-01-01T00:00:00.000Z');
    });

    it('sets Content-Type: application/json', async () => {
      const response = await GET(createRequest());
      expect(response.headers.get('content-type')).toContain('application/json');
    });

    it('sets Cache-Control: no-store to prevent CDN caching of PII', async () => {
      const response = await GET(createRequest());
      expect(response.headers.get('cache-control')).toBe('no-store');
    });
  });

  // --------------------------------------------------------------------------
  // 3. Tier defaults to 'free' when no subscription
  // --------------------------------------------------------------------------

  describe('subscription tier defaulting', () => {
    it('returns tier: free when no subscription row exists', async () => {
      mockSubscriptionResult = { data: null, error: null };
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tier).toBe('free');
    });

    it('returns tier: free when subscription.tier is null', async () => {
      mockSubscriptionResult = { data: { tier: '' }, error: null };
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      // Empty string is falsy — defaults to 'free'
      expect(body.tier).toBe('free');
    });
  });

  // --------------------------------------------------------------------------
  // 4. mfa_enrolled: false when no passkeys
  // --------------------------------------------------------------------------

  describe('MFA enrollment detection', () => {
    it('returns mfa_enrolled: false when no passkey rows exist', async () => {
      mockPasskeyResult = { data: [], error: null };
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.mfa_enrolled).toBe(false);
    });

    it('returns mfa_enrolled: false when passkeys data is null', async () => {
      mockPasskeyResult = { data: null, error: null };
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.mfa_enrolled).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Both subscription and passkeys absent
  // --------------------------------------------------------------------------

  it('returns tier: free and mfa_enrolled: false when both are absent', async () => {
    mockSubscriptionResult = { data: null, error: null };
    mockPasskeyResult = { data: [], error: null };
    mockAdminClientInstance = createMockAdminClient();

    const response = await GET(createRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tier).toBe('free');
    expect(body.mfa_enrolled).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 6. 404 — auth.users row missing
  // --------------------------------------------------------------------------

  describe('404 handling', () => {
    it('returns 404 and fires Sentry warning when auth.users row is missing', async () => {
      mockGetUserByIdResult = { data: { user: null }, error: null };
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Account not found');

      // WHY assert captureMessage (not captureException): a missing auth.users row
      // for a valid key is a consistency alert, not an exception. Sentry warning
      // level is correct for investigation. SOC 2 CC7.2.
      expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledOnce();
    });

    it('returns 404 and fires Sentry warning when getUserById returns an error', async () => {
      mockGetUserByIdResult = { data: { user: null }, error: { message: 'User not found' } };
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(404);
      expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------------------------
  // 7. 500 + Sentry on DB error
  // --------------------------------------------------------------------------

  describe('500 error handling', () => {
    it('returns 200 with tier: free + captureMessage when subscriptions query returns an error', async () => {
      mockSubscriptionResult = { data: null, error: { message: 'connection timeout', code: 'PGRST301' } };
      // WHY 200 not 500: subscription returned-error is non-fatal. The route
      // defaults tier to 'free', fires a Sentry warning (captureMessage, not
      // captureException), and continues. The CLI receives a usable response.
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tier).toBe('free');
      // WHY captureMessage (not captureException): a returned DB error on the
      // subscriptions table is a warning-level signal, not an exception.
      expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledOnce();
      expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
    });

    it('returns 500 + captureException when passkeys query errors', async () => {
      mockPasskeyResult = { data: null, error: { message: 'permission denied' } };
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Failed to fetch account details');
      expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledOnce();
    });

    it('returns sanitized error message — no internal DB details exposed', async () => {
      mockPasskeyResult = { data: null, error: { message: 'FATAL: internal pg secret schema detail' } };
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(500);
      const body = await response.json();
      // The raw error message must NOT appear in the response (OWASP A02:2021)
      expect(body.error).not.toContain('FATAL');
      expect(body.error).not.toContain('schema');
    });
  });

  // --------------------------------------------------------------------------
  // 7b. Subscription query THROWS (network-level) — must still soft-fail to free
  // --------------------------------------------------------------------------

  describe('subscription throw soft-fail', () => {
    it('returns 200 with tier: free and Sentry warning when subscription query throws', async () => {
      // WHY mock setup: override maybeSingle to throw a network-level Error
      // (not return { error }). This covers the catch branch that previously
      // returned 500, contradicting the documented soft-fail design.
      mockAdminClientInstance = {
        ...createMockAdminClient(),
        from: vi.fn((table: string) => {
          if (table === 'subscriptions') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockRejectedValue(new Error('Network timeout')),
            };
          }
          if (table === 'passkeys') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              limit: vi.fn().mockResolvedValue(mockPasskeyResult),
            };
          }
          throw new Error(`Unexpected table: ${table}`);
        }),
        auth: createMockAdminClient().auth,
      };

      const response = await GET(createRequest());

      // IMPORTANT: must be 200, NOT 500 — subscription throw is non-fatal
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tier).toBe('free');

      // WHY captureMessage (not captureException): a network throw on a
      // non-critical dependency warrants a warning-level Sentry signal.
      expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledOnce();
      expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledWith(
        expect.stringContaining('threw'),
        expect.objectContaining({ level: 'warning' }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // 7c. Phone-only accounts — email is null in auth.users
  // --------------------------------------------------------------------------

  describe('phone-only account email fallback', () => {
    it('returns 200 with email: empty string for phone-only account (null email in auth.users)', async () => {
      // WHY null email: Supabase returns email: null for phone-only accounts
      // (accounts created via phone OTP without an email address attached).
      // The route intentionally falls back to '' via `?? ''` — this is NOT
      // a bug. Returning empty string is the documented signal to the CLI that
      // this is a phone-only user, without requiring a nullable AccountResponse type.
      mockGetUserByIdResult = {
        data: {
          user: {
            id: 'test-user-uuid-123',
            email: null as unknown as string,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        },
        error: null,
      };
      mockAdminClientInstance = createMockAdminClient();

      const response = await GET(createRequest());
      expect(response.status).toBe(200);
      const body = await response.json();

      // WHY empty string assertion: this documents that blank email is intentional
      // for phone-only accounts, not a silent null-leakage bug.
      expect(body.email).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // 8. Response has EXACTLY 6 fields — no extra PII
  // --------------------------------------------------------------------------

  it('response body has exactly 6 keys — no extra PII leaked', async () => {
    const response = await GET(createRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    const keys = Object.keys(body);
    expect(keys).toHaveLength(6);
    expect(keys.sort()).toEqual(
      ['created_at', 'email', 'key_expires_at', 'mfa_enrolled', 'tier', 'user_id'].sort(),
    );
  });

  // --------------------------------------------------------------------------
  // 9. Rate limit — 429 wiring
  // --------------------------------------------------------------------------

  it('returns 429 when rate limiter rejects', async () => {
    const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
    vi.mocked(withApiAuthAndRateLimit).mockImplementationOnce(() => async () =>
      NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 }),
    );

    // WHY vi.resetModules() + fresh import: same reason as the 401 test above —
    // withApiAuthAndRateLimit wraps the handler at module evaluation time.
    // Re-importing forces the mock override to apply to the new GET export.
    vi.resetModules();
    const { GET: freshGET } = await import('../route');
    const response = await freshGET(createRequest());
    expect(response.status).toBe(429);
  });

  // --------------------------------------------------------------------------
  // 10. GET-only handler — no other methods exported
  // --------------------------------------------------------------------------

  it('does not export POST, PUT, DELETE, or PATCH handlers', async () => {
    const routeModule = await import('../route');
    expect(routeModule).not.toHaveProperty('POST');
    expect(routeModule).not.toHaveProperty('PUT');
    expect(routeModule).not.toHaveProperty('DELETE');
    expect(routeModule).not.toHaveProperty('PATCH');
  });

  // --------------------------------------------------------------------------
  // 11. key_expires_at comes from auth context keyId (not re-queried)
  // --------------------------------------------------------------------------

  it('key_expires_at uses keyExpiresAt from auth context', async () => {
    // keyExpiresAt is set to '2027-01-01T00:00:00.000Z' in mockAuthContext
    const response = await GET(createRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.key_expires_at).toBe('2027-01-01T00:00:00.000Z');
    // Verify api_keys table was NOT queried
    expect(mockAdminClientInstance.from).not.toHaveBeenCalledWith('api_keys');
  });

  it('returns key_expires_at: null when context keyExpiresAt is null', async () => {
    const { withApiAuthAndRateLimit } = await import('@/middleware/api-auth');
    // WHY explicit cast: the mock type only needs to satisfy the runtime contract.
    // TypeScript's structural check on withApiAuthAndRateLimit's overloaded
    // signature is too narrow to accept { keyExpiresAt: null }. The cast is safe
    // here because the handler receives the context directly at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withApiAuthAndRateLimit as any).mockImplementationOnce(
      (handler: (req: NextRequest, ctx: Record<string, unknown>) => Promise<NextResponse>) => {
        return async (request: NextRequest) =>
          handler(request, { ...mockAuthContext, keyExpiresAt: null });
      },
    );

    vi.resetModules();
    const { GET: freshGET } = await import('../route');
    const response = await freshGET(createRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.key_expires_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 12. Email comes from auth.users — not from query params
  // --------------------------------------------------------------------------

  it('email is taken from auth.users, not from any request input', async () => {
    // Even if an attacker adds ?email=attacker@evil.com, the response must
    // reflect the authenticated user's email from auth.users. OWASP A01:2021.
    const requestWithEmailParam = new NextRequest(
      'http://localhost:3000/api/v1/account?email=attacker%40evil.com',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer styrby_live_test_key' },
      },
    );

    const response = await GET(requestWithEmailParam);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.email).toBe('test@example.com');
    expect(body.email).not.toContain('attacker');
  });

  // --------------------------------------------------------------------------
  // 13. user_id comes from auth context — not from query params
  // --------------------------------------------------------------------------

  it('user_id is taken from auth context, not from any request input', async () => {
    const requestWithUserIdParam = new NextRequest(
      'http://localhost:3000/api/v1/account?user_id=malicious-uuid',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer styrby_live_test_key' },
      },
    );

    const response = await GET(requestWithUserIdParam);
    expect(response.status).toBe(200);
    const body = await response.json();
    // Must be the userId from the auth context, never from the query string
    expect(body.user_id).toBe('test-user-uuid-123');
    expect(body.user_id).not.toBe('malicious-uuid');
  });
});
