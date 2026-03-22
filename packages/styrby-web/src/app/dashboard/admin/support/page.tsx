'use client';

/**
 * Admin Support Tickets Dashboard
 *
 * Fetches all support tickets from the admin API and displays them in a
 * filterable table (desktop) or card list (mobile). Clicking a row navigates
 * to the ticket detail page.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw } from 'lucide-react';

/* ──────────────────────────── Types ──────────────────────────── */

interface AdminTicket {
  id: string;
  user_id: string;
  type: 'bug' | 'feature' | 'question';
  subject: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high';
  created_at: string;
  updated_at: string;
  user_email: string;
  profiles?: {
    display_name: string | null;
  } | null;
}

type StatusFilter = 'all' | 'open' | 'in_progress' | 'resolved' | 'closed';

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
  if (diffDay > 0) return `${diffDay}d ago`;
  const diffHr = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHr > 0) return `${diffHr}h ago`;
  const diffMin = Math.floor(diffMs / (1000 * 60));
  if (diffMin > 0) return `${diffMin}m ago`;
  return 'Now';
}

/** Short ID display (first 8 chars of UUID) */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Badge styles for ticket types */
const TYPE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  bug: { bg: 'bg-red-500/10', text: 'text-red-400', label: 'Bug' },
  feature: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Feature' },
  question: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Question' },
};

/** Badge styles for ticket statuses */
const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  open: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Open' },
  in_progress: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'In Progress' },
  resolved: { bg: 'bg-green-500/10', text: 'text-green-400', label: 'Resolved' },
  closed: { bg: 'bg-zinc-700/50', text: 'text-zinc-400', label: 'Closed' },
};

/* ──────────────────────────── Component ──────────────────────── */

export default function AdminSupportPage() {
  const [tickets, setTickets] = useState<AdminTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  /**
   * Fetches tickets from the admin API with the current status filter.
   */
  const fetchTickets = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (statusFilter !== 'all') {
      params.set('status', statusFilter);
    }

    try {
      const res = await fetch(`/api/admin/support?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to fetch tickets');
        setLoading(false);
        return;
      }

      const data = await res.json();
      setTickets(data.tickets);
      setTotal(data.total);
    } catch {
      setError('Failed to fetch tickets');
    }
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="mb-4 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Support Tickets</h1>
            <p className="mt-1 text-sm text-zinc-400">
              {total} ticket{total !== 1 ? 's' : ''} total
            </p>
          </div>
          <button
            onClick={fetchTickets}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
            aria-label="Refresh tickets"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="mb-6 flex flex-wrap gap-2">
        {(['all', 'open', 'in_progress', 'resolved', 'closed'] as StatusFilter[]).map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              statusFilter === status
                ? 'bg-amber-500 text-white'
                : 'border border-zinc-700 text-zinc-400 hover:text-zinc-100'
            }`}
          >
            {status === 'all'
              ? 'All'
              : status === 'in_progress'
                ? 'In Progress'
                : status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Loading state */}
      {loading && tickets.length === 0 && (
        <div className="py-16 text-center">
          <RefreshCw className="mx-auto h-8 w-8 animate-spin text-zinc-500" />
          <p className="mt-4 text-sm text-zinc-500">Loading tickets...</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && tickets.length === 0 && !error && (
        <div className="py-16 text-center">
          <p className="text-sm text-zinc-500">No tickets found.</p>
        </div>
      )}

      {/* Desktop table view */}
      {tickets.length > 0 && (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-zinc-800 md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/50">
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">ID</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Subject</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">User</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-zinc-400">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {tickets.map((ticket) => {
                  const typeBadge = TYPE_BADGE[ticket.type];
                  const statusBadge = STATUS_BADGE[ticket.status];
                  return (
                    <tr key={ticket.id} className="transition-colors hover:bg-zinc-800/50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/dashboard/admin/support/${ticket.id}`}
                          className="font-mono text-xs text-zinc-500 hover:text-amber-400"
                        >
                          {shortId(ticket.id)}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${typeBadge.bg} ${typeBadge.text}`}
                        >
                          {typeBadge.label}
                        </span>
                      </td>
                      <td className="max-w-xs truncate px-4 py-3">
                        <Link
                          href={`/dashboard/admin/support/${ticket.id}`}
                          className="text-zinc-100 hover:text-amber-400"
                        >
                          {ticket.subject}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-zinc-400">
                        {ticket.profiles?.display_name || ticket.user_email}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge.bg} ${statusBadge.text}`}
                        >
                          {statusBadge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500">
                        {getRelativeTime(ticket.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card view */}
          <div className="space-y-3 md:hidden">
            {tickets.map((ticket) => {
              const typeBadge = TYPE_BADGE[ticket.type];
              const statusBadge = STATUS_BADGE[ticket.status];
              return (
                <Link
                  key={ticket.id}
                  href={`/dashboard/admin/support/${ticket.id}`}
                  className="block rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700"
                >
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
                    <span className="text-xs text-zinc-500">
                      {getRelativeTime(ticket.created_at)}
                    </span>
                  </div>
                  <p className="truncate text-sm font-medium text-zinc-100">
                    {ticket.subject}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {ticket.profiles?.display_name || ticket.user_email}
                  </p>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
