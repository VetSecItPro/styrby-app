/**
 * Tests for OverrideTierForm
 *
 * Covers:
 *   (a) Renders tier select, expiresAt input, reason textarea, submit button
 *   (b) Hidden targetUserId field is present with correct value
 *   (c) currentTier prop pre-selects the correct option
 *   (d) Inline error renders when state returns { ok: false, field }
 *   (e) Top-level error renders when state returns { ok: false } without field
 *   (f) Form submits via the overrideTierAction action prop
 *   (g) I1: normalizeDatetimeLocal coerces datetime-local to ISO UTC before action call
 *   (h) I3: aria-invalid + aria-describedby set on errored field
 *
 * Testing strategy:
 *   - Mock `useActionState` (React 19) to control state + isPending + formAction.
 *   - Render the form and assert DOM structure and behavior.
 *   - We do NOT test the server action itself here (that lives in actions.test.ts).
 *
 * WHY mock useActionState:
 *   useActionState is a React 19 hook that connects a server action to a form.
 *   In a jsdom/Vitest environment there is no server-action runtime. We mock
 *   the hook so we can control the returned state and assert the form reacts
 *   to it correctly (error display, pending state, etc.).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ─── Mocks ───────────────────────────────────────────────────────────────────

/**
 * Controls the state returned by the mocked useActionState.
 * Default: { state: null, isPending: false }.
 */
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

// Mock the server action import — we don't test it here, only the form behavior.
vi.mock('@/app/dashboard/admin/users/[userId]/actions', () => ({
  overrideTierAction: vi.fn(),
  resetPasswordAction: vi.fn(),
  toggleConsentAction: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Stub action prop for OverrideTierForm.
 *
 * WHY needed (Fix B): the form now requires a bound action prop (passed from
 * the page) rather than importing the action directly. In form tests we mock
 * useActionState so the action is never actually called — the stub satisfies
 * the required prop type without importing a live server action.
 */
const mockBoundAction = vi.fn().mockResolvedValue({ ok: true });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OverrideTierForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActionState = null;
    mockIsPending = false;
  });

  it('(a) renders all form fields', async () => {
    const { OverrideTierForm } = await import('../OverrideTierForm');
    render(<OverrideTierForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    expect(screen.getByTestId('tier-select')).toBeDefined();
    expect(screen.getByTestId('expires-at-input')).toBeDefined();
    expect(screen.getByTestId('reason-textarea')).toBeDefined();
    expect(screen.getByTestId('submit-button')).toBeDefined();
  });

  it('(b) hidden targetUserId field has correct value', async () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const { OverrideTierForm } = await import('../OverrideTierForm');
    const { container } = render(<OverrideTierForm targetUserId={userId} action={mockBoundAction} />);

    const hiddenInput = container.querySelector('input[name="targetUserId"]') as HTMLInputElement;
    expect(hiddenInput).not.toBeNull();
    expect(hiddenInput.value).toBe(userId);
  });

  it('(c) currentTier pre-selects the correct option in the tier select', async () => {
    const { OverrideTierForm } = await import('../OverrideTierForm');
    render(
      <OverrideTierForm
        targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        currentTier="enterprise"
        action={mockBoundAction}
      />
    );

    const select = screen.getByTestId('tier-select') as HTMLSelectElement;
    expect(select.value).toBe('enterprise');
  });

  it('(d) renders field-specific error when state has ok: false with field', async () => {
    mockActionState = { ok: false, error: 'Reason is required', field: 'reason' };

    const { OverrideTierForm } = await import('../OverrideTierForm');
    render(<OverrideTierForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Reason is required');
    // Top-level error box should NOT be rendered when there's a field error.
    expect(screen.queryByTestId('form-error')).toBeNull();
  });

  it('(e) renders top-level error when state has ok: false without field', async () => {
    mockActionState = { ok: false, error: 'Not authorized' };

    const { OverrideTierForm } = await import('../OverrideTierForm');
    render(<OverrideTierForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    const errorBox = screen.getByTestId('form-error');
    expect(errorBox.textContent).toContain('Not authorized');
  });

  it('(f) submit button shows pending label when isPending', async () => {
    mockIsPending = true;

    const { OverrideTierForm } = await import('../OverrideTierForm');
    render(<OverrideTierForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Applying…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('(f) submit button shows idle label when not pending', async () => {
    const { OverrideTierForm } = await import('../OverrideTierForm');
    render(<OverrideTierForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    const btn = screen.getByTestId('submit-button');
    expect(btn.textContent).toBe('Apply tier override');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('(a) form has correct aria-label', async () => {
    const { OverrideTierForm } = await import('../OverrideTierForm');
    render(<OverrideTierForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    expect(screen.getByRole('form', { name: 'Override user tier' })).toBeDefined();
  });

  it('(g) I1: normalizeDatetimeLocal coerces datetime-local to ISO UTC string', async () => {
    // WHY test normalizeDatetimeLocal directly: the form wraps the action with
    // this function before submission. We verify the coercion contract independently
    // to decouple it from the mocked useActionState. T6 quality review #I1.
    const { normalizeDatetimeLocal } = await import('../OverrideTierForm');

    // datetime-local input value (no offset) → full ISO UTC string
    const input = '2027-06-15T14:30';
    const result = normalizeDatetimeLocal(input);

    expect(result).not.toBeNull();
    // Result must be a full ISO string (ends with Z from toISOString())
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Null/empty passthrough
    expect(normalizeDatetimeLocal(null)).toBeNull();
    expect(normalizeDatetimeLocal('')).toBeNull();

    // Invalid date returns null
    expect(normalizeDatetimeLocal('not-a-date')).toBeNull();
  });

  it('(h) I3: reason textarea gets aria-invalid + aria-describedby on field error', async () => {
    mockActionState = { ok: false, error: 'Reason is required', field: 'reason' };

    const { OverrideTierForm } = await import('../OverrideTierForm');
    render(<OverrideTierForm targetUserId="a1b2c3d4-e5f6-7890-abcd-ef1234567890" action={mockBoundAction} />);

    const textarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;
    const errorEl = screen.getByTestId('reason-error');

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe('reason-error');
    expect(errorEl.id).toBe('reason-error');
    expect(errorEl.textContent).toContain('Reason is required');
  });
});
