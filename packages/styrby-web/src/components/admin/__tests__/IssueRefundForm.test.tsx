/**
 * Tests for IssueRefundForm
 *
 * Covers:
 *   (a) Renders all form fields (subscription select, amount input, reason textarea, submit)
 *   (b) Hidden targetUserId field is present with correct value
 *   (c) Subscription select renders provided options
 *   (d) dollarsToCents converts valid dollar strings to integer cents
 *   (e) dollarsToCents returns NaN for invalid inputs
 *   (f) Inline field error renders with aria-invalid + aria-describedby
 *   (g) Top-level error renders when state has ok:false without field
 *   (h) Top-level error is truncated at 200 chars (phishing defense)
 *   (i) Submit button shows pending label "Issuing…" when isPending
 *   (j) All inputs are disabled when isPending
 *   (k) Submit button shows "Issue refund" when idle
 *   (l) Form has correct aria-label
 *
 * Testing strategy:
 *   - Mock `useActionState` (React 19) to control state + isPending + formAction.
 *   - Render the form and assert DOM structure and behavior.
 *   - Test `dollarsToCents` exported helper directly.
 *
 * WHY mock useActionState:
 *   useActionState is a React 19 hook connecting a server action to a form.
 *   In jsdom/Vitest there is no server-action runtime. We mock the hook to
 *   control returned state and assert the form reacts correctly.
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STUB_OPTIONS = [
  { id: 'sub_abc123', label: 'power — monthly (sub_abc123)' },
  { id: 'sub_def456', label: 'free — annual (sub_def456)' },
];

const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('IssueRefundForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActionState = null;
    mockIsPending = false;
  });

  it('(a) renders all form fields', async () => {
    const { IssueRefundForm } = await import('../IssueRefundForm');
    render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    expect(screen.getByTestId('subscription-select')).toBeDefined();
    expect(screen.getByTestId('amount-input')).toBeDefined();
    expect(screen.getByTestId('reason-textarea')).toBeDefined();
    expect(screen.getByTestId('submit-button')).toBeDefined();
  });

  it('(b) hidden targetUserId field has correct value', async () => {
    const { IssueRefundForm } = await import('../IssueRefundForm');
    const { container } = render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    const hiddenInput = container.querySelector('input[name="targetUserId"]') as HTMLInputElement;
    expect(hiddenInput).not.toBeNull();
    expect(hiddenInput.value).toBe(USER_ID);
  });

  it('(c) subscription select renders provided options', async () => {
    const { IssueRefundForm } = await import('../IssueRefundForm');
    render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    const select = screen.getByTestId('subscription-select') as HTMLSelectElement;
    // +1 for the placeholder option
    expect(select.options.length).toBe(STUB_OPTIONS.length + 1);
    expect(select.options[1].value).toBe('sub_abc123');
    expect(select.options[2].value).toBe('sub_def456');
  });

  it('(d) dollarsToCents converts valid dollar strings to integer cents', async () => {
    const { dollarsToCents } = await import('../IssueRefundForm');

    expect(dollarsToCents('49.00')).toBe(4900);
    expect(dollarsToCents('0.01')).toBe(1);
    expect(dollarsToCents('5000')).toBe(500000);
    expect(dollarsToCents('10.99')).toBe(1099);
  });

  it('(e) dollarsToCents returns NaN for invalid inputs', async () => {
    const { dollarsToCents } = await import('../IssueRefundForm');

    expect(dollarsToCents(null)).toBe(NaN);
    expect(dollarsToCents('')).toBe(NaN);
    expect(dollarsToCents('not-a-number')).toBe(NaN);
    expect(dollarsToCents('-10')).toBe(NaN);
    expect(dollarsToCents('0')).toBe(NaN);
  });

  it('(f) reason textarea gets aria-invalid + aria-describedby on field error', async () => {
    mockActionState = { ok: false, error: 'Reason is required', field: 'reason' };

    const { IssueRefundForm } = await import('../IssueRefundForm');
    render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    const textarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;
    const errorEl = screen.getByTestId('reason-error');

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe('reason-error');
    expect(errorEl.id).toBe('reason-error');
    expect(errorEl.getAttribute('role')).toBe('alert');
    expect(errorEl.textContent).toContain('Reason is required');
  });

  it('(g) top-level error renders when state has ok:false without field', async () => {
    mockActionState = { ok: false, error: 'Internal error — check Sentry' };

    const { IssueRefundForm } = await import('../IssueRefundForm');
    render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    const errorBox = screen.getByTestId('form-error');
    expect(errorBox.getAttribute('role')).toBe('alert');
    expect(errorBox.textContent).toContain('Internal error — check Sentry');
  });

  it('(h) top-level error is truncated at 200 chars', async () => {
    const longError = 'A'.repeat(300);
    mockActionState = { ok: false, error: longError };

    const { IssueRefundForm } = await import('../IssueRefundForm');
    render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    const errorBox = screen.getByTestId('form-error');
    expect((errorBox.textContent ?? '').length).toBeLessThanOrEqual(200);
  });

  it('(i) submit button shows "Issuing…" when isPending', async () => {
    mockIsPending = true;

    const { IssueRefundForm } = await import('../IssueRefundForm');
    render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Issuing…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('(j) all inputs are disabled when isPending', async () => {
    mockIsPending = true;

    const { IssueRefundForm } = await import('../IssueRefundForm');
    render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    const select = screen.getByTestId('subscription-select') as HTMLSelectElement;
    const amountInput = screen.getByTestId('amount-input') as HTMLInputElement;
    const reasonTextarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;

    expect(select.disabled).toBe(true);
    expect(amountInput.disabled).toBe(true);
    expect(reasonTextarea.disabled).toBe(true);
  });

  it('(k) submit button shows "Issue refund" when idle', async () => {
    const { IssueRefundForm } = await import('../IssueRefundForm');
    render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Issue refund');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('(l) form has correct aria-label', async () => {
    const { IssueRefundForm } = await import('../IssueRefundForm');
    render(
      <IssueRefundForm
        targetUserId={USER_ID}
        subscriptionOptions={STUB_OPTIONS}
        action={mockBoundAction}
      />
    );

    expect(screen.getByRole('form', { name: 'Issue refund' })).toBeDefined();
  });
});
