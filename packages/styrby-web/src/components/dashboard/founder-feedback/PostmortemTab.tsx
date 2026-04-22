'use client';

/**
 * PostmortemTab — session post-mortem feedback panel for the founder dashboard.
 *
 * Displays latest 50 post-mortem ratings with:
 *   - Filter by agent type
 *   - Filter by rating (useful / not_useful)
 *   - Duration, agent, and reason display
 *
 * Auto-refreshes every 60 seconds.
 *
 * @module components/dashboard/founder-feedback/PostmortemTab
 */

import * as React from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface SessionRef {
  agent_type: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface PostmortemItem {
  id: string;
  session_id: string | null;
  rating: string | null;
  reason: string | null;
  context_json: Record<string, unknown> | null;
  created_at: string;
  session?: SessionRef | null;
}

interface PostmortemTabProps {
  initialItems: PostmortemItem[];
  initialTotal: number;
}

// ============================================================================
// Helpers
// ============================================================================

/** Calculate session duration in minutes from started_at / ended_at. */
function durationMin(session: SessionRef | null | undefined): number | null {
  if (!session?.started_at || !session?.ended_at) return null;
  return Math.round(
    (new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 60000
  );
}

/** Agent display names. */
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  aider: 'Aider',
  goose: 'Goose',
  amp: 'Amp',
  crush: 'Crush',
  kilo: 'Kilo',
  kiro: 'Kiro',
  droid: 'Droid',
};

// ============================================================================
// Component
// ============================================================================

/**
 * Session post-mortem tab for the founder dashboard.
 *
 * @param props - PostmortemTabProps
 */
export function PostmortemTab({ initialItems, initialTotal }: PostmortemTabProps) {
  const [items, setItems] = React.useState<PostmortemItem[]>(initialItems);
  const [total, setTotal] = React.useState(initialTotal);
  const [agentFilter, setAgentFilter] = React.useState<string>('');
  const [ratingFilter, setRatingFilter] = React.useState<string>('');
  const [loading, setLoading] = React.useState(false);

  // Refetch when filters change
  React.useEffect(() => {
    const params = new URLSearchParams({ tab: 'postmortems' });
    if (agentFilter) params.set('agent', agentFilter);
    if (ratingFilter) params.set('rating', ratingFilter);

    let cancelled = false;
    setLoading(true);

    fetch(`/api/admin/founder-feedback?${params}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json) {
          setItems(json.data.items);
          setTotal(json.data.total);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentFilter, ratingFilter]);

  // Auto-refresh every 60 seconds when no filters active
  React.useEffect(() => {
    if (agentFilter || ratingFilter) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/admin/founder-feedback?tab=postmortems', {
          credentials: 'include',
        });
        if (res.ok) {
          const json = await res.json();
          setItems(json.data.items);
          setTotal(json.data.total);
        }
      } catch {
        // Non-fatal
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [agentFilter, ratingFilter]);

  const agents = Array.from(
    new Set(
      items
        .map((i) => i.session?.agent_type)
        .filter(Boolean) as string[]
    )
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          aria-label="Filter by agent"
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {AGENT_LABELS[a] ?? a}
            </option>
          ))}
        </select>

        <select
          value={ratingFilter}
          onChange={(e) => setRatingFilter(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          aria-label="Filter by rating"
        >
          <option value="">All ratings</option>
          <option value="useful">Useful</option>
          <option value="not_useful">Not useful</option>
        </select>

        {loading && (
          <span className="flex items-center text-xs text-zinc-500">
            <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
            Loading...
          </span>
        )}

        <span className="ml-auto text-xs text-zinc-500">
          {items.length} of {total}
        </span>
      </div>

      {/* List */}
      {items.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-sm text-zinc-500">No post-mortem data yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <PostmortemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sub-component
// ============================================================================

/**
 * Single post-mortem feedback card.
 *
 * @param item - PostmortemItem to display
 */
function PostmortemCard({ item }: { item: PostmortemItem }) {
  const isUseful = item.rating === 'useful';
  const agentLabel =
    item.session?.agent_type ? (AGENT_LABELS[item.session.agent_type] ?? item.session.agent_type) : 'unknown';
  const dur = durationMin(item.session);
  const date = new Date(item.created_at).toLocaleDateString();

  return (
    <div
      className={`rounded-lg border p-4 ${
        isUseful ? 'border-zinc-800 bg-zinc-900' : 'border-red-900/40 bg-red-950/20'
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        {isUseful ? (
          <ThumbsUp className="h-4 w-4 flex-shrink-0 text-green-400" />
        ) : (
          <ThumbsDown className="h-4 w-4 flex-shrink-0 text-red-400" />
        )}
        <span
          className={`text-sm font-medium ${
            isUseful ? 'text-green-300' : 'text-red-300'
          }`}
        >
          {isUseful ? 'Useful' : 'Not useful'}
        </span>
        <span className="text-xs text-zinc-500">{agentLabel}</span>
        {dur != null && (
          <span className="text-xs text-zinc-500">{dur} min</span>
        )}
        <span className="ml-auto text-xs text-zinc-400">{date}</span>
      </div>

      {item.reason && (
        <p className="mt-1 text-sm text-zinc-300">{item.reason}</p>
      )}
    </div>
  );
}
