/**
 * InvitationsList Component
 *
 * Displays a paginated table of team invitations with Re-send and Revoke
 * actions for pending rows. Used in the team admin panel
 * (/dashboard/team/[teamId]/invitations).
 *
 * WHY pagination at 50 items:
 *   Teams with many invitations would have a large DOM if all rows were rendered.
 *   50 rows is a comfortable page size that avoids scroll fatigue.
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, RefreshCw, Trash2 } from 'lucide-react';
import { formatDistanceToNow, isPast } from 'date-fns';

// ============================================================================
// Types
// ============================================================================

/**
 * Invitation row data shape used by this component.
 * Matches the shape returned from the admin invitations page query.
 */
export interface InvitationRow {
  /** Primary key */
  id: string;
  /** Target email address */
  email: string;
  /** Role assigned at invitation time */
  role: 'admin' | 'member' | 'viewer';
  /** Current lifecycle status */
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  /** ISO timestamp when invitation was created */
  invited_at: string;
  /** ISO timestamp when invitation expires */
  expires_at: string;
  /** Team UUID (needed for action routes) */
  team_id: string;
}

/** Props for InvitationsList */
interface InvitationsListProps {
  /** All invitations to display (pagination handled internally) */
  invitations: InvitationRow[];
  /** Team UUID for API calls */
  teamId: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Max rows per page before pagination shows. */
const PAGE_SIZE = 50;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns a human-readable "expires in X" or "expired X ago" string.
 *
 * @param expiresAt - ISO expiry timestamp
 * @param status - Invitation status
 * @returns Human-readable expiry string
 */
function expiresLabel(expiresAt: string, status: string): string {
  if (status !== 'pending') return '-';
  const expiry = new Date(expiresAt);
  if (isPast(expiry)) return 'Expired';
  return `Expires in ${formatDistanceToNow(expiry)}`;
}

/**
 * Returns a Tailwind class for the status badge.
 *
 * @param status - Invitation status
 * @returns Tailwind color class string
 */
function statusBadgeClass(status: InvitationRow['status']): string {
  switch (status) {
    case 'pending': return 'bg-yellow-500/10 text-yellow-400';
    case 'accepted': return 'bg-green-500/10 text-green-400';
    case 'revoked': return 'bg-red-500/10 text-red-400';
    case 'expired': return 'bg-zinc-700 text-zinc-400';
    default: return 'bg-zinc-700 text-zinc-400';
  }
}

// ============================================================================
// Component
// ============================================================================

/**
 * Paginated table of team invitations.
 *
 * Shows Re-send and Revoke action buttons only for 'pending' rows.
 * Non-pending rows display status + relevant timestamps but no actions.
 *
 * WHY fetch calls are inline here (not passed as props from page.tsx):
 *   InvitationsList is already 'use client'. Passing server action stubs from
 *   the parent Server Component would create no-op props (void invitationId).
 *   Owning the fetch calls here keeps the action logic co-located with the UI
 *   and uses Next.js router.refresh() to invalidate stale server data.
 *
 * @param props - InvitationsListProps
 */
export function InvitationsList({ invitations }: InvitationsListProps) {
  const router = useRouter();
  const [page, setPage] = useState(0);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const totalPages = Math.ceil(invitations.length / PAGE_SIZE);
  const pageInvitations = invitations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  /**
   * Wraps an async action (resend/revoke) with loading state tracking.
   *
   * @param invitationId - UUID of the target invitation
   * @param action - Async function to execute
   */
  async function withLoading(invitationId: string, action: () => Promise<void>) {
    setActionLoading((prev) => ({ ...prev, [invitationId]: true }));
    setActionError(null);
    try {
      await action();
    } finally {
      setActionLoading((prev) => ({ ...prev, [invitationId]: false }));
    }
  }

  /**
   * Re-sends the invitation email with a fresh token.
   *
   * WHY router.refresh(): After a successful resend, the server-side invitation
   * row has a new token_hash + expires_at. router.refresh() re-fetches the
   * Server Component data without a full page reload.
   *
   * @param invitationId - UUID of the target invitation
   */
  async function handleResend(invitationId: string) {
    const res = await fetch(`/api/invitations/${invitationId}/resend`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string };
      setActionError(body.message ?? 'Failed to resend invitation. Please try again.');
      return;
    }
    router.refresh();
  }

  /**
   * Revokes the invitation after user confirmation.
   *
   * WHY confirm() before DELETE-equivalent action:
   *   Revoke is destructive — the recipient loses the ability to join. A
   *   confirmation dialog prevents accidental clicks in a dense table UI.
   *
   * @param invitationId - UUID of the target invitation
   */
  async function handleRevoke(invitationId: string) {
    if (!window.confirm('Revoke this invitation? The recipient will no longer be able to accept.')) {
      return;
    }
    const res = await fetch(`/api/invitations/${invitationId}/revoke`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string };
      setActionError(body.message ?? 'Failed to revoke invitation. Please try again.');
      return;
    }
    router.refresh();
  }

  if (invitations.length === 0) {
    return (
      <div className="text-center py-12">
        <Mail className="w-10 h-10 text-zinc-400 mx-auto mb-3" aria-hidden="true" />
        <p className="text-zinc-400">No invitations yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Action error banner */}
      {actionError && (
        <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300">
          {actionError}
        </div>
      )}
      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-400">
              <th className="text-left px-4 py-3 font-medium">Email</th>
              <th className="text-left px-4 py-3 font-medium">Role</th>
              <th className="text-left px-4 py-3 font-medium">Invited</th>
              <th className="text-left px-4 py-3 font-medium">Expires</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-right px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageInvitations.map((inv) => {
              const isLoading = actionLoading[inv.id] ?? false;
              const isPending = inv.status === 'pending';

              return (
                <tr key={inv.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                  {/* Email */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Mail className="w-4 h-4 text-zinc-500 flex-shrink-0" aria-hidden="true" />
                      <span className="text-zinc-200 truncate max-w-[200px]">{inv.email}</span>
                    </div>
                  </td>

                  {/* Role */}
                  <td className="px-4 py-3">
                    <span className="text-zinc-300 capitalize">{inv.role}</span>
                  </td>

                  {/* Invited at */}
                  <td className="px-4 py-3 text-zinc-400">
                    {formatDistanceToNow(new Date(inv.invited_at), { addSuffix: true })}
                  </td>

                  {/* Expires */}
                  <td className="px-4 py-3 text-zinc-400">
                    {expiresLabel(inv.expires_at, inv.status)}
                  </td>

                  {/* Status badge */}
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${statusBadgeClass(inv.status)}`}>
                      {inv.status}
                    </span>
                  </td>

                  {/* Actions (pending only) */}
                  <td className="px-4 py-3 text-right">
                    {isPending && (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          aria-label="Re-send invitation"
                          disabled={isLoading}
                          onClick={() => withLoading(inv.id, () => handleResend(inv.id))}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                          Re-send
                        </button>
                        <button
                          aria-label="Revoke invitation"
                          disabled={isLoading}
                          onClick={() => withLoading(inv.id, () => handleRevoke(inv.id))}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-zinc-400">
          <span>
            Page {page + 1} of {totalPages} ({invitations.length} total)
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
