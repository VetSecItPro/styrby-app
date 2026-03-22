'use client';

/**
 * Ticket Detail with Reply Thread (Client Component)
 *
 * Shows the full ticket information, a chronological reply thread, and a form
 * for the user to add replies. User replies appear right-aligned with amber accent,
 * admin replies appear left-aligned with zinc accent.
 *
 * @param props.ticket - The support ticket record
 * @param props.replies - Array of replies for this ticket
 * @param props.userId - The authenticated user's ID
 */

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Send } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

/* ──────────────────────────── Types ──────────────────────────── */

interface SupportTicket {
  id: string;
  type: 'bug' | 'feature' | 'question';
  subject: string;
  description: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high';
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

interface TicketDetailClientProps {
  /** The support ticket record */
  ticket: SupportTicket;
  /** Replies for this ticket in chronological order */
  replies: TicketReply[];
  /** The authenticated user's UUID */
  userId: string;
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
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffDay > 30) {
    return date.toLocaleDateString();
  }
  if (diffDay > 0) {
    return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  }
  if (diffHr > 0) {
    return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  }
  if (diffMin > 0) {
    return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  }
  return 'Just now';
}

/** Badge styles for ticket types */
const TYPE_BADGE: Record<SupportTicket['type'], { bg: string; text: string; label: string }> = {
  bug: { bg: 'bg-red-500/10', text: 'text-red-400', label: 'Bug Report' },
  feature: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Feature Request' },
  question: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'General Question' },
};

/** Badge styles for ticket statuses */
const STATUS_BADGE: Record<SupportTicket['status'], { bg: string; text: string; label: string }> = {
  open: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Open' },
  in_progress: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'In Progress' },
  resolved: { bg: 'bg-green-500/10', text: 'text-green-400', label: 'Resolved' },
  closed: { bg: 'bg-zinc-700/50', text: 'text-zinc-400', label: 'Closed' },
};

/** Badge styles for priority levels */
const PRIORITY_BADGE: Record<SupportTicket['priority'], { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-zinc-700/50', text: 'text-zinc-400', label: 'Low' },
  medium: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Medium' },
  high: { bg: 'bg-red-500/10', text: 'text-red-400', label: 'High' },
};

/* ──────────────────────────── Component ──────────────────────── */

export function TicketDetailClient({ ticket, replies, userId }: TicketDetailClientProps) {
  const router = useRouter();
  const supabase = createClient();

  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const typeBadge = TYPE_BADGE[ticket.type];
  const statusBadge = STATUS_BADGE[ticket.status];
  const priorityBadge = PRIORITY_BADGE[ticket.priority];

  /** Whether the ticket is in a state that accepts new replies */
  const canReply = ticket.status !== 'closed';

  /**
   * Inserts a user reply into support_ticket_replies.
   * RLS verifies ticket ownership and author_type/author_id constraints.
   */
  const handleSendReply = useCallback(async () => {
    if (!replyText.trim()) return;
    if (replyText.trim().length > 5000) {
      setReplyError('Reply must be 5,000 characters or fewer.');
      return;
    }

    setSending(true);
    setReplyError(null);

    const { error } = await supabase.from('support_ticket_replies').insert({
      ticket_id: ticket.id,
      author_type: 'user',
      author_id: userId,
      message: replyText.trim(),
    });

    if (error) {
      setReplyError(error.message);
      setSending(false);
      return;
    }

    setReplyText('');
    setSending(false);
    router.refresh();
  }, [supabase, ticket.id, userId, replyText, router]);

  return (
    <div>
      {/* Back link */}
      <Link
        href="/dashboard/support"
        className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to tickets
      </Link>

      {/* Ticket header card */}
      <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900 p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${typeBadge.bg} ${typeBadge.text}`}
          >
            {typeBadge.label}
          </span>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge.bg} ${statusBadge.text}`}
          >
            {statusBadge.label}
          </span>
          {ticket.type === 'bug' && (
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${priorityBadge.bg} ${priorityBadge.text}`}
            >
              Priority: {priorityBadge.label}
            </span>
          )}
        </div>

        <h1 className="mb-2 text-xl font-bold text-zinc-100">{ticket.subject}</h1>

        <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
          {ticket.description}
        </p>

        <p className="mt-4 text-xs text-zinc-500">
          Submitted {getRelativeTime(ticket.created_at)}
        </p>
      </div>

      {/* Reply thread */}
      {replies.length > 0 && (
        <div className="mb-6 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-400">Replies</h2>
          {replies.map((reply) => {
            const isUser = reply.author_type === 'user';
            return (
              <div
                key={reply.id}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-xl px-4 py-3 ${
                    isUser
                      ? 'border border-amber-500/20 bg-amber-500/5'
                      : 'border border-zinc-700 bg-zinc-800'
                  }`}
                >
                  <p className="mb-1 text-xs font-medium text-zinc-400">
                    {isUser ? 'You' : 'Styrby Support'}
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

      {/* Reply form */}
      {canReply ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <label htmlFor="reply-message" className="mb-2 block text-sm font-medium text-zinc-300">
            Add a reply
          </label>
          <textarea
            id="reply-message"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Type your reply..."
            rows={3}
            maxLength={5000}
            className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
          {replyError && (
            <p className="mb-3 text-sm text-red-400" role="alert">
              {replyError}
            </p>
          )}
          <div className="flex justify-end">
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
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-center">
          <p className="text-sm text-zinc-500">
            This ticket is closed. If you need further help, please open a new ticket.
          </p>
        </div>
      )}
    </div>
  );
}
