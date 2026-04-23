/**
 * Team Invitation Accept Page
 *
 * Handles the flow when a user clicks an invitation link from their email.
 *
 * Security contract (Phase 2.2 requirement):
 *   - Unauthenticated visitors see ONLY "You've been invited to join a team on
 *     Styrby" + a sign-in prompt. Team name, inviter, and email are NEVER
 *     shown to unauthenticated visitors (enumeration leak prevention).
 *   - Token lookup uses SHA-256 hash (token_hash column, migration 030).
 *     The legacy `token` column is NOT used for accept lookups.
 *   - Timing-safe comparison (crypto.timingSafeEqual) prevents timing-oracle
 *     attacks where response-time measurement reveals how many bytes matched.
 *   - If authenticated and email matches: show full details + Accept button.
 *   - If authenticated and email does NOT match: show mismatch message.
 *   - If token is invalid/expired/unknown: generic error (no detail leak).
 *   - Accept POSTs to /api/invitations/accept (Unit B route) which performs
 *     the DB transaction and audit log server-side.
 *
 * WHY Server Component:
 *   Invitation lookup requires DB access. Doing it server-side ensures
 *   sensitive invitation details never reach unauthenticated browsers.
 */

import { timingSafeEqual } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import Link from 'next/link';
import { InviteActions } from './invite-actions';

// ============================================================================
// Types
// ============================================================================

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

// ============================================================================
// Crypto helpers
// ============================================================================

/**
 * Computes SHA-256 hex digest of a string using Web Crypto API.
 *
 * WHY Web Crypto (not Node crypto): Available in all Next.js runtimes
 * (Node, Edge, Vercel). More portable than Node's `crypto` module.
 *
 * @param input - String to hash
 * @returns 64-char lowercase hex SHA-256 digest
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Timing-safe comparison of two hex strings.
 *
 * WHY crypto.timingSafeEqual instead of ===:
 *   String equality short-circuits on the first differing character. An attacker
 *   measuring HTTP response latency could infer how many prefix bytes of the
 *   stored token_hash matched the URL token. crypto.timingSafeEqual always
 *   inspects all bytes, preventing this oracle.
 *
 * @param a - First hex string (computed hash from URL token)
 * @param b - Second hex string (stored token_hash from DB)
 * @returns true if both hex strings represent identical byte sequences
 */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Lengths differ - cannot be equal. Run a dummy comparison to maintain
    // constant-time behavior. In practice both are 64-char SHA-256 digests.
    // WHY Node's timingSafeEqual (not globalThis.crypto):
    //   Web Crypto API does not expose timingSafeEqual. Node's crypto module does.
    const dummy = Buffer.alloc(Math.min(Math.floor(a.length / 2) || 1, 32));
    try { timingSafeEqual(dummy, dummy); } catch { /* ignore */ }
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
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

// ============================================================================
// Shared UI pieces
// ============================================================================

/** Minimal wrapper so each state renders consistently. */
function PageWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-zinc-900 rounded-2xl p-8 text-center">
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// Page Component
// ============================================================================

/**
 * Server Component for the invitation acceptance page.
 *
 * Renders one of five states:
 *   1. Invalid / malformed token - generic error (no leak)
 *   2. Unauthenticated visitor - sign-in prompt (NO team details shown)
 *   3. Authenticated, wrong email - mismatch message
 *   4. Non-pending invitation (accepted/revoked/expired) - status message
 *   5. Authenticated, matching email, pending - full details + Accept button
 *
 * @param props - Next.js page props with token param
 */
