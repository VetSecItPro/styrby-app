/**
 * Team Invitation Accept Page
 *
 * Handles the flow when a user clicks an invitation link from their email.
 * - If logged in: Shows invitation details and accept/decline buttons
 * - If not logged in: Redirects to login with return URL
 * - If invitation is expired/invalid: Shows appropriate error
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { InviteActions } from './invite-actions';

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

/**
 * Formats an ISO date string to a human-readable format.
 *
 * @param isoDate - ISO 8601 date string
 * @returns Formatted date like "February 6, 2026 at 2:30 PM"
 */
function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const supabase = await createClient();

  // Check if user is logged in
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Redirect to login with return URL
    redirect(`/login?redirect=/invite/${token}`);
  }

  // Fetch invitation details
  // WHY: We select invited_by as a direct UUID column (not a relation)
  // because it references auth.users which isn't accessible via Supabase
  // client-side queries. We look up the inviter's profile separately.
  const { data: invitation, error } = await supabase
    .from('team_invitations')
    .select(`
      id,
      email,
      role,
      status,
      expires_at,
      created_at,
      invited_by,
      team:teams (
        id,
        name,
        description
      )
    `)
    .eq('token', token)
    .single();

  // Handle various error states
  if (error || !invitation) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-zinc-900 rounded-2xl p-8 text-center">
          <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg
              className="w-8 h-8 text-red-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-zinc-100 mb-2">
            Invitation Not Found
          </h1>
          <p className="text-zinc-400 mb-6">
            This invitation link is invalid or has been revoked.
          </p>
          <Link
            href="/dashboard"
            className="inline-block bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // Check if invitation is for the current user's email
  if (invitation.email.toLowerCase() !== user.email?.toLowerCase()) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-zinc-900 rounded-2xl p-8 text-center">
          <div className="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg
              className="w-8 h-8 text-yellow-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-zinc-100 mb-2">
            Wrong Account
          </h1>
          <p className="text-zinc-400 mb-2">
            This invitation was sent to{' '}
            <span className="text-zinc-200 font-medium">{invitation.email}</span>
          </p>
          <p className="text-zinc-400 mb-6">
            You&apos;re logged in as{' '}
            <span className="text-zinc-200 font-medium">{user.email}</span>
          </p>
          <p className="text-zinc-500 text-sm mb-6">
            Please log in with the correct account or ask the team admin to send
            a new invitation to your current email address.
          </p>
          <Link
            href="/login"
            className="inline-block bg-orange-500 hover:bg-orange-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Switch Account
          </Link>
        </div>
      </div>
    );
  }

  // Check if already processed
  if (invitation.status !== 'pending') {
    const statusMessages: Record<string, { title: string; message: string; icon: React.ReactNode }> = {
      accepted: {
        title: 'Already Accepted',
        message: 'You have already accepted this invitation.',
        icon: (
          <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ),
      },
      declined: {
        title: 'Invitation Declined',
        message: 'You have previously declined this invitation.',
        icon: (
          <svg className="w-8 h-8 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ),
      },
      expired: {
        title: 'Invitation Expired',
        message: 'This invitation has expired. Please ask the team admin to send a new one.',
        icon: (
          <svg className="w-8 h-8 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ),
      },
      revoked: {
        title: 'Invitation Revoked',
        message: 'This invitation has been revoked by the team admin.',
        icon: (
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        ),
      },
    };

    const status = statusMessages[invitation.status] || statusMessages.expired;

    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-zinc-900 rounded-2xl p-8 text-center">
          <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center mx-auto mb-6">
            {status.icon}
          </div>
          <h1 className="text-xl font-bold text-zinc-100 mb-2">{status.title}</h1>
          <p className="text-zinc-400 mb-6">{status.message}</p>
          <Link
            href="/dashboard"
            className="inline-block bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // Check if expired
  const isExpired = new Date(invitation.expires_at) < new Date();
  if (isExpired) {
    // Update status to expired
    await supabase
      .from('team_invitations')
      .update({ status: 'expired' })
      .eq('id', invitation.id);

    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-zinc-900 rounded-2xl p-8 text-center">
          <div className="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg
              className="w-8 h-8 text-yellow-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-zinc-100 mb-2">
            Invitation Expired
          </h1>
          <p className="text-zinc-400 mb-6">
            This invitation expired on {formatDate(invitation.expires_at)}.
            Please ask the team admin to send a new one.
          </p>
          <Link
            href="/dashboard"
            className="inline-block bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // Get inviter info from profiles table
  // WHY: We use the invited_by UUID to look up the inviter's display_name
  // from the profiles table (which is created for all users via trigger).
  const { data: inviterProfile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', invitation.invited_by)
    .single();

  const inviterName = inviterProfile?.display_name || 'A team member';

  // Cast team to the expected type
  // WHY: Supabase returns foreign key relations as arrays even for single()
  // queries. We safely extract the first element if it exists.
  const teamData = invitation.team as unknown as
    | { id: string; name: string; description: string | null }[]
    | { id: string; name: string; description: string | null }
    | null;
  const team = Array.isArray(teamData) ? teamData[0] : teamData;

  // Show invitation details and accept/decline
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-zinc-900 rounded-2xl p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg
              className="w-8 h-8 text-orange-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100 mb-2">
            Join {team?.name || 'Team'}
          </h1>
          <p className="text-zinc-400">
            {inviterName} invited you to join this team
          </p>
        </div>

        {/* Team details */}
        <div className="bg-zinc-800/50 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-orange-500/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <span className="text-xl font-bold text-orange-500">
                {team?.name?.[0]?.toUpperCase() || 'T'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-zinc-100 truncate">
                {team?.name || 'Team'}
              </h3>
              {team?.description && (
                <p className="text-sm text-zinc-400 truncate">
                  {team.description}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Role badge */}
        <div className="flex items-center justify-between py-3 border-t border-zinc-800">
          <span className="text-zinc-400">Your role</span>
          <span
            className={`px-3 py-1 rounded-full text-sm font-medium ${
              invitation.role === 'admin'
                ? 'bg-purple-500/10 text-purple-400'
                : 'bg-zinc-700 text-zinc-300'
            }`}
          >
            {invitation.role === 'admin' ? 'Admin' : 'Member'}
          </span>
        </div>

        {/* Expiration */}
        <div className="flex items-center justify-between py-3 border-t border-zinc-800">
          <span className="text-zinc-400">Expires</span>
          <span className="text-zinc-300 text-sm">
            {formatDate(invitation.expires_at)}
          </span>
        </div>

        {/* Actions */}
        <InviteActions token={token} teamName={team?.name || 'Team'} />
      </div>
    </div>
  );
}
