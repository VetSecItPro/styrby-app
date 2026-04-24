'use client';

/**
 * ResetPasswordForm — Client Component for the password reset confirmation action.
 *
 * Purpose:
 *   Presents a deliberate confirmation flow before triggering a password reset
 *   magic-link send. Displays the target user's email prominently to prevent
 *   fat-fingering. Requires a non-empty reason before submission.
 *
 * Anti-fat-finger design:
 *   The target email is displayed in a highlighted box above the form. The
 *   admin must read the email, fill in the reason, and click Confirm — three
 *   intentional steps. There is no keyboard shortcut or single-click path.
 *
 * Security (C1 fix):
 *   targetEmail is displayed for UX confirmation ONLY. It is NOT submitted via
 *   FormData. The server action resolves the email server-side via the trusted
 *   Supabase Auth Admin API. Sending targetEmail through FormData would allow
 *   a tampered hidden field to redirect the recovery link to an attacker-controlled
 *   email (account-takeover primitive). T6 quality review #C1.
 *
 * WHY "use client":
 *   Needs `useActionState` for pending state and inline error rendering.
 *
 * @param targetUserId - UUID of the target user (hidden field).
 * @param targetEmail - Email of the target user (displayed for UX only, NOT sent via FormData).
 */

import { useActionState } from 'react';
import type { AdminActionResult } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResetPasswordFormProps {
  /** UUID of the target user. */
  targetUserId: string;
  /**
   * Email address shown in the confirmation box for admin UX only.
   * NOT submitted via FormData — the action fetches it server-side from Auth Admin
   * API to prevent tampered-field account-takeover. T6 quality review #C1.
   */
  targetEmail: string;
  /**
   * Bound server action from the page — has the URL's trusted userId pre-applied
   * as the first argument. The form passes FormData as the second argument.
   *
   * WHY bound action (Fix B): prevents forensic integrity issues from tampered
   * hidden fields. Threat review round 2, Fix B.
   */
  action: (formData: FormData) => Promise<AdminActionResult>;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Confirmation form for the password reset action.
 *
 * Renders the target email in a warning box so the admin visually confirms
 * the correct user before submitting. On success, the action redirects back
 * to the dossier. A warning (audit recorded but link failed) is rendered
 * inline without redirecting, since the admin must be informed.
 *
 * Security: targetEmail is displayed only. The server action resolves the email
 * independently via Supabase Auth Admin API (C1 fix). See ResetPasswordFormProps.
 *
 * @param targetUserId - UUID of the target user.
 * @param targetEmail - Email displayed in the confirmation box (not submitted as FormData).
 */
export function ResetPasswordForm({ targetUserId, targetEmail, action }: ResetPasswordFormProps) {
  // WHY wrapper: useActionState expects (prevState, formData) => result, but
  // our server action only needs formData. We ignore prevState here because
  // the server action is fully stateless — it computes the result from the
  // form submission alone and redirects on success (or returns a warning).
  // WHY action prop (Fix B): the bound action already carries the trusted
  // URL userId as its first argument. We pass only FormData here.
  const [state, formAction, isPending] = useActionState<AdminActionResult | null, FormData>(
    (_prevState: AdminActionResult | null, formData: FormData) => action(formData),
    null
  );

  // WHY handle warning separately: a `{ ok: true, warning }` result means the
  // audit was written but the magic link failed. We render the warning inline
  // rather than treating it as an error — the admin should NOT retry, but should
  // check Sentry and manually follow up.
  const hasWarning = state?.ok === true && !!state.warning;

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4"
      data-testid="reset-password-form"
      aria-label="Reset user password"
    >
      {/* Hidden fields */}
      {/*
        WHY no hidden targetEmail field (C1 fix):
        Sending targetEmail through FormData would allow an admin to tamper the
        field via browser devtools and redirect the recovery magic-link to an
        email they control — a full account-takeover primitive. The server action
        resolves the email server-side via the trusted Auth Admin API. The email
        is displayed below for admin confirmation only. T6 quality review #C1.
      */}
      <input type="hidden" name="targetUserId" value={targetUserId} />

      {/* Target email confirmation box */}
      <div
        className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
        data-testid="target-email-box"
        role="region"
        aria-label="Target user confirmation"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-amber-400">
          This will send a password-reset magic link to:
        </p>
        <p
          className="mt-1 font-mono text-sm font-semibold text-zinc-100"
          data-testid="target-email-display"
        >
          {/* WHY JSX text: React escapes user-supplied email — no XSS risk. */}
          {targetEmail}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          The link expires after 24 hours. The admin_audit_log row is written
          before the email is sent — see Sentry if delivery fails.
        </p>
      </div>

      {/* Warning: audit recorded but link failed */}
      {hasWarning && (
        <div
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300"
          role="alert"
          data-testid="warning-box"
        >
          <strong>Warning:</strong> {state.warning}
        </div>
      )}

      {/* Reason (required) */}
      <div className="flex flex-col gap-1">
        <label htmlFor="reason" className="text-sm font-medium text-zinc-300">
          Reason <span className="text-red-400">*</span>
        </label>
        <textarea
          id="reason"
          name="reason"
          required
          rows={3}
          maxLength={500}
          disabled={isPending}
          placeholder="e.g. User locked out — confirmed identity via support ticket #1234"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50 resize-none"
          data-testid="reason-textarea"
          aria-invalid={state && !state.ok && state.field === 'reason' ? true : undefined}
          aria-describedby={state && !state.ok && state.field === 'reason' ? 'reason-error' : undefined}
        />
        {state && !state.ok && state.field === 'reason' && (
          <p id="reason-error" className="text-xs text-red-400" role="alert" data-testid="reason-error">{state.error}</p>
        )}
      </div>

      {/* Top-level error */}
      {state && !state.ok && !state.field && (
        <p
          className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400"
          role="alert"
          data-testid="form-error"
        >
          {state.error}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="submit-button"
      >
        {isPending ? 'Sending…' : 'Confirm — send reset link'}
      </button>
    </form>
  );
}
