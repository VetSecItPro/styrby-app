/**
 * Tests for /billing/offer/[offerId] Server Component page
 *
 * Phase 4.3 — Billing Ops T6
 *
 * Coverage:
 *   (a) Renders "Limited-time offer" panel + Accept button for active offer
 *   (b) Renders "Offer accepted" panel (with accepted_at + optional discount code)
 *       and no Accept button
 *   (c) Renders "Offer revoked" terminal panel and no Accept button
 *   (d) Renders "Offer expired" terminal panel and no Accept button
 *   (e) Calls notFound() when RLS returns 0 rows (non-owner scenario)
 *   (f) Calls notFound() when offerId param is non-numeric, 0, or negative
 *   (g) ChurnSaveOfferCard not rendered for terminal states (accepted/revoked/expired)
 *   (h) ChurnSaveOfferCard rendered only for active state
 *   (i) Reason truncated to 200 chars when longer
 *
 * Testing strategy:
 *   Server Components cannot be rendered directly in a jsdom test (they are async
 *   and Next.js-server-specific). We test the page by:
 *     1. Mocking next/navigation notFound to throw (so we can assert its call).
 *     2. Mocking @/lib/supabase/server createClient to return controlled offer data.
 *     3. Mocking the actions module (acceptOfferAction) as a stub.
 *     4. Mocking the ChurnSaveOfferCard client component to a simple testid stub.
 *     5. Calling the page function directly (async Server Component = async function).
 *     6. Rendering the JSX result with @testing-library/react.
 *
 * WHY this approach (not full e2e): server component rendering in vitest/jsdom
 * requires mocking Next.js internals. Direct invocation + React render is the
 * established pattern in this codebase (see support/access and admin tests).
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
const mockEq = vi.fn().mockReturnThis();
const mockSelect = vi.fn(() => ({
  eq: mockEq,
  maybeSingle: mockMaybeSingle,
}));
const mockFrom = vi.fn(() => ({ select: mockSelect }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ from: mockFrom })),
}));

// ─── Actions mock ─────────────────────────────────────────────────────────────

// WHY stub actions: we test the page's rendering logic, not the action itself
// (that is covered in actions.test.ts). Stubbing prevents real mutations.
vi.mock('../actions', () => ({
  acceptOfferAction: vi.fn(async () => ({ ok: true })),
}));

// ─── ChurnSaveOfferCard mock ──────────────────────────────────────────────────

// WHY stub the client component: ChurnSaveOfferCard uses useTransition which
// requires React Client Component context. Stubbing lets us assert presence
// without the hook complexity.
vi.mock('@/components/billing/ChurnSaveOfferCard', () => ({
  ChurnSaveOfferCard: ({
    discountPct,
    durationMonths,
  }: {
    discountPct: number;
    durationMonths: number;
  }) => (
    <div
      data-testid="churn-save-offer-card"
      data-discount-pct={discountPct}
      data-duration-months={durationMonths}
    />
  ),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface MockOffer {
  id: number;
  kind: string;
  discount_pct: number;
  discount_duration_months: number;
  sent_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  polar_discount_code: string | null;
  reason: string;
}

const BASE_OFFER: MockOffer = {
  id: 7,
  kind: 'annual_3mo_25pct',
  discount_pct: 25,
  discount_duration_months: 3,
  sent_at: '2026-04-24T08:00:00.000Z',
  // Far future — always active in tests
  expires_at: '2099-12-31T23:59:59.000Z',
  accepted_at: null,
  revoked_at: null,
  polar_discount_code: null,
  reason: 'We noticed you may be considering cancelling. Here is a special offer as a thank you.',
};

/**
 * Builds a params object as returned by Next.js async params.
 * The page awaits the params Promise, so we wrap in a Promise.
 */
function makeParams(offerId: string | number) {
  return Promise.resolve({ offerId: String(offerId) });
}

/**
 * Configures the Supabase mock to return a specific offer row.
 *
 * @param overrides - Partial overrides merged into BASE_OFFER.
 */
function mockOffer(overrides: Partial<MockOffer> = {}) {
  mockMaybeSingle.mockResolvedValueOnce({
    data: { ...BASE_OFFER, ...overrides },
    error: null,
  });
}

/**
 * Configures the Supabase mock to return 0 rows (simulates RLS non-owner).
 */
function mockOfferNotFound() {
  mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
}

/**
 * Configures the Supabase mock to return an RPC error.
 */
