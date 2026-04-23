/**
 * Tests for the OAuth/magic-link auth callback handler.
 *
 * WHY these tests matter: This route is the final step in the authentication
 * flow. Bugs here can allow open redirect attacks (sending users to attacker
 * sites), bypass session creation, or accidentally reveal auth errors to
 * untrusted parties. Every branch must be covered.
 *
 * Covers:
 * - Successful code exchange -> redirect to destination
 * - Missing code -> redirect to /login?error=auth_failed
 * - Exchange error -> redirect to /login?error=auth_failed
 * - Welcome email sent for new users (created <60s ago)
 * - Welcome email NOT sent for existing users
 * - Redirect sanitization preventing open redirect attacks
 * - Phase 2.7: Google SSO auto-enroll fires for hd-claim users
 * - Phase 2.7: require_sso=true blocks non-Google-SSO auth at callback level
 * - Phase 2.7: wrong Google domain rejected for require_sso teams
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (must be hoisted before any imports of the module under test)
// ============================================================================

const mockExchangeCodeForSession = vi.fn();
const mockGetUser = vi.fn();
const mockSendWelcomeEmail = vi.fn();
const mockCreateClient = vi.fn();
const mockRpc = vi.fn();

// Admin client mock (for SSO auto-enroll)
const mockAdminFrom = vi.fn();
const mockCreateAdminClient = vi.fn(() => ({
  from: mockAdminFrom,
  rpc: mockRpc,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClient,
  createAdminClient: mockCreateAdminClient,
}));

vi.mock('@/lib/resend', () => ({
  sendWelcomeEmail: mockSendWelcomeEmail,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    redirect: (url: string) => ({
      type: 'redirect',
      url,
      status: 302,
      headers: new Map([['location', url]]),
    }),
  },
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a Request with the given query parameters against https://styrby.com.
 *
 * @param params - Record of query string key/value pairs
 * @returns Minimal Request object accepted by the route handler
 */
function buildRequest(params: Record<string, string>): Request {
  const url = new URL('https://styrby.com/auth/callback');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return { url: url.toString() } as unknown as Request;
}

/**
 * Returns a user object whose created_at is the given number of seconds ago.
 *
 * @param secondsAgo - How many seconds before now the user was created
 * @param overrides - Optional overrides for user fields
 */
function makeUser(
  secondsAgo: number,
  overrides: Partial<{
    email: string;
    user_metadata: Record<string, unknown>;
    app_metadata: Record<string, unknown>;
  }> = {}
) {
  const createdAt = new Date(Date.now() - secondsAgo * 1000).toISOString();
  return {
    id: 'user-abc-123',
    email: overrides.email ?? 'user@example.com',
    created_at: createdAt,
    user_metadata: overrides.user_metadata ?? {},
    app_metadata: overrides.app_metadata ?? { provider: 'github' },
  };
}

/**
 * Creates a chainable admin from() mock that returns the given data.
 */
function makeAdminFromChain(result: { data?: unknown; error?: unknown; count?: number }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'insert', 'update', 'delete', 'in', 'order', 'limit', 'contains', 'is']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

// ============================================================================
// Tests
// ============================================================================

