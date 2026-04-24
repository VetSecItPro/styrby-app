/**
 * Tests for SendChurnSaveOfferForm
 *
 * Covers:
 *   (a) Renders radio inputs for both offer kinds
 *   (b) Renders reason textarea
 *   (c) Renders optional Polar discount code input
 *   (d) Hidden targetUserId field is present with correct value
 *   (e) "annual_3mo_25pct" radio is checked by default
 *   (f) Inline field error renders with aria-invalid + aria-describedby on reason
 *   (g) Top-level error renders when state has ok:false without field
 *   (h) Top-level error is truncated at 200 chars
 *   (i) Submit button shows "Sending…" and inputs disabled when isPending
 *   (j) Submit button shows "Send churn-save offer" when idle
 *   (k) Form has correct aria-label
 *
 * Testing strategy:
 *   - Mock `useActionState` (React 19) to control state + isPending.
 *
 * WHY mock useActionState:
 *   useActionState is a React 19 hook with no server-action runtime in jsdom.
 *   We mock it to control state and assert the form reacts correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let mockActionState: { ok: boolean; error?: string; field?: string } | null = null;
let mockIsPending = false;
const mockFormAction = vi.fn();

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  return {
    ...actual,
    useActionState: (_action: unknown, _initial: unknown) => [
      mockActionState,
      mockFormAction,
      mockIsPending,
    ],
  };
});

const mockBoundAction = vi.fn().mockResolvedValue({ ok: true });

const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SendChurnSaveOfferForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActionState = null;
    mockIsPending = false;
  });

  it('(a) renders radio inputs for both offer kinds', async () => {
    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    expect(screen.getByTestId('kind-radio-annual_3mo_25pct')).toBeDefined();
    expect(screen.getByTestId('kind-radio-monthly_1mo_50pct')).toBeDefined();
  });

  it('(b) renders reason textarea', async () => {
    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    expect(screen.getByTestId('reason-textarea')).toBeDefined();
  });

  it('(c) renders optional Polar discount code input', async () => {
    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    expect(screen.getByTestId('polar-discount-code-input')).toBeDefined();
  });

  it('(d) hidden targetUserId field has correct value', async () => {
    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    const { container } = render(
      <SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />
    );

    const hiddenInput = container.querySelector('input[name="targetUserId"]') as HTMLInputElement;
    expect(hiddenInput).not.toBeNull();
    expect(hiddenInput.value).toBe(USER_ID);
  });

  it('(e) "annual_3mo_25pct" radio is checked by default', async () => {
    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    const annualRadio = screen.getByTestId('kind-radio-annual_3mo_25pct') as HTMLInputElement;
    expect(annualRadio.defaultChecked).toBe(true);
  });

  it('(f) reason textarea gets aria-invalid + aria-describedby on field error', async () => {
    mockActionState = { ok: false, error: 'Reason is required', field: 'reason' };

    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    const textarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;
    const errorEl = screen.getByTestId('reason-error');

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe('reason-error');
    expect(errorEl.id).toBe('reason-error');
    expect(errorEl.getAttribute('role')).toBe('alert');
    expect(errorEl.textContent).toContain('Reason is required');
  });

  it('(g) top-level error renders when state has ok:false without field', async () => {
    mockActionState = { ok: false, error: 'Active offer already exists for this user' };

    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    const errorBox = screen.getByTestId('form-error');
    expect(errorBox.getAttribute('role')).toBe('alert');
    expect(errorBox.textContent).toContain('Active offer already exists');
  });

  it('(h) top-level error is truncated at 200 chars', async () => {
    mockActionState = { ok: false, error: 'X'.repeat(300) };

    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    const errorBox = screen.getByTestId('form-error');
    expect((errorBox.textContent ?? '').length).toBeLessThanOrEqual(200);
  });

  it('(i) submit shows "Sending…" and radio inputs disabled when isPending', async () => {
    mockIsPending = true;

    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Sending…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);

    const annualRadio = screen.getByTestId('kind-radio-annual_3mo_25pct') as HTMLInputElement;
    const monthlyRadio = screen.getByTestId('kind-radio-monthly_1mo_50pct') as HTMLInputElement;
    const discountInput = screen.getByTestId('polar-discount-code-input') as HTMLInputElement;
    const reasonTextarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;

    expect(annualRadio.disabled).toBe(true);
    expect(monthlyRadio.disabled).toBe(true);
    expect(discountInput.disabled).toBe(true);
    expect(reasonTextarea.disabled).toBe(true);
  });

  it('(j) submit shows "Send churn-save offer" when idle', async () => {
    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Send churn-save offer');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('(k) form has correct aria-label', async () => {
    const { SendChurnSaveOfferForm } = await import('../SendChurnSaveOfferForm');
    render(<SendChurnSaveOfferForm targetUserId={USER_ID} action={mockBoundAction} />);

    expect(screen.getByRole('form', { name: 'Send churn-save offer' })).toBeDefined();
  });
});
