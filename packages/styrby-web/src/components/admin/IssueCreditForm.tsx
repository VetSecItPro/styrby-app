'use client';

/**
 * IssueCreditForm — Client Component for the admin-initiated account credit action.
 *
 * Purpose:
 *   Renders a dense ops form that submits to a bound server action (T5). Provides
 *   client-side pending state, field-level error rendering, and dollar-to-cents
 *   conversion. Optional expiry normalised to ISO UTC before submission.
 *
 * Security model:
 *   This form renders inside the admin layout gate. The action itself enforces
 *   authorization (RPC + SECURITY DEFINER). No redundant client-side auth check.
 *
 * WHY "use client":
 *   We need `useActionState` (React 19) for pending/error state during submission.
 *   Actual mutation is server-side.
 *
 * WHY dollar→cents conversion here:
 *   The server action validates integer cents (Zod integer, 1–100000 = $1–$1000).
 *   Converting in the form means Zod receives a clean integer string.
 *
 * WHY normalizeDatetimeLocal (reused from OverrideTierForm pattern):
 *   `<input type="datetime-local">` emits "YYYY-MM-DDTHH:mm" (no offset). Zod's
 *   `z.string().datetime({ offset: true })` rejects this format. We coerce to a
 *   full ISO UTC string via `new Date().toISOString()` before submission.
 *
 * @param targetUserId - UUID of the target user (hidden field, bound server-side).
 * @param action - Bound server action (has userId pre-applied from the page).
 */

