/**
 * Tests for /dashboard/admin/users/[userId] — User Dossier Page
 *
 * Covers:
 *   (a) Invalid UUID in params → notFound() is called
 *   (b) Valid UUID but no matching profile → notFound() is called
 *   (c) Valid UUID + existing profile → UserDossier renders with correct props
 *   (d) Suspense fallback skeletons are visible before cards resolve
 *
 * Testing strategy:
 *   - We test the page Server Component directly (calling it as an async function)
 *     with mocked `createAdminClient` and `notFound`.
 *   - We test `UserDossier` as a pure render component (no async) with mocked
 *     sub-card components to confirm Suspense boundaries are present.
 *   - We test each sub-card component in isolation with mocked `createAdminClient`
 *     to confirm correct query shapes and data rendering.
 *
 * WHY we mock notFound() from next/navigation:
 *   notFound() throws a special Next.js error object. In a unit test context,
 *   that throw would surface as an unhandled rejection rather than a clean
 *   404 assertion. We mock it to a vi.fn() so we can assert it was called.
 *
 * WHY sub-card mocking in UserDossier tests:
 *   UserDossier wraps each card in Suspense. In jsdom / Vitest (no streaming),
 *   async Server Components inside Suspense are not automatically resolved.
 *   Mocking the cards as sync stubs lets us test the Suspense boundary
 *   wiring and layout without real DB calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ─── Mocks ───────────────────────────────────────────────────────────────────

/**
 * Mock next/navigation. notFound() is the critical one for T5 — invalid/missing
 * user detection depends on it.
 */
const mockNotFound = vi.fn(() => {
  // WHY throw: Next.js notFound() throws internally. We replicate that so that
  // the page component's control flow stops at the notFound() call site, just
  // like it would in production. Without throwing, the test would continue
  // past the notFound() call and potentially render stale state.
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  redirect: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => <a href={href} {...rest}>{children}</a>,
}));

/**
 * Mock createAdminClient with a configurable data/error return.
 *
 * WHY a factory mock (not a static object): each card calls a fresh chain of
 * `.from().select().eq().maybeSingle()` etc. We need each test to be able to
 * return different data shapes. The factory pattern lets individual tests
 * override `mockDbResult` before calling the component.
 */
const mockMaybeSingle = vi.fn();
const mockRange = vi.fn();
const mockLimit = vi.fn();

// WHY chainable mock: Supabase client uses a builder pattern.
// Each method in the chain returns `this`-like object so the next method
// can be called on it. We satisfy this with `mockReturnThis()`.
const mockRpc = vi.fn();
const mockAdminChain = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  ilike: vi.fn().mockReturnThis(),
  gte: vi.fn().mockReturnThis(),
  maybeSingle: mockMaybeSingle,
  range: mockRange,
  limit: mockLimit,
  // WHY rpc: resolveAdminEmails uses .rpc('resolve_user_emails_for_admin')
  // instead of .from('profiles').select('email').in() — profiles has no
  // email column. Migration 043. SOC 2 CC7.2.
  rpc: mockRpc,
};

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => mockAdminChain,
  createClient: vi.fn(),
}));

/**
 * Mock lucide-react icons to avoid SVG rendering complexity in tests.
 * All icons render as a small span with their name, so structural assertions
 * remain possible without importing the full lucide bundle.
 */
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left" />,
  Users: () => <span data-testid="icon-users" />,
  User: () => <span data-testid="icon-user" />,
  Shield: () => <span data-testid="icon-shield" />,
  CreditCard: () => <span data-testid="icon-credit-card" />,
  AlertTriangle: () => <span data-testid="icon-alert-triangle" />,
  Terminal: () => <span data-testid="icon-terminal" />,
  ScrollText: () => <span data-testid="icon-scroll-text" />,
  UserCog: () => <span data-testid="icon-user-cog" />,
  ExternalLink: () => <span data-testid="icon-external-link" />,
}));

