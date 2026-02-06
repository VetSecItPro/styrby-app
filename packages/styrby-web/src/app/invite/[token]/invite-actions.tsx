'use client';

/**
 * Invite Actions Client Component
 *
 * Handles the accept/decline actions for team invitations.
 * Uses client-side state for loading and error handling.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

interface InviteActionsProps {
  token: string;
  teamName: string;
}

export function InviteActions({ token, teamName }: InviteActionsProps) {
  const router = useRouter();
  const [isAccepting, setIsAccepting] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Creates a Supabase client for browser-side operations.
   */
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  /**
   * Accepts the team invitation using the database function.
   */
  async function handleAccept() {
    setIsAccepting(true);
    setError(null);

    try {
      const { data, error: rpcError } = await supabase.rpc('accept_team_invitation', {
        p_invitation_token: token,
      });

      if (rpcError) {
        console.error('Failed to accept invitation:', rpcError);
        setError('Failed to accept invitation. Please try again.');
        setIsAccepting(false);
        return;
      }

      // Check the result
      const result = data?.[0];
      if (!result?.success) {
        setError(result?.message || 'Failed to accept invitation.');
        setIsAccepting(false);
        return;
      }

      // Redirect to the team page
      router.push(`/team?joined=${encodeURIComponent(teamName)}`);
    } catch (err) {
      console.error('Error accepting invitation:', err);
      setError('An unexpected error occurred. Please try again.');
      setIsAccepting(false);
    }
  }

  /**
   * Declines the team invitation.
   */
  async function handleDecline() {
    setIsDeclining(true);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from('team_invitations')
        .update({ status: 'declined', responded_at: new Date().toISOString() })
        .eq('token', token);

      if (updateError) {
        console.error('Failed to decline invitation:', updateError);
        setError('Failed to decline invitation. Please try again.');
        setIsDeclining(false);
        return;
      }

      // Redirect to dashboard
      router.push('/dashboard');
    } catch (err) {
      console.error('Error declining invitation:', err);
      setError('An unexpected error occurred. Please try again.');
      setIsDeclining(false);
    }
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
        disabled={isAccepting || isDeclining}
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
        disabled={isAccepting || isDeclining}
        className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800/50 disabled:cursor-not-allowed text-zinc-300 px-6 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
      >
        {isDeclining ? (
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
            Declining...
          </>
        ) : (
          'Decline'
        )}
      </button>
    </div>
  );
}