export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const supabase = await createClient();

  // ── Step 1: Validate token format ─────────────────────────────────────────

  // WHY pre-validate: Malformed tokens can skip the DB lookup entirely.
  // Format check does NOT reveal whether a valid token exists.
  const isValidFormat = typeof token === 'string' && /^[0-9a-f]{64,}$/i.test(token);

  // ── Step 2: Hash the raw token ────────────────────────────────────────────

  // WHY hash before lookup: Migration 030 stores only the SHA-256 hash.
  // The raw token exists only in the email and URL - never in the DB.
  const tokenHash = isValidFormat ? await sha256Hex(token) : '';

  // ── Step 3: Look up invitation by token_hash ──────────────────────────────

  const { data: invitation, error } = isValidFormat
    ? await supabase
        .from('team_invitations')
        .select(`
          id,
          email,
          role,
          status,
          expires_at,
          created_at,
          invited_by,
          token_hash,
          team:teams (
            id,
            name,
            description
          )
        `)
        .eq('token_hash', tokenHash)
        .single()
    : { data: null, error: { message: 'Invalid token format' } };

  // ── Step 4: Timing-safe comparison (defense in depth) ────────────────────

  // WHY double-check: If an ORM bug returned a non-matching row, this catches it.
  // timingSafeEqual prevents timing leaks even in this redundant check.
  const hashesMatch = invitation?.token_hash
    ? timingSafeHexEqual(tokenHash, invitation.token_hash)
    : false;

  // ── Step 5: Handle invalid / not found token ──────────────────────────────

  if (error || !invitation || !hashesMatch) {
    return (
      <PageWrapper>
        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-zinc-100 mb-2">Invitation Not Found</h1>
        <p className="text-zinc-400 mb-6">
          This invitation link is invalid or has been revoked.
        </p>
        <Link href="/dashboard" className="inline-block bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-6 py-3 rounded-lg font-medium transition-colors">
          Go to Dashboard
        </Link>
      </PageWrapper>
    );
  }

  // ── Step 6: Check authentication ──────────────────────────────────────────

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // WHY we do NOT show team name, inviter name, or invitation email here:
    //   An unauthenticated visitor should not learn which team sent the invite,
    //   who invited them, or which email was targeted. This prevents enumeration
    //   (e.g., a competitor scraping invite URLs to discover team membership).
    //   We show only a generic message + sign-in CTA.
    return (
      <PageWrapper>
        <div className="w-16 h-16 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-zinc-100 mb-2">
          You have been invited to join a team on Styrby
        </h1>
        <p className="text-zinc-400 mb-6">
          Sign in to view your invitation and accept or decline.
        </p>
        <Link
          href={`/login?returnTo=/invite/${token}`}
          className="inline-block bg-orange-500 hover:bg-orange-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
        >
          Sign in to accept
        </Link>
      </PageWrapper>
    );
  }

  // ── Step 7: Check email match FIRST ──────────────────────────────────────

  // WHY email check comes BEFORE status/expiry rendering:
  //   A user on the wrong account who intercepts an invitation URL must NOT
  //   learn whether the invitation is active, expired, or revoked. Showing
  //   "Invitation Expired" to the wrong user leaks the invitation's lifecycle.
  //   By checking email first, wrong-email users always see the Wrong Account
  //   message regardless of invitation status.
  const sessionEmail = (user.email ?? '').toLowerCase().trim();
  const invitationEmail = (invitation.email ?? '').toLowerCase().trim();

  if (!sessionEmail || sessionEmail !== invitationEmail) {
    return (
      <PageWrapper>
        <div className="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-zinc-100 mb-2">Wrong Account</h1>
        <p className="text-zinc-400 mb-6">
          This invitation was sent to a different email address. Sign out and sign in with the correct
          account to accept.
        </p>
        <Link href="/login" className="inline-block bg-orange-500 hover:bg-orange-600 text-white px-6 py-3 rounded-lg font-medium transition-colors">
          Switch Account
        </Link>
      </PageWrapper>
    );
  }

  // ── Step 8: Handle non-pending status ─────────────────────────────────────

  // WHY status check is AFTER email check: see Step 7 above.
  // Only users with a matching email see status-specific messages.
  const isExpired = new Date(invitation.expires_at) < new Date();

  if (invitation.status !== 'pending' || isExpired) {
    type StatusKey = 'accepted' | 'declined' | 'expired' | 'revoked';
    const statusMessages: Record<StatusKey, { title: string; message: string }> = {
      accepted: {
        title: 'Already Accepted',
        message: 'You have already accepted this invitation.',
      },
      declined: {
        title: 'Invitation Declined',
        message: 'You have previously declined this invitation.',
      },
      expired: {
        title: 'Invitation Expired',
        message: `This invitation expired on ${formatDate(invitation.expires_at)}. Please ask the team admin to send a new one.`,
      },
      revoked: {
        title: 'Invitation Revoked',
        message: 'This invitation has been revoked by the team admin.',
      },
    };

    const effectiveStatus = isExpired ? 'expired' : (invitation.status as StatusKey);
    const statusInfo = statusMessages[effectiveStatus] ?? statusMessages.expired;

    return (
      <PageWrapper>
        <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-zinc-100 mb-2">{statusInfo.title}</h1>
        <p className="text-zinc-400 mb-6">{statusInfo.message}</p>
        <Link href="/dashboard" className="inline-block bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-6 py-3 rounded-lg font-medium transition-colors">
          Go to Dashboard
        </Link>
      </PageWrapper>
    );
  }

  // ── Step 9: Authenticated + matching email: show full invitation UI ────────

  // Cast team to the expected type (Supabase relation may be array or object)
  const teamData = invitation.team as unknown as
    | { id: string; name: string; description: string | null }[]
    | { id: string; name: string; description: string | null }
    | null;
  const team = Array.isArray(teamData) ? teamData[0] : teamData;

  // Fetch inviter info from profiles
  // WHY: invited_by is a UUID. We join profiles separately to get display_name.
  const { data: inviterProfile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', invitation.invited_by)
    .single();
  const inviterName = inviterProfile?.display_name ?? 'A team member';

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-zinc-900 rounded-2xl p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100 mb-2">
            Join {team?.name ?? 'Team'}
          </h1>
          <p className="text-zinc-400">{inviterName} invited you to join this team</p>
        </div>

        {/* Team details */}
        <div className="bg-zinc-800/50 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-orange-500/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <span className="text-xl font-bold text-orange-500">
                {team?.name?.[0]?.toUpperCase() ?? 'T'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-zinc-100 truncate">{team?.name ?? 'Team'}</h3>
              {team?.description && (
                <p className="text-sm text-zinc-400 truncate">{team.description}</p>
              )}
            </div>
          </div>
        </div>

        {/* Role badge */}
        <div className="flex items-center justify-between py-3 border-t border-zinc-800">
          <span className="text-zinc-400">Your role</span>
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${
            invitation.role === 'admin'
              ? 'bg-purple-500/10 text-purple-400'
              : invitation.role === 'viewer'
              ? 'bg-blue-500/10 text-blue-400'
              : 'bg-zinc-700 text-zinc-300'
          }`}>
            {invitation.role === 'admin' ? 'Admin' : invitation.role === 'viewer' ? 'Viewer' : 'Member'}
          </span>
        </div>

        {/* Expiration */}
        <div className="flex items-center justify-between py-3 border-t border-zinc-800">
          <span className="text-zinc-400">Expires</span>
          <span className="text-zinc-300 text-sm">{formatDate(invitation.expires_at)}</span>
        </div>

        {/* Accept/Decline actions - uses new /api/invitations/accept route */}
        <InviteActions token={token} teamName={team?.name ?? 'Team'} />
      </div>
    </div>
  );
}
