'use client';

/**
 * OverrideTierForm — Client Component for the tier override action.
 *
 * Purpose:
 *   Renders a dense ops form that submits to `overrideTierAction`. Provides
 *   client-side pending state and inline error rendering. No animations —
 *   this is ops UI, not a marketing page.
 *
 * Security model:
 *   This form renders inside the admin layout (T3 gate). The action itself
 *   is a Next.js server action that enforces authorization at multiple layers.
 *   WHY no client-side auth check here: the admin layout + middleware have
 *   already confirmed the viewer is a site admin. Redundant checks here would
 *   create false confidence without adding security.
 *
 * WHY "use client":
 *   We need `useActionState` (React 19) and the disabled/pending state during
 *   submission. These require client-side React. The actual mutation runs on
 *   the server (server action); only the interaction layer is client-side.
 *
 * @param targetUserId - UUID of the user being acted upon (hidden field).
 * @param currentTier - Current tier shown as the default select value.
 */

import { useActionState, useRef, useCallback } from 'react';
import type { AdminActionResult } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── Datetime helpers ─────────────────────────────────────────────────────────

/**
 * Coerces a `<input type="datetime-local">` value to a full ISO 8601 UTC string.
 *
 * WHY needed (I1 fix):
 *   `<input type="datetime-local">` produces the format `"YYYY-MM-DDTHH:mm"` (no
 *   timezone offset). Zod's `z.string().datetime({ offset: true })` REJECTS this
 *   format, causing every non-empty expiresAt submission to fail validation silently.
 *   Parsing the local string through `new Date()` interprets it in the browser's
 *   local timezone and `toISOString()` converts it to UTC (`Z` suffix), which Zod
 *   accepts. T6 quality review #I1.
 *
 * @param v - Value from a datetime-local input, or null/empty if not set.
 * @returns A full ISO 8601 UTC string (e.g. `"2027-06-15T19:30:00.000Z"`), or null
 *   if the input is empty, null, or produces an invalid Date.
 */
export function normalizeDatetimeLocal(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OverrideTierFormProps {
  /** UUID of the target user — passed as a hidden field to the server action. */
  targetUserId: string;
  /** Current tier shown as the pre-selected option. */
  currentTier?: string;
  /**
   * Bound server action from the page — has the URL's trusted userId pre-applied
   * as the first argument. The form passes FormData as the second argument.
   *
   * WHY bound action (Fix B): the page binds `overrideTierAction.bind(null, userId)`
   * so the action receives the unforgeable URL param as `trustedUserId`. The form
   * cannot influence this value — it is set server-side before FormData is parsed.
   * Threat review round 2, Fix B.
   */
  action: (formData: FormData) => Promise<AdminActionResult>;
}

// ─── Tier options ─────────────────────────────────────────────────────────────

/** All valid tier values — mirrors the Zod schema in actions.ts. */
const TIER_OPTIONS: { value: string; label: string }[] = [
  { value: 'free', label: 'Free' },
  { value: 'pro', label: 'Pro' },
  { value: 'power', label: 'Power' },
  { value: 'team', label: 'Team' },
  { value: 'business', label: 'Business' },
  { value: 'enterprise', label: 'Enterprise' },
];

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Form for the tier override action.
 *
 * Uses `useActionState` (React 19) to wire the server action to the form.
 * On submission, the form is disabled with a text indicator.
 * On error, the error message renders inline above the submit button.
 *
 * @param targetUserId - UUID of the target user.
 * @param currentTier - Current tier pre-selected in the dropdown.
 */
export function OverrideTierForm({ targetUserId, currentTier = 'free', action }: OverrideTierFormProps) {
  // WHY wrapper: useActionState expects (prevState, formData) => result, but
  // our server action only needs formData. We ignore prevState here because
  // the server action is fully stateless — it computes the result from the
  // form submission alone and redirects on success.
  //
  // WHY normalizeDatetimeLocal (I1 fix):
  //   `<input type="datetime-local">` emits "YYYY-MM-DDTHH:mm" (no offset), which
  //   Zod's datetime({ offset: true }) rejects. We coerce it to a full ISO UTC
  //   string before passing to the server action. T6 quality review #I1.
  // WHY action in dependency array: the bound action is stable (created once on
  // the server and passed as a prop), but ESLint exhaustive-deps requires it.
  const wrappedAction = useCallback(
    (_prevState: AdminActionResult | null, formData: FormData): Promise<AdminActionResult> => {
      const raw = formData.get('expiresAt') as string | null;
      const normalized = normalizeDatetimeLocal(raw);
      // Mutate the FormData copy so the server action sees the coerced value.
      if (normalized !== null) {
        formData.set('expiresAt', normalized);
      } else {
        formData.delete('expiresAt');
      }
      // WHY action prop (Fix B): the bound action already carries the trusted
      // URL userId as its first argument. We pass only FormData here.
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
      data-testid="override-tier-form"
      aria-label="Override user tier"
    >
      {/* Hidden field: target user id */}
      <input type="hidden" name="targetUserId" value={targetUserId} />

      {/* Tier select */}
      <div className="flex flex-col gap-1">
        <label htmlFor="newTier" className="text-sm font-medium text-zinc-300">
          New tier
        </label>
        <select
          id="newTier"
          name="newTier"
          defaultValue={currentTier}
          disabled={isPending}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          data-testid="tier-select"
          aria-invalid={state && !state.ok && state.field === 'newTier' ? true : undefined}
          aria-describedby={state && !state.ok && state.field === 'newTier' ? 'newTier-error' : undefined}
        >
          {TIER_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {state && !state.ok && state.field === 'newTier' && (
          <p id="newTier-error" className="text-xs text-red-400" role="alert" data-testid="newTier-error">{state.error}</p>
        )}
      </div>

      {/* Expires at (optional) */}
      <div className="flex flex-col gap-1">
        <label htmlFor="expiresAt" className="text-sm font-medium text-zinc-300">
          Expires at <span className="text-zinc-500 font-normal">(optional — leave blank for permanent)</span>
        </label>
        <input
          id="expiresAt"
          name="expiresAt"
          type="datetime-local"
          disabled={isPending}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          data-testid="expires-at-input"
          aria-invalid={state && !state.ok && state.field === 'expiresAt' ? true : undefined}
          aria-describedby={state && !state.ok && state.field === 'expiresAt' ? 'expiresAt-error' : undefined}
        />
        {state && !state.ok && state.field === 'expiresAt' && (
          <p id="expiresAt-error" className="text-xs text-red-400" role="alert" data-testid="expiresAt-error">{state.error}</p>
        )}
      </div>

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
          placeholder="e.g. Sales deal — upgrade to enterprise for 90-day trial"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50 resize-none"
          data-testid="reason-textarea"
          aria-invalid={state && !state.ok && state.field === 'reason' ? true : undefined}
          aria-describedby={state && !state.ok && state.field === 'reason' ? 'reason-error' : undefined}
        />
        {state && !state.ok && state.field === 'reason' && (
          <p id="reason-error" className="text-xs text-red-400" role="alert" data-testid="reason-error">{state.error}</p>
        )}
      </div>

      {/* Top-level error (not field-specific) */}
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
        {isPending ? 'Applying…' : 'Apply tier override'}
      </button>
    </form>
  );
}
