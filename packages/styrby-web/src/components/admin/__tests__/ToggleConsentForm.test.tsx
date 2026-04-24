/**
 * Tests for ToggleConsentForm
 *
 * Covers:
 *   (a) Renders current state box, purpose select, grant/revoke radios, reason textarea
 *   (b) Hidden targetUserId field has correct value
 *   (c) currentState prop correctly populates the current state display
 *   (d) Grant radio is pre-checked when currentState is 'revoked' or 'not_set'
 *   (e) Revoke radio is pre-checked when currentState is 'granted'
 *   (f) Field-specific error renders when state returns { ok: false, field }
 *   (g) Top-level error renders when state returns { ok: false } without field
 *   (h) Submit button shows pending label when isPending
 *   (i) Radio inputs have explicit id attributes + htmlFor on labels (I3)
 *   (j) aria-invalid + aria-describedby set on errored field (I3)
 *
 * WHY mock useActionState:
 *   Same rationale as OverrideTierForm.test.tsx — no server-action runtime in jsdom.
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

vi.mock('@/app/dashboard/admin/users/[userId]/actions', () => ({
  overrideTierAction: vi.fn(),
  resetPasswordAction: vi.fn(),
  toggleConsentAction: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Stub action prop for ToggleConsentForm.
 *
 * WHY needed (Fix B): the form now requires a bound action prop. In form tests
 * we mock useActionState so the action is never actually called.
 */
const mockBoundAction = vi.fn().mockResolvedValue({ ok: true });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ToggleConsentForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActionState = null;
    mockIsPending = false;
  });

  it('(a) renders all major sections', async () => {
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(<ToggleConsentForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    expect(screen.getByTestId('current-state-box')).toBeDefined();
    expect(screen.getByTestId('purpose-select')).toBeDefined();
    expect(screen.getByTestId('radio-grant')).toBeDefined();
    expect(screen.getByTestId('radio-revoke')).toBeDefined();
    expect(screen.getByTestId('reason-textarea')).toBeDefined();
    expect(screen.getByTestId('submit-button')).toBeDefined();
  });

  it('(b) hidden targetUserId field has correct value', async () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    const { container } = render(<ToggleConsentForm targetUserId={userId} action={mockBoundAction} />);

    const hiddenInput = container.querySelector('input[name="targetUserId"]') as HTMLInputElement;
    expect(hiddenInput).not.toBeNull();
    expect(hiddenInput.value).toBe(userId);
  });

  it('(c) shows "Granted" when currentState is "granted"', async () => {
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(
      <ToggleConsentForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        currentState="granted"
        action={mockBoundAction}
      />
    );

    expect(screen.getByTestId('current-state-value').textContent).toBe('Granted');
  });

  it('(c) shows "Revoked" when currentState is "revoked"', async () => {
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(
      <ToggleConsentForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        currentState="revoked"
        action={mockBoundAction}
      />
    );

    expect(screen.getByTestId('current-state-value').textContent).toBe('Revoked');
  });

  it('(c) shows "Not set" when currentState is "not_set"', async () => {
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(
      <ToggleConsentForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        currentState="not_set"
        action={mockBoundAction}
      />
    );

    expect(screen.getByTestId('current-state-value').textContent).toBe('Not set');
  });

  it('(d) grant radio is defaultChecked when currentState is not "granted"', async () => {
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(
      <ToggleConsentForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        currentState="revoked"
        action={mockBoundAction}
      />
    );

    // WHY check defaultChecked attribute: for uncontrolled radios, defaultChecked
    // sets the initial selected state. We verify the prop, not the checked property
    // (which would only reflect user interaction in jsdom).
    const grantRadio = screen.getByTestId('radio-grant') as HTMLInputElement;
    expect(grantRadio.defaultChecked).toBe(true);
  });

  it('(e) revoke radio is defaultChecked when currentState is "granted"', async () => {
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(
      <ToggleConsentForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        currentState="granted"
        action={mockBoundAction}
      />
    );

    const revokeRadio = screen.getByTestId('radio-revoke') as HTMLInputElement;
    expect(revokeRadio.defaultChecked).toBe(true);
  });

  it('(f) renders field-specific error', async () => {
    mockActionState = { ok: false, error: 'Reason is required', field: 'reason' };

    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(<ToggleConsentForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Reason is required');
    expect(screen.queryByTestId('form-error')).toBeNull();
  });

  it('(g) renders top-level error when no field is specified', async () => {
    mockActionState = { ok: false, error: 'Not authorized' };

    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(<ToggleConsentForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    expect(screen.getByTestId('form-error').textContent).toContain('Not authorized');
  });

  it('(h) submit button is disabled and shows pending label when isPending', async () => {
    mockIsPending = true;

    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(<ToggleConsentForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Applying…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('(h) submit button shows idle label when not pending', async () => {
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(<ToggleConsentForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    expect(screen.getByTestId('submit-button').textContent).toBe('Apply consent change');
  });

  it('(a) purpose select defaults to support_read_metadata', async () => {
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(<ToggleConsentForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    const select = screen.getByTestId('purpose-select') as HTMLSelectElement;
    expect(select.value).toBe('support_read_metadata');
  });

  it('(i) I3: radio inputs have explicit id attributes + associated htmlFor on labels', async () => {
    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    const { container } = render(
      <ToggleConsentForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />
    );

    const grantRadio = screen.getByTestId('radio-grant') as HTMLInputElement;
    const revokeRadio = screen.getByTestId('radio-revoke') as HTMLInputElement;

    // Explicit id attributes — required for robust AT label association.
    expect(grantRadio.id).toBe('grant-true');
    expect(revokeRadio.id).toBe('grant-false');

    // Labels must have matching htmlFor attributes.
    const grantLabel = container.querySelector('label[for="grant-true"]');
    const revokeLabel = container.querySelector('label[for="grant-false"]');
    expect(grantLabel).not.toBeNull();
    expect(revokeLabel).not.toBeNull();
  });

  it('(j) I3: reason textarea gets aria-invalid + aria-describedby on field error', async () => {
    mockActionState = { ok: false, error: 'Reason is required', field: 'reason' };

    const { ToggleConsentForm } = await import('../ToggleConsentForm');
    render(<ToggleConsentForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    const textarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;
    const errorEl = screen.getByTestId('reason-error');

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe('reason-error');
    expect(errorEl.id).toBe('reason-error');
    expect(errorEl.textContent).toContain('Reason is required');
  });
});
