'use client';

/**
 * Support Tickets List (Client Component)
 *
 * Displays the user's support tickets as cards with type badges, status indicators,
 * and relative timestamps. Includes a "New Ticket" button that opens the SupportModal.
 *
 * @param props.tickets - Array of support ticket records from Supabase
 */

import { useState } from 'react';
import Link from 'next/link';
import { HelpCircle, Plus } from 'lucide-react';
import { SupportModal } from '@/components/dashboard/support-modal';

/* ──────────────────────────── Types ──────────────────────────── */

interface SupportTicket {
  id: string;
  type: 'bug' | 'feature' | 'question';
  subject: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high';
  created_at: string;
  updated_at: string;
}

interface SupportListClientProps {
  /** Pre-fetched tickets from the server component */
  tickets: SupportTicket[];
}

/* ──────────────────────────── Helpers ────────────────────────── */

/**
 * Returns a human-readable relative time string (e.g., "2 days ago").
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

/** Badge color configuration for ticket types */
const TYPE_BADGE: Record<SupportTicket['type'], { bg: string; text: string; label: string }> = {
  bug: { bg: 'bg-red-500/10', text: 'text-red-400', label: 'Bug' },
  feature: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Feature' },
  question: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Question' },
};

/** Badge color configuration for ticket statuses */
const STATUS_BADGE: Record<SupportTicket['status'], { bg: string; text: string; label: string }> = {
  open: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Open' },
  in_progress: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'In Progress' },
  resolved: { bg: 'bg-green-500/10', text: 'text-green-400', label: 'Resolved' },
  closed: { bg: 'bg-zinc-700/50', text: 'text-zinc-400', label: 'Closed' },
};

/* ──────────────────────────── Component ──────────────────────── */

export function SupportListClient({ tickets }: SupportListClientProps) {
  const [showModal, setShowModal] = useState(false);

  return (
    <div>
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Support</h1>
        <button
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600"
        >
          <Plus className="h-4 w-4" />
          New Ticket
        </button>
      </div>

      {/* Ticket list */}
      {tickets.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 py-16">
          <HelpCircle className="mb-4 h-12 w-12 text-zinc-600" />
          <p className="text-sm font-medium text-zinc-300">No tickets yet.</p>
          <p className="mt-1 text-sm text-zinc-500">
            Need help? Submit a ticket and we will get back to you.
          </p>
          <button
            onClick={() => setShowModal(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600"
          >
            <Plus className="h-4 w-4" />
            Submit a Ticket
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map((ticket) => {
            const typeBadge = TYPE_BADGE[ticket.type];
            const statusBadge = STATUS_BADGE[ticket.status];

            return (
              <Link
                key={ticket.id}
                href={`/dashboard/support/${ticket.id}`}
                className="block rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-800/50"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${typeBadge.bg} ${typeBadge.text}`}
                      >
                        {typeBadge.label}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge.bg} ${statusBadge.text}`}
                      >
                        {statusBadge.label}
                      </span>
                    </div>
                    <p className="truncate text-sm font-medium text-zinc-100">
                      {ticket.subject}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-zinc-500">
                    {getRelativeTime(ticket.created_at)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <SupportModal open={showModal} onOpenChange={setShowModal} />
    </div>
  );
}
