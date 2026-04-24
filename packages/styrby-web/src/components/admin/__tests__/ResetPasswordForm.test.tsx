/**
 * Tests for ResetPasswordForm
 *
 * Covers:
 *   (a) Renders target email confirmation box, reason textarea, submit button
 *   (b) Hidden fields — only targetUserId present (NO targetEmail — C1 fix)
 *   (c) Warning box renders when state is { ok: true, warning }
 *   (d) Field-specific error renders when state returns { ok: false, field }
 *   (e) Top-level error renders when state returns { ok: false } without field
 *   (f) Submit button shows correct label / disabled state during pending
 *   (g) aria-invalid + aria-describedby set on errored field
 *
 * WHY mock useActionState:
 *   Same rationale as OverrideTierForm.test.tsx — no server-action runtime
 *   in jsdom. We test the form's reaction to state, not the action itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let mockActionState: { ok: boolean; error?: string; field?: string; warning?: string } | null = null;
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
 * Stub action prop for ResetPasswordForm.
 *
 * WHY needed (Fix B): the form now requires a bound action prop (passed from
 * the page). In form tests we mock useActionState so the action is never
 * actually called — the stub satisfies the required prop type.
 */
const mockBoundAction = vi.fn().mockResolvedValue({ ok: true });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ResetPasswordForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActionState = null;
    mockIsPending = false;
  });

  it('(a) renders the target email confirmation box', async () => {
    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    render(
      <ResetPasswordForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        targetEmail="alice@example.com"
        action={mockBoundAction}
      />
    );

    expect(screen.getByTestId('target-email-box')).toBeDefined();
    expect(screen.getByTestId('target-email-display').textContent).toBe('alice@example.com');
  });

  it('(a) renders reason textarea and submit button', async () => {
    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    render(
      <ResetPasswordForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        targetEmail="alice@example.com"
        action={mockBoundAction}
      />
    );

    expect(screen.getByTestId('reason-textarea')).toBeDefined();
    expect(screen.getByTestId('submit-button')).toBeDefined();
  });

  it('(b) hidden targetUserId field has correct value and no targetEmail hidden field exists (C1 fix)', async () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const email = 'alice@example.com';
    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    const { container } = render(
      <ResetPasswordForm targetUserId={userId} targetEmail={email} action={mockBoundAction} />
    );

    const userIdInput = container.querySelector('input[name="targetUserId"]') as HTMLInputElement;
    // CRITICAL (C1): no hidden targetEmail field must exist in the DOM.
    // Sending targetEmail through FormData would allow tampered-field account-takeover.
    // The server action resolves email via Auth Admin API. T6 quality review #C1.
    const emailInput = container.querySelector('input[name="targetEmail"]');

    expect(userIdInput).not.toBeNull();
    expect(userIdInput.value).toBe(userId);
    expect(emailInput).toBeNull();
  });

  it('(c) renders warning box when state is { ok: true, warning }', async () => {
    mockActionState = {
      ok: true,
      warning: 'Audit recorded (id 42) but magic link send failed — check Sentry.',
    };

    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    render(
      <ResetPasswordForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        targetEmail="alice@example.com"
        action={mockBoundAction}
      />
    );

    const warningBox = screen.getByTestId('warning-box');
    expect(warningBox.textContent).toContain('Audit recorded (id 42)');
  });

  it('(d) renders field-specific error', async () => {
    mockActionState = { ok: false, error: 'Reason is required', field: 'reason' };

    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    render(
      <ResetPasswordForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        targetEmail="alice@example.com"
        action={mockBoundAction}
      />
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Reason is required');
    expect(screen.queryByTestId('form-error')).toBeNull();
  });

  it('(e) renders top-level error when no field is specified', async () => {
    mockActionState = { ok: false, error: 'Not authorized' };

    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    render(
      <ResetPasswordForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        targetEmail="alice@example.com"
        action={mockBoundAction}
      />
    );

    expect(screen.getByTestId('form-error').textContent).toContain('Not authorized');
  });

  it('(f) submit button is disabled and shows pending label when isPending', async () => {
    mockIsPending = true;

    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    render(
      <ResetPasswordForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        targetEmail="alice@example.com"
        action={mockBoundAction}
      />
    );

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Sending…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('(f) submit button shows confirm label when not pending', async () => {
    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    render(
      <ResetPasswordForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        targetEmail="alice@example.com"
        action={mockBoundAction}
      />
    );

    expect(screen.getByTestId('submit-button').textContent).toBe('Confirm — send reset link');
  });

  it('(a) form has correct aria-label', async () => {
    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    render(
      <ResetPasswordForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        targetEmail="alice@example.com"
        action={mockBoundAction}
      />
    );

    expect(screen.getByRole('form', { name: 'Reset user password' })).toBeDefined();
  });

  it('(g) reason textarea gets aria-invalid + aria-describedby on field error (I3)', async () => {
    mockActionState = { ok: false, error: 'Reason is required', field: 'reason' };

    const { ResetPasswordForm } = await import('../ResetPasswordForm');
    render(
      <ResetPasswordForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        targetEmail="alice@example.com"
        action={mockBoundAction}
      />
    );

    const textarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;
    const errorEl = screen.getByTestId('reason-error');

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe('reason-error');
    expect(errorEl.id).toBe('reason-error');
    expect(errorEl.textContent).toContain('Reason is required');
  });
});