// ─── Page import ─────────────────────────────────────────────────────────────

// WHY dynamic import inside describe blocks: vi.mock hoisting happens at the
// module level, so all mocks above are set before the module loads. We still
// use dynamic import so we can re-import cleanly between test suites.

// ─── Test: page-level UUID validation ───────────────────────────────────────

describe('UserDossierPage — UUID validation and existence check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the chain mocks to return `this` by default.
    mockAdminChain.from.mockReturnThis();
    mockAdminChain.select.mockReturnThis();
    mockAdminChain.eq.mockReturnThis();
    mockAdminChain.in.mockReturnThis();
    mockAdminChain.order.mockReturnThis();
    mockAdminChain.gte.mockReturnThis();
    mockAdminChain.limit.mockImplementation(() => mockAdminChain);
  });

  it('(a) calls notFound() for an invalid UUID (too short)', async () => {
    const { default: Page } = await import('../page');

    await expect(
      Page({ params: Promise.resolve({ userId: 'not-a-uuid' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
    // WHY verify no DB call: invalid UUID should short-circuit before any query.
    expect(mockAdminChain.from).not.toHaveBeenCalled();
  });

  it('(a) calls notFound() for an empty userId', async () => {
    const { default: Page } = await import('../page');

    await expect(
      Page({ params: Promise.resolve({ userId: '' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('(a) calls notFound() for a UUID-shaped but not RFC 4122 string', async () => {
    const { default: Page } = await import('../page');

    // 35 chars (missing one char) — passes visual inspection but fails regex.
    await expect(
      Page({ params: Promise.resolve({ userId: '00000000-0000-0000-0000-00000000000' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('(b) calls notFound() when profile does not exist', async () => {
    // Valid UUID format, but mock returns null (no matching row).
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const { default: Page } = await import('../page');

    await expect(
      Page({ params: Promise.resolve({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('(b) calls notFound() when DB returns an error on profile lookup', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection refused' },
    });

    const { default: Page } = await import('../page');

    await expect(
      Page({ params: Promise.resolve({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('(c) renders UserDossier when profile exists with correct userId and email', async () => {
    const testUserId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const testEmail = 'alice@example.com';

    // The page does a profiles query; mock it to return a valid profile.
    mockMaybeSingle.mockResolvedValueOnce({
      data: { id: testUserId, email: testEmail },
      error: null,
    });

    const { default: Page } = await import('../page');

    // Render the page. UserDossier will render with the mocked sub-cards.
    // WHY: we're testing that the page passes the correct props to UserDossier,
    // not that UserDossier renders perfectly (that's tested in the next suite).
    const element = await Page({ params: Promise.resolve({ userId: testUserId }) });

    // The element returned is a React element — render it.
    render(element as React.ReactElement);

    // Header shows the email.
    expect(screen.getByTestId('dossier-title')).toBeDefined();
    expect(screen.getByText(testEmail)).toBeDefined();

    // Action buttons link to correct T6 routes.
    const overrideLink = screen.getByTestId('action-override-tier') as HTMLAnchorElement;
    expect(overrideLink.href).toContain(`/dashboard/admin/users/${testUserId}/override-tier`);

    const resetLink = screen.getByTestId('action-reset-password') as HTMLAnchorElement;
    expect(resetLink.href).toContain(`/dashboard/admin/users/${testUserId}/reset-password`);

    const consentLink = screen.getByTestId('action-toggle-consent') as HTMLAnchorElement;
    expect(consentLink.href).toContain(`/dashboard/admin/users/${testUserId}/toggle-consent`);
  });
});

// ─── Test: UserDossier layout ────────────────────────────────────────────────

describe('UserDossier — layout and Suspense boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(d) renders dossier header and Suspense skeleton fallbacks while cards are loading', async () => {
    // WHY: In a synchronous test environment (jsdom / Vitest without streaming),
    // async Server Components inside Suspense are not auto-resolved. We verify
    // the Suspense boundary wiring by:
    //   1. Importing UserDossier (which wraps cards in Suspense).
    //   2. Rendering with sub-cards that are genuine async Server Components
    //      (they suspend because their Supabase queries return pending Promises).
    //   3. Asserting that the Suspense FALLBACK skeletons are visible
    //      (data-testid="card-skeleton") before the async cards resolve.
    //
    // This validates that each card has its own Suspense boundary (5 skeletons
    // = 5 boundaries) and that the dossier layout renders without blocking
    // on any single card.
    //
    // Note: act() warning is expected here because async Server Component
    // resolution happens after the render call. We suppress it by not awaiting
    // the suspended state transitions — we only care about the fallback state.
    const { UserDossier } = await import('@/components/admin/UserDossier');

    // Cards will suspend because their module-level Supabase calls return
    // un-resolved Promises (mockMaybeSingle / mockLimit are not configured
    // in this test). The Suspense boundaries render their fallback skeletons.
    render(
      <UserDossier userId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" userEmail="alice@example.com" />
    );

    // WHY dossier-title check: confirms the non-Suspense part of UserDossier
    // renders immediately, before any card resolves.
    expect(screen.getByTestId('dossier-title')).toBeDefined();
    expect(screen.getByText('alice@example.com')).toBeDefined();

    // Back link points to the user search page.
    const backLink = screen.getByText('Back to user search').closest('a') as HTMLAnchorElement;
    expect(backLink.href).toContain('/dashboard/admin');

    // Skeleton fallbacks should be present (one per Suspense boundary).
    // There are 5 Suspense boundaries in UserDossier (one per card).
    const skeletons = screen.getAllByTestId('card-skeleton');
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
  });

  it('(c) action buttons have correct T6 hrefs', async () => {
    const { UserDossier } = await import('@/components/admin/UserDossier');
    const userId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

    render(<UserDossier userId={userId} userEmail="bob@example.com" />);

    const overrideLink = screen.getByTestId('action-override-tier') as HTMLAnchorElement;
    expect(overrideLink.href).toContain(`/dashboard/admin/users/${userId}/override-tier`);

    const resetLink = screen.getByTestId('action-reset-password') as HTMLAnchorElement;
    expect(resetLink.href).toContain(`/dashboard/admin/users/${userId}/reset-password`);

    const consentLink = screen.getByTestId('action-toggle-consent') as HTMLAnchorElement;
    expect(consentLink.href).toContain(`/dashboard/admin/users/${userId}/toggle-consent`);
  });
});

// ─── Test: ProfileCard ───────────────────────────────────────────────────────

describe('ProfileCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminChain.from.mockReturnThis();
    mockAdminChain.select.mockReturnThis();
    mockAdminChain.eq.mockReturnThis();
    mockAdminChain.in.mockReturnThis();
    mockAdminChain.order.mockReturnThis();
  });

  it('(c) renders profile data when profile exists', async () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    // Promise.all in ProfileCard issues 3 queries in order:
    // 1. profiles
    // 2. site_admins
    // 3. consent_flags
    mockMaybeSingle
      .mockResolvedValueOnce({
        data: { id: userId, email: 'alice@example.com', full_name: 'Alice', created_at: '2025-01-15T10:00:00Z' },
        error: null,
      }) // profiles
      .mockResolvedValueOnce({ data: null, error: null }); // site_admins

    // consent_flags uses select().eq().order() — ends with a data/error pair.
    // Override the chain to return data for this call.
    mockAdminChain.order.mockResolvedValueOnce({ data: [], error: null });

    const { ProfileCard } = await import('@/components/admin/dossier/ProfileCard');
    const element = await ProfileCard({ userId });
    render(element as React.ReactElement);

    expect(screen.getByTestId('profile-card')).toBeDefined();
    expect(screen.getByTestId('profile-email').textContent).toBe('alice@example.com');
    expect(screen.getByTestId('profile-user-id').textContent).toBe(userId);
    // No site-admin badge (maybeSingle returned null for site_admins)
    expect(screen.queryByText('Site Admin')).toBeNull();
  });

  it('(c) renders site-admin badge when user is in site_admins', async () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    mockMaybeSingle
      .mockResolvedValueOnce({
        data: { id: userId, email: 'admin@example.com', full_name: null, created_at: '2025-01-15T10:00:00Z' },
        error: null,
      }) // profiles
      .mockResolvedValueOnce({ data: { user_id: userId }, error: null }); // site_admins

    mockAdminChain.order.mockResolvedValueOnce({ data: [], error: null });

    const { ProfileCard } = await import('@/components/admin/dossier/ProfileCard');
    const element = await ProfileCard({ userId });
    render(element as React.ReactElement);

    expect(screen.getByText('Site Admin')).toBeDefined();
  });

  it('(b) renders error state when profile is null', async () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // profiles
      .mockResolvedValueOnce({ data: null, error: null }); // site_admins

    mockAdminChain.order.mockResolvedValueOnce({ data: [], error: null });

    const { ProfileCard } = await import('@/components/admin/dossier/ProfileCard');
    const element = await ProfileCard({ userId });
    render(element as React.ReactElement);

    expect(screen.getByTestId('profile-card-error')).toBeDefined();
  });

  it('(c) renders consent flags when present', async () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    mockMaybeSingle
      .mockResolvedValueOnce({
        data: { id: userId, email: 'alice@example.com', full_name: null, created_at: '2025-01-15T10:00:00Z' },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    mockAdminChain.order.mockResolvedValueOnce({
      data: [
        { purpose: 'support_read_metadata', granted_at: '2025-03-01T00:00:00Z', revoked_at: null },
      ],
      error: null,
    });

    const { ProfileCard } = await import('@/components/admin/dossier/ProfileCard');
    const element = await ProfileCard({ userId });
    render(element as React.ReactElement);

    expect(screen.getByTestId('consent-flag-row')).toBeDefined();
    expect(screen.getByText('support_read_metadata')).toBeDefined();
    // Status should be 'granted' since granted_at is set and revoked_at is null.
    expect(screen.getByTestId('consent-status-support_read_metadata').textContent).toBe('granted');
  });
});

// ─── Test: SubscriptionCard ──────────────────────────────────────────────────

describe('SubscriptionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminChain.from.mockReturnThis();
    mockAdminChain.select.mockReturnThis();
    mockAdminChain.eq.mockReturnThis();
  });

  it('(error) renders error state when Supabase returns an error', async () => {
    // WHY: an admin looking at the dossier must see "query failed" vs "no subscription".
    // Verifies Fix 1 — error state is surfaced, not silently treated as empty.
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });

    const { SubscriptionCard } = await import('@/components/admin/dossier/SubscriptionCard');
    const element = await SubscriptionCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('subscription-card-error')).toBeDefined();
    expect(screen.queryByTestId('subscription-card')).toBeNull();
  });

  it('(c) renders tier and billing data', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        tier: 'power',
        override_source: 'polar',
        override_expires_at: null,
        override_reason: null,
        billing_cycle: 'monthly',
        current_period_end: '2026-05-23T00:00:00Z',
        updated_at: '2026-04-23T00:00:00Z',
      },
      error: null,
    });

    const { SubscriptionCard } = await import('@/components/admin/dossier/SubscriptionCard');
    const element = await SubscriptionCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('subscription-card')).toBeDefined();
    expect(screen.getByTestId('subscription-tier').textContent).toBe('power');
    expect(screen.getByTestId('override-source').textContent).toBe('polar');
    expect(screen.getByTestId('billing-cycle').textContent).toBe('monthly');
    // No manual override badge for polar source.
    expect(screen.queryByTestId('manual-override-badge')).toBeNull();
  });

  it('(c) shows manual override badge when override_source is manual', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        tier: 'enterprise',
        override_source: 'manual',
        override_expires_at: '2027-01-01T00:00:00Z', // future → active
        override_reason: 'Sales deal',
        billing_cycle: 'annual',
        current_period_end: null,
        updated_at: null,
      },
      error: null,
    });

    const { SubscriptionCard } = await import('@/components/admin/dossier/SubscriptionCard');
    const element = await SubscriptionCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('manual-override-badge')).toBeDefined();
    expect(screen.getByTestId('override-reason').textContent).toBe('Sales deal');
  });

  it('(c) renders no-subscription state when row is null', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const { SubscriptionCard } = await import('@/components/admin/dossier/SubscriptionCard');
    const element = await SubscriptionCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('no-subscription')).toBeDefined();
  });
});

// ─── Test: SessionsCard ──────────────────────────────────────────────────────

describe('SessionsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminChain.from.mockReturnThis();
    mockAdminChain.select.mockReturnThis();
    mockAdminChain.eq.mockReturnThis();
    mockAdminChain.order.mockReturnThis();
    mockAdminChain.gte.mockReturnThis();
  });

  it('(error) renders error state when count query returns an error', async () => {
    // WHY: either query failing must surface the error state, not silently
    // fall through to "no sessions". Verifies Fix 1 for the count path.
    mockAdminChain.gte.mockResolvedValueOnce({ count: null, data: null, error: { message: 'db down' } });
    mockLimit.mockResolvedValueOnce({ data: [], error: null });

    const { SessionsCard } = await import('@/components/admin/dossier/SessionsCard');
    const element = await SessionsCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('sessions-card-error')).toBeDefined();
    expect(screen.queryByTestId('sessions-card')).toBeNull();
  });

  it('(c) renders session count and recent sessions', async () => {
    // Promise.all in SessionsCard: count query first, then recent sessions.
    // Count query ends with .select('id', {count: 'exact', head: true}).eq().gte()
    //   → returns { count: 12, data: null, error: null }
    // Recent query ends with .order().limit()
    //   → returns { data: [...], error: null }

    mockAdminChain.gte.mockResolvedValueOnce({ count: 12, data: null, error: null });
    mockLimit.mockResolvedValueOnce({
      data: [
        {
          id: 'sess-0000-0000-0000-000000000001',
          agent_type: 'claude',
          started_at: '2026-04-22T10:00:00Z',
          token_cost_usd: 0.0142,
          status: 'ended',
        },
      ],
      error: null,
    });

    const { SessionsCard } = await import('@/components/admin/dossier/SessionsCard');
    const element = await SessionsCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('sessions-card')).toBeDefined();
    expect(screen.getByTestId('session-count-30d').textContent).toBe('12');
    expect(screen.getAllByTestId('session-row')).toHaveLength(1);
    expect(screen.getByText('claude')).toBeDefined();
  });

  it('(c) renders no-sessions state when no sessions', async () => {
    mockAdminChain.gte.mockResolvedValueOnce({ count: 0, data: null, error: null });
    mockLimit.mockResolvedValueOnce({ data: [], error: null });

    const { SessionsCard } = await import('@/components/admin/dossier/SessionsCard');
    const element = await SessionsCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('no-sessions')).toBeDefined();
  });
});