describe('Auth Callback Route — GET', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: exchange succeeds, user exists (existing user = no welcome email)
    mockCreateClient.mockResolvedValue({
      auth: {
        exchangeCodeForSession: mockExchangeCodeForSession,
        getUser: mockGetUser,
      },
      from: vi.fn(() => makeAdminFromChain({ data: null, error: null })),
      rpc: mockRpc,
    });

    // Default: exchange returns a user object (Phase 2.7 signature)
    mockExchangeCodeForSession.mockResolvedValue({
      data: { user: makeUser(300) }, // existing user, no welcome email
      error: null,
    });

    mockGetUser.mockResolvedValue({ data: { user: makeUser(300) } });
    mockSendWelcomeEmail.mockResolvedValue(undefined);

    // Admin client from() default (for team query in SSO path)
    mockAdminFrom.mockReturnValue(makeAdminFromChain({ data: [], error: null }));

    // Default RPC mock: no SSO policies
    mockRpc.mockResolvedValue({ data: { policies: [] }, error: null });
  });

  // --------------------------------------------------------------------------
  // Success path
  // --------------------------------------------------------------------------

  describe('successful code exchange', () => {
    it('redirects to /dashboard when no redirect param is provided', async () => {
      const { GET } = await import('../route');
      const req = buildRequest({ code: 'valid-code' });

      const response = await GET(req);

      expect(response.url).toBe('https://styrby.com/dashboard');
    });

    it('redirects to the sanitized path when a valid relative redirect is given', async () => {
      const { GET } = await import('../route');
      const req = buildRequest({ code: 'valid-code', redirect: '/sessions/abc' });

      const response = await GET(req);

      expect(response.url).toBe('https://styrby.com/sessions/abc');
    });

    it('calls exchangeCodeForSession with the code from the URL', async () => {
      const { GET } = await import('../route');
      await GET(buildRequest({ code: 'my-oauth-code' }));

      expect(mockExchangeCodeForSession).toHaveBeenCalledWith('my-oauth-code');
    });
  });

  // --------------------------------------------------------------------------
  // Welcome email
  // --------------------------------------------------------------------------

  describe('welcome email', () => {
    it('sends welcome email for a brand-new user (created 10 seconds ago)', async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: makeUser(10) },
        error: null,
      });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'code' }));

      // Email is fire-and-forget - let the microtask queue flush
      await new Promise((r) => setTimeout(r, 0));
      expect(mockSendWelcomeEmail).toHaveBeenCalledOnce();
    });

    it('uses full_name metadata as displayName when available', async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: makeUser(5, { user_metadata: { full_name: 'Jane Doe' } }) },
        error: null,
      });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'code' }));
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendWelcomeEmail).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Jane Doe' })
      );
    });

    it('does NOT send welcome email for existing user (created 120 seconds ago)', async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: makeUser(120) },
        error: null,
      });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'code' }));
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendWelcomeEmail).not.toHaveBeenCalled();
    });

    it('does not throw when sendWelcomeEmail rejects (fire-and-forget)', async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: makeUser(5) },
        error: null,
      });
      mockSendWelcomeEmail.mockRejectedValue(new Error('Resend timeout'));

      const { GET } = await import('../route');
      await expect(GET(buildRequest({ code: 'code' }))).resolves.toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Failure paths
  // --------------------------------------------------------------------------

  describe('auth failure paths', () => {
    it('redirects to /login?error=auth_failed when no code param is present', async () => {
      const { GET } = await import('../route');
      const response = await GET(buildRequest({}));

      expect(response.url).toBe('https://styrby.com/login?error=auth_failed');
    });

    it('redirects to /login?error=auth_failed when exchange returns an error', async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid code' },
      });
      const { GET } = await import('../route');

      const response = await GET(buildRequest({ code: 'bad-code' }));

      expect(response.url).toBe('https://styrby.com/login?error=auth_failed');
    });
  });

  // --------------------------------------------------------------------------
  // Redirect sanitization (open redirect prevention)
  // --------------------------------------------------------------------------

  describe('redirect sanitization - open redirect prevention', () => {
    const CASES: Array<{ label: string; redirect: string }> = [
      { label: 'absolute http URL', redirect: 'http://evil.com' },
      { label: 'absolute https URL', redirect: 'https://evil.com/steal-tokens' },
      { label: 'protocol-relative URL', redirect: '//evil.com' },
      { label: 'double-slash prefix', redirect: '//evil.com/path' },
      { label: 'backslash normalized redirect', redirect: '/\\evil.com' },
      { label: 'embedded double-slash', redirect: '/path//../../etc/passwd' },
    ];

    for (const { label, redirect } of CASES) {
      it(`falls back to /dashboard for: ${label}`, async () => {
        const { GET } = await import('../route');
        const req = buildRequest({ code: 'valid-code', redirect });

        const response = await GET(req);

        expect(response.url).toBe('https://styrby.com/dashboard');
      });
    }

    it('allows a safe relative path like /settings/profile', async () => {
      const { GET } = await import('../route');
      const req = buildRequest({ code: 'valid-code', redirect: '/settings/profile' });

      const response = await GET(req);

      expect(response.url).toBe('https://styrby.com/settings/profile');
    });
  });

  // --------------------------------------------------------------------------
  // Phase 2.7: Google SSO auto-enroll
  // --------------------------------------------------------------------------

  describe('Phase 2.7 - Google SSO auto-enroll', () => {
    it('triggers SSO auto-enroll for Google user with hd claim', async () => {
      const googleUser = makeUser(300, {
        email: 'alice@acme.com',
        app_metadata: { provider: 'google' },
        user_metadata: { hd: 'acme.com' },
      });

      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: googleUser },
        error: null,
      });

      // Admin from: teams query returns one matching team
      mockAdminFrom.mockReturnValueOnce({
        ...makeAdminFromChain({ data: [{ id: 'team-1', seat_cap: 10, active_seats: 3, require_sso: false }], error: null }),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ data: [{ id: 'team-1', seat_cap: 10, active_seats: 3, require_sso: false }], error: null }),
      });

      // RPC calls: auto_sso_enroll + get_team_sso_policy
      mockRpc
        .mockResolvedValueOnce({ data: { enrolled: true }, error: null })   // auto_sso_enroll
        .mockResolvedValueOnce({ data: { policies: [] }, error: null });    // get_team_sso_policy

      const { GET } = await import('../route');
      await GET(buildRequest({ code: 'google-code' }));

      // Verify auto_sso_enroll was called with the correct hd claim
      const autoEnrollCall = mockRpc.mock.calls.find((c) => c[0] === 'auto_sso_enroll');
      expect(autoEnrollCall).toBeDefined();
      expect(autoEnrollCall?.[1].p_hd_claim).toBe('acme.com');
      expect(autoEnrollCall?.[1].p_user_email).toBe('alice@acme.com');
    });

    it('does NOT call auto_sso_enroll for GitHub user', async () => {
      const githubUser = makeUser(300, {
        app_metadata: { provider: 'github' },
        user_metadata: {},
      });

      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: githubUser },
        error: null,
      });

      const { GET } = await import('../route');
      await GET(buildRequest({ code: 'github-code' }));

      const autoEnrollCall = mockRpc.mock.calls.find((c) => c[0] === 'auto_sso_enroll');
      expect(autoEnrollCall).toBeUndefined();
    });

    it('does NOT call auto_sso_enroll for personal Google (no hd claim)', async () => {
      const personalGoogleUser = makeUser(300, {
        app_metadata: { provider: 'google' },
        user_metadata: {}, // no hd = personal Gmail
      });

      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: personalGoogleUser },
        error: null,
      });

      const { GET } = await import('../route');
      await GET(buildRequest({ code: 'google-code' }));

      const autoEnrollCall = mockRpc.mock.calls.find((c) => c[0] === 'auto_sso_enroll');
      expect(autoEnrollCall).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Phase 2.7: require_sso enforcement - SECURITY CRITICAL
  // --------------------------------------------------------------------------

  describe('Phase 2.7 - require_sso enforcement', () => {
    /**
     * SECURITY TEST: Password / OTP auth must be rejected for SSO-only teams.
     *
     * WHY: If an attacker knows a team member's email, they could attempt
     * magic-link auth. The callback must reject them server-side, not rely on
     * UI-level hiding of the email login option.
     */
    it('rejects email/OTP auth when team has require_sso=true', async () => {
      const emailUser = makeUser(300, {
        app_metadata: { provider: 'email' },
        user_metadata: {},
      });

      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: emailUser },
        error: null,
      });

      // get_team_sso_policy: SSO-required team
      mockRpc.mockResolvedValueOnce({
        data: { policies: [{
          team_id: 'team-sso-only',
          sso_domain: 'acme.com',
          require_sso: true,
          role: 'member',
        }] },
        error: null,
      });

      // Audit log insert (fire-and-forget)
      mockAdminFrom.mockReturnValue(makeAdminFromChain({ data: null, error: null }));

      const { GET } = await import('../route');
      const response = await GET(buildRequest({ code: 'email-code' }));

      expect(response.url).toContain('sso_required');
      expect(response.url).not.toContain('/dashboard');
    });

    it('rejects GitHub auth when team has require_sso=true', async () => {
      const githubUser = makeUser(300, {
        app_metadata: { provider: 'github' },
        user_metadata: {},
      });

      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: githubUser },
        error: null,
      });

      mockRpc.mockResolvedValueOnce({
        data: { policies: [{
          team_id: 'team-sso-only',
          sso_domain: 'acme.com',
          require_sso: true,
          role: 'member',
        }] },
        error: null,
      });

      mockAdminFrom.mockReturnValue(makeAdminFromChain({ data: null, error: null }));

      const { GET } = await import('../route');
      const response = await GET(buildRequest({ code: 'github-code' }));

      expect(response.url).toContain('sso_required');
    });

    it('allows Google auth with matching hd when require_sso=true', async () => {
      const googleUser = makeUser(300, {
        email: 'alice@acme.com',
        app_metadata: { provider: 'google' },
        user_metadata: { hd: 'acme.com' },
      });

      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: googleUser },
        error: null,
      });

      // No matching teams for enroll (user already enrolled)
      mockAdminFrom.mockReturnValue(makeAdminFromChain({ data: [], error: null }));

      // get_team_sso_policy: require_sso=true with matching domain
      mockRpc
        .mockResolvedValueOnce({ data: { policies: [{
          team_id: 'team-sso-only',
          sso_domain: 'acme.com',
          require_sso: true,
          role: 'member',
        }] }, error: null });

      const { GET } = await import('../route');
      const response = await GET(buildRequest({ code: 'google-code' }));

      // Must ALLOW login - Google with correct hd
      expect(response.url).toContain('/dashboard');
      expect(response.url).not.toContain('sso_required');
    });

    it('rejects Google auth with WRONG hd when require_sso=true', async () => {
      const googleUser = makeUser(300, {
        email: 'alice@wrong.com',
        app_metadata: { provider: 'google' },
        user_metadata: { hd: 'wrong.com' }, // different from team's domain
      });

      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: googleUser },
        error: null,
      });

      mockAdminFrom.mockReturnValue(makeAdminFromChain({ data: [], error: null }));

      mockRpc
        .mockResolvedValueOnce({ data: { policies: [{
          team_id: 'team-sso-only',
          sso_domain: 'acme.com',   // team's domain = acme.com
          require_sso: true,
          role: 'member',
        }] }, error: null });

      mockAdminFrom.mockReturnValue(makeAdminFromChain({ data: null, error: null })); // audit log

      const { GET } = await import('../route');
      const response = await GET(buildRequest({ code: 'wrong-domain-code' }));

      // MUST reject - wrong Google domain
      expect(response.url).toContain('sso_required');
    });

    it('allows any auth when require_sso=false', async () => {
      const emailUser = makeUser(300, {
        app_metadata: { provider: 'email' },
        user_metadata: {},
      });

      mockExchangeCodeForSession.mockResolvedValue({
        data: { user: emailUser },
        error: null,
      });

      mockRpc.mockResolvedValueOnce({
        data: { policies: [{
          team_id: 'team-optional-sso',
          sso_domain: 'acme.com',
          require_sso: false, // SSO optional
          role: 'member',
        }] },
        error: null,
      });

      const { GET } = await import('../route');
      const response = await GET(buildRequest({ code: 'email-code' }));

      // Must allow - require_sso is false
      expect(response.url).toContain('/dashboard');
      expect(response.url).not.toContain('sso_required');
    });
  });
});
