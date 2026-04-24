/**
 * Tests for /support/access/[grantId] Server Component page
 *
 * Phase 4.2 — Support Tooling T5
 *
 * Coverage:
 *   (a) Renders "Awaiting your decision" panel + approve/deny buttons for pending grant
 *   (b) Renders "Access active" panel + revoke button for approved grant
 *   (c) Renders "Access revoked" terminal panel (no buttons) for revoked grant
 *   (d) Renders "Access cap reached" terminal panel for consumed grant
 *   (e) Renders "Access expired" terminal panel for expired grant
 *   (f) Calls notFound() when RLS returns 0 rows (non-owner scenario)
 *   (g) Calls notFound() when grantId param is non-numeric / 0
 *   (h) Raw token is NEVER displayed — token_hash is never in the select query
 *   (i) GrantApprovalCard does NOT render for terminal states (revoked/consumed/expired)
 *
 * Testing strategy:
 *   Server Components cannot be rendered directly in a jsdom test (they are async
 *   and Next.js-server-specific). We test the page by:
 *     1. Mocking next/navigation notFound to throw (so we can assert its call).
 *     2. Mocking @/lib/supabase/server createClient to return controlled grant data.
 *     3. Mocking the actions module (approveAction / revokeAction) as stubs.
 *     4. Mocking the GrantApprovalCard client component to a simple testid stub.
 *     5. Calling the page function directly (async Server Component = async function).
 *     6. Rendering the JSX result with @testing-library/react.
 *
 * WHY this approach (not full e2e): server component rendering in vitest/jsdom
 * requires mocking Next.js internals. Direct invocation + React render is the
 * established pattern in this codebase (see dashboard/admin tests).
 *
 * @module __tests__/page
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// WHY throw: notFound() in Next.js throws a special error. We replicate this
// so tests can assert `expect(fn).rejects.toThrow(/NEXT_NOT_FOUND/)`.
const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  redirect: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockMaybeSingle = vi.fn();
const mockSelect = vi.fn(() => ({
  eq: vi.fn().mockReturnThis(),
  maybeSingle: mockMaybeSingle,
}));
const mockFrom = vi.fn(() => ({ select: mockSelect }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ from: mockFrom })),
}));

// ─── Actions mock ─────────────────────────────────────────────────────────────

// WHY stub actions: we test the page's rendering logic, not the actions
// themselves (those are covered in actions.test.ts). Stubbing prevents
// real server-side mutations during page render tests.
vi.mock('../actions', () => ({
  approveAction: vi.fn(async () => ({ ok: true })),
  revokeAction: vi.fn(async () => ({ ok: true })),
}));

// ─── GrantApprovalCard mock ───────────────────────────────────────────────────

// WHY stub the client component: GrantApprovalCard uses useTransition which
// requires React Client Component context. Stubbing lets us assert it is
// rendered (or not) without the hook complexity.
vi.mock('@/components/support/GrantApprovalCard', () => ({
  GrantApprovalCard: ({ status }: { status: string }) => (
    <div data-testid="grant-approval-card" data-status={status} />
  ),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

type GrantStatus = 'pending' | 'approved' | 'revoked' | 'expired' | 'consumed';

interface MockGrant {
  id: number;
  ticket_id: string;
  session_id: string;
  status: GrantStatus;
  scope: { fields: string[] };
  expires_at: string;
  requested_at: string;
  approved_at: string | null;
  revoked_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
  max_access_count: number;
  reason: string;
  support_tickets: { subject: string } | null;
}

const BASE_GRANT: MockGrant = {
  id: 42,
  ticket_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  session_id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  status: 'pending',
  scope: { fields: ['action', 'tool', 'timestamp', 'tokens', 'status'] },
  expires_at: '2026-04-25T12:00:00.000Z',
  requested_at: '2026-04-24T10:00:00.000Z',
  approved_at: null,
  revoked_at: null,
  last_accessed_at: null,
  access_count: 0,
  max_access_count: 10,
  reason: 'User reported cost spike — investigating session tool call pattern to diagnose issue.',
  support_tickets: { subject: 'Cost spike investigation' },
};

/**
 * Builds a params object as returned by Next.js async params.
 * The page awaits the params Promise, so we wrap in a Promise.
 */
function makeParams(grantId: string | number) {
  return Promise.resolve({ grantId: String(grantId) });
}

/**
 * Configures the Supabase mock to return a specific grant row.
 *
 * @param overrides - Partial overrides merged into BASE_GRANT.
 */
function mockGrant(overrides: Partial<MockGrant> = {}) {
  mockMaybeSingle.mockResolvedValueOnce({
    data: { ...BASE_GRANT, ...overrides },
    error: null,
  });
}

/**
 * Configures the Supabase mock to return 0 rows (simulates RLS non-owner).
 */
function mockGrantNotFound() {
  mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
}

/**
 * Configures the Supabase mock to return an RPC error.
 */