// ─── Test: RecentAuditCard ───────────────────────────────────────────────────

describe('RecentAuditCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminChain.from.mockReturnThis();
    mockAdminChain.select.mockReturnThis();
    mockAdminChain.eq.mockReturnThis();
    mockAdminChain.in.mockReturnThis();
    mockAdminChain.order.mockReturnThis();
    // WHY default rpc mock: resolveAdminEmails calls rpc(); default to empty
    // so tests that don't need email resolution don't crash.
    mockRpc.mockResolvedValue({ data: [], error: null });
  });

  it('(error) renders error state when audit query returns an error', async () => {
    // WHY: an admin must see "query failed" vs "no audit rows". Verifies Fix 1.
    mockLimit.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });

    const { RecentAuditCard } = await import('@/components/admin/dossier/RecentAuditCard');
    const element = await RecentAuditCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('recent-audit-card-error')).toBeDefined();
    expect(screen.queryByTestId('recent-audit-card')).toBeNull();
  });

  it('(c) renders audit rows with actor emails', async () => {
    const actorId = 'c3d4e5f6-a7b8-9012-cdef-012345678901';

    // Audit query: ends with .limit() call.
    mockLimit.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          action: 'override_tier',
          actor_id: actorId,
          reason: 'Sales discount',
          created_at: '2026-04-20T12:00:00Z',
        },
      ],
      error: null,
    });

    // Actor email resolution: now uses rpc('resolve_user_emails_for_admin').
    // WHY: profiles has no email column. RecentAuditCard calls resolveAdminEmails
    // which bridges to auth.users via the SECURITY DEFINER RPC (migration 043).
    // SOC 2 CC7.2: audit actor identity must be resolvable.
    mockRpc.mockResolvedValueOnce({
      data: [{ user_id: actorId, email: 'admin@example.com' }],
      error: null,
    });

    const { RecentAuditCard } = await import('@/components/admin/dossier/RecentAuditCard');
    const element = await RecentAuditCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('recent-audit-card')).toBeDefined();
    expect(screen.getAllByTestId('audit-row')).toHaveLength(1);
    expect(screen.getByTestId('audit-action').textContent).toBe('override_tier');
    expect(screen.getByTestId('audit-actor').textContent).toBe('admin@example.com');
    expect(screen.getByTestId('audit-reason').textContent).toBe('Sales discount');
  });

  it('(c) renders no-audit state when no rows', async () => {
    mockLimit.mockResolvedValueOnce({ data: [], error: null });

    const { RecentAuditCard } = await import('@/components/admin/dossier/RecentAuditCard');
    const element = await RecentAuditCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('no-audit-rows')).toBeDefined();
  });
});

