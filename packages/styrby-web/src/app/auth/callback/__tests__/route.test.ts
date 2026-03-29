/**
 * Tests for the OAuth/magic-link auth callback handler.
 *
 * WHY these tests matter: This route is the final step in the authentication
 * flow. Bugs here can allow open redirect attacks (sending users to attacker
 * sites), bypass session creation, or accidentally reveal auth errors to
 * untrusted parties. Every branch must be covered.
 *
 * Covers:
 * - Successful code exchange → redirect to destination
 * - Missing code → redirect to /login?error=auth_failed
 * - Exchange error → redirect to /login?error=auth_failed
 * - Welcome email sent for new users (created <60s ago)
 * - Welcome email NOT sent for existing users
 * - Redirect sanitization preventing open redirect attacks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (must be hoisted before any imports of the module under test)
// ============================================================================

const mockExchangeCodeForSession = vi.fn();
const mockGetUser = vi.fn();
const mockSendWelcomeEmail = vi.fn();
const mockCreateClient = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClient,
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
    user_metadata: Record<string, string>;
  }> = {}
) {
  const createdAt = new Date(Date.now() - secondsAgo * 1000).toISOString();
  return {
    id: 'user-abc-123',
    email: overrides.email ?? 'user@example.com',
    created_at: createdAt,
    user_metadata: overrides.user_metadata ?? {},
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Auth Callback Route — GET', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: exchange succeeds, user exists
    mockCreateClient.mockResolvedValue({
      auth: {
        exchangeCodeForSession: mockExchangeCodeForSession,
        getUser: mockGetUser,
      },
    });
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    mockGetUser.mockResolvedValue({ data: { user: makeUser(300) } });
    mockSendWelcomeEmail.mockResolvedValue(undefined);
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
      mockGetUser.mockResolvedValue({ data: { user: makeUser(10) } });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'code' }));

      // Email is fire-and-forget — let the microtask queue flush
      await new Promise((r) => setTimeout(r, 0));
      expect(mockSendWelcomeEmail).toHaveBeenCalledOnce();
    });

    it('uses full_name metadata as displayName when available', async () => {
      mockGetUser.mockResolvedValue({
        data: {
          user: makeUser(5, { user_metadata: { full_name: 'Jane Doe' } }),
        },
      });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'code' }));
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendWelcomeEmail).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Jane Doe' })
      );
    });

    it('falls back to name metadata when full_name is absent', async () => {
      mockGetUser.mockResolvedValue({
        data: {
          user: makeUser(5, { user_metadata: { name: 'Alice' } }),
        },
      });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'code' }));
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendWelcomeEmail).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Alice' })
      );
    });

    it('falls back to the email local part when no name metadata exists', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: makeUser(5, { email: 'hello@example.com' }) },
      });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'code' }));
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendWelcomeEmail).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'hello' })
      );
    });

    it('does NOT send welcome email for existing user (created 120 seconds ago)', async () => {
      mockGetUser.mockResolvedValue({ data: { user: makeUser(120) } });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'code' }));
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendWelcomeEmail).not.toHaveBeenCalled();
    });

    it('does NOT send welcome email when user has no email address', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { ...makeUser(5), email: null } },
      });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'code' }));
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendWelcomeEmail).not.toHaveBeenCalled();
    });

    it('does not throw when sendWelcomeEmail rejects (fire-and-forget)', async () => {
      mockGetUser.mockResolvedValue({ data: { user: makeUser(5) } });
      mockSendWelcomeEmail.mockRejectedValue(new Error('Resend timeout'));

      const { GET } = await import('../route');

      // Should resolve without throwing even if email fails
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
        error: { message: 'Invalid code' },
      });
      const { GET } = await import('../route');

      const response = await GET(buildRequest({ code: 'bad-code' }));

      expect(response.url).toBe('https://styrby.com/login?error=auth_failed');
    });

    it('does not call getUser when exchange fails', async () => {
      mockExchangeCodeForSession.mockResolvedValue({
        error: { message: 'Expired code' },
      });
      const { GET } = await import('../route');

      await GET(buildRequest({ code: 'expired-code' }));

      expect(mockGetUser).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Redirect sanitization (open redirect prevention)
  // --------------------------------------------------------------------------

  describe('redirect sanitization — open redirect prevention', () => {
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

    it('allows a path with a query string like /sessions?tab=active', async () => {
      const { GET } = await import('../route');
      const req = buildRequest({ code: 'valid-code', redirect: '/sessions?tab=active' });

      const response = await GET(req);

      expect(response.url).toBe('https://styrby.com/sessions?tab=active');
    });
  });
});
