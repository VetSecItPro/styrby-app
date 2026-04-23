'use client';

/**
 * Invite Actions Client Component
 *
 * Handles the accept action for team invitations.
 * POSTs to /api/invitations/accept (Unit B route) which performs the DB
 * transaction, role mapping, and audit log server-side.
 *
 * WHY we POST to the API route instead of calling supabase.rpc directly:
 *   The old `accept_team_invitation` RPC (Phase 2.1) doesn't apply
 *   INVITE_ROLE_TO_MEMBER_ROLE, doesn't use timing-safe token comparison,
 *   and doesn't write the Phase 2.2 audit_log action. The new API route
 *   encapsulates all these concerns correctly.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface InviteActionsProps {
  token: string;
  teamName: string;
}

/**
 * Renders Accept and Decline buttons for a pending invitation.
 *
 * @param token - The raw invitation token from the URL
 * @param teamName - Display name of the team (for redirect URL)
 */
export function InviteActions({ token, teamName }: InviteActionsProps) {
  const router = useRouter();
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Accepts the team invitation via the /api/invitations/accept route.
   *
   * WHY API route instead of direct Supabase RPC:
   *   The accept route performs timing-safe token comparison, maps invitation
   *   roles through INVITE_ROLE_TO_MEMBER_ROLE, and writes audit_log correctly.
   *   The old RPC does not implement Phase 2.2 security requirements.
   */
  async function handleAccept() {
    setIsAccepting(true);
    setError(null);

    try {
      const response = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const data = await response.json();

      if (!response.ok) {
        const message =
          data?.message ??
          data?.error ??
          'Failed to accept invitation. Please try again.';
        setError(message);
        setIsAccepting(false);
        return;
      }

      // On success, redirect to team dashboard
      router.push(`/dashboard/team/${data.team_id}?joined=${encodeURIComponent(teamName)}`);
    } catch (err) {
      console.error('[InviteActions] Error accepting invitation:', err);
      setError('An unexpected error occurred. Please try again.');
      setIsAccepting(false);
    }
  }

  /**
   * Navigates away without accepting. No DB mutation - the invitation remains
   * pending until it expires or is revoked.
   *
   * WHY no "decline" DB mutation: Decline is not in the Phase 2.2 scope.
   * Invitations expire after 24h. A dedicated decline endpoint is Phase 2.3.
   */
  function handleDecline() {
    router.push('/dashboard');
  }

  return (
    <div className="mt-6 space-y-4">
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <button
        onClick={handleAccept}
        disabled={isAccepting}
        className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-500/50 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
      >
        {isAccepting ? (
          <>
            <svg
              className="w-5 h-5 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            Joining...
          </>
        ) : (
          <>
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            Accept Invitation
          </>
        )}
      </button>

      <button
        onClick={handleDecline}
        disabled={isAccepting}
        className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800/50 disabled:cursor-not-allowed text-zinc-300 px-6 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
      >
        Decline
      </button>
    </div>
  );
}
