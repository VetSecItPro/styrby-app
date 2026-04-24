/**
 * Tests for SessionPrivacyBanner — session detail support access warning banner.
 *
 * Phase 4.2 — Support Tooling T7
 *
 * Coverage:
 *   (a) No active grants → renders null (banner absent from DOM)
 *   (b) One active grant → renders with correct view count + expiry
 *   (c) Multiple active grants → shows the one with latest expires_at
 *   (d) Revoke button is present and bound to the correct grant ID + session ID
 *   (e) a11y: role="region" + aria-label present on the banner wrapper
 *   (f) Unauthenticated user (getUser returns null) → renders null
 *   (g) DB error on grant query → renders null (graceful degradation)
 *
 * Testing strategy:
 *   SessionPrivacyBanner is an async Server Component. We test it by:
 *     1. Mocking @/lib/supabase/server createClient with controlled Supabase stubs.
 *     2. Mocking @/app/support/access/[grantId]/actions (revokeAction stub).
 *     3. Calling the component function directly (async fn → JSX).
 *     4. Rendering the result with @testing-library/react.
 *
 * WHY this approach: direct invocation + React render is the established pattern
 * in this codebase (see page.test.tsx in T5). It avoids needing a full Next.js
 * server render context for unit-level assertions.
 *
 * SOC 2 CC7.2: banner visibility ensures users are always aware of active
 * support access windows. Tests confirm correct rendering of access_count and
 * expires_at so users can make an informed revocation decision.
 *
 * @module __tests__/SessionPrivacyBanner
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

/**
 * Mock revokeAction as a simple async stub.
 * WHY: We test that the bound action is wired to the form — not the action's
 * internal logic (that is covered in actions.test.ts). Using a stub prevents
 * real Supabase mutations during render tests.
 *
 * We expose `mockRevokeAction` so tests can inspect `.bind()` call behavior.
 */
const mockRevokeAction = vi.fn(async () => ({ ok: true as const }));
// Simulate Function.prototype.bind — returns a new function tagged with the args
// so we can assert which grantId + sessionId were bound.
// WHY `as unknown as typeof mockRevokeAction.bind`: TypeScript's Function.prototype.bind
// overloads are too strict to accept our custom spy here. We cast through unknown to
// attach the tracking spy without changing the runtime behaviour.
(mockRevokeAction as unknown as { bind: ReturnType<typeof vi.fn> }).bind = vi.fn(
  (_thisArg: unknown, grantId: number, sessionId?: string) => {
    const bound = vi.fn(async () => ({ ok: true as const }));
    (bound as unknown as { _boundGrantId: number })._boundGrantId = grantId;
    (bound as unknown as { _boundSessionId?: string })._boundSessionId = sessionId;
    return bound;
  },
);

vi.mock('@/app/support/access/[grantId]/actions', () => ({
  revokeAction: mockRevokeAction,
}));

// ─── Supabase mock ────────────────────────────────────────────────────────────

/**
 * Supabase mock that supports chained query builder methods.
 *
 * WHY order returns `this`: the query chain in SessionPrivacyBanner is:
 *   .from().select().eq().eq().in().gt().order()
 * Each method must return `this` (the same mock object) until the final
 * `.order()` call which resolves the promise with `{ data, error }`.
 */
let mockGrantsResult: { data: unknown[] | null; error: unknown } = {
  data: [],
  error: null,
};

// Capture the final order() call which resolves the chain
const mockOrder = vi.fn(() => mockGrantsResult);
const mockGt = vi.fn(() => ({ order: mockOrder }));
const mockIn = vi.fn(() => ({ gt: mockGt }));
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockGetUser = vi.fn();

// eq() can be chained multiple times — each call returns an object with the
// next builder method needed by the chain.
// Chain shape: .eq(session_id).eq(user_id).in().gt().order()
mockEq
  .mockReturnValueOnce({ eq: mockEq }) // first .eq('session_id', ...)
  .mockReturnValue({ in: mockIn });     // second .eq('user_id', ...)