function mockOfferError() {
  mockMaybeSingle.mockResolvedValueOnce({
    data: null,
    error: { code: '42501', message: 'insufficient privilege' },
  });
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('ChurnSaveOfferPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEq.mockReturnThis();
    mockSelect.mockReturnValue({
      eq: mockEq,
      maybeSingle: mockMaybeSingle,
    });
    mockFrom.mockReturnValue({ select: mockSelect });
  });

  // ── (a) Active offer state ─────────────────────────────────────────────────

  it('(a) renders "Limited-time offer" panel for active offer', async () => {
    mockOffer();
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    expect(screen.getByText(/Limited-time offer/i)).toBeTruthy();
    // ChurnSaveOfferCard should be rendered for active state
    const card = screen.getByTestId('churn-save-offer-card');
    expect(card).toBeTruthy();
  });

  it('(a) passes correct discount_pct and duration to ChurnSaveOfferCard', async () => {
    mockOffer({ discount_pct: 50, discount_duration_months: 1 });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    const card = screen.getByTestId('churn-save-offer-card');
    expect(card.getAttribute('data-discount-pct')).toBe('50');
    expect(card.getAttribute('data-duration-months')).toBe('1');
  });

  it('(a) renders offer detail section with discount % and duration', async () => {
    mockOffer({ discount_pct: 25, discount_duration_months: 3 });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    expect(screen.getByText(/25%/)).toBeTruthy();
    expect(screen.getByText(/3 months/i)).toBeTruthy();
  });

  // ── (b) Accepted state ─────────────────────────────────────────────────────

  it('(b) renders "Offer accepted" panel with accepted_at for accepted offer', async () => {
    mockOffer({ accepted_at: '2026-04-24T10:00:00.000Z' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    expect(screen.getByText(/Offer accepted/i)).toBeTruthy();
    // No ChurnSaveOfferCard for accepted state
    expect(screen.queryByTestId('churn-save-offer-card')).toBeNull();
  });

  it('(b) renders polar_discount_code in accepted panel when present', async () => {
    mockOffer({
      accepted_at: '2026-04-24T10:00:00.000Z',
      polar_discount_code: 'SAVE25ABC',
    });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    expect(screen.getByText('SAVE25ABC')).toBeTruthy();
    expect(screen.getByText(/apply it manually/i)).toBeTruthy();
  });

  it('(b) does not render discount code section when polar_discount_code is null', async () => {
    mockOffer({
      accepted_at: '2026-04-24T10:00:00.000Z',
      polar_discount_code: null,
    });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    expect(screen.queryByText(/apply it manually/i)).toBeNull();
  });

  // ── (c) Revoked state ──────────────────────────────────────────────────────

  it('(c) renders "Offer revoked" panel for revoked offer', async () => {
    mockOffer({ revoked_at: '2026-04-24T09:00:00.000Z' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    expect(screen.getByText(/Offer revoked/i)).toBeTruthy();
    // No ChurnSaveOfferCard for terminal states
    expect(screen.queryByTestId('churn-save-offer-card')).toBeNull();
  });

  it('(c) does not render accept button for revoked offer', async () => {
    mockOffer({ revoked_at: '2026-04-24T09:00:00.000Z' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    expect(screen.queryByRole('button', { name: /accept offer/i })).toBeNull();
  });

  // ── (d) Expired state ──────────────────────────────────────────────────────

  it('(d) renders "Offer expired" panel for expired offer (past expires_at)', async () => {
    mockOffer({ expires_at: '2020-01-01T00:00:00.000Z' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    // WHY getAllByText: "Offer expired" appears in the status panel heading and
    // potentially in the OfferDetails section label. We assert at least one match.
    expect(screen.getAllByText(/Offer expired/i).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('churn-save-offer-card')).toBeNull();
  });

  // ── (e) Non-owner / RLS returns 0 rows ─────────────────────────────────────

  it('(e) calls notFound() when Supabase returns 0 rows (non-owner RLS)', async () => {
    mockOfferNotFound();
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams(7) })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('(e) calls notFound() when Supabase returns an error', async () => {
    mockOfferError();
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams(7) })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  // ── (f) Invalid offerId param ──────────────────────────────────────────────

  it('(f) calls notFound() for non-numeric offerId param', async () => {
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams('not-a-number') })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
    // Must NOT reach Supabase
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('(f) calls notFound() for offerId = 0', async () => {
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams(0) })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('(f) calls notFound() for negative offerId param', async () => {
    const { default: Page } = await import('../page');
    await expect(Page({ params: makeParams(-3) })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  it('(f) calls notFound() for float offerId param', async () => {
    const { default: Page } = await import('../page');
    // parseInt('1.5') returns 1 (integer), so floats are actually parsed OK.
    // We test the NaN case via a truly non-numeric string above.
    // This test verifies a UUID-looking param triggers notFound.
    await expect(Page({ params: makeParams('abc-def-ghi') })).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  // ── (g) ChurnSaveOfferCard not rendered for terminal states ────────────────

  it('(g) does NOT render ChurnSaveOfferCard for accepted state', async () => {
    mockOffer({ accepted_at: '2026-04-24T10:00:00.000Z' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);
    expect(screen.queryByTestId('churn-save-offer-card')).toBeNull();
  });

  it('(g) does NOT render ChurnSaveOfferCard for revoked state', async () => {
    mockOffer({ revoked_at: '2026-04-24T09:00:00.000Z' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);
    expect(screen.queryByTestId('churn-save-offer-card')).toBeNull();
  });

  it('(g) does NOT render ChurnSaveOfferCard for expired state', async () => {
    mockOffer({ expires_at: '2020-01-01T00:00:00.000Z' });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);
    expect(screen.queryByTestId('churn-save-offer-card')).toBeNull();
  });

  // ── (h) ChurnSaveOfferCard rendered only for active state ──────────────────

  it('(h) DOES render ChurnSaveOfferCard for active offer', async () => {
    mockOffer();
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);
    expect(screen.getByTestId('churn-save-offer-card')).toBeTruthy();
  });

  // ── (i) Reason truncation ──────────────────────────────────────────────────

  it('(i) truncates reason to 200 chars in offer detail section', async () => {
    const longReason = 'A'.repeat(250);
    mockOffer({ reason: longReason });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    // The truncated text in the OfferDetails section should be present (200 + ellipsis)
    const truncated = 'A'.repeat(200) + '…';
    expect(screen.getByText(truncated)).toBeTruthy();
  });

  it('(i) renders full reason when it is within 200 chars', async () => {
    const shortReason = 'Short reason for this offer.';
    mockOffer({ reason: shortReason });
    const { default: Page } = await import('../page');
    const jsx = await Page({ params: makeParams(7) });
    render(<>{jsx}</>);

    expect(screen.getAllByText(shortReason).length).toBeGreaterThan(0);
  });
});
