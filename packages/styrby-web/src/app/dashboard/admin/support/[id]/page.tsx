'use client';

/**
 * Admin Support Ticket Detail Page
 *
 * Shows the full ticket with user info panel, reply thread, admin reply form,
 * status management dropdown, internal notes textarea, and session access grants
 * section (Phase 4.2 T4 — request-access UI).
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Send, RefreshCw, User, KeyRound, Plus } from 'lucide-react';

/* ──────────────────────────── Types ──────────────────────────── */

interface TicketData {
  id: string;
  user_id: string;
  type: 'bug' | 'feature' | 'question';
  subject: string;
  description: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high';
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface TicketReply {
  id: string;
  ticket_id: string;
  author_type: 'user' | 'admin';
  author_id: string;
  message: string;
  created_at: string;
}

interface TicketUser {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  joined_at: string | null;
  tier: string;
  subscription_status: string | null;
  machines_count: number;
}

/**
 * A support_access_grant row displayed in the ticket detail sidebar.
 * Fetched from /api/admin/support/[id]/grants (Phase 4.2 T4).
 */
interface AccessGrant {
  id: number;
  session_id: string;
  status: 'pending' | 'approved' | 'revoked' | 'expired' | 'consumed';
  expires_at: string;
  requested_at: string;
  reason: string;
}

/* ──────────────────────────── Helpers ────────────────────────── */

/**
 * Returns a human-readable relative time string.
 *
 * @param dateStr - ISO 8601 date string
 * @returns Relative time string
 */
function getRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffDay = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDay > 30) return date.toLocaleDateString();
  if (diffDay > 0) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHr > 0) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffMin = Math.floor(diffMs / (1000 * 60));
  if (diffMin > 0) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  return 'Just now';
}

/** Badge styles for ticket types */
const TYPE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  bug: { bg: 'bg-red-500/10', text: 'text-red-400', label: 'Bug Report' },
  feature: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Feature Request' },
  question: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'General Question' },
};

/** Badge styles for tier labels */
const TIER_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  free: { bg: 'bg-zinc-700/50', text: 'text-zinc-400', label: 'Free' },
  pro: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Pro' },
  power: { bg: 'bg-purple-500/10', text: 'text-purple-400', label: 'Power' },
};

/** All possible ticket statuses for the dropdown */
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

/* ──────────────────────────── Component ──────────────────────── */

