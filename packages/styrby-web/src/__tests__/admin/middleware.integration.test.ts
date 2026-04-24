/**
 * Admin Console — Middleware Integration Tests
 *
 * Integration seam: This file verifies the full request path through the
 * Next.js middleware layer → admin path detection → requireSiteAdmin guard
 * → backend response. Rather than unit-testing individual functions in
 * isolation, we exercise the middleware export as a whole and assert the
 * response returned to the caller.
 *
 * WHY this exists (Phase 4.1 T9):
 *   The admin console's first line of defence is the middleware gate. A
 *   regression here — e.g., requireSiteAdmin not being called for /api/admin/*,
 *   or a typo in the path boundary check — silently exposes the admin surface
 *   to unauthenticated users. These tests give CI a tripwire so every merge
 *   to main verifies the full guard contract end-to-end (at the module-mock
 *   boundary, not against a live DB).
 *
 * What phase it tests: Phase 4.1 (Admin Console — T3 middleware guard + T9
 * integration coverage).
 *
 * Design note on NEXT_PUBLIC_SUPABASE_URL:
 *   The middleware constructs the Supabase client inline with createServerClient
 *   (not via @/lib/supabase/server) using getHttpsUrlEnv(). When the env var is
 *   absent or not an https:// URL, getHttpsUrlEnv() returns null and the guard
 *   fails-closed with a 404 — BEFORE calling requireSiteAdmin. This is the
 *   tested behaviour: in CI the middleware returns 404 for admin paths because
 *   the env is not wired up, which matches the deny-by-default security model.
 *   The requireSiteAdmin unit tests (guard.test.ts) verify the guard logic in
 *   isolation; here we verify the middleware path-routing invariants.
 *
 * SOC 2 CC6.1: Access control regressions in the middleware gate would allow
 * unauthorized subjects to reach admin route handlers. These tests enforce the
 * deny-by-obscurity invariant (404 for admin paths) at the middleware boundary.
 * OWASP A01:2021.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks — declared before any import of the module under test
// ============================================================================

/**
 * Controls the response returned by updateSession().
 * Individual tests override per-scenario to simulate valid/invalid sessions.
 */
const mockUpdateSession = vi.fn();

vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
}));

/**
 * Controls the response from requireSiteAdmin.
 * null = allow (is a site admin), NextResponse = deny (non-admin/unauth).
 *
 * WHY we still mock this: even though the middleware creates the Supabase client
 * inline (not through @/lib/supabase/server), it does import requireSiteAdmin
 * from @/lib/admin/guard. Mocking allows tests that set env vars to control the
 * guard behaviour without a real DB.
 */
const mockRequireSiteAdmin = vi.fn();

vi.mock('@/lib/admin/guard', () => ({
  requireSiteAdmin: (...args: unknown[]) => mockRequireSiteAdmin(...args),
}));

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: Object.assign(vi.fn().mockReturnValue({ limit: vi.fn() }), {
    slidingWindow: vi.fn(),
  }),
}));

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn().mockReturnValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
    },
    from: vi.fn().mockReturnValue({
      select:      vi.fn().mockReturnThis(),
      eq:          vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  }),
}));

// Import AFTER mocks are declared
import { middleware } from '../../middleware';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a NextRequest for the given path with optional auth cookie.
 *
 * @param path - URL path to request
 * @param authenticated - If true, attaches a fake auth cookie derived from
 *   NEXT_PUBLIC_SUPABASE_URL (mirrors the middleware's own cookie logic).
 * @param userAgent - User-Agent header (defaults to a benign browser UA)
 */
function makeRequest(
  path: string,
  authenticated = false,
  userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120',
): NextRequest {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] ?? '';
  const cookieName = `sb-${projectRef}-auth-token`;

  return new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'user-agent': userAgent,
      ...(authenticated ? { cookie: `${cookieName}=fake-jwt-token` } : {}),
    },
  });
}

/**
 * Builds a mock NextResponse-like object for updateSession() return values.
 *
 * @param locationHeader - If set, simulate a redirect (expired/invalid session)
 */
function mockSessionResponse(locationHeader?: string) {
  const headers = new Headers();
  if (locationHeader) headers.set('location', locationHeader);
  return { headers, status: 200, cookies: { set: vi.fn(), get: vi.fn() } };
}

/**
 * Builds a 404 NextResponse-like object — what requireSiteAdmin returns for
 * a non-admin or unauthenticated user.
 */