import { useActionState, useCallback } from 'react';
import type { AdminActionResult } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IssueCreditFormProps {
  /** UUID of the target user — passed as hidden field to the server action. */
  targetUserId: string;
  /**
   * Bound server action from the page — has the URL's trusted userId pre-applied.
   * Phase 4.1 T6 Fix B pattern.
   */
  action: (formData: FormData) => Promise<AdminActionResult>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum credit in cents ($1,000). Enforced by the server action RPC. */
const MAX_CREDIT_CENTS = 100_000;

/** Maximum credit in display dollars. */
const MAX_CREDIT_DOLLARS = MAX_CREDIT_CENTS / 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts a dollar string from the number input to integer cents.
 *
 * @param dollars - String value from the dollar input (e.g. "49.00")
 * @returns Integer cents, or NaN if the input is invalid
 */
export function dollarsToCents(dollars: string | null): number {
  if (!dollars) return NaN;
  const parsed = parseFloat(dollars);
  if (isNaN(parsed) || parsed <= 0) return NaN;
  return Math.round(parsed * 100);
}

/**
 * Coerces a `<input type="datetime-local">` value to a full ISO 8601 UTC string.
 *
 * WHY needed: `datetime-local` produces "YYYY-MM-DDTHH:mm" (no offset). Zod's
 * `z.string().datetime({ offset: true })` rejects this. Parsing through `new Date()`
 * interprets it in the browser's local timezone; `.toISOString()` converts to UTC.
 * Mirrors the normalizeDatetimeLocal helper from OverrideTierForm (Phase 4.1 T6 #I1).
 *
 * @param v - Value from a datetime-local input, or null/empty.
 * @returns Full ISO 8601 UTC string, or null if empty/invalid.
 */
export function normalizeDatetimeLocal(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Form for the admin issue-credit action.
 *
 * Uses `useActionState` (React 19) to wire the server action to the form.
 * Converts dollar input to cents and normalises expiry to ISO UTC before submission.
 * Disables all inputs during pending state.
 *
 * @param targetUserId - UUID of target user.
 * @param action - Bound server action.
 */
export function IssueCreditForm({ targetUserId, action }: IssueCreditFormProps) {
  // WHY wrapped action: coerce dollar amount to cents + normalize optional expiry
  // before the server action sees the FormData.
  const wrappedAction = useCallback(
    (_prevState: AdminActionResult | null, formData: FormData): Promise<AdminActionResult> => {
      // Dollar → cents
      const dollarsStr = formData.get('amount_dollars') as string | null;
      const cents = dollarsToCents(dollarsStr);
      if (isNaN(cents)) {
        return Promise.resolve({
          ok: false,
          error: 'Enter a valid dollar amount between $1.00 and $1,000.00',
          field: 'amount_dollars',
        });
      }
      formData.set('amount_cents', String(cents));

      // Normalize optional expiry datetime-local → ISO UTC
      const rawExpiry = formData.get('expires_at') as string | null;
      const normalized = normalizeDatetimeLocal(rawExpiry);
      if (normalized !== null) {
        formData.set('expires_at', normalized);
      } else {
        formData.delete('expires_at');
      }

      return action(formData);
    },
    [action]
  );

  const [state, formAction, isPending] = useActionState<AdminActionResult | null, FormData>(
    wrappedAction,
    null
  );

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4"
      data-testid="issue-credit-form"
      aria-label="Issue account credit"
    >
      {/* Hidden: target user id */}
      <input type="hidden" name="targetUserId" value={targetUserId} />

      {/* Amount in dollars */}
      <div className="flex flex-col gap-1">
        <label htmlFor="amount_dollars" className="text-sm font-medium text-zinc-300">
          Credit amount <span className="text-red-400">*</span>
          <span className="ml-2 text-zinc-500 font-normal text-xs">$1.00 – $1,000.00</span>
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400 text-sm">
            $
          </span>
          <input
            id="amount_dollars"
            name="amount_dollars"
            type="number"
            step="0.01"
            min="1.00"
            max={MAX_CREDIT_DOLLARS}
            required
            disabled={isPending}
            placeholder="10.00"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-7 pr-3 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
            data-testid="amount-input"
            aria-invalid={
              state && !state.ok && state.field === 'amount_dollars' ? true : undefined
            }
            aria-describedby={
              state && !state.ok && state.field === 'amount_dollars'
                ? 'amount_dollars-error'
                : undefined
            }
          />
        </div>
        {state && !state.ok && state.field === 'amount_dollars' && (
          <p
            id="amount_dollars-error"
            className="text-xs text-red-400"
            role="alert"
            data-testid="amount_dollars-error"
          >
            {state.error}
          </p>
        )}
      </div>

      {/* Reason */}
      <div className="flex flex-col gap-1">
        <label htmlFor="reason" className="text-sm font-medium text-zinc-300">
          Reason <span className="text-red-400">*</span>
        </label>
        <textarea
          id="reason"
          name="reason"
          required
          rows={3}
          minLength={10}
          maxLength={500}
          disabled={isPending}
          placeholder="e.g. Service disruption credit — outage on 2026-04-20"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50 resize-none"
          data-testid="reason-textarea"
          aria-invalid={state && !state.ok && state.field === 'reason' ? true : undefined}
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

      {/* Optional expiry */}
      <div className="flex flex-col gap-1">
        <label htmlFor="expires_at" className="text-sm font-medium text-zinc-300">
          Expires at{' '}
          <span className="text-zinc-500 font-normal">(optional — leave blank for no expiry)</span>
        </label>
        <input
          id="expires_at"
          name="expires_at"
          type="datetime-local"
          disabled={isPending}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          data-testid="expires-at-input"
          aria-invalid={state && !state.ok && state.field === 'expires_at' ? true : undefined}
          aria-describedby={
            state && !state.ok && state.field === 'expires_at' ? 'expires_at-error' : undefined
          }
        />
        {state && !state.ok && state.field === 'expires_at' && (
          <p
            id="expires_at-error"
            className="text-xs text-red-400"
            role="alert"
            data-testid="expires_at-error"
          >
            {state.error}
          </p>
        )}
      </div>

      {/* Top-level error (not field-specific) */}
      {state && !state.ok && !state.field && (
        <p
          className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400"
          role="alert"
          data-testid="form-error"
        >
          {/* WHY 200-char cap: phishing defense — prevents long injected error strings. */}
          {(state.error ?? '').slice(0, 200)}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="submit-button"
      >
        {isPending ? 'Issuing…' : 'Issue credit'}
      </button>
    </form>
  );
}