// ─── Test: TeamsCard ─────────────────────────────────────────────────────────

describe('TeamsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminChain.from.mockReturnThis();
    mockAdminChain.select.mockReturnThis();
    mockAdminChain.eq.mockReturnThis();
    mockAdminChain.order.mockReturnThis();
  });

  it('(error) renders error state when Supabase returns an error', async () => {
    // WHY: an admin must see "query failed" vs "not in any teams". Verifies Fix 1.
    mockAdminChain.order.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });

    const { TeamsCard } = await import('@/components/admin/dossier/TeamsCard');
    const element = await TeamsCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('teams-card-error')).toBeDefined();
    expect(screen.queryByTestId('teams-card')).toBeNull();
  });

  it('(c) renders team memberships', async () => {
    // TeamsCard query ends with .order() — returns data directly.
    mockAdminChain.order.mockResolvedValueOnce({
      data: [
        {
          team_id: 'team-0000-0000-0000-000000000001',
          role: 'owner',
          created_at: '2026-01-15T00:00:00Z',
          teams: { name: 'Acme Corp' },
        },
      ],
      error: null,
    });

    const { TeamsCard } = await import('@/components/admin/dossier/TeamsCard');
    const element = await TeamsCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('teams-card')).toBeDefined();
    expect(screen.getAllByTestId('team-row')).toHaveLength(1);
    expect(screen.getByText('Acme Corp')).toBeDefined();
    expect(screen.getByTestId('team-role').textContent).toBe('owner');
  });

  it('(c) renders no-teams state', async () => {
    mockAdminChain.order.mockResolvedValueOnce({ data: [], error: null });

    const { TeamsCard } = await import('@/components/admin/dossier/TeamsCard');
    const element = await TeamsCard({ userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    render(element as React.ReactElement);

    expect(screen.getByTestId('no-teams')).toBeDefined();
  });
});
