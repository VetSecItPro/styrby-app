'use client';

/**
 * ToggleConsentForm — Client Component for the consent toggle action.
 *
 * Purpose:
 *   Allows a site admin to grant or revoke a per-user consent flag for a
 *   specific purpose (currently only 'support_read_metadata'). Shows the
 *   current consent state prominently so the admin understands what change
 *   they are making before submitting.
 *
 * WHY show current state:
 *   If the flag is already 'granted', submitting "grant" again is a no-op on
 *   the DB (the RPC sets granted_at and clears revoked_at idempotently), but
 *   it creates a redundant audit row. Showing the current state lets the admin
 *   make an intentional choice rather than guessing. SOC 2 CC6.1.
 *
 * WHY grant/revoke as radio buttons (not a toggle):
 *   A toggle requires the admin to infer intent from the current state.
 *   Explicit radio buttons make the desired end-state unambiguous — critical
 *   for consent operations where the audit must record clear intent.
 *
 * WHY "use client":
 *   Needs `useActionState` for pending state and inline error rendering.
 *
 * @param targetUserId - UUID of the target user (hidden field).
 * @param purpose - Consent purpose being toggled.
 * @param currentState - Current consent state: 'granted', 'revoked', or 'not_set'.
 */

import { useActionState } from 'react';
import type { AdminActionResult } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Valid consent purposes — mirrors the Postgres ENUM and Zod schema. */
type ConsentPurpose = 'support_read_metadata';

/** Human-readable labels for consent purposes. */
const PURPOSE_LABELS: Record<ConsentPurpose, string> = {
  support_read_metadata: 'Support read metadata',
};

export interface ToggleConsentFormProps {
  /** UUID of the target user. */
  targetUserId: string;
  /** Consent purpose to toggle. */
  purpose?: ConsentPurpose;
  /** Current consent state for the purpose. */
  currentState?: 'granted' | 'revoked' | 'not_set';
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
 * Form for the consent toggle action.
 *
 * Displays the current consent state at the top, then a purpose select
 * (currently only one option), grant/revoke radio group, and reason textarea.
 *
 * @param targetUserId - UUID of the target user.
 * @param purpose - Pre-selected consent purpose (defaults to 'support_read_metadata').
 * @param currentState - Current state of the selected purpose.
 */
export function ToggleConsentForm({
  targetUserId,
  purpose = 'support_read_metadata',
  currentState = 'not_set',
  action,
}: ToggleConsentFormProps) {
  // WHY wrapper: useActionState expects (prevState, formData) => result, but
  // our server action only needs formData. We ignore prevState here because
  // the server action is fully stateless — it computes the result from the
  // form submission alone and redirects on success.
  // WHY action prop (Fix B): the bound action already carries the trusted
  // URL userId as its first argument. We pass only FormData here.
  const [state, formAction, isPending] = useActionState<AdminActionResult | null, FormData>(
    (_prevState: AdminActionResult | null, formData: FormData) => action(formData),
    null
  );

  const currentStateColor =
    currentState === 'granted'
      ? 'text-green-400'
      : currentState === 'revoked'
        ? 'text-red-400'
        : 'text-zinc-500';

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4"
      data-testid="toggle-consent-form"
      aria-label="Toggle user consent flag"
    >
      {/* Hidden field: target user id */}
      <input type="hidden" name="targetUserId" value={targetUserId} />

      {/* Current state indicator */}
      <div
        className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3"
        data-testid="current-state-box"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Current state</p>
        <p className={`mt-1 text-sm font-semibold ${currentStateColor}`} data-testid="current-state-value">
          {currentState === 'granted'
            ? 'Granted'
            : currentState === 'revoked'
              ? 'Revoked'
              : 'Not set'}
        </p>
      </div>

      {/* Purpose select */}
      <div className="flex flex-col gap-1">
        <label htmlFor="purpose" className="text-sm font-medium text-zinc-300">
          Purpose
        </label>
        <select
          id="purpose"
          name="purpose"
          defaultValue={purpose}
          disabled={isPending}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          data-testid="purpose-select"
          aria-invalid={state && !state.ok && state.field === 'purpose' ? true : undefined}
          aria-describedby={state && !state.ok && state.field === 'purpose' ? 'purpose-error' : undefined}
        >
          {(Object.entries(PURPOSE_LABELS) as [ConsentPurpose, string][]).map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>
        {state && !state.ok && state.field === 'purpose' && (
          <p id="purpose-error" className="text-xs text-red-400" role="alert" data-testid="purpose-error">{state.error}</p>
        )}
      </div>

      {/* Grant / Revoke radio group */}
      {/*
        WHY explicit id + htmlFor on radio inputs (I3 fix):
        Implicit labels (wrapping <label>) are technically valid but explicit
        id + htmlFor associations are more robust for assistive technology,
        especially within a <fieldset>/<legend> context. T6 quality review #I3.
      */}
      <fieldset
        className="flex flex-col gap-2"
        aria-describedby={state && !state.ok && state.field === 'grant' ? 'grant-error' : undefined}
      >
        <legend className="text-sm font-medium text-zinc-300">
          Action <span className="text-red-400">*</span>
        </legend>

        <label
          htmlFor="grant-true"
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 px-4 py-2.5 hover:border-zinc-600"
        >
          <input
            id="grant-true"
            type="radio"
            name="grant"
            value="true"
            required
            disabled={isPending}
            defaultChecked={currentState !== 'granted'}
            className="accent-green-500"
            data-testid="radio-grant"
            aria-invalid={state && !state.ok && state.field === 'grant' ? true : undefined}
          />
          <span className="text-sm text-zinc-100">Grant</span>
          <span className="ml-auto text-xs text-zinc-500">Sets granted_at, clears revoked_at</span>
        </label>

        <label
          htmlFor="grant-false"
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 px-4 py-2.5 hover:border-zinc-600"
        >
          <input
            id="grant-false"
            type="radio"
            name="grant"
            value="false"
            required
            disabled={isPending}
            defaultChecked={currentState === 'granted'}
            className="accent-red-500"
            data-testid="radio-revoke"
            aria-invalid={state && !state.ok && state.field === 'grant' ? true : undefined}
          />
          <span className="text-sm text-zinc-100">Revoke</span>
          <span className="ml-auto text-xs text-zinc-500">Sets revoked_at, preserves granted_at</span>
        </label>

        {state && !state.ok && state.field === 'grant' && (
          <p id="grant-error" className="text-xs text-red-400" role="alert" data-testid="grant-error">{state.error}</p>
        )}
      </fieldset>

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
          placeholder="e.g. User submitted consent form via support ticket #5678"
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
        className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="submit-button"
      >
        {isPending ? 'Applying…' : 'Apply consent change'}
      </button>
    </form>
  );
}