export default function AdminTicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [ticket, setTicket] = useState<TicketData | null>(null);
  const [replies, setReplies] = useState<TicketReply[]>([]);
  const [ticketUser, setTicketUser] = useState<TicketUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Phase 4.2 T4: session access grants for this ticket.
  // WHY separate state: grants are fetched from a separate API endpoint and
  // we don't want a grant fetch failure to break the entire ticket view.
  const [accessGrants, setAccessGrants] = useState<AccessGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(true);

  // Admin reply form
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySuccess, setReplySuccess] = useState<string | null>(null);

  // Status update
  const [updatingStatus, setUpdatingStatus] = useState(false);

  // Admin notes
  const [adminNotes, setAdminNotes] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

  /**
   * Fetches the ticket, replies, and user info from the admin API.
   */
  const fetchTicket = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/admin/support/${id}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to fetch ticket');
        setLoading(false);
        return;
      }

      const data = await res.json();
      setTicket(data.ticket);
      setReplies(data.replies);
      setTicketUser(data.user);
      setAdminNotes(data.ticket.admin_notes || '');
    } catch {
      setError('Failed to fetch ticket');
    }
    setLoading(false);
  }, [id]);

  /**
   * Fetches existing session access grants for this ticket.
   *
   * WHY separate fetch: grants are a Phase 4.2 addition. Keeping them in a
   * separate call isolates failures — a broken grants endpoint won't break
   * the entire ticket page. The grants list is for context only.
   */
  const fetchGrants = useCallback(async () => {
    setGrantsLoading(true);
    try {
      const res = await fetch(`/api/admin/support/${id}/grants`);
      if (res.ok) {
        const data = await res.json();
        setAccessGrants(data.grants ?? []);
      }
      // WHY silent failure: if the grants endpoint is unavailable (not yet
      // deployed, network error), we show an empty list rather than an error
      // state. The admin can still use the ticket; grants are context only.
    } catch {
      // Silent failure — grants list is advisory only.
    }
    setGrantsLoading(false);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTicket();
    // WHY fetch grants in the same effect: grants are always needed alongside
    // the ticket. Both fetches run in parallel (no await chaining).
    fetchGrants();
  }, [fetchTicket, fetchGrants]);

  /**
   * Sends an admin reply and triggers email notification.
   */
  const handleSendReply = useCallback(async () => {
    if (!replyText.trim()) return;

    setSending(true);
    setReplyError(null);
    setReplySuccess(null);

    try {
      const res = await fetch(`/api/admin/support/${id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: replyText.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        setReplyError(data.error || 'Failed to send reply');
        setSending(false);
        return;
      }

      const data = await res.json();
      setReplyText('');
      setReplySuccess(data.emailSent ? 'Reply sent and email delivered.' : 'Reply sent (email delivery skipped).');
      // Refresh to show the new reply
      await fetchTicket();
    } catch {
      setReplyError('Failed to send reply');
    }
    setSending(false);
  }, [id, replyText, fetchTicket]);

  /**
   * Updates the ticket status via the admin API.
   */
  const handleStatusChange = useCallback(
    async (newStatus: string) => {
      setUpdatingStatus(true);

      try {
        const res = await fetch(`/api/admin/support/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
        });

        if (res.ok) {
          const data = await res.json();
          setTicket(data.ticket);
        }
      } catch {
        // Silently fail; the dropdown will retain the old value
      }
      setUpdatingStatus(false);
    },
    [id]
  );

  /**
   * Saves admin notes on blur (auto-save pattern).
   */
  const handleNotesSave = useCallback(async () => {
    if (!ticket || adminNotes === (ticket.admin_notes || '')) return;

    setNotesSaving(true);
    setNotesSaved(false);

    try {
      const res = await fetch(`/api/admin/support/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_notes: adminNotes }),
      });

      if (res.ok) {
        const data = await res.json();
        setTicket(data.ticket);
        setNotesSaved(true);
        setTimeout(() => setNotesSaved(false), 2000);
      }
    } catch {
      // Silently fail
    }
    setNotesSaving(false);
  }, [id, adminNotes, ticket]);

  /* ── Loading / Error states ──────────────────────────────────── */

  if (loading) {
    return (
      <div className="py-16 text-center">
        <RefreshCw className="mx-auto h-8 w-8 animate-spin text-zinc-500" />
        <p className="mt-4 text-sm text-zinc-500">Loading ticket...</p>
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-red-400">{error || 'Ticket not found'}</p>
        <button
          onClick={() => router.push('/dashboard/admin/support')}
          className="mt-4 text-sm text-amber-400 hover:text-amber-300"
        >
          Back to tickets
        </button>
      </div>
    );
  }

  const typeBadge = TYPE_BADGE[ticket.type];
  const tierBadge = TIER_BADGE[ticketUser?.tier || 'free'] || TIER_BADGE.free;

  return (
    <div>
      {/* Back link */}
      <Link
        href="/dashboard/admin/support"
        className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to tickets
      </Link>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main content: ticket + replies (2/3 width on desktop) */}
        <div className="lg:col-span-2">
          {/* Ticket header */}
          <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${typeBadge.bg} ${typeBadge.text}`}
              >
                {typeBadge.label}
              </span>
              {ticket.type === 'bug' && (
                <span className="inline-flex items-center rounded-full bg-zinc-700/50 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
                  Priority: {ticket.priority}
                </span>
              )}
              <span className="font-mono text-xs text-zinc-500">{ticket.id.slice(0, 8)}</span>
            </div>

            <h1 className="mb-2 text-xl font-bold text-zinc-100">{ticket.subject}</h1>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
              {ticket.description}
            </p>
            <p className="mt-4 text-xs text-zinc-500">
              Submitted {getRelativeTime(ticket.created_at)}
              {ticket.updated_at !== ticket.created_at && (
                <> &middot; Updated {getRelativeTime(ticket.updated_at)}</>
              )}
            </p>
          </div>

          {/* Status management */}
          <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-center justify-between">
              <label htmlFor="status-select" className="text-sm font-medium text-zinc-300">
                Status
              </label>
              <select
                id="status-select"
                value={ticket.status}
                onChange={(e) => handleStatusChange(e.target.value)}
                disabled={updatingStatus}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Reply thread */}
          {replies.length > 0 && (
            <div className="mb-6 space-y-4">
              <h2 className="text-sm font-semibold text-zinc-400">
                Replies ({replies.length})
              </h2>
              {replies.map((reply) => {
                const isAdmin = reply.author_type === 'admin';
                return (
                  <div
                    key={reply.id}
                    className={`flex ${isAdmin ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-xl px-4 py-3 ${
                        isAdmin
                          ? 'border border-amber-500/20 bg-amber-500/5'
                          : 'border border-zinc-700 bg-zinc-800'
                      }`}
                    >
                      <p className="mb-1 text-xs font-medium text-zinc-400">
                        {isAdmin ? 'Admin' : ticketUser?.display_name || ticketUser?.email || 'User'}
                      </p>
                      <p className="whitespace-pre-wrap text-sm text-zinc-200">
                        {reply.message}
                      </p>
                      <p className="mt-2 text-xs text-zinc-500">
                        {getRelativeTime(reply.created_at)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Admin reply form */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <label htmlFor="admin-reply" className="mb-2 block text-sm font-medium text-zinc-300">
              Send Reply
            </label>
            <textarea
              id="admin-reply"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Type your reply to the user..."
              rows={4}
              maxLength={5000}
              className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            {replyError && (
              <p className="mb-3 text-sm text-red-400" role="alert">
                {replyError}
              </p>
            )}
            {replySuccess && (
              <p className="mb-3 text-sm text-green-400">{replySuccess}</p>
            )}
            <div className="flex items-center justify-between">
              <p className="text-xs text-zinc-500">
                Reply will be emailed to {ticketUser?.email || 'the user'}.
              </p>
              <button
                onClick={handleSendReply}
                disabled={sending || !replyText.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {sending ? 'Sending...' : 'Send Reply'}
              </button>
            </div>
          </div>

          {/* Internal notes */}
          <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-2 flex items-center justify-between">
              <label htmlFor="admin-notes" className="text-sm font-medium text-zinc-300">
                Internal Notes
              </label>
              <span className="text-xs text-zinc-500">
                {notesSaving ? 'Saving...' : notesSaved ? 'Saved' : 'Auto-saves on blur'}
              </span>
            </div>
            <textarea
              id="admin-notes"
              value={adminNotes}
              onChange={(e) => setAdminNotes(e.target.value)}
              onBlur={handleNotesSave}
              placeholder="Private notes about this ticket (not visible to user)..."
              rows={3}
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
            />
          </div>
        </div>

        {/* User info sidebar (1/3 width on desktop) */}
        <div className="space-y-6 lg:col-span-1">
          {/* User card */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800">
                <User className="h-5 w-5 text-zinc-400" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-100">
                  {ticketUser?.display_name || 'No display name'}
                </p>
                <p className="truncate text-xs text-zinc-500">{ticketUser?.email}</p>
              </div>
            </div>

            <div className="space-y-3 border-t border-zinc-800 pt-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">Tier</span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tierBadge.bg} ${tierBadge.text}`}
                >
                  {tierBadge.label}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">Machines</span>
                <span className="text-xs text-zinc-300">{ticketUser?.machines_count || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">Account ID</span>
                <span className="font-mono text-xs text-zinc-500">
                  {ticketUser?.id?.slice(0, 8) || 'N/A'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">Joined</span>
                <span className="text-xs text-zinc-300">
                  {ticketUser?.joined_at
                    ? new Date(ticketUser.joined_at).toLocaleDateString()
                    : 'N/A'}
                </span>
              </div>
            </div>
          </div>

          {/* ── Session Access Grants (Phase 4.2 T4) ──────────────────── */}
          {/*
            WHY this section: allows the admin to see all existing grants for
            this ticket and navigate to request a new one without leaving the
            ticket detail page. The "+ Request new access" link goes to the
            dedicated server-component form page for safer action handling.
          */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-zinc-400" />
                <span className="text-sm font-medium text-zinc-300">Session Access Grants</span>
              </div>
              <Link
                href={`/dashboard/admin/support/${id}/request-access`}
                className="inline-flex items-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/10"
                data-testid="request-new-access-link"
              >
                <Plus className="h-3 w-3" />
                Request new access
              </Link>
            </div>

            {grantsLoading ? (
              <p className="text-xs text-zinc-500" data-testid="grants-loading">
                Loading grants...
              </p>
            ) : accessGrants.length === 0 ? (
              <p className="text-xs text-zinc-500" data-testid="no-grants-message">
                No session access grants yet for this ticket.
              </p>
            ) : (
              <div className="space-y-2" data-testid="grants-list">
                {accessGrants.map((grant) => {
                  // WHY derive display values here: status badge colours mirror
                  // the ticket status pattern used elsewhere in this file.
                  const isApproved =
                    grant.status === 'approved' &&
                    new Date(grant.expires_at) > new Date();
                  const isPendingGrant = grant.status === 'pending';
                  const statusColor = isApproved
                    ? 'text-green-400'
                    : isPendingGrant
                    ? 'text-amber-400'
                    : 'text-zinc-500';

                  return (
                    <div
                      key={grant.id}
                      className="rounded-lg border border-zinc-800 px-3 py-2"
                      data-testid={`grant-item-${grant.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-mono text-xs text-zinc-500">
                          {grant.session_id.slice(0, 8)}...
                        </p>
                        <span className={`shrink-0 text-xs font-medium ${statusColor}`}>
                          {grant.status}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-zinc-400">
                        {/* WHY 60-char truncation: reason may contain user-input text.
                            Truncating in the compact sidebar view prevents the card
                            from growing unbounded. Full reason is on the request-access
                            page. */}
                        {grant.reason.slice(0, 60)}
                        {grant.reason.length > 60 ? '…' : ''}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Expires {new Date(grant.expires_at).toLocaleDateString()}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
