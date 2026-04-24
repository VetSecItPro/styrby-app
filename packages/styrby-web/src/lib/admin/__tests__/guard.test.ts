/**
 * Unit tests for requireSiteAdmin (packages/styrby-web/src/lib/admin/guard.ts).
 *
 * WHY these cases:
 *   The guard is the single security gate for all /admin routes. Every failure
 *   mode must return 404 (deny-by-obscurity) — never a 401/403 that reveals
 *   the route's existence. These tests lock that behaviour in so a refactor
 *   cannot accidentally weaken the gate.
 *
 * Test matrix:
 *   1. Authenticated admin         → null (allow)
 *   2. Authenticated non-admin     → 404 Response
 *   3. Unauthenticated user        → 404 Response
 *   4. DB query error              → 404 Response (fail-closed)
 *   5. Response body is null       → no information leak
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { requireSiteAdmin } from '../guard';

// ─── Mock Supabase client factory ────────────────────────────────────────────

/**
 * Builds a minimal Supabase client mock.
 *
 * The mock replicates the `.from().select().eq().maybeSingle()` chain that
 * requireSiteAdmin uses, plus `supabase.auth.getUser()`.
 *
 * @param opts.user     - The user returned by getUser() (null = unauthenticated)
 * @param opts.authError - Error returned by getUser() (null = success)
 * @param opts.row      - The row returned by maybeSingle() (null = no row)
 * @param opts.dbError  - Error returned by maybeSingle() (null = success)
 */
function makeMockSupabase(opts: {
  user?: { id: string } | null;
  authError?: Error | null;
  row?: { user_id: string } | null;
  dbError?: { message: string } | null;
}) {
  const { user = null, authError = null, row = null, dbError = null } = opts;

  // Build the chained query mock: .from().select().eq().maybeSingle()
  const maybeSingleMock = vi.fn().mockResolvedValue({ data: row, error: dbError });
  const eqMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
  const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
  const fromMock = vi.fn().mockReturnValue({ select: selectMock });

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user },
        error: authError,
      }),
    },
    from: fromMock,
    // Expose inner mocks so tests can assert call arguments if needed
    _mocks: { fromMock, selectMock, eqMock, maybeSingleMock },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a minimal NextRequest for testing the guard. */
function makeRequest(path = '/admin'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('requireSiteAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Case 1: Authenticated admin → allow (null) ──────────────────────────

  it('returns null for an authenticated user who is a site admin', async () => {
    const supabase = makeMockSupabase({
      user: { id: 'admin-user-uuid' },
      row: { user_id: 'admin-user-uuid' }, // Row present in site_admins → admin
    });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(result).toBeNull();
  });

  it('queries site_admins with the authenticated user id', async () => {
    const supabase = makeMockSupabase({
      user: { id: 'admin-user-uuid' },
      row: { user_id: 'admin-user-uuid' },
    });

    await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(supabase._mocks.fromMock).toHaveBeenCalledWith('site_admins');
    expect(supabase._mocks.eqMock).toHaveBeenCalledWith('user_id', 'admin-user-uuid');
    expect(supabase._mocks.maybeSingleMock).toHaveBeenCalledOnce();
  });

  // ── Case 2: Authenticated non-admin → 404 ──────────────────────────────

  it('returns 404 for an authenticated user who is NOT in site_admins', async () => {
    const supabase = makeMockSupabase({
      user: { id: 'regular-user-uuid' },
      row: null, // No row → not admin
    });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
  });

  // ── Case 3: Unauthenticated user → 404 ─────────────────────────────────

  it('returns 404 when getUser() returns null user (unauthenticated)', async () => {
    const supabase = makeMockSupabase({
      user: null, // No authenticated user
    });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
  });

  it('returns 404 when getUser() returns an auth error', async () => {
    const supabase = makeMockSupabase({
      user: null,
      authError: new Error('JWT expired'),
    });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
  });

  it('does NOT query site_admins when getUser() fails (fast-fail)', async () => {
    const supabase = makeMockSupabase({
      user: null,
      authError: new Error('network error'),
    });

    await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    // No DB query should be made if auth already failed
    expect(supabase._mocks.fromMock).not.toHaveBeenCalled();
  });

  // ── Case 4: DB query error → 404 (fail-closed) ─────────────────────────

  it('returns 404 when the site_admins DB query returns an error (fail-closed)', async () => {
    const supabase = makeMockSupabase({
      user: { id: 'some-user-uuid' },
      row: null,
      dbError: { message: 'connection timeout' }, // DB error
    });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
  });

  it('returns 404 when the supabase query chain throws unexpectedly', async () => {
    // Simulate a thrown exception from the DB layer
    const throwingSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-uuid' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockRejectedValue(new Error('DB crashed')),
          }),
        }),
      }),
    };

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throwingSupabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
  });

  // ── Case 5: Response body is null (no information leak) ────────────────

  it('deny response has null body (no leak of denial reason)', async () => {
    const supabase = makeMockSupabase({ user: null });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    // NextResponse(null, ...) → body is null
    expect(result!.body).toBeNull();
  });

  it('non-admin deny response also has null body', async () => {
    const supabase = makeMockSupabase({
      user: { id: 'regular-user-uuid' },
      row: null,
    });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    expect(result!.body).toBeNull();
  });

  it('DB-error deny response also has null body', async () => {
    const supabase = makeMockSupabase({
      user: { id: 'some-user-uuid' },
      dbError: { message: 'timeout' },
    });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    expect(result!.body).toBeNull();
  });

  // ── Case 6: Cache-Control: no-store on denial (CDN must never cache it) ──

  it('deny response includes Cache-Control: no-store, max-age=0', async () => {
    // WHY: A CDN caching a 404 denial would lock the admin out on subsequent
    // valid requests from the same cache key. Verify the header is always set.
    const supabase = makeMockSupabase({ user: null });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    expect(result!.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });

  // ── Case 7: Exact-boundary path — /dashboardfake must NOT be gated ────────
  //
  // NOTE: requireSiteAdmin itself does not check the path — the middleware does.
  // This test verifies that makeRequest('/dashboardfake') produces a request
  // that the guard function accepts or rejects purely on auth, not on path
  // (the guard is path-agnostic; path filtering is middleware's responsibility).
  // It documents the contract: guard receives already-filtered requests.

  it('guard does not reject /dashboardfake path — path filtering is middleware-owned', async () => {
    // An authenticated admin hitting any path the middleware passes through → allowed.
    const supabase = makeMockSupabase({
      user: { id: 'admin-user-uuid' },
      row: { user_id: 'admin-user-uuid' },
    });

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      makeRequest('/dashboardfake') // guard is path-agnostic; middleware filters before calling it
    );

    // Admin → allowed regardless of path (path check is not the guard's job)
    expect(result).toBeNull();
  });

  // ── getUser() throws (e.g. network exception) → 404 ───────────────────

  it('returns 404 when getUser() throws an exception', async () => {
    const throwingAuthSupabase = {
      auth: {
        getUser: vi.fn().mockRejectedValue(new Error('network failure')),
      },
      from: vi.fn(),
    };

    const result = await requireSiteAdmin(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throwingAuthSupabase as any,
      makeRequest()
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
    // DB query must not be attempted
    expect(throwingAuthSupabase.from).not.toHaveBeenCalled();
  });
});
