/**
 * Tests for RequestSupportAccessForm
 *
 * Phase 4.2 — Support Tooling T4
 *
 * Covers:
 *   (a) Render — session select, reason textarea, expiry select, expiry callout,
 *       cancel link, and submit button all render correctly
 *   (b) No-sessions fallback — renders a message when sessions array is empty
 *   (c) Field-level error rendering — session_id, reason, expires_in_hours each
 *       get aria-invalid + aria-describedby + error message element when state
 *       contains that field
 *   (d) Top-level error rendering — when state.ok = false and no field, renders
 *       the form-error element (truncated to 200 chars)
 *   (e) Submit button pending state — disabled + "Requesting…" label when isPending
 *   (f) Submit button disabled when no sessions (even when not pending)
 *   (g) Form has correct aria-label for landmark navigation
 *   (h) Expiry callout is present (admin sees the expiry window before submitting)
 *   (i) Cancel link navigates to backHref
 *
 * WHY mock useActionState:
 *   No server-action runtime in jsdom. We test the form's reaction to state,
 *   not the action itself (action is tested in actions.test.ts).
 *
 * SOC 2 CC6.1: a11y attributes (aria-invalid, aria-describedby) ensure screen-
 * reader users receive the same security-critical field error feedback as
 * sighted users. This is a compliance requirement, not just UX.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

// WHY mock next/link: jsdom doesn't resolve routes. We replace with a simple
// anchor so we can assert on the href attribute.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) =>
    React.createElement('a', { href, ...rest }, children),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SESSIONS = [
  { id: 'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', label: 'Claude Code — Apr 23, 2026' },
  { id: 'ffff-0000-1111-2222-333333333333', label: 'Codex — Apr 22, 2026 (completed)' },
];

const BACK_HREF = '/dashboard/admin/support/ticket-uuid-here';

/** Stub bound action — never called in form render tests. */
const mockBoundAction = vi.fn().mockResolvedValue({ ok: true, grantId: '99' });

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function renderForm(
  sessions = SESSIONS,
  overrides: Partial<{ action: typeof mockBoundAction; backHref: string }> = {}
) {
  const { RequestSupportAccessForm } = await import('../RequestSupportAccessForm');
  return render(
    <RequestSupportAccessForm
      sessions={sessions}
      action={overrides.action ?? mockBoundAction}
      backHref={overrides.backHref ?? BACK_HREF}
    />
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RequestSupportAccessForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActionState = null;
    mockIsPending = false;
  });

  // ── (a) Render ─────────────────────────────────────────────────────────────

  it('(a) renders session select with options', async () => {
    await renderForm();

    const select = screen.getByTestId('session-select') as HTMLSelectElement;
    expect(select).toBeDefined();
    // Placeholder option + 2 sessions.
    expect(select.options.length).toBe(3);
    expect(select.options[1].value).toBe(SESSIONS[0].id);
    expect(select.options[1].textContent).toBe(SESSIONS[0].label);
  });

  it('(a) renders reason textarea', async () => {
    await renderForm();
    expect(screen.getByTestId('reason-textarea')).toBeDefined();
  });

  it('(a) renders expiry select with all 7 options', async () => {
    await renderForm();
    const select = screen.getByTestId('expiry-select') as HTMLSelectElement;
    // 7 expiry options defined in EXPIRY_OPTIONS constant.
    expect(select.options.length).toBe(7);
  });

  it('(a) renders expiry callout with datetime', async () => {
    await renderForm();
    expect(screen.getByTestId('expiry-callout')).toBeDefined();
    expect(screen.getByTestId('expiry-datetime')).toBeDefined();
    // The datetime should be a non-empty string.
    expect(screen.getByTestId('expiry-datetime').textContent?.length).toBeGreaterThan(0);
  });

  it('(a) renders submit button', async () => {
    await renderForm();
    expect(screen.getByTestId('submit-button')).toBeDefined();
    expect(screen.getByTestId('submit-button').textContent).toBe('Request access');
  });

  it('(i) cancel link has correct href', async () => {
    await renderForm();
    const link = screen.getByTestId('cancel-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(BACK_HREF);
  });

  it('(g) form has correct aria-label', async () => {
    await renderForm();
    expect(
      screen.getByRole('form', { name: 'Request support session access' })
    ).toBeDefined();
  });

  // ── (b) No-sessions fallback ────────────────────────────────────────────────

  it('(b) renders no-sessions message when sessions is empty', async () => {
    await renderForm([]);
    expect(screen.getByTestId('no-sessions-message')).toBeDefined();
    expect(screen.queryByTestId('session-select')).toBeNull();
  });

  it('(f) submit button is disabled when sessions is empty', async () => {
    await renderForm([]);
    const btn = screen.getByTestId('submit-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ── (c) Field-level error rendering ────────────────────────────────────────

  it('(c) session_id field error: aria-invalid + aria-describedby + error element', async () => {
    mockActionState = { ok: false, error: 'Invalid session ID', field: 'session_id' };
    await renderForm();

    const select = screen.getByTestId('session-select') as HTMLSelectElement;
    const errorEl = screen.getByTestId('session_id-error');

    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe('session_id-error');
    expect(errorEl.id).toBe('session_id-error');
    expect(errorEl.textContent).toContain('Invalid session ID');
    expect(errorEl.getAttribute('role')).toBe('alert');
  });

  it('(c) reason field error: aria-invalid + aria-describedby + error element', async () => {
    mockActionState = {
      ok: false,
      error: 'Reason must be at least 10 characters',
      field: 'reason',
    };
    await renderForm();

    const textarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;
    const errorEl = screen.getByTestId('reason-error');

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe('reason-error');
    expect(errorEl.id).toBe('reason-error');
    expect(errorEl.textContent).toContain('Reason must be at least 10 characters');
    expect(errorEl.getAttribute('role')).toBe('alert');
  });

  it('(c) expires_in_hours field error: aria-invalid + aria-describedby + error element', async () => {
    mockActionState = {
      ok: false,
      error: 'Expiry must be at least 1 hour',
      field: 'expires_in_hours',
    };
    await renderForm();

    const select = screen.getByTestId('expiry-select') as HTMLSelectElement;
    const errorEl = screen.getByTestId('expires_in_hours-error');

    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe('expires_in_hours-error');
    expect(errorEl.id).toBe('expires_in_hours-error');
    expect(errorEl.getAttribute('role')).toBe('alert');
  });

  it('(c) no aria-invalid when state is null', async () => {
    await renderForm();
    const select = screen.getByTestId('session-select');
    expect(select.getAttribute('aria-invalid')).toBeNull();
  });

  // ── (d) Top-level error rendering ─────────────────────────────────────────

  it('(d) renders top-level error when no field is specified', async () => {
    mockActionState = { ok: false, error: 'Not authorized' };
    await renderForm();

    const errorEl = screen.getByTestId('form-error');
    expect(errorEl.textContent).toContain('Not authorized');
    expect(errorEl.getAttribute('role')).toBe('alert');
  });

  it('(d) truncates top-level error at 200 chars', async () => {
    const longError = 'X'.repeat(300);
    mockActionState = { ok: false, error: longError };
    await renderForm();

    const errorEl = screen.getByTestId('form-error');
    // Display text should be truncated to 200 chars.
    expect(errorEl.textContent?.length).toBeLessThanOrEqual(200);
  });

  it('(d) no form-error element when state has a field', async () => {
    mockActionState = { ok: false, error: 'Bad field', field: 'reason' };
    await renderForm();
    expect(screen.queryByTestId('form-error')).toBeNull();
  });

  // ── (e) Pending state ──────────────────────────────────────────────────────

  it('(e) submit button is disabled and shows pending label when isPending', async () => {
    mockIsPending = true;
    await renderForm();

    const btn = screen.getByTestId('submit-button') as HTMLButtonElement;
    expect(btn.textContent).toBe('Requesting…');
    expect(btn.disabled).toBe(true);
  });

  it('(e) session select is disabled when isPending', async () => {
    mockIsPending = true;
    await renderForm();

    const select = screen.getByTestId('session-select') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it('(e) reason textarea is disabled when isPending', async () => {
    mockIsPending = true;
    await renderForm();

    const textarea = screen.getByTestId('reason-textarea') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  // ── (h) Expiry callout ─────────────────────────────────────────────────────

  it('(h) expiry callout has aria attributes for accessibility', async () => {
    await renderForm();
    const callout = screen.getByTestId('expiry-callout');
    expect(callout.getAttribute('role')).toBe('region');
    expect(callout.getAttribute('aria-label')).toBe('Access expiry window');
  });
});
