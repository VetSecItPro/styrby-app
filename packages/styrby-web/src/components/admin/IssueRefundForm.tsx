'use client';

/**
 * IssueRefundForm — Client Component for the admin-initiated refund action.
 *
 * Purpose:
 *   Renders a dense ops form that submits to a bound server action (T5). Provides
 *   client-side pending state, field-level error rendering, and dollar-to-cents
 *   conversion so admins type natural "$X.XX" amounts.
 *
 * Security model:
 *   This form renders inside the admin layout gate. The action itself enforces
 *   authorization at the server level (RPC + SECURITY DEFINER). No client-side
 *   auth check here — the layout + middleware have already confirmed site admin.
 *
 * WHY "use client":
 *   We need `useActionState` (React 19) for pending/error state during submission.
 *   The actual mutation runs server-side (server action); only the interaction
 *   layer is client-side.
 *
 * WHY dollar→cents conversion in the form (not the action):
 *   The action expects integer cents (Zod integer, 1–500000). The form displays
 *   a dollar input for usability ($0.01 – $5000). We convert to cents before
 *   FormData submission so the server action never receives a float string that
 *   Zod would reject with a confusing error.
 *
 * @param targetUserId - UUID of the target user (hidden field, bound server-side).
 * @param subscriptionOptions - Array of { id, label } for the subscription/order select.
 * @param action - Bound server action (has userId pre-applied from the page).
 */

import { useActionState, useCallback } from 'react';
import type { AdminActionResult } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SubscriptionOption {
  /** Polar subscription or order ID. */
  id: string;
  /** Human-readable label shown in the select dropdown. */
  label: string;
}

