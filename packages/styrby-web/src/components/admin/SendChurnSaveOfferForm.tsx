'use client';

/**
 * SendChurnSaveOfferForm — Client Component for the admin churn-save offer action.
 *
 * Purpose:
 *   Renders a dense ops form that submits to a bound server action (T5). Provides
 *   client-side pending state, field-level error rendering. The offer kind is a
 *   radio group — discount percentages are hardcoded server-side and never
 *   controlled by the client.
 *
 * Security model:
 *   This form renders inside the admin layout gate. The action itself enforces
 *   authorization (RPC + SECURITY DEFINER). The discount_pct and duration_months
 *   are derived server-side from the kind enum — the client cannot inject arbitrary
 *   percentages.
 *
 * WHY "use client":
 *   We need `useActionState` (React 19) for pending/error state during submission.
 *
 * WHY kind radio (not hidden hardcoded values):
 *   The admin must choose the offer type. The form sends the kind enum string
 *   ("annual_3mo_25pct" | "monthly_1mo_50pct") — the server derives all financial
 *   values from the enum, so the client has no influence over percentages or duration.
 *
 * @param targetUserId - UUID of the target user (hidden field, bound server-side).
 * @param action - Bound server action (has userId pre-applied from the page).
 */

import { useActionState } from 'react';
import type { AdminActionResult } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SendChurnSaveOfferFormProps {
  /** UUID of the target user — passed as hidden field to the server action. */
  targetUserId: string;
  /**
   * Bound server action from the page — has the URL's trusted userId pre-applied.
   * Phase 4.1 T6 Fix B pattern.
   */
  action: (formData: FormData) => Promise<AdminActionResult>;
}

// ─── Offer kinds ──────────────────────────────────────────────────────────────

/**
 * Valid churn-save offer kinds — mirrors the `churn_offer_kind` Postgres enum
 * from migration 050. All financial values (discount_pct, duration_months) are
 * derived server-side from these keys; the client never controls them.
 */
const OFFER_KINDS = [
  {
    value: 'annual_3mo_25pct',
    label: 'Annual - 25% off for 3 months',
    description: 'For annual subscribers at risk of cancellation',
  },
  {
    value: 'monthly_1mo_50pct',
    label: 'Monthly - 50% off for 1 month',
    description: 'For monthly subscribers requesting a pause or downgrade',
  },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Form for the admin send-churn-save-offer action.
 *
 * Uses `useActionState` (React 19) to wire the server action to the form.
 * Radio group for offer kind; optional Polar discount code field; reason textarea.
 * Disables all inputs during pending state.
 *
 * @param targetUserId - UUID of target user.
 * @param action - Bound server action.
 */
export function SendChurnSaveOfferForm({ targetUserId, action }: SendChurnSaveOfferFormProps) {
  const [state, formAction, isPending] = useActionState<AdminActionResult | null, FormData>(
    // WHY action directly (no wrapper): no FormData coercion needed for this form.
    // The kind is a valid enum string, reason is plain text, discount code is optional text.
    (_prevState, formData) => action(formData),
    null
  );

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4"
      data-testid="send-churn-save-offer-form"
      aria-label="Send churn-save offer"
    >
      {/* Hidden: target user id */}
      <input type="hidden" name="targetUserId" value={targetUserId} />

      {/* Offer kind — radio group */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-zinc-300">
          Offer type <span className="text-red-400">*</span>
        </legend>

        <div
          aria-invalid={state && !state.ok && state.field === 'kind' ? true : undefined}
          aria-describedby={
            state && !state.ok && state.field === 'kind' ? 'kind-error' : undefined
          }
        >
          {OFFER_KINDS.map(({ value, label, description }) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors ${
                isPending ? 'opacity-50 cursor-not-allowed' : 'hover:border-zinc-600'
              } border-zinc-700`}
            >
              <input
                type="radio"
                name="kind"
                value={value}
                required
                disabled={isPending}
                defaultChecked={value === 'annual_3mo_25pct'}
                className="mt-0.5 shrink-0"
                data-testid={`kind-radio-${value}`}
              />
              <div>
                <p className="text-sm font-medium text-zinc-100">{label}</p>
                <p className="text-xs text-zinc-400">{description}</p>
              </div>
            </label>
          ))}
        </div>

        {state && !state.ok && state.field === 'kind' && (
          <p
            id="kind-error"
            className="text-xs text-red-400"
            role="alert"
            data-testid="kind-error"
          >
            {state.error}
          </p>
        )}
      </fieldset>

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
          placeholder="e.g. User expressed intent to cancel in support ticket #123 — offering win-back discount"
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

      {/* Optional Polar discount code */}
      <div className="flex flex-col gap-1">
        <label htmlFor="polar_discount_code" className="text-sm font-medium text-zinc-300">
          Polar discount code{' '}
          <span className="text-zinc-500 font-normal">(optional — create in Polar dashboard first)</span>
        </label>
        <input
          id="polar_discount_code"
          name="polar_discount_code"
          type="text"
          disabled={isPending}
          placeholder="SAVE25-ABC123"
          maxLength={100}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          data-testid="polar-discount-code-input"
          aria-invalid={
            state && !state.ok && state.field === 'polar_discount_code' ? true : undefined
          }
          aria-describedby={
            state && !state.ok && state.field === 'polar_discount_code'
              ? 'polar_discount_code-error'
              : undefined
          }
        />
        {state && !state.ok && state.field === 'polar_discount_code' && (
          <p
            id="polar_discount_code-error"
            className="text-xs text-red-400"
            role="alert"
            data-testid="polar_discount_code-error"
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
          {/* WHY 200-char cap: phishing defense against long injected error strings. */}
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
        {isPending ? 'Sending…' : 'Send churn-save offer'}
      </button>
    </form>
  );
}
