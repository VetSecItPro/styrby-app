'use client';

/**
 * RequestSupportAccessForm — Client Component for the support session access request.
 *
 * Purpose:
 *   Presents the form for an admin to select a user session, enter a reason,
 *   and choose an expiry window for a support access grant. The form submits
 *   to the `requestSupportAccessAction` server action.
 *
 * Security (carryover from T2 threat review):
 *   - reason is validated client-side (non-blank + min 10 chars) to mirror
 *     server-side Zod validation, reducing unnecessary round-trips.
 *   - expires_in_hours is validated client-side to the [1, 168] range.
 *   - session_id select is scoped to the target user's sessions only — the
 *     parent page is responsible for fetching and passing only sessions
 *     belonging to the ticket's user_id. This prevents cross-user wiring.
 *   - The raw token is NEVER in this component. It flows through a server-set
 *     cookie to the success page only.
 *
 * Accessibility:
 *   - aria-invalid on errored inputs.
 *   - aria-describedby linking errored inputs to their error message elements.
 *   - role="alert" on all error messages for screen-reader announcement.
 *   - Form has aria-label for landmark navigation.
 *
 * WHY "use client":
 *   Needs `useActionState` for pending state and inline error rendering without
 *   a full-page reload.
 *
 * @param sessions       - User sessions available for selection (scoped to ticket user).
 * @param action         - Bound server action from the page (trustedTicketId pre-applied).
 * @param backHref       - URL for the "Cancel" link to return to the ticket.
 * @param expiryWindowHr - The selected expiry in hours, shown in the expiry info callout.
 */

import { useActionState, useState } from 'react';
import Link from 'next/link';
import type { SupportAccessActionResult } from '@/app/dashboard/admin/support/[id]/actions';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A session selectable for support access — scoped to the ticket's user. */
export interface SelectableSession {
  /** UUID of the session. */
  id: string;
  /** Display label shown in the dropdown (e.g., "Claude Code — 2026-04-23"). */
  label: string;
}

export interface RequestSupportAccessFormProps {
  /**
   * Sessions belonging to the ticket's user (last 30 days).
   * WHY caller-scoped: server page fetches sessions filtered by ticket.user_id.
   * This component never fetches its own data — it trusts the parent's query.
   * If the admin somehow sends a session_id for a different user, the RPC
   * raises 22023 (cross-user session) as a defence-in-depth check.
   */
  sessions: SelectableSession[];
  /**
   * Bound server action — has the ticket ID pre-applied via .bind().
   * The form passes FormData as the second argument.
   *
   * WHY bound action (Fix B pattern from Phase 4.1 T6): prevents forensic
   * integrity issues where a tampered hidden field causes the action to
   * operate on a different ticket than the URL.
   */
  action: (formData: FormData) => Promise<SupportAccessActionResult>;
  /** URL to navigate back to on Cancel. */
  backHref: string;
}

// ─── Expiry options ───────────────────────────────────────────────────────────

