'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';

/* ──────────────────────────── Types ──────────────────────────── */

interface Session {
  /** Unique session identifier */
  id: string;
  /** User-defined session title */
  title: string | null;
  /** Which AI agent was used ('claude' | 'codex' | 'gemini') */
  agent_type: string;
  /** Current session status ('running' | 'idle' | 'ended') */
  status: string;
  /** Cumulative cost in USD */
  total_cost_usd: number;
  /** Number of messages exchanged */
  message_count: number;
  /** ISO 8601 timestamp of session creation */
  created_at: string;
  /** AI-generated summary of the session */
  summary: string | null;
  /** User-applied tags */
  tags: string[] | null;
}

interface SessionsFilterProps {
  /** All sessions fetched from the server, sorted by created_at desc */
  sessions: Session[];
}

/* ──────────────────────────── Hook: Debounce ─────────────────── */

/**
 * Returns a debounced version of the provided value.
 * Updates only after the specified delay (ms) of inactivity.
 *
 * @param value - The value to debounce
 * @param delay - Delay in milliseconds before the value updates
 * @returns The debounced value
 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Client component that provides search and agent-type filtering
 * for the sessions list. Receives the full list from the server
 * and filters it client-side with debounced search.
 *
 * @param props.sessions - Pre-fetched sessions array from the server component
 */
export function SessionsFilter({ sessions }: SessionsFilterProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const inputRef = useRef<HTMLInputElement>(null);

  // WHY: 300ms debounce prevents excessive re-renders while the user types.
  // The filtering happens on every debounced update, not on every keystroke.
  const debouncedSearch = useDebouncedValue(searchQuery, 300);

  /**
   * Filters sessions by agent type and debounced search query.
   * Search matches against title and summary (case-insensitive).
   */
  const filteredSessions = useMemo(() => {
    let result = sessions;

    // Filter by agent type
    if (agentFilter !== 'all') {
      result = result.filter(
        (session) => session.agent_type === agentFilter
      );
    }

    // Filter by search query (matches title or summary)
    if (debouncedSearch.trim()) {
      const query = debouncedSearch.toLowerCase().trim();
      result = result.filter((session) => {
        const titleMatch =
          session.title?.toLowerCase().includes(query) ?? false;
        const summaryMatch =
          session.summary?.toLowerCase().includes(query) ?? false;
        return titleMatch || summaryMatch;
      });
    }

    return result;
  }, [sessions, agentFilter, debouncedSearch]);

  /**
   * Groups filtered sessions by their creation date for display.
   */
  const sessionsByDate = useMemo(() => {
    return filteredSessions.reduce(
      (acc, session) => {
        const date = new Date(session.created_at).toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
        if (!acc[date]) {
          acc[date] = [];
        }
        acc[date].push(session);
        return acc;
      },
      {} as Record<string, Session[]>
    );
  }, [filteredSessions]);

  /**
   * Clears all active filters and focuses the search input.
   */
  const handleClearFilters = useCallback(() => {
    setSearchQuery('');
    setAgentFilter('all');
    inputRef.current?.focus();
  }, []);

  const hasActiveFilters = searchQuery.trim() !== '' || agentFilter !== 'all';

  return (
    <>
      {/* Search and filters */}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-zinc-100">Sessions</h1>

        <div className="flex items-center gap-4">
          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              aria-label="Search sessions by title or summary"
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 pl-9 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 w-64"
            />
            {/* Search icon */}
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            {/* Clear search button */}
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                aria-label="Clear search"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>

          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            aria-label="Filter sessions by agent type"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
          >
            <option value="all">All Agents</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
      </div>

      {/* Active filter indicator */}
      {hasActiveFilters && (
        <div className="mb-4 flex items-center gap-3 text-sm text-zinc-400">
          <span>
            Showing {filteredSessions.length} of {sessions.length} sessions
          </span>
          <button
            onClick={handleClearFilters}
            className="text-orange-500 hover:text-orange-400 transition-colors"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Sessions list grouped by date */}
      {Object.keys(sessionsByDate).length > 0 ? (
        <div className="space-y-8">
          {Object.entries(sessionsByDate).map(([date, dateSessions]) => (
            <div key={date}>
              <h2 className="text-sm font-medium text-zinc-500 mb-3">
                {date}
              </h2>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
                {dateSessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/sessions/${session.id}`}
                    className="block px-4 py-4 hover:bg-zinc-800/50 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-1">
                          {/* Agent badge */}
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                              session.agent_type === 'claude'
                                ? 'bg-orange-500/10 text-orange-400'
                                : session.agent_type === 'codex'
                                  ? 'bg-green-500/10 text-green-400'
                                  : 'bg-blue-500/10 text-blue-400'
                            }`}
                          >
                            {session.agent_type}
                          </span>

                          {/* Status indicator */}
                          <span
                            className={`h-2 w-2 rounded-full ${
                              session.status === 'running'
                                ? 'bg-green-500 animate-pulse'
                                : session.status === 'idle'
                                  ? 'bg-yellow-500'
                                  : 'bg-zinc-500'
                            }`}
                          />

                          {/* Tags */}
                          {session.tags &&
                            session.tags.slice(0, 3).map((tag: string) => (
                              <span
                                key={tag}
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs bg-zinc-800 text-zinc-400"
                              >
                                {tag}
                              </span>
                            ))}
                        </div>

                        {/* Title */}
                        <h3 className="text-zinc-100 font-medium">
                          {session.title || 'Untitled session'}
                        </h3>

                        {/* Summary */}
                        {session.summary && (
                          <p className="text-sm text-zinc-500 mt-1 line-clamp-2">
                            {session.summary}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-col items-end gap-1 text-sm text-zinc-500 ml-4">
                        <span>{session.message_count} messages</span>
                        <span>
                          ${Number(session.total_cost_usd).toFixed(4)}
                        </span>
                        <span>
                          {new Date(session.created_at).toLocaleTimeString(
                            'en-US',
                            {
                              hour: 'numeric',
                              minute: '2-digit',
                            }
                          )}
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : hasActiveFilters ? (
        /* No results for current filter */
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-16 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
            <svg
              className="h-6 w-6 text-zinc-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-zinc-100">
            No matching sessions
          </h3>
          <p className="mt-2 text-zinc-500">
            No sessions match your current search or filter criteria.
          </p>
          <button
            onClick={handleClearFilters}
            className="mt-4 text-sm text-orange-500 hover:text-orange-400 transition-colors"
          >
            Clear filters
          </button>
        </div>
      ) : (
        /* No sessions at all */
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-16 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
            <svg
              className="h-6 w-6 text-zinc-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-zinc-100">
            No sessions yet
          </h3>
          <p className="mt-2 text-zinc-500">
            Start a session with your AI coding agent to see it here.
          </p>
          <p className="mt-1 text-sm text-zinc-600">
            Run <code className="text-orange-500">styrby chat</code> to get
            started.
          </p>
        </div>
      )}
    </>
  );
}
