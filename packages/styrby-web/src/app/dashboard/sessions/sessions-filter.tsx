'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { SessionBookmarkButton } from './[id]/session-bookmark-button';

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
  /** Initial sessions fetched from the server, sorted by created_at desc */
  sessions: Session[];
  /** The authenticated user's ID for fetching additional pages and scope switching */
  userId: string;
  /** Whether the user belongs to a team (controls scope filter visibility) */
  hasTeam: boolean;
  /** Whether there are more sessions beyond the initial page */
  initialHasMore: boolean;
  /**
   * Set of session IDs that the user has bookmarked, fetched during SSR.
   * Used for the initial state of star icons and the Bookmarked filter.
   */
  initialBookmarkedIds: Set<string>;
}

/**
 * Scope filter values matching the mobile app's implementation.
 * 'mine' = user's personal sessions, 'team' = all team sessions.
 */
type SessionScope = 'mine' | 'team';

/* ──────────────────────────── Constants ──────────────────────────── */

/**
 * Number of sessions to fetch per infinite scroll page.
 *
 * WHY: Matches the mobile app's PAGE_SIZE constant (useSessions.ts)
 * for consistent pagination behaviour across platforms.
 */
const PAGE_SIZE = 20;

/**
 * Short day-of-week names for date section headers.
 *
 * WHY: Hoisted to module level so this array is allocated once at import time,
 * matching the mobile app's approach.
 */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Short month name abbreviations for date section headers.
 */
const MONTH_ABBREVS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/* ──────────────────────────── Date Grouping Helpers ──────────────────────────── */

/**
 * Format a date into a human-friendly section header label.
 *
 * Returns "Today", "Yesterday", or a short date like "Mon Mar 25" for
 * older dates. This matches the mobile app's formatSectionDate behaviour.
 *
 * WHY: Uses `new Date(year, month, day)` constructor instead of `new Date("YYYY-MM-DD")`
 * to avoid UTC timezone parsing issues. The string constructor parses as UTC midnight,
 * which can shift the date backward in western time zones.
 *
 * @param date - The date to format
 * @returns A section header string
 *
 * @example
 * formatSectionDate(new Date()); // "Today"
 * formatSectionDate(yesterday);  // "Yesterday"
 * formatSectionDate(lastWeek);   // "Mon Mar 25"
 */
