'use client';

/**
 * GrantApprovalCard — User-facing support access grant action buttons.
 *
 * Phase 4.2 — Support Tooling T5
 *
 * This client component renders the approve and revoke buttons for a
 * support_access_grant in the `pending` or `approved` state.
 *
 * Design decisions:
 *   - Approve and Revoke/Deny are separate forms with distinct server actions.
 *     This ensures each button triggers an explicit POST (GDPR Art. 7 — no
 *     auto-approve via query params or GET requests).
 *   - Buttons are disabled during form submission to prevent double-submission.
 *   - Errors are surfaced inline with role="alert" for screen-reader support.
 *   - Button labels are explicit ("Approve access" / "Revoke access" / "Deny access")
 *     to meet WCAG 2.1 SC 2.4.6 (Labels or Instructions).
 *
 * Security:
 *   - The raw support access token is NEVER displayed or accessible to the user.
 *   - The actions (.bind) bind the grantId server-side — FormData cannot override it.
 *   - CSRF: Next.js 15 server actions enforce `Action-Origin` same-origin.
 *
 * @module components/support/GrantApprovalCard
 */

import { useTransition, useState } from 'react';
import type { UserSupportAccessActionResult } from '@/app/support/access/[grantId]/actions';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Grant status values that are valid for user-facing action buttons.
 * Terminal states (`expired`, `consumed`) only display information — no buttons.
 */
export type GrantStatus = 'pending' | 'approved' | 'revoked' | 'expired' | 'consumed';

/**
 * Props for the GrantApprovalCard component.
 */
export interface GrantApprovalCardProps {
  /** The current status of the grant. */
  status: GrantStatus;

  /**
   * Bound server action for approving the grant.
   * WHY bound action (not plain function): the grantId is bound server-side in
   * the page component via `.bind(null, grantId)`. The client component receives
   * a callable action that has the correct grantId without needing to know it.
   * This prevents FormData-based grantId tampering.
   */
  approveAction: () => Promise<UserSupportAccessActionResult>;

  /**
   * Bound server action for revoking the grant.
   * Same binding rationale as approveAction.
   */
  revokeAction: () => Promise<UserSupportAccessActionResult>;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders approve/deny/revoke buttons for a support access grant.
 *
 * State machine:
 *   pending  → shows "Approve access" + "Deny access" buttons
 *   approved → shows "Revoke access" button
 *   (all other states) → null (no buttons — parent page renders status info only)
 *
 * @example
 * // In a Server Component page:
 * const boundApprove = approveAction.bind(null, grantId);
 * const boundRevoke = revokeAction.bind(null, grantId);
 * <GrantApprovalCard
 *   status={grant.status}
 *   approveAction={boundApprove}
 *   revokeAction={boundRevoke}
 * />
 */
export function GrantApprovalCard({
  status,
  approveAction,
  revokeAction,
}: GrantApprovalCardProps) {
  const [isPendingApprove, startApproveTransition] = useTransition();
  const [isPendingRevoke, startRevokeTransition] = useTransition();
  const [approveError, setApproveError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // WHY no buttons for terminal states: expired, consumed, and revoked grants
  // cannot be acted upon. The parent Server Component renders appropriate
  // informational text for those states; this component only handles interactive states.
  if (status !== 'pending' && status !== 'approved') {
    return null;
  }

  /**
   * Handles the approve form submission.
   *
   * WHY useTransition: marks the pending state during the server action call
   * without blocking the UI thread. The isPendingApprove flag disables the
   * button to prevent double-submission while the action is in-flight.
   */
  function handleApprove() {
    setApproveError(null);
    startApproveTransition(async () => {
      const result = await approveAction();
      // WHY check ok: redirect() throws internally so a successful approve
      // never reaches this line. If we get here, the action returned an error.
      if (!result.ok) {
        setApproveError(result.error);
      }
    });
  }

  /**
   * Handles the revoke/deny form submission.
   *
   * WHY idempotent: the revokeAction RPC treats terminal states as a no-op,
   * so clicking "Revoke" twice is harmless. The button is still disabled
   * during the transition to prevent UI confusion.
   */
  function handleRevoke() {
    setRevokeError(null);
    startRevokeTransition(async () => {
      const result = await revokeAction();
      if (!result.ok) {
        setRevokeError(result.error);
      }
    });
  }

  const isAnyPending = isPendingApprove || isPendingRevoke;

  return (
    <div className="mt-6 space-y-3">
      {/* ── Error banners ───────────────────────────────────────────────── */}
      {approveError && (
        <div
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
          data-testid="approve-error"
        >
          {approveError}
        </div>
      )}
      {revokeError && (
        <div
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
          data-testid="revoke-error"
        >
          {revokeError}
        </div>
      )}

      {/* ── Action buttons ───────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row">
        {status === 'pending' && (
          <>
            {/* Approve button — affirmative action required (GDPR Art. 7) */}
            <button
              type="button"
              onClick={handleApprove}
              disabled={isAnyPending}
              aria-disabled={isAnyPending}
              aria-busy={isPendingApprove}
              data-testid="approve-button"
              className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPendingApprove ? 'Approving...' : 'Approve access'}
            </button>

            {/* Deny button — same as revoke semantics (sets status=revoked) */}
            <button
              type="button"
              onClick={handleRevoke}
              disabled={isAnyPending}
              aria-disabled={isAnyPending}
              aria-busy={isPendingRevoke}
              data-testid="deny-button"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-semibold text-zinc-300 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPendingRevoke ? 'Denying...' : 'Deny access'}
            </button>
          </>
        )}

        {status === 'approved' && (
          /* Revoke button — available for already-approved grants */
          <button
            type="button"
            onClick={handleRevoke}
            disabled={isAnyPending}
            aria-disabled={isAnyPending}
            aria-busy={isPendingRevoke}
            data-testid="revoke-button"
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-400 transition-colors hover:bg-red-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPendingRevoke ? 'Revoking...' : 'Revoke access'}
          </button>
        )}
      </div>
    </div>
  );
}
