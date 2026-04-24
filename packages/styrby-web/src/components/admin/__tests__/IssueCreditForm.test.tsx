/**
 * Tests for IssueCreditForm
 *
 * Covers:
 *   (a) Renders all form fields (amount input, reason textarea, expires_at, submit)
 *   (b) Hidden targetUserId field is present with correct value
 *   (c) dollarsToCents converts valid dollar strings to cents
 *   (d) dollarsToCents returns NaN for invalid inputs
 *   (e) normalizeDatetimeLocal coerces datetime-local to ISO UTC
 *   (f) normalizeDatetimeLocal returns null for empty/invalid inputs
 *   (g) Inline field error renders with aria-invalid + aria-describedby on reason
 *   (h) Top-level error renders when state has ok:false without field
 *   (i) Top-level error is truncated at 200 chars
 *   (j) Submit button shows "Issuing…" and inputs disabled when isPending
 *   (k) Submit button shows "Issue credit" when idle
 *   (l) Form has correct aria-label
 *
 * Testing strategy:
 *   - Mock `useActionState` (React 19) to control state + isPending.
 *   - Test exported helper functions directly.
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

describe('IssueCreditForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActionState = null;
    mockIsPending = false;
  });

  it('(a) renders all form fields', async () => {
    const { IssueCreditForm } = await import('../IssueCreditForm');
    render(<IssueCreditForm targetUserId={USER_ID} action={mockBoundAction} />);

    expect(screen.getByTestId('amount-input')).toBeDefined();
    expect(screen.getByTestId('reason-textarea')).toBeDefined();
    expect(screen.getByTestId('expires-at-input')).toBeDefined();
    expect(screen.getByTestId('submit-button')).toBeDefined();
  });

  it('(b) hidden targetUserId field has correct value', async () => {
    const { IssueCreditForm } = await import('../IssueCreditForm');
    const { container } = render(
      <IssueCreditForm targetUserId={USER_ID} action={mockBoundAction} />
    );

    const hiddenInput = container.querySelector('input[name="targetUserId"]') as HTMLInputElement;
    expect(hiddenInput).not.toBeNull();
    expect(hiddenInput.value).toBe(USER_ID);
  });

  it('(c) dollarsToCents converts valid dollar strings to integer cents', async () => {
    const { dollarsToCents } = await import('../IssueCreditForm');

    expect(dollarsToCents('10.00')).toBe(1000);
    expect(dollarsToCents('1.00')).toBe(100);
    expect(dollarsToCents('1000')).toBe(100000);
    expect(dollarsToCents('0.50')).toBe(50);
  });

  it('(d) dollarsToCents returns NaN for invalid inputs', async () => {
    const { dollarsToCents } = await import('../IssueCreditForm');

    expect(dollarsToCents(null)).toBe(NaN);
    expect(dollarsToCents('')).toBe(NaN);
    expect(dollarsToCents('abc')).toBe(NaN);
    expect(dollarsToCents('-5')).toBe(NaN);
    expect(dollarsToCents('0')).toBe(NaN);
  });

  it('(e) normalizeDatetimeLocal coerces datetime-local to ISO UTC string', async () => {
    const { normalizeDatetimeLocal } = await import('../IssueCreditForm');

    const input = '2027-06-15T14:30';
    const result = normalizeDatetimeLocal(input);

    expect(result).not.toBeNull();
    // Must end with Z (UTC from toISOString)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('(f) normalizeDatetimeLocal returns null for empty/invalid inputs', async () => {
    const { normalizeDatetimeLocal } = await import('../IssueCreditForm');

    expect(normalizeDatetimeLocal(null)).toBeNull();
    expect(normalizeDatetimeLocal('')).toBeNull();
    expect(normalizeDatetimeLocal('not-a-date')).toBeNull();
  });

  it('(g) reason textarea gets aria-invalid + aria-describedby on field error', async () => {
    mockActionState = { ok: false, error: 'Reason is required', field: 'reason' };

    const { IssueCreditForm } = await import('../IssueCreditForm');
    render(<IssueCreditForm targetUserId={USER_ID} action={mockBoundAction} />);

    const textarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;
    const errorEl = screen.getByTestId('reason-error');

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe('reason-error');
    expect(errorEl.id).toBe('reason-error');
    expect(errorEl.getAttribute('role')).toBe('alert');
    expect(errorEl.textContent).toContain('Reason is required');
  });

  it('(h) top-level error renders when state has ok:false without field', async () => {
    mockActionState = { ok: false, error: 'Not authorized' };

    const { IssueCreditForm } = await import('../IssueCreditForm');
    render(<IssueCreditForm targetUserId={USER_ID} action={mockBoundAction} />);

    const errorBox = screen.getByTestId('form-error');
    expect(errorBox.getAttribute('role')).toBe('alert');
    expect(errorBox.textContent).toContain('Not authorized');
  });

  it('(i) top-level error is truncated at 200 chars', async () => {
    mockActionState = { ok: false, error: 'Z'.repeat(300) };

    const { IssueCreditForm } = await import('../IssueCreditForm');
    render(<IssueCreditForm targetUserId={USER_ID} action={mockBoundAction} />);

    const errorBox = screen.getByTestId('form-error');
    expect((errorBox.textContent ?? '').length).toBeLessThanOrEqual(200);
  });

  it('(j) submit shows "Issuing…" and inputs disabled when isPending', async () => {
    mockIsPending = true;

    const { IssueCreditForm } = await import('../IssueCreditForm');
    render(<IssueCreditForm targetUserId={USER_ID} action={mockBoundAction} />);

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Issuing…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);

    const amountInput = screen.getByTestId('amount-input') as HTMLInputElement;
    const reasonTextarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;
    const expiresInput = screen.getByTestId('expires-at-input') as HTMLInputElement;

    expect(amountInput.disabled).toBe(true);
    expect(reasonTextarea.disabled).toBe(true);
    expect(expiresInput.disabled).toBe(true);
  });

  it('(k) submit shows "Issue credit" when idle', async () => {
    const { IssueCreditForm } = await import('../IssueCreditForm');
    render(<IssueCreditForm targetUserId={USER_ID} action={mockBoundAction} />);

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Issue credit');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('(l) form has correct aria-label', async () => {
    const { IssueCreditForm } = await import('../IssueCreditForm');
    render(<IssueCreditForm targetUserId={USER_ID} action={mockBoundAction} />);

    expect(screen.getByRole('form', { name: 'Issue account credit' })).toBeDefined();
  });
});