/** Selectable expiry windows for the grant. Default = 24h per spec. */
const EXPIRY_OPTIONS = [
  { value: '1', label: '1 hour' },
  { value: '4', label: '4 hours' },
  { value: '8', label: '8 hours' },
  { value: '24', label: '24 hours (default)' },
  { value: '48', label: '48 hours' },
  { value: '72', label: '72 hours' },
  { value: '168', label: '7 days (maximum)' },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Form component for the support session access request.
 *
 * Renders:
 *   1. Session select — scoped to the ticket's user.
 *   2. Reason textarea (10-500 chars).
 *   3. Expiry select with [1-168] hours, default 24h.
 *   4. Expiry callout showing the admin exactly when the grant expires.
 *   5. Field-level and top-level error rendering.
 *   6. Cancel + Submit buttons.
 *
 * Client-side validation mirrors server-side Zod constraints to give immediate
 * feedback without a round-trip. Server validation is still the authoritative gate.
 *
 * @param sessions - User sessions for the dropdown.
 * @param action   - Bound server action from the page.
 * @param backHref - Cancel link destination.
 */
export function RequestSupportAccessForm({
  sessions,
  action,
  backHref,
}: RequestSupportAccessFormProps) {
  // WHY useActionState wrapper: server action signature is (FormData) → result
  // after binding. useActionState expects (prevState, FormData) → result.
  // We ignore prevState since the action is fully stateless.
  const [state, formAction, isPending] = useActionState<
    SupportAccessActionResult | null,
    FormData
  >((_prev: SupportAccessActionResult | null, formData: FormData) => action(formData), null);

  // WHY local expiry state: we need to read the selected expiry to show the
  // admin the exact expiry window in the callout before they submit.
  const [expiryHours, setExpiryHours] = useState<number>(24);

  // Derive the expiry datetime string for the callout display.
  const expiryAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);
  const expiryDisplay = expiryAt.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <form
      action={formAction}
      className="flex flex-col gap-5"
      data-testid="request-access-form"
      aria-label="Request support session access"
    >
      {/* ── Session select ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="session_id" className="text-sm font-medium text-zinc-300">
          Session <span className="text-red-400" aria-hidden="true">*</span>
        </label>

        {sessions.length === 0 ? (
          <p className="text-sm text-zinc-400" data-testid="no-sessions-message">
            No sessions found in the last 30 days for this user.
          </p>
        ) : (
          <select
            id="session_id"
            name="session_id"
            required
            disabled={isPending}
            defaultValue=""
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
            data-testid="session-select"
            aria-invalid={
              state && !state.ok && state.field === 'session_id' ? true : undefined
            }
            aria-describedby={
              state && !state.ok && state.field === 'session_id'
                ? 'session_id-error'
                : undefined
            }
          >
            <option value="" disabled>
              Select a session...
            </option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}

        {state && !state.ok && state.field === 'session_id' && (
          <p
            id="session_id-error"
            className="text-xs text-red-400"
            role="alert"
            data-testid="session_id-error"
          >
            {state.error}
          </p>
        )}
      </div>

      {/* ── Reason textarea ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="reason" className="text-sm font-medium text-zinc-300">
          Reason <span className="text-red-400" aria-hidden="true">*</span>
        </label>
        <p className="text-xs text-zinc-400">
          Explain why you need access to this session. This is recorded in the audit log
          and shown to the user. (10-500 characters)
        </p>
        <textarea
          id="reason"
          name="reason"
          required
          rows={4}
          minLength={10}
          maxLength={500}
          disabled={isPending}
          placeholder="e.g. User reported unexpected cost spike — reviewing session metadata to diagnose tool call pattern."
          className="resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
          data-testid="reason-textarea"
          aria-invalid={
            state && !state.ok && state.field === 'reason' ? true : undefined
          }
          aria-describedby={
            state && !state.ok && state.field === 'reason' ? 'reason-error' : undefined
          }
        />
        {state && !state.ok && state.field === 'reason' && (
          <p
            id="reason-error"
            className="text-xs text-red-400"
            role="alert"
            data-testid="reason-error"
          >
            {state.error}
          </p>
        )}
      </div>

      {/* ── Expiry select ───────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="expires_in_hours" className="text-sm font-medium text-zinc-300">
          Access window
        </label>
        <select
          id="expires_in_hours"
          name="expires_in_hours"
          disabled={isPending}
          defaultValue="24"
          onChange={(e) => setExpiryHours(parseInt(e.target.value, 10))}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
          data-testid="expiry-select"
          aria-invalid={
            state && !state.ok && state.field === 'expires_in_hours' ? true : undefined
          }
          aria-describedby={
            state && !state.ok && state.field === 'expires_in_hours'
              ? 'expires_in_hours-error'
              : undefined
          }
        >
          {EXPIRY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {state && !state.ok && state.field === 'expires_in_hours' && (
          <p
            id="expires_in_hours-error"
            className="text-xs text-red-400"
            role="alert"
            data-testid="expires_in_hours-error"
          >
            {state.error}
          </p>
        )}
      </div>

      {/* ── Expiry callout ──────────────────────────────────────────────── */}
      {/* WHY show expiry window explicitly: spec carryover from T2 threat review.
          Admin must see the exact expiry datetime before submitting so they
          choose an appropriate window. Prevents accidentally granting 7-day
          access for a quick debug session. */}
      <div
        className="rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-3"
        data-testid="expiry-callout"
        role="region"
        aria-label="Access expiry window"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          Grant will expire at
        </p>
        <p
          className="mt-1 font-mono text-sm font-semibold text-zinc-100"
          data-testid="expiry-datetime"
        >
          {expiryDisplay}
        </p>
        <p className="mt-1 text-xs text-zinc-400">
          ({expiryHours} hour{expiryHours === 1 ? '' : 's'} from submission)
        </p>
      </div>

      {/* ── Top-level error ─────────────────────────────────────────────── */}
      {state && !state.ok && !state.field && (
        <p
          className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400"
          role="alert"
          data-testid="form-error"
        >
          {/*
            WHY truncate at 200 chars in display:
            The error message may contain user-supplied reason text echoed back
            in a validation error. We truncate to defang any reflective content
            that could be used for social engineering. The actual reason is in
            the form field where the admin can edit it.
          */}
          {(state.error ?? '').slice(0, 200)}
        </p>
      )}

      {/* ── Action row ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <Link
          href={backHref}
          className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
          data-testid="cancel-link"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={isPending || sessions.length === 0}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="submit-button"
        >
          {isPending ? 'Requesting…' : 'Request access'}
        </button>
      </div>
    </form>
  );
}
