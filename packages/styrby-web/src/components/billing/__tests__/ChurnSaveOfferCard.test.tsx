/**
 * Tests for ChurnSaveOfferCard — client component for churn-save offer acceptance.
 *
 * Phase 4.3 — Billing Ops T6
 *
 * Coverage:
 *   (a) Renders large discount display (25% or 50%)
 *   (b) Renders duration text ("3 months" or "1 month")
 *   (c) Renders reason (200-char truncated)
 *   (d) Renders expiry display
 *   (e) Accept button starts not disabled
 *   (f) Accept button shows pending state + disabled while action is in-flight
 *   (g) role="alert" on error banner when action returns an error
 *   (h) Error banner disappears on retry (cleared on next click)
 *   (i) 200-char reason truncation in component itself
 *   (j) Accept button label is "Accept offer" (not "Submit")
 *
 * Testing strategy:
 *   ChurnSaveOfferCard is a React client component. We render it directly with
 *   @testing-library/react in jsdom. The server action is mocked as a jest.fn()
 *   so we can control the resolved value.
 *
 * WHY we test the client component separately from the page:
 *   The page test stubs ChurnSaveOfferCard to avoid jsdom/hook complexity.
 *   This file covers the actual component behavior in isolation, following the
 *   same pattern as GrantApprovalCard.test.tsx in Phase 4.2.
 *
 * @module __tests__/ChurnSaveOfferCard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { ChurnSaveOfferCard } from '../ChurnSaveOfferCard';
import type { AcceptOfferActionResult } from '@/app/billing/offer/[offerId]/actions';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FAR_FUTURE_EXPIRY = '2099-12-31T23:59:59.000Z';

const BASE_PROPS = {
  offerId: 7,
  discountPct: 25,
  durationMonths: 3,
  expiresAt: FAR_FUTURE_EXPIRY,
  reason: 'We appreciate your loyalty and want to offer you a special deal.',
};

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('ChurnSaveOfferCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── (a) Discount display ───────────────────────────────────────────────────

  it('(a) renders 25% discount for annual_3mo_25pct offer', () => {
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(
      <ChurnSaveOfferCard
        {...BASE_PROPS}
        discountPct={25}
        acceptAction={mockAction}
      />
    );
    expect(screen.getByText(/25% off/i)).toBeTruthy();
  });

  it('(a) renders 50% discount for monthly_1mo_50pct offer', () => {
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(
      <ChurnSaveOfferCard
        {...BASE_PROPS}
        discountPct={50}
        durationMonths={1}
        acceptAction={mockAction}
      />
    );
    expect(screen.getByText(/50% off/i)).toBeTruthy();
  });

  // ── (b) Duration display ───────────────────────────────────────────────────

  it('(b) renders "3 months" for durationMonths=3', () => {
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(
      <ChurnSaveOfferCard {...BASE_PROPS} durationMonths={3} acceptAction={mockAction} />
    );
    expect(screen.getByText(/3 months/i)).toBeTruthy();
  });

  it('(b) renders "1 month" for durationMonths=1', () => {
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(
      <ChurnSaveOfferCard
        {...BASE_PROPS}
        durationMonths={1}
        acceptAction={mockAction}
      />
    );
    expect(screen.getByText(/for 1 month/i)).toBeTruthy();
  });

  // ── (c) Reason display ─────────────────────────────────────────────────────

  it('(c) renders reason text', () => {
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(<ChurnSaveOfferCard {...BASE_PROPS} acceptAction={mockAction} />);
    expect(screen.getByText(BASE_PROPS.reason)).toBeTruthy();
  });

  // ── (d) Expiry display ─────────────────────────────────────────────────────

  it('(d) renders expiry information', () => {
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(
      <ChurnSaveOfferCard {...BASE_PROPS} expiresAt={FAR_FUTURE_EXPIRY} acceptAction={mockAction} />
    );
    // Should show "Expires" somewhere in the component
    expect(screen.getByText(/expires/i)).toBeTruthy();
  });

  // ── (e) Button initial state ───────────────────────────────────────────────

  it('(e) renders Accept button not disabled initially', () => {
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(<ChurnSaveOfferCard {...BASE_PROPS} acceptAction={mockAction} />);
    const button = screen.getByTestId('accept-button');
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  // ── (f) Pending state ──────────────────────────────────────────────────────

  it('(f) disables button while action is pending', async () => {
    // Use a never-resolving promise to hold the pending state
    let resolveAction!: (result: AcceptOfferActionResult) => void;
    const mockAction = vi.fn(
      () => new Promise<AcceptOfferActionResult>((resolve) => { resolveAction = resolve; })
    );

    render(<ChurnSaveOfferCard {...BASE_PROPS} acceptAction={mockAction} />);
    const button = screen.getByTestId('accept-button') as HTMLButtonElement;

    fireEvent.click(button);

    // Button should be disabled immediately after click (in transition)
    await waitFor(() => {
      expect(button.disabled).toBe(true);
    });

    // Resolve to clean up
    resolveAction({ ok: true });
  });

  it('(f) shows "Accepting..." text while action is pending', async () => {
    let resolveAction!: (result: AcceptOfferActionResult) => void;
    const mockAction = vi.fn(
      () => new Promise<AcceptOfferActionResult>((resolve) => { resolveAction = resolve; })
    );

    render(<ChurnSaveOfferCard {...BASE_PROPS} acceptAction={mockAction} />);
    const button = screen.getByTestId('accept-button');

    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/Accepting\.\.\./i)).toBeTruthy();
    });

    // WHY act() + microtask flush: resolveAction() triggers React's startTransition
    // to flip the pending state back to ready. Without act(), the test exits while
    // React is mid-transition, causing the "wrap in act()" warning intermittently
    // and a flaky "(f) was hanging on prior render" failure under CI load.
    // Awaiting a microtask after resolveAction lets React commit the resolved state.
    await act(async () => {
      resolveAction({ ok: true });
      await Promise.resolve();
    });
  });

  // ── (g) Error banner ───────────────────────────────────────────────────────

  it('(g) renders error banner with role="alert" when action returns error', async () => {
    const mockAction = vi.fn(async (): Promise<AcceptOfferActionResult> => ({
      ok: false,
      error: 'Offer is no longer available (already accepted, revoked, or expired)',
      statusCode: 400,
    }));

    render(<ChurnSaveOfferCard {...BASE_PROPS} acceptAction={mockAction} />);
    fireEvent.click(screen.getByTestId('accept-button'));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain('Offer is no longer available');
    });
  });

  it('(g) error banner has aria-live="assertive" for screen-reader announcement', async () => {
    const mockAction = vi.fn(async (): Promise<AcceptOfferActionResult> => ({
      ok: false,
      error: 'You are not authorized to accept this offer',
      statusCode: 403,
    }));

    render(<ChurnSaveOfferCard {...BASE_PROPS} acceptAction={mockAction} />);
    fireEvent.click(screen.getByTestId('accept-button'));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.getAttribute('aria-live')).toBe('assertive');
      expect(alert.getAttribute('aria-atomic')).toBe('true');
    });
  });

  // ── (h) Error cleared on retry ─────────────────────────────────────────────

  it('(h) clears error banner on second click attempt', async () => {
    let callCount = 0;
    const mockAction = vi.fn(async (): Promise<AcceptOfferActionResult> => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          error: 'Offer is no longer available (already accepted, revoked, or expired)',
          statusCode: 400,
        };
      }
      // Second call: simulate a never-resolving pending state so we can check
      // that the error was cleared before the action resolves.
      return new Promise(() => {});
    });

    render(<ChurnSaveOfferCard {...BASE_PROPS} acceptAction={mockAction} />);
    fireEvent.click(screen.getByTestId('accept-button'));

    // Wait for error to appear
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    // Click again — error should clear immediately
    fireEvent.click(screen.getByTestId('accept-button'));

    await waitFor(() => {
      // Error should be gone while the second action is in-flight
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  // ── (i) 200-char reason truncation ────────────────────────────────────────

  it('(i) truncates reason longer than 200 chars with ellipsis', () => {
    const longReason = 'B'.repeat(250);
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(
      <ChurnSaveOfferCard {...BASE_PROPS} reason={longReason} acceptAction={mockAction} />
    );

    // The component should show truncated text (200 chars + ellipsis)
    const truncated = 'B'.repeat(200) + '…';
    expect(screen.getByText(truncated)).toBeTruthy();

    // The full 250-char text must NOT appear
    expect(screen.queryByText(longReason)).toBeNull();
  });

  it('(i) renders full reason when within 200 chars', () => {
    const shortReason = 'Short reason.';
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(
      <ChurnSaveOfferCard {...BASE_PROPS} reason={shortReason} acceptAction={mockAction} />
    );

    expect(screen.getByText(shortReason)).toBeTruthy();
  });

  // ── (j) Button label ───────────────────────────────────────────────────────

  it('(j) button label is "Accept offer" — not "Submit"', () => {
    const mockAction = vi.fn(async () => ({ ok: true } as AcceptOfferActionResult));
    render(<ChurnSaveOfferCard {...BASE_PROPS} acceptAction={mockAction} />);

    const button = screen.getByTestId('accept-button');
    expect(button.textContent).toBe('Accept offer');

    // Explicitly assert it is NOT "Submit"
    expect(button.textContent).not.toBe('Submit');
  });
});