mockSelect.mockReturnValue({ eq: mockEq });
mockFrom.mockReturnValue({ select: mockSelect });

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SESSION_ID = 'session-uuid-abc-123';
const USER_ID = 'user-uuid-xyz-456';

/** Future ISO timestamp — 24 hours from now. */
function futureIso(offsetMs = 24 * 60 * 60 * 1000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Build a mock active grant row matching the query select fields.
 */
function makeGrant(overrides: Partial<{
  id: number;
  granted_by: string;
  access_count: number;
  max_access_count: number | null;
  expires_at: string;
  approved_at: string | null;
  status: string;
}> = {}) {
  return {
    id: 1001,
    granted_by: 'admin@styrby.io',
    access_count: 3,
    max_access_count: 10,
    expires_at: futureIso(),
    approved_at: new Date().toISOString(),
    status: 'approved',
    ...overrides,
  };
}

/**
 * Renders SessionPrivacyBanner by calling it as an async function and rendering
 * the returned JSX. This is the standard Server Component test pattern.
 */
async function renderBanner(sessionId = SESSION_ID) {
  // Dynamic import AFTER mocks are set up so vi.mock() takes effect.
  const { SessionPrivacyBanner } = await import('../SessionPrivacyBanner');
  const jsx = await SessionPrivacyBanner({ sessionId });
  if (!jsx) return { container: null };
  const { container } = render(jsx as React.ReactElement);
  return { container };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionPrivacyBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset the chain mocks for each test
    mockEq.mockReset();
    mockEq
      .mockReturnValueOnce({ eq: mockEq })
      .mockReturnValue({ in: mockIn });

    mockSelect.mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ select: mockSelect });
    mockIn.mockReturnValue({ gt: mockGt });
    mockGt.mockReturnValue({ order: mockOrder });

    // Default: authenticated user
    mockGetUser.mockResolvedValue({
      data: { user: { id: USER_ID } },
      error: null,
    });

    // Default: no active grants
    mockGrantsResult = { data: [], error: null };
    mockOrder.mockReturnValue(mockGrantsResult);
  });

  // ── (a) No active grants → null ─────────────────────────────────────────────

  describe('when no active grants exist', () => {
    it('renders nothing (returns null) when grants array is empty', async () => {
      mockGrantsResult = { data: [], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      const { container } = await renderBanner();

      expect(container).toBeNull();
    });

    it('renders nothing when grants is null (unexpected Supabase response)', async () => {
      mockGrantsResult = { data: null, error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      const { container } = await renderBanner();

      expect(container).toBeNull();
    });
  });

  // ── (b) One active grant → renders correctly ─────────────────────────────────

  describe('when one active grant exists', () => {
    it('renders the warning banner with role and aria-label', async () => {
      const grant = makeGrant({ access_count: 3, max_access_count: 10 });
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      const region = screen.getByRole('region', { name: /support access notice/i });
      expect(region).toBeInTheDocument();
    });

    it('renders the warning headline text', async () => {
      const grant = makeGrant();
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      expect(
        screen.getByText(/support has active read access to this session/i),
      ).toBeInTheDocument();
    });

    it('renders the viewed count with max_access_count', async () => {
      const grant = makeGrant({ access_count: 4, max_access_count: 10 });
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      expect(screen.getByText(/viewed 4 of 10 times allowed/i)).toBeInTheDocument();
    });

    it('renders the viewed count without max_access_count (unlimited)', async () => {
      const grant = makeGrant({ access_count: 2, max_access_count: null });
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      expect(screen.getByText(/viewed 2 times/i)).toBeInTheDocument();
    });

    it('renders "1 time" (singular) when access_count is 1', async () => {
      const grant = makeGrant({ access_count: 1, max_access_count: null });
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      // "Viewed 1 time." (singular, not "1 times")
      expect(screen.getByText(/viewed 1 time\./i)).toBeInTheDocument();
    });

    it('renders the expiry date text', async () => {
      const grant = makeGrant({ expires_at: futureIso() });
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      // The expiry line starts with "Expires"
      expect(screen.getByText(/expires/i)).toBeInTheDocument();
    });

    it('renders the revoke button with correct label', async () => {
      const grant = makeGrant();
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      const button = screen.getByRole('button', { name: /revoke support access/i });
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('type', 'submit');
    });
  });

  // ── (c) Multiple active grants → shows latest expiry ─────────────────────────

  describe('when multiple active grants exist', () => {
    it('shows only the grant with the latest expires_at (first in DESC-ordered result)', async () => {
      // The query orders by expires_at DESC — first element = latest expiry.
      const latestGrant = makeGrant({
        id: 2001,
        access_count: 7,
        max_access_count: 20,
        expires_at: futureIso(48 * 60 * 60 * 1000), // 48 hours from now
      });
      const earlierGrant = makeGrant({
        id: 2002,
        access_count: 1,
        max_access_count: 5,
        expires_at: futureIso(12 * 60 * 60 * 1000), // 12 hours from now
      });

      // Order: latest first (as Supabase would return with `order('expires_at', { ascending: false })`)
      mockGrantsResult = { data: [latestGrant, earlierGrant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      // Should show latestGrant's access_count (7 of 20) — not earlierGrant's (1 of 5)
      expect(screen.getByText(/viewed 7 of 20 times allowed/i)).toBeInTheDocument();
      expect(screen.queryByText(/viewed 1 of 5 times allowed/i)).not.toBeInTheDocument();
    });
  });

  // ── (d) Revoke button has correct form action binding ─────────────────────────

  describe('revoke action binding', () => {
    it('calls revokeAction.bind with the correct grantId and sessionId', async () => {
      const grant = makeGrant({ id: 9999 });
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner(SESSION_ID);

      // revokeAction.bind should have been called with (null, 9999, SESSION_ID)
      const bindSpy = (mockRevokeAction as unknown as { bind: ReturnType<typeof vi.fn> }).bind;
      expect(bindSpy).toHaveBeenCalledWith(null, 9999, SESSION_ID);
    });

    it('renders the revoke button inside a form element', async () => {
      const grant = makeGrant();
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      const button = screen.getByTestId('revoke-support-access-button');
      // The button's closest form ancestor should exist
      expect(button.closest('form')).not.toBeNull();
    });
  });

  // ── (e) a11y attributes ───────────────────────────────────────────────────────

  describe('accessibility', () => {
    it('banner wrapper has role="region"', async () => {
      const grant = makeGrant();
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      expect(screen.getByRole('region')).toBeInTheDocument();
    });

    it('banner wrapper has aria-label="Support access notice"', async () => {
      const grant = makeGrant();
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      const region = screen.getByRole('region');
      expect(region).toHaveAttribute('aria-label', 'Support access notice');
    });

    it('revoke button has descriptive aria-label', async () => {
      const grant = makeGrant();
      mockGrantsResult = { data: [grant], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      await renderBanner();

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute(
        'aria-label',
        'Revoke support access to this session',
      );
    });
  });

  // ── (f) Unauthenticated user → null ──────────────────────────────────────────

  describe('when user is not authenticated', () => {
    it('renders nothing when getUser returns null user', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: null,
      });
      mockGrantsResult = { data: [makeGrant()], error: null };
      mockOrder.mockReturnValue(mockGrantsResult);

      const { container } = await renderBanner();

      expect(container).toBeNull();
    });
  });

  // ── (g) DB error → graceful null ─────────────────────────────────────────────

  describe('when the grants query returns an error', () => {
    it('renders nothing (graceful degradation) when Supabase returns an error', async () => {
      mockGrantsResult = {
        data: null,
        error: { code: 'PGRST301', message: 'Row level security violation' },
      };
      mockOrder.mockReturnValue(mockGrantsResult);

      const { container } = await renderBanner();

      // Banner must not appear — the session page remains fully functional
      expect(container).toBeNull();
    });
  });
});