export interface IssueRefundFormProps {
  /** UUID of the target user — passed as hidden field to the server action. */
  targetUserId: string;
  /**
   * Subscription options fetched server-side from Polar / subscriptions table.
   * Passed as prop because the form is a Client Component and cannot DB-fetch.
   */
  subscriptionOptions: SubscriptionOption[];
  /**
   * Bound server action from the page — has the URL's trusted userId pre-applied.
   * WHY bound: prevents form-tampered hidden userId from bypassing the audit trail.
   * Phase 4.1 T6 Fix B pattern.
   */
  action: (formData: FormData) => Promise<AdminActionResult>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum refund in cents ($5,000). Enforced by the server action RPC. */
const MAX_REFUND_CENTS = 500_000;

/** Maximum refund in display dollars. */
const MAX_REFUND_DOLLARS = MAX_REFUND_CENTS / 100;

// ─── Dollar → cents helper ────────────────────────────────────────────────────

/**
 * Converts a dollar string from the number input to integer cents.
 *
 * WHY convert here (not server-side): the server action validates integer cents.
 * Converting in the form wrapper means Zod sees "4900" not "49.00", avoiding
 * float-string validation failures.
 *
 * @param dollars - String value from the dollar input (e.g. "49.00" or "49")
 * @returns Integer cents, or NaN if the input is not a valid positive number
 */
export function dollarsToCents(dollars: string | null): number {
  if (!dollars) return NaN;
  const parsed = parseFloat(dollars);
  if (isNaN(parsed) || parsed <= 0) return NaN;
  // Round to avoid floating-point precision issues ($0.01 → 1, not 0.9999...).
  return Math.round(parsed * 100);
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Form for the admin issue-refund action.
 *
 * Uses `useActionState` (React 19) to wire the server action to the form.
 * Converts dollar input to cents before submission. Disables all inputs during
 * pending state. Renders field-level errors with aria-invalid / aria-describedby.
 *
 * @param targetUserId - UUID of target user.
 * @param subscriptionOptions - Subscription select options (fetched server-side).
 * @param action - Bound server action.
 */
export function IssueRefundForm({
  targetUserId,
  subscriptionOptions,
  action,
}: IssueRefundFormProps) {
  // WHY wrapped action: useActionState expects (prevState, formData) => result.
  // We intercept FormData to coerce the dollar amount to cents before the action
  // sees it, so the Zod schema receives a clean integer string.
  const wrappedAction = useCallback(
    (_prevState: AdminActionResult | null, formData: FormData): Promise<AdminActionResult> => {
      const dollarsStr = formData.get('amount_dollars') as string | null;
      const cents = dollarsToCents(dollarsStr);
      if (isNaN(cents)) {
        // Return a synthetic field error so the form renders it immediately
        // without a server round-trip.
        return Promise.resolve({
          ok: false,
          error: 'Enter a valid dollar amount between $0.01 and $5,000.00',
          field: 'amount_dollars',
        });
      }
      formData.set('amount_cents', String(cents));
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
      data-testid="issue-refund-form"
      aria-label="Issue refund"
    >
      {/* Hidden: target user id */}
      <input type="hidden" name="targetUserId" value={targetUserId} />

      {/* Subscription / order select */}
      <div className="flex flex-col gap-1">
        <label htmlFor="subscriptionId" className="text-sm font-medium text-zinc-300">
          Subscription or order <span className="text-red-400">*</span>
        </label>
        <select
          id="subscriptionId"
          name="subscriptionId"
          required
          disabled={isPending}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          data-testid="subscription-select"
          aria-invalid={state && !state.ok && state.field === 'subscriptionId' ? true : undefined}
          aria-describedby={state && !state.ok && state.field === 'subscriptionId' ? 'subscriptionId-error' : undefined}
        >
          <option value="">Select subscription or order…</option>
          {subscriptionOptions.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        {state && !state.ok && state.field === 'subscriptionId' && (
          <p id="subscriptionId-error" className="text-xs text-red-400" role="alert" data-testid="subscriptionId-error">
            {state.error}
          </p>
        )}
      </div>

      {/* Amount in dollars */}
      <div className="flex flex-col gap-1">
        <label htmlFor="amount_dollars" className="text-sm font-medium text-zinc-300">
          Amount <span className="text-red-400">*</span>
          <span className="ml-2 text-zinc-500 font-normal text-xs">Max $5,000.00</span>
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400 text-sm">$</span>
          <input
            id="amount_dollars"
            name="amount_dollars"
            type="number"
            step="0.01"
            min="0.01"
            max={MAX_REFUND_DOLLARS}
            required
            disabled={isPending}
            placeholder="0.00"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-7 pr-3 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
            data-testid="amount-input"
            aria-invalid={state && !state.ok && state.field === 'amount_dollars' ? true : undefined}
            aria-describedby={
              state && !state.ok && state.field === 'amount_dollars'
                ? 'amount_dollars-error'
                : 'amount-hint'
            }
          />
        </div>
        <p id="amount-hint" className="text-xs text-zinc-500">
          Max $5,000 per refund (500,000 cents enforced server-side)
        </p>
        {state && !state.ok && state.field === 'amount_dollars' && (
          <p id="amount_dollars-error" className="text-xs text-red-400" role="alert" data-testid="amount_dollars-error">
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
          placeholder="e.g. Customer request — accidental duplicate charge on 2026-04-15"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50 resize-none"
          data-testid="reason-textarea"
          aria-invalid={state && !state.ok && state.field === 'reason' ? true : undefined}
          aria-describedby={state && !state.ok && state.field === 'reason' ? 'reason-error' : undefined}
        />
        {state && !state.ok && state.field === 'reason' && (
          <p id="reason-error" className="text-xs text-red-400" role="alert" data-testid="reason-error">
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
          {/* WHY 200-char truncation: prevents phishing via long injected error strings
              rendered in the DOM. Server errors are safe (our own strings), but we
              cap defensively. Phase 4.1 T6 pattern. */}
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
        {isPending ? 'Issuing…' : 'Issue refund'}
      </button>
    </form>
  );
}