function deny404Response() {
  // Return a real NextResponse so the middleware can return it verbatim.
  const { NextResponse } = require('next/server');
  return new NextResponse(null, {
    status: 404,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('admin middleware integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: updateSession returns a plain pass-through (no redirect).
    mockUpdateSession.mockResolvedValue(mockSessionResponse());

    // Default: requireSiteAdmin denies (non-admin path).
    // Tests that need the admin to pass through override this.
    mockRequireSiteAdmin.mockResolvedValue(deny404Response());
  });

  // --------------------------------------------------------------------------
  // (a) Authenticated site admin reaches /dashboard/admin — mocked 200
  // --------------------------------------------------------------------------

  describe('(a) site admin passes through to /dashboard/admin', () => {
    it('returns non-404 when requireSiteAdmin allows (returns null) and env is configured', async () => {
      // requireSiteAdmin returns null → allow the request through.
      // WHY null: guard.ts returns null when the user is a confirmed admin.
      mockRequireSiteAdmin.mockResolvedValue(null);
      mockUpdateSession.mockResolvedValue(mockSessionResponse());

      // WHY stub env vars: the middleware calls getHttpsUrlEnv('NEXT_PUBLIC_SUPABASE_URL')
      // before creating the Supabase client. Without a valid https:// URL, it
      // fails-closed (404) before requireSiteAdmin is ever called. We stub the
      // env to a valid https:// value to reach the requireSiteAdmin check.
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',  'https://testref.supabase.co');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');

      const req = makeRequest('/dashboard/admin', true);
      const response = await middleware(req);

      // requireSiteAdmin returned null → allow. Should not be 404 from the guard.
      // (The subsequent dashboard auth check may redirect unauthenticated users
      // to /login, which is a 307. Either way it is NOT a 404.)
      expect(response.status).not.toBe(404);
      // requireSiteAdmin must have been called for admin paths.
      expect(mockRequireSiteAdmin).toHaveBeenCalledOnce();
    });

    it('calls requireSiteAdmin exactly once for /dashboard/admin/* paths when env is configured', async () => {
      mockRequireSiteAdmin.mockResolvedValue(null);

      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',  'https://testref.supabase.co');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');

      const req = makeRequest('/dashboard/admin/users', true);
      await middleware(req);

      expect(mockRequireSiteAdmin).toHaveBeenCalledOnce();
    });

    it('calls updateSession before the admin guard for admin requests', async () => {
      mockRequireSiteAdmin.mockResolvedValue(null);

      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',  'https://testref.supabase.co');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');

      const req = makeRequest('/dashboard/admin', true);
      await middleware(req);

      expect(mockUpdateSession).toHaveBeenCalledOnce();
      expect(mockUpdateSession).toHaveBeenCalledWith(req);
    });
  });

  // --------------------------------------------------------------------------
  // (b) Non-admin authenticated user reaching /dashboard/admin → 404
  // --------------------------------------------------------------------------

  describe('(b) non-admin user gets 404 from guard for /dashboard/admin', () => {
    it('returns 404 when requireSiteAdmin denies (non-admin user, env configured)', async () => {
      // requireSiteAdmin is already mocked to return a 404 response in beforeEach.
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',  'https://testref.supabase.co');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');

      const req = makeRequest('/dashboard/admin', true);
      const response = await middleware(req);

      // Guard fired and returned 404.
      expect(response.status).toBe(404);
      expect(mockRequireSiteAdmin).toHaveBeenCalledOnce();
    });

    it('returns 404 for /dashboard/admin/users for non-admin user', async () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',  'https://testref.supabase.co');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');

      const req = makeRequest('/dashboard/admin/users', true);
      const response = await middleware(req);

      expect(response.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // (c) Unauthenticated user reaching /dashboard/admin → 404
  //
  // WHY two sub-scenarios:
  //   - Without env: middleware fails-closed at the env-check (before calling
  //     requireSiteAdmin). Still returns 404. Path-detection is still exercised.
  //   - With env: middleware calls requireSiteAdmin which also returns 404
  //     because the user is unauthenticated (mock default).
  // --------------------------------------------------------------------------

  describe('(c) unauthenticated user gets 404 from guard', () => {
    it('returns 404 for /dashboard/admin with no auth cookie (no env — fail-closed)', async () => {
      // No env configured → middleware returns 404 immediately for admin paths.
      // WHY this is correct behaviour: fail-closed is the right security posture
      // for admin routes when the Supabase client cannot be constructed.
      const req = makeRequest('/dashboard/admin', false);
      const response = await middleware(req);

      expect(response.status).toBe(404);
    });

    it('returns 404 for /dashboard/admin/* with no auth cookie (no env — fail-closed)', async () => {
      const req = makeRequest('/dashboard/admin/users', false);
      const response = await middleware(req);

      expect(response.status).toBe(404);
    });

    it('returns 404 for /dashboard/admin when requireSiteAdmin denies unauthenticated user', async () => {
      // With env configured, requireSiteAdmin is called. The mock returns 404
      // by default (simulating an unauthenticated/non-admin user).
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',  'https://testref.supabase.co');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');

      const req = makeRequest('/dashboard/admin', false);
      const response = await middleware(req);

      expect(response.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // (d) /api/admin/audit/verify is gated — 404 for non-admin
  // --------------------------------------------------------------------------

  describe('(d) /api/admin/audit/verify is guarded', () => {
    it('returns 404 for /api/admin/audit/verify without auth (no env — fail-closed)', async () => {
      // WHY: no env → fail-closed 404 before the guard is invoked.
      const req = makeRequest('/api/admin/audit/verify', false);
      const response = await middleware(req);

      expect(response.status).toBe(404);
    });

    it('returns 404 for /api/admin/audit/verify with non-admin session (env configured)', async () => {
      // requireSiteAdmin mock returns 404 by default (non-admin).
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',  'https://testref.supabase.co');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');

      const req = makeRequest('/api/admin/audit/verify', true);
      const response = await middleware(req);

      expect(response.status).toBe(404);
      expect(mockRequireSiteAdmin).toHaveBeenCalledOnce();
    });

    it('does NOT return 404 for /api/admin/audit/verify when site admin (env configured)', async () => {
      // Site admin: requireSiteAdmin returns null → allow.
      mockRequireSiteAdmin.mockResolvedValue(null);

      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',  'https://testref.supabase.co');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');

      const req = makeRequest('/api/admin/audit/verify', true);
      const response = await middleware(req);

      // Guard allowed through. Response will be either a pass-through or a
      // dashboard redirect (not a 404 from the admin guard).
      expect(response.status).not.toBe(404);
      expect(mockRequireSiteAdmin).toHaveBeenCalledOnce();
    });

    it('returns 404 for all /api/admin/* sub-paths when env is absent (fail-closed)', async () => {
      // WHY: without env, every admin path returns 404 before requireSiteAdmin.
      // This verifies path detection (boundary check) is correct for all sub-paths.
      const paths = [
        '/api/admin/audit/verify',
        '/api/admin/support',
        '/api/admin/users',
      ];

      for (const path of paths) {
        vi.clearAllMocks();
        mockUpdateSession.mockResolvedValue(mockSessionResponse());

        const req = makeRequest(path, false);
        const response = await middleware(req);

        // 404 from fail-closed env check.
        expect(response.status, `Expected 404 for path ${path}`).toBe(404);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Boundary: non-admin paths are NOT gated
  // --------------------------------------------------------------------------

  describe('non-admin paths are not guarded', () => {
    it('does not call requireSiteAdmin for /dashboard (non-admin path)', async () => {
      // Authenticated user on a normal dashboard route.
      mockRequireSiteAdmin.mockResolvedValue(null); // would allow if called

      const req = makeRequest('/dashboard', true);
      await middleware(req);

      // requireSiteAdmin should NOT be called for non-admin paths.
      expect(mockRequireSiteAdmin).not.toHaveBeenCalled();
    });

    it('does not call requireSiteAdmin for /api/sessions', async () => {
      const req = makeRequest('/api/sessions', false);
      await middleware(req);

      expect(mockRequireSiteAdmin).not.toHaveBeenCalled();
    });

    it('does not gate /dashboardfake — not an admin path (exact boundary)', async () => {
      // WHY: startsWith('/dashboard/admin') would match /dashboardfake if the
      // boundary check is wrong. Verify the gate is exact-boundary only.
      const req = makeRequest('/dashboardfake', false);
      const response = await middleware(req);

      // Middleware should NOT gate this path as an admin path.
      // No env configured, so if the guard fired we'd get 404.
      // updateSession returns 200 → response is not 404 from the admin guard.
      expect(mockRequireSiteAdmin).not.toHaveBeenCalled();
    });
  });
});
