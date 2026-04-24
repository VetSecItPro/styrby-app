'use client';

/**
 * ChurnSaveOfferCard — User-facing churn-save offer acceptance button.
 *
 * Phase 4.3 — Billing Ops T6
 *
 * This client component renders the "Accept offer" button for an active
 * churn_save_offer. It handles:
 *   - Large discount display (25% or 50%)
 *   - Duration text ("3 months" or "1 month")
 *   - Reason (200-char truncated)
 *   - Expiry countdown
 *   - Accept button with useTransition + pending state + role="alert" for errors
 *   - For non-active states: no button is rendered (parent page decides)
 *
 * Design decisions:
 *   - Only one action (accept) — no cancel/decline button here. Users can simply
 *     navigate away if they don't want the offer.
 *   - Button is disabled during the server action call to prevent double-submission.
 *   - Errors are surfaced inline with role="alert" for screen-reader support.
 *   - Button label is explicit ("Accept offer") per WCAG 2.1 SC 2.4.6.
 *
 * Security:
 *   - The accept action is bound server-side via `.bind(null, offerId)` so the
 *     offerId cannot be tampered through client-side FormData.
 *   - CSRF: Next.js 15 server actions enforce `Action-Origin` same-origin.
 *   - All Polar API calls happen server-side via the SECURITY DEFINER RPC —
 *     never in this client component.
 *
 * Accessibility:
 *   - role="alert" on the error banner for assertive screen-reader announcement.
 *   - aria-live="assertive" + aria-atomic="true" for full error announcement.
 *   - aria-busy on the button reflects the in-flight pending state.
 *   - aria-disabled mirrors the HTML disabled attribute for AT compatibility.
 *
 * @module components/billing/ChurnSaveOfferCard
 */

import { useTransition, useState } from 'react';
import type { AcceptOfferActionResult } from '@/app/billing/offer/[offerId]/actions';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Props for the ChurnSaveOfferCard component.
 */
export interface ChurnSaveOfferCardProps {
  /** The offer's primary key (for display / accessibility labeling). */
  offerId: number;

  /** Discount percentage (25 or 50). */
  discountPct: number;

  /** Discount duration in months (1 or 3). */
  durationMonths: number;

  /** ISO 8601 expiry timestamp. Used for the expiry display. */
  expiresAt: string;

  /**
   * Admin-supplied reason for the offer.
   * The parent page passes the full reason; this component truncates to 200 chars.
   * WHY truncate here too: defense-in-depth — even if the parent page skips truncation,
   * the client component never renders unbounded admin text.
   */
  reason: string;

  /**
   * Bound server action for accepting the offer.
   * WHY bound action (not plain function): the offerId is bound server-side in
   * the page component via `.bind(null, offerId)`. The client component receives
   * a callable action that has the correct offerId without needing to know it.
   * This prevents FormData-based offerId tampering.
   */
  acceptAction: () => Promise<AcceptOfferActionResult>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncates a string to a maximum character length, appending an ellipsis.
 *
 * @param text - The text to truncate.
 * @param maxLen - Maximum character count (default: 200).
 * @returns The truncated string, or the original if within the limit.
 */
function truncate(text: string, maxLen = 200): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/**
 * Formats a duration in months to a human-readable string.
 *
 * @param months - Number of months.
 * @returns Human-readable duration label.
 */
function formatDuration(months: number): string {
  return months === 1 ? '1 month' : `${months} months`;
}

/**
 * Formats an ISO 8601 date string for display.
 *
 * @param iso - ISO 8601 date string.
 * @returns Locale-formatted date + time string.
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders the "Accept offer" CTA card for an active churn-save offer.
 *
 * This component is only rendered by the parent page when the offer is in
 * the `active` state (not accepted, not revoked, not expired). It is not
 * responsible for rendering terminal-state information — the parent handles that.
 *
 * @example
 * // In a Server Component page:
 * const boundAccept = acceptOfferAction.bind(null, offerId);
 * <ChurnSaveOfferCard
 *   offerId={offer.id}
 *   discountPct={offer.discount_pct}
 *   durationMonths={offer.discount_duration_months}
 *   expiresAt={offer.expires_at}
 *   reason={offer.reason}
 *   acceptAction={boundAccept}
 * />
 */
export function ChurnSaveOfferCard({
  discountPct,
  durationMonths,
  expiresAt,
  reason,
  acceptAction,
}: ChurnSaveOfferCardProps) {
  const [isPending, startTransition] = useTransition();
  const [acceptError, setAcceptError] = useState<string | null>(null);

  /**
   * Handles the accept button click.
   *
   * WHY useTransition: marks the pending state during the server action call
   * without blocking the UI thread. The isPending flag disables the button
   * to prevent double-submission while the action is in-flight.
   *
   * On success: redirect() in the action throws a NEXT_REDIRECT error, which
   * Next.js catches and navigates to the offer page (now in accepted state).
   * This function never receives a success result — it only runs if the action
   * returns an error (redirect throws before returning).
   */
  function handleAccept() {
    setAcceptError(null);
    startTransition(async () => {
      const result = await acceptAction();
      // WHY check ok: redirect() throws internally so a successful accept
      // never reaches this line. If we get here, the action returned an error.
      if (!result.ok) {
        setAcceptError(result.error);
      }
    });
  }

  return (
    <div className="mt-6 space-y-4">
      {/* Summary reminder — discount + duration at a glance */}
      <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-5">
        <p className="text-center text-4xl font-extrabold text-indigo-300">
          {discountPct}% off
        </p>
        <p className="mt-1 text-center text-sm text-indigo-300/70">
          for {formatDuration(durationMonths)}
        </p>

        {/* Reason (truncated) */}
        {reason && (
          <p className="mt-4 text-center text-sm leading-relaxed text-zinc-400">
            {truncate(reason)}
          </p>
        )}

        {/* Expiry countdown */}
        <p className="mt-3 text-center text-xs text-zinc-500">
          Expires {formatDate(expiresAt)}
        </p>
      </div>

      {/* Error banner — role="alert" for assertive screen-reader announcement */}
      {acceptError && (
        <div
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
          data-testid="accept-error"
        >
          {acceptError}
        </div>
      )}

      {/* Accept button */}
      <button
        type="button"
        onClick={handleAccept}
        disabled={isPending}
        aria-disabled={isPending}
        aria-busy={isPending}
        data-testid="accept-button"
        className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? 'Accepting...' : 'Accept offer'}
      </button>

      <p className="text-center text-xs text-zinc-500">
        By accepting, you agree to the discounted subscription terms.
        You can cancel anytime after the promotional period.
      </p>
    </div>
  );
}