function formatSectionDate(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor(
    (today.getTime() - target.getTime()) / 86_400_000
  );

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  return `${DAY_NAMES[date.getDay()]} ${MONTH_ABBREVS[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Derive a date-only key string (YYYY-MM-DD) from an ISO timestamp,
 * using the user's local timezone.
 *
 * WHY: We group sessions by the date portion of `created_at` in local time.
 * Using a consistent key format ensures sessions created on the same calendar
 * day are grouped together regardless of UTC offset.
 *
 * @param isoTimestamp - An ISO 8601 timestamp string
 * @returns A date key string in YYYY-MM-DD format (local timezone)
 */
function getDateKey(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Section shape for grouped session display. Each section contains a
 * formatted date label, session count, and the sessions for that date.
 */
interface SessionSection {
  /** Human-friendly date label (e.g. "Today", "Yesterday", "Mon Mar 25") */
  title: string;
  /** Number of sessions in this section */
  count: number;
  /** Sessions in this section, preserving the original sort order */
  data: Session[];
}

/**
 * Group an array of sessions by their `created_at` date into sections.
 *
 * Preserves the input order within each group (sessions are already sorted
 * by `created_at DESC` from the query).
 *
 * WHY: Uses `new Date(year, month - 1, day)` for the section header date
 * to avoid UTC parsing issues with `new Date("YYYY-MM-DD")`.
 *
 * @param sessions - Array of sessions to group
 * @returns Array of sections, each with a title, count, and data
 */
function groupSessionsByDate(sessions: Session[]): SessionSection[] {
  const groupMap = new Map<string, Session[]>();

  for (const session of sessions) {
    const key = getDateKey(session.created_at);
    const existing = groupMap.get(key);
    if (existing) {
      existing.push(session);
    } else {
      groupMap.set(key, [session]);
    }
  }

  const sections: SessionSection[] = [];

  for (const [key, data] of groupMap) {
    // WHY: Parse the YYYY-MM-DD key using component constructor, not string
    // constructor, to avoid UTC timezone shift.
    const [year, month, day] = key.split('-').map(Number);
    const dateObj = new Date(year, month - 1, day);

    sections.push({
      title: formatSectionDate(dateObj),
      count: data.length,
      data,
    });
  }

  return sections;
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
 * Client component that provides search, agent-type filtering, scope filtering
 * (mine/team), date-grouped display, and infinite scroll pagination for the
 * sessions list.
 *
 * WHY scope filter: Users who belong to teams need to switch between viewing
 * their own sessions and team-wide sessions. This mirrors the mobile app's
 * "My Sessions" / "Team Sessions" chip filter.
 *
 * WHY infinite scroll: Loading all sessions upfront (previous limit-50) doesn't
 * scale for power users. Intersection observer-based pagination loads 20
 * sessions at a time, matching the mobile app's PAGE_SIZE.
 *
 * WHY date grouping: "Today", "Yesterday", "Mon Mar 25" section headers
 * give users temporal context without parsing raw timestamps, matching the
 * mobile app's SectionList grouping.
 *
 * @param props - Pre-fetched sessions, user ID, team membership, and pagination state
 */
export function SessionsFilter({
  sessions: initialSessions,
  userId,
  hasTeam,
  initialHasMore,
  initialBookmarkedIds,
}: SessionsFilterProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  /** When true, only sessions that the user has bookmarked are shown. */
  const [showBookmarkedOnly, setShowBookmarkedOnly] = useState(false);
  const [scope, setScope] = useState<SessionScope>('mine');
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Infinite scroll state ──
  const [allSessions, setAllSessions] = useState<Session[]>(initialSessions);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isScopeLoading, setIsScopeLoading] = useState(false);

  // WHY: Intersection observer sentinel ref. When this element becomes visible,
  // we trigger the next page load. Placed at the bottom of the sessions list.
  const sentinelRef = useRef<HTMLDivElement>(null);

  // WHY: Keep initialSessions in sync when real-time updates change the parent's state.
  // Only update when scope is 'mine' since team sessions are fetched client-side.
  useEffect(() => {
    if (scope === 'mine') {
      setAllSessions(initialSessions);
      setHasMore(initialHasMore);
    }
  }, [initialSessions, initialHasMore, scope]);

  /**
   * Extracts unique tags from all sessions, sorted by frequency (most-used first).
   * Used to populate the tag filter dropdown with real data rather than hardcoded values.
   */
  const availableTags = useMemo(() => {
    const tagCounts: Record<string, number> = {};
    for (const session of allSessions) {
      if (session.tags) {
        for (const tag of session.tags) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }
    }
    return Object.entries(tagCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([tag]) => tag);
  }, [allSessions]);

  // WHY: 300ms debounce prevents excessive re-renders while the user types.
  // The filtering happens on every debounced update, not on every keystroke.
  const debouncedSearch = useDebouncedValue(searchQuery, 300);

  /**
   * Filters sessions by bookmarked state, agent type, tag, and debounced
   * search query.
   *
   * WHY bookmark filter: The `initialBookmarkedIds` set was fetched during SSR,
   * so no extra client-side fetch is needed to show "Bookmarked" sessions in
   * the list. For newly bookmarked sessions in this same page view we rely on
   * the optimistic star toggle in SessionBookmarkButton (visual only); the
   * filter reflects the SSR snapshot and refreshes on next page load.
   *
   * @returns Filtered session array matching all active criteria
   */
  const filteredSessions = useMemo(() => {
    let result = allSessions;

    // Filter by bookmark state
    if (showBookmarkedOnly) {
      result = result.filter((session) =>
        initialBookmarkedIds.has(session.id)
      );
    }

    // Filter by agent type
    if (agentFilter !== 'all') {
      result = result.filter(
        (session) => session.agent_type === agentFilter
      );
    }

    // Filter by tag
    if (tagFilter !== 'all') {
      result = result.filter(
        (session) => session.tags?.includes(tagFilter) ?? false
      );
    }

    // Filter by search query (matches title, summary, or tags)
    if (debouncedSearch.trim()) {
      const query = debouncedSearch.toLowerCase().trim();
      result = result.filter((session) => {
        const titleMatch =
          session.title?.toLowerCase().includes(query) ?? false;
        const summaryMatch =
          session.summary?.toLowerCase().includes(query) ?? false;
        const tagMatch =
          session.tags?.some((tag) => tag.toLowerCase().includes(query)) ?? false;
        return titleMatch || summaryMatch || tagMatch;
      });
    }

    return result;
  }, [allSessions, showBookmarkedOnly, initialBookmarkedIds, agentFilter, tagFilter, debouncedSearch]);

  /**
   * Groups filtered sessions by their creation date for display.
   *
   * WHY: Uses the new groupSessionsByDate helper that produces "Today",
   * "Yesterday", and "Day Mon DD" labels matching the mobile app's
   * SectionList headers.
   */
  const sessionSections = useMemo(
    () => groupSessionsByDate(filteredSessions),
    [filteredSessions]
  );

  /**
   * Clears all active filters and focuses the search input.
   */
  const handleClearFilters = useCallback(() => {
    setSearchQuery('');
    setAgentFilter('all');
    setTagFilter('all');
    setShowBookmarkedOnly(false);
    inputRef.current?.focus();
  }, []);

  const hasActiveFilters =
    searchQuery.trim() !== '' ||
    agentFilter !== 'all' ||
    tagFilter !== 'all' ||
    showBookmarkedOnly;

  // ── Scope switching ──

  /**
   * Handles scope filter change. When switching to "team" scope, fetches
   * team sessions from Supabase. When switching back to "mine", restores
   * the initial sessions from SSR.
   *
   * WHY: Team sessions require a different query (no user_id filter, or a
   * team_id filter). We fetch these client-side rather than SSR because the
   * scope toggle is an interactive client action.
   *
   * @param newScope - The new scope to switch to
   */
  const handleScopeChange = useCallback(async (newScope: SessionScope) => {
    if (newScope === scope) return;
    setScope(newScope);

    if (newScope === 'team') {
      setIsScopeLoading(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('sessions')
          .select('id, title, agent_type, status, total_cost_usd, message_count, created_at, summary, tags')
          .is('deleted_at', null)
          .not('team_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);

        setAllSessions(data || []);
        setHasMore((data?.length ?? 0) >= PAGE_SIZE);
      } catch {
        // On error, fall back to empty state
        setAllSessions([]);
        setHasMore(false);
      } finally {
        setIsScopeLoading(false);
      }
    } else {
      // Switching back to 'mine' - restore SSR sessions
      setAllSessions(initialSessions);
      setHasMore(initialHasMore);
    }
  }, [scope, initialSessions, initialHasMore]);

  // ── Infinite scroll: load more ──

  /**
   * Fetches the next page of sessions and appends to the current list.
   *
   * WHY: Uses the same query shape as the SSR fetch, with offset-based
   * pagination. The scope determines whether we filter by user_id or team_id.
   */
  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore) return;

    setIsLoadingMore(true);
    try {
      const supabase = createClient();
      let query = supabase
        .from('sessions')
        .select('id, title, agent_type, status, total_cost_usd, message_count, created_at, summary, tags')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .range(allSessions.length, allSessions.length + PAGE_SIZE - 1);

      if (scope === 'mine') {
        query = query.eq('user_id', userId);
      } else {
        query = query.not('team_id', 'is', null);
      }

      const { data } = await query;
      const newSessions = data || [];

      setAllSessions((prev) => [...prev, ...newSessions]);
      setHasMore(newSessions.length >= PAGE_SIZE);
    } catch {
      // Silently fail - user can scroll again to retry
      setHasMore(false);
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, isLoadingMore, allSessions.length, scope, userId]);

  // ── Intersection Observer for infinite scroll ──

  /**
   * WHY: IntersectionObserver is more performant than scroll event listeners
   * because the browser handles threshold calculations natively. When the
   * sentinel element (placed at the bottom of the list) becomes visible,
   * we trigger a loadMore call.
   */
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isLoadingMore) {
          loadMore();
        }
      },
      {
        // WHY: rootMargin extends the detection zone 200px below the viewport
        // so we start loading before the user reaches the absolute bottom.
        rootMargin: '0px 0px 200px 0px',
        threshold: 0,
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, loadMore]);

  return (
    <>
      {/* Header with scope filter and search/filters */}
      <div className="flex flex-col gap-4 mb-8">
        <div className="flex items-center justify-between">
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

            {/* Bookmarked filter toggle */}
            {/* WHY: A toggle button is used instead of a select/checkbox so the
                "Bookmarked" filter visually matches the scope filter tabs for
                consistency. The star icon provides immediate visual affordance
                for what the filter does. */}
            <button
              onClick={() => setShowBookmarkedOnly((prev) => !prev)}
              aria-pressed={showBookmarkedOnly}
              aria-label={
                showBookmarkedOnly
                  ? 'Showing bookmarked sessions — click to show all'
                  : 'Show only bookmarked sessions'
              }
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                showBookmarkedOnly
                  ? 'border-orange-500/50 bg-orange-500/10 text-orange-400'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
              }`}
            >
              {/* Filled star when active, outline when inactive */}
              {showBookmarkedOnly ? (
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              )}
              Bookmarked
            </button>

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

            {/* Tag filter - only rendered when sessions have tags */}
            {availableTags.length > 0 && (
              <select
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                aria-label="Filter sessions by tag"
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              >
                <option value="all">All Tags</option>
                {availableTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Scope filter tabs - only visible when user has a team */}
        {/* WHY: The scope filter mirrors the mobile app's "My Sessions" / "Team Sessions"
            chips. It's only shown to users who have team sessions, avoiding confusion
            for solo users. Uses a segmented control pattern (shadcn-compatible styling)
            for quick toggling between personal and team views. */}
        {hasTeam && (
          <div
            className="inline-flex rounded-lg bg-zinc-800 p-1 self-start"
            role="tablist"
            aria-label="Session scope filter"
          >
            <button
              role="tab"
              aria-selected={scope === 'mine'}
              onClick={() => handleScopeChange('mine')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                scope === 'mine'
                  ? 'bg-orange-500 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              My Sessions
            </button>
            <button
              role="tab"
              aria-selected={scope === 'team'}
              onClick={() => handleScopeChange('team')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                scope === 'team'
                  ? 'bg-orange-500 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Team Sessions
            </button>
          </div>
        )}
      </div>

      {/* Active filter indicator */}
      {hasActiveFilters && (
        <div aria-live="polite" className="mb-4 flex items-center gap-3 text-sm text-zinc-400">
          <span>
            Showing {filteredSessions.length} of {allSessions.length} sessions
          </span>
          <button
            onClick={handleClearFilters}
            className="text-orange-500 hover:text-orange-400 transition-colors"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Scope loading indicator */}
      {isScopeLoading && (
        <div className="flex items-center justify-center py-12">
          <svg
            className="animate-spin h-6 w-6 text-orange-500"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
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
          <span className="ml-3 text-zinc-400">Loading sessions...</span>
        </div>
      )}

      {/* Sessions list grouped by date */}
      {!isScopeLoading && sessionSections.length > 0 ? (
        <div className="space-y-8">
          {sessionSections.map((section) => (
            <div key={section.title}>
              {/* Sticky date header matching mobile app's section headers */}
              <h2 className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur-sm text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3 py-1">
                {section.title} ({section.count})
              </h2>
              <div className="rounded-xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
                {section.data.map((session) => (
                  <Link
                    key={session.id}
                    href={`/dashboard/sessions/${session.id}`}
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
                            aria-hidden="true"
                            className={`h-2 w-2 rounded-full ${
                              session.status === 'running'
                                ? 'bg-green-500 animate-pulse'
                                : session.status === 'idle'
                                  ? 'bg-yellow-500'
                                  : 'bg-zinc-500'
                            }`}
                          />
                          <span className="sr-only">
                            {session.status === 'running'
                              ? 'Running'
                              : session.status === 'idle'
                                ? 'Idle'
                                : 'Ended'}
                          </span>

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
                        {/* Bookmark star — click to toggle without navigating to detail */}
                        <SessionBookmarkButton
                          sessionId={session.id}
                          initialBookmarked={initialBookmarkedIds.has(session.id)}
                          size="sm"
                        />
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

          {/* Infinite scroll sentinel and loading indicator */}
          <div ref={sentinelRef} className="h-1" aria-hidden="true" />
          {isLoadingMore && (
            <div className="flex items-center justify-center py-6">
              <svg
                className="animate-spin h-5 w-5 text-orange-500"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
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
              <span className="ml-2 text-sm text-zinc-500">Loading more sessions...</span>
            </div>
          )}
          {!hasMore && allSessions.length > 0 && (
            <p className="text-center text-sm text-zinc-500 py-4">
              All sessions loaded
            </p>
          )}
        </div>
      ) : !isScopeLoading && hasActiveFilters ? (
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
      ) : !isScopeLoading ? (
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
            {scope === 'team' ? 'No team sessions yet' : 'No sessions yet'}
          </h3>
          <p className="mt-2 text-zinc-500">
            {scope === 'team'
              ? 'Team sessions will appear here when team members start using Styrby.'
              : 'Start a session with your AI coding agent to see it here.'}
          </p>
          {scope === 'mine' && (
            <p className="mt-1 text-sm text-zinc-500">
              Run <code className="text-orange-500">styrby chat</code> to get
              started.
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}