function mockGrantError() {
  mockMaybeSingle.mockResolvedValueOnce({
    data: null,
    error: { code: '42501', message: 'insufficient privilege' },
  });
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('GrantApprovalPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({
      eq: vi.fn().mockReturnThis(),
      maybeSingle: mockMaybeSingle,
    });
    mockFrom.mockReturnValue({ select: mockSelect });
  });

  // ── (a) Pending state ──────────────────────────────────────────────────────

  it('(a) renders "Awaiting your decision" panel for pending grant', async () => {
    mockGrant({ status: 'pending' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);

    expect(screen.getByText(/Awaiting your decision/i)).toBeTruthy();
    // GrantApprovalCard should be rendered for pending state
    const card = screen.getByTestId('grant-approval-card');
    expect(card).toBeTruthy();
    expect(card.getAttribute('data-status')).toBe('pending');
  });

  it('(a) renders reason and ticket subject for pending grant', async () => {
    mockGrant({ status: 'pending' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);

    expect(screen.getByText('Cost spike investigation')).toBeTruthy();
    expect(screen.getByText(/User reported cost spike/)).toBeTruthy();
  });

  it('(a) renders session shortId (last 8 chars) for pending grant', async () => {
    mockGrant({ status: 'pending', session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeff001122' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);

    // The session display is the last 8 chars of the UUID: 'ff001122'
    expect(screen.getByText(/ff001122/)).toBeTruthy();
  });

  it('(a) renders scope fields as pills', async () => {
    mockGrant({ status: 'pending' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);

    // All 5 default scope fields should be visible
    expect(screen.getByText('action')).toBeTruthy();
    expect(screen.getByText('tool')).toBeTruthy();
    expect(screen.getByText('timestamp')).toBeTruthy();
    expect(screen.getByText('tokens')).toBeTruthy();
    expect(screen.getByText('status')).toBeTruthy();
  });

  // ── (b) Approved state ─────────────────────────────────────────────────────

  it('(b) renders "Access active" panel for approved grant', async () => {
    mockGrant({
      status: 'approved',
      approved_at: '2026-04-24T11:00:00.000Z',
      access_count: 3,
      max_access_count: 10,
    });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);

    expect(screen.getByText(/Access active/i)).toBeTruthy();
    // Shows access count
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    // GrantApprovalCard should be rendered for approved state
    const card = screen.getByTestId('grant-approval-card');
    expect(card.getAttribute('data-status')).toBe('approved');
  });

  // ── (c) Revoked state ──────────────────────────────────────────────────────

  it('(c) renders "Access revoked" panel for revoked grant', async () => {
    mockGrant({
      status: 'revoked',
      revoked_at: '2026-04-24T11:30:00.000Z',
    });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);

    expect(screen.getByText(/Access revoked/i)).toBeTruthy();
    // No GrantApprovalCard for terminal states
    expect(screen.queryByTestId('grant-approval-card')).toBeNull();
  });

  // ── (d) Consumed state ─────────────────────────────────────────────────────

  it('(d) renders "Access cap reached" panel for consumed grant', async () => {
    mockGrant({
      status: 'consumed',
      access_count: 10,
      last_accessed_at: '2026-04-24T12:00:00.000Z',
    });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);

    expect(screen.getByText(/Access cap reached/i)).toBeTruthy();
    // No GrantApprovalCard for terminal states
    expect(screen.queryByTestId('grant-approval-card')).toBeNull();
  });

  // ── (e) Expired state ──────────────────────────────────────────────────────

  it('(e) renders "Access expired" panel for expired grant', async () => {
    mockGrant({
      status: 'expired',
    });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);

    expect(screen.getByText(/Access expired/i)).toBeTruthy();
    // No GrantApprovalCard for terminal states
    expect(screen.queryByTestId('grant-approval-card')).toBeNull();
  });

  // ── (f) Non-owner / RLS returns 0 rows ─────────────────────────────────────

  it('(f) calls notFound() when Supabase returns 0 rows (non-owner RLS)', async () => {
    mockGrantNotFound();
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams(42) })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('(f) calls notFound() when Supabase returns an error', async () => {
    mockGrantError();
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams(42) })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  // ── (g) Invalid grantId param ──────────────────────────────────────────────

  it('(g) calls notFound() for non-numeric grantId param', async () => {
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams('not-a-number') })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
    // Must NOT reach Supabase
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('(g) calls notFound() for grantId = 0', async () => {
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams(0) })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('(g) calls notFound() for negative grantId param', async () => {
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams(-5) })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  // ── (h) Token never displayed ───────────────────────────────────────────────

  it('(h) never selects token_hash from the grant table', async () => {
    mockGrant({ status: 'pending' });
    const { default: Page } = await import('../page');
    await Page({ params: makeParams(42) });

    // Inspect the Supabase select call to verify token_hash is absent.
    // WHY: token_hash is the SHA-256 of the raw access token. It must never
    // be sent to the client — including in the rendered HTML. Verifying it is
    // excluded from the select query is the correct enforcement point.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selectArg: string = (mockSelect.mock.calls as any)[0]?.[0] ?? '';
    expect(selectArg).not.toContain('token_hash');
    // granted_by (admin UUID) is also excluded per spec §4.3.
    expect(selectArg).not.toContain('granted_by');
  });

  // ── (i) GrantApprovalCard not rendered for terminal states ─────────────────

  it('(i) does NOT render GrantApprovalCard for revoked state', async () => {
    mockGrant({ status: 'revoked', revoked_at: '2026-04-24T11:30:00.000Z' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);
    expect(screen.queryByTestId('grant-approval-card')).toBeNull();
  });

  it('(i) does NOT render GrantApprovalCard for consumed state', async () => {
    mockGrant({ status: 'consumed', access_count: 10 });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);
    expect(screen.queryByTestId('grant-approval-card')).toBeNull();
  });

  it('(i) does NOT render GrantApprovalCard for expired state', async () => {
    mockGrant({ status: 'expired' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);
    expect(screen.queryByTestId('grant-approval-card')).toBeNull();
  });

  it('(i) DOES render GrantApprovalCard for pending state', async () => {
    mockGrant({ status: 'pending' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);
    expect(screen.getByTestId('grant-approval-card')).toBeTruthy();
  });

  it('(i) DOES render GrantApprovalCard for approved state', async () => {
    mockGrant({ status: 'approved', approved_at: '2026-04-24T11:00:00.000Z' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(42) });
    render(<>{jsx}</>);
    expect(screen.getByTestId('grant-approval-card')).toBeTruthy();
  });
});
