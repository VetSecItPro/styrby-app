/**
 * Sessions Data Hook
 *
 * Fetches and manages session data from Supabase for the sessions list screen.
 * Supports infinite-scroll pagination, debounced search, status/agent filtering,
 * and pull-to-refresh. Returns typed session rows along with loading, error,
 * and pagination states.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { AgentType, SessionStatus } from 'styrby-shared';

// ============================================================================
// Constants
// ============================================================================

/** Number of sessions to load per page. */
const PAGE_SIZE = 20;

/** Debounce delay in milliseconds for search input. */
const SEARCH_DEBOUNCE_MS = 300;

// ============================================================================
// Types
// ============================================================================

/**
 * A single session row returned from the Supabase `sessions` table.
 * Only the columns needed for the list / card UI are selected.
 */
export interface SessionRow {
  /** Primary key */
  id: string;
  /** Owner of the session */
  user_id: string;
  /** Machine that ran the session */
  machine_id: string;
  /** Which AI agent was used (claude, codex, gemini) */
  agent_type: AgentType;
  /** Session lifecycle status */
  status: SessionStatus;
  /** Human-readable session title (may be null for untitled sessions) */
  title: string | null;
  /** AI-generated summary of what happened in the session */
  summary: string | null;
  /** Total input tokens consumed */
  total_input_tokens: number;
  /** Total output tokens consumed */
  total_output_tokens: number;
  /** Total cost in USD for the session */
  total_cost_usd: number;
  /** When the session began */
  started_at: string;
  /** When the session ended (null if still active) */
  ended_at: string | null;
  /** User-defined tags for organisation */
  tags: string[];
  /** Last time the session was modified */
  updated_at: string;
  /** Number of messages exchanged */
  message_count: number;
  /** Team ID if this is a team session (null for personal sessions) */
  team_id: string | null;
}

/**
 * Combined filter state for the sessions list.
 */
export interface SessionFilters {
  /** Status filter: null means "all" */
  status: 'active' | 'completed' | null;
  /** Agent filter: null means "all agents" */
  agent: AgentType | null;
  /** Scope filter: 'mine' for personal sessions, 'team' for team sessions */
  scope: 'mine' | 'team' | null;
  /** Team ID to filter by (only used when scope is 'team') */
  teamId: string | null;
}

/**
 * Return type for the useSessions hook.
 */
export interface UseSessionsReturn {
  /** Array of loaded session rows */
  sessions: SessionRow[];
  /** Whether the initial load is in progress */
  isLoading: boolean;
  /** Whether a pull-to-refresh is in progress */
  isRefreshing: boolean;
  /** Whether more pages are being loaded */
  isLoadingMore: boolean;
  /** Whether there are more pages to load */
  hasMore: boolean;
  /** Error message if the most recent fetch failed */
  error: string | null;
  /** Current search query */
  searchQuery: string;
  /** Current active filters */
  filters: SessionFilters;
  /** Update the search query (debounced internally) */
  setSearchQuery: (query: string) => void;
  /** Update the filter state (triggers immediate re-fetch) */
  setFilters: (filters: SessionFilters) => void;
  /** Pull-to-refresh handler */
  refresh: () => Promise<void>;
  /** Load the next page of results (call on scroll-end) */
  loadMore: () => Promise<void>;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for fetching, searching, filtering, and paginating session data.
 *
 * Sessions are fetched from the Supabase `sessions` table, ordered by
 * `updated_at DESC`, filtered to the currently authenticated user, and
 * paginated in increments of {@link PAGE_SIZE}.
 *
 * Search uses Postgres `.ilike()` against `title` and `summary` with a
 * 300 ms debounce so the database is not hammered on every keystroke.
 *
 * @returns Session data, loading / error states, and control functions
 *
 * @example
 * const {
 *   sessions, isLoading, error, refresh, isRefreshing,
 *   loadMore, hasMore, searchQuery, setSearchQuery,
 *   filters, setFilters,
 * } = useSessions();
 */
export function useSessions(): UseSessionsReturn {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQueryState] = useState('');
  const [filters, setFiltersState] = useState<SessionFilters>({
    status: null,
    agent: null,
    scope: null,
    teamId: null,
  });

  // WHY: We keep a ref to the latest debounced search term so that the
  // actual Supabase query always uses the most recent value, even when
  // multiple debounced calls overlap.
  const debouncedSearchRef = useRef('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WHY: An incrementing "generation" counter lets us discard stale
  // responses from out-of-order network requests. Each new fetch bumps
  // the counter; when a response arrives we only apply it if its
  // generation still matches the current value.
  const fetchGenerationRef = useRef(0);

  // -------------------------------------------------------------------------
  // Core fetcher
  // -------------------------------------------------------------------------

  /**
   * Build and execute the Supabase query for a page of sessions.
   *
   * @param offset - Number of rows to skip (for pagination)
   * @param search - Search string to match against title/summary
   * @param currentFilters - Active status and agent filters
   * @returns The fetched rows, or throws on error
   */
  const fetchSessions = useCallback(
    async (
      offset: number,
      search: string,
      currentFilters: SessionFilters,
    ): Promise<SessionRow[]> => {
      // Start with the base query scoped to the authenticated user.
      // RLS on the sessions table already enforces ownership, but we
      // also filter explicitly so the covering index is used.
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        throw new Error('You must be logged in to view sessions.');
      }

      let query = supabase
        .from('sessions')
        .select(
          'id, user_id, machine_id, agent_type, status, title, summary, ' +
          'total_input_tokens, total_output_tokens, total_cost_usd, ' +
          'started_at, ended_at, tags, updated_at, message_count, team_id',
        )
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      // ---- Scope filter (mine vs team) ----
      // WHY: RLS handles access control, but we filter here to show either
      // personal sessions (owned by user) or team sessions (team_id is set).
      if (currentFilters.scope === 'mine' || !currentFilters.scope) {
        // Show only user's personal sessions
        query = query.eq('user_id', user.id);
      } else if (currentFilters.scope === 'team' && currentFilters.teamId) {
        // Show only team sessions for the specified team
        query = query.eq('team_id', currentFilters.teamId);
      } else {
        // Default: user's own sessions
        query = query.eq('user_id', user.id);
      }

      // ---- Status filter ----
      if (currentFilters.status === 'active') {
        // WHY: "active" maps to multiple session_status enum values.
        // A session is considered active if it hasn't reached a terminal
        // state (stopped, error, expired).
        query = query.in('status', ['starting', 'running', 'idle', 'paused']);
      } else if (currentFilters.status === 'completed') {
        query = query.in('status', ['stopped', 'expired']);
      }

      // ---- Agent filter ----
      if (currentFilters.agent) {
        query = query.eq('agent_type', currentFilters.agent);
      }

      // ---- Search filter ----
      // WHY: We use `.ilike()` with a wildcard pattern because the
      // pg_trgm GIN index on the sessions table accelerates ILIKE
      // queries with patterns >= 3 characters. For shorter queries
      // Postgres falls back to a sequential scan, which is acceptable
      // given that each user has at most a few thousand sessions.
      if (search.trim().length > 0) {
        const pattern = `%${search.trim()}%`;
        query = query.or(`title.ilike.${pattern},summary.ilike.${pattern}`);
      }

      const { data, error: queryError } = await query;

      if (queryError) {
        throw new Error(queryError.message);
      }

      // WHY: Supabase's generated types don't match our SessionRow interface
      // exactly because we SELECT a subset of columns. The cast through
      // `unknown` is safe because the SELECT list above matches SessionRow.
      return (data as unknown as SessionRow[]) || [];
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Initial load & re-fetch on filter/search change
  // -------------------------------------------------------------------------

  /**
   * Perform a fresh fetch (page 0) using the current search and filters.
   * Resets pagination state.
   */
  const loadInitial = useCallback(
    async (search: string, currentFilters: SessionFilters) => {
      const generation = ++fetchGenerationRef.current;
      setIsLoading(true);
      setError(null);

      try {
        const rows = await fetchSessions(0, search, currentFilters);

        // Discard stale response
        if (generation !== fetchGenerationRef.current) return;

        setSessions(rows);
        setHasMore(rows.length === PAGE_SIZE);
      } catch (err) {
        if (generation !== fetchGenerationRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load sessions');
      } finally {
        if (generation === fetchGenerationRef.current) {
          setIsLoading(false);
        }
      }
    },
    [fetchSessions],
  );

  // Trigger a fresh load whenever debounced search or filters change.
  useEffect(() => {
    loadInitial(debouncedSearchRef.current, filters);
  }, [loadInitial, filters]);

  // -------------------------------------------------------------------------
  // Debounced search
  // -------------------------------------------------------------------------

  /**
   * Update the search query. Internally debounces the actual Supabase
   * request by {@link SEARCH_DEBOUNCE_MS} so that we don't fire a query
   * on every keystroke.
   *
   * @param query - The raw search input text
   */
  const setSearchQuery = useCallback(
    (query: string) => {
      setSearchQueryState(query);

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        debouncedSearchRef.current = query;
        loadInitial(query, filters);
      }, SEARCH_DEBOUNCE_MS);
    },
    [filters, loadInitial],
  );

  // Cleanup the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Filters
  // -------------------------------------------------------------------------

  /**
   * Replace the current filter state. Triggers an immediate re-fetch
   * (the useEffect on `filters` handles this).
   *
   * @param newFilters - The new status and agent filters to apply
   */
  const setFilters = useCallback((newFilters: SessionFilters) => {
    setFiltersState(newFilters);
  }, []);

  // -------------------------------------------------------------------------
  // Pull-to-refresh
  // -------------------------------------------------------------------------

  /**
   * Pull-to-refresh handler. Reloads page 0 while keeping the current
   * search and filters intact.
   */
  const refresh = useCallback(async () => {
    const generation = ++fetchGenerationRef.current;
    setIsRefreshing(true);
    setError(null);

    try {
      const rows = await fetchSessions(
        0,
        debouncedSearchRef.current,
        filters,
      );

      if (generation !== fetchGenerationRef.current) return;

      setSessions(rows);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (err) {
      if (generation !== fetchGenerationRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to refresh sessions');
    } finally {
      if (generation === fetchGenerationRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [fetchSessions, filters]);

  // -------------------------------------------------------------------------
  // Infinite scroll (load more)
  // -------------------------------------------------------------------------

  /**
   * Load the next page of sessions and append to the existing list.
   * No-ops if there are no more pages or a load is already in progress.
   */
  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore || isLoading) return;

    const generation = ++fetchGenerationRef.current;
    setIsLoadingMore(true);

    try {
      const rows = await fetchSessions(
        sessions.length,
        debouncedSearchRef.current,
        filters,
      );

      if (generation !== fetchGenerationRef.current) return;

      setSessions((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (err) {
      if (generation !== fetchGenerationRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load more sessions');
    } finally {
      if (generation === fetchGenerationRef.current) {
        setIsLoadingMore(false);
      }
    }
  }, [hasMore, isLoadingMore, isLoading, sessions.length, fetchSessions, filters]);

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    sessions,
    isLoading,
    isRefreshing,
    isLoadingMore,
    hasMore,
    error,
    searchQuery,
    filters,
    setSearchQuery,
    setFilters,
    refresh,
    loadMore,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert an ISO timestamp string into a human-friendly relative time string.
 *
 * Returns "just now" for < 1 minute, "Xm ago" for < 1 hour, "Xh ago" for
 * < 24 hours, "yesterday" for 24-48 hours, and a short date for anything
 * older.
 *
 * @param isoTimestamp - An ISO 8601 date string (e.g. from Supabase)
 * @returns A short relative time string suitable for display in a list item
 *
 * @example
 * formatRelativeTime('2025-01-15T10:30:00Z'); // "3h ago" (if now is 1:30pm)
 */
export function formatRelativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  if (diffMs < MINUTE) return 'just now';
  if (diffMs < HOUR) return `${Math.floor(diffMs / MINUTE)}m ago`;
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)}h ago`;
  if (diffMs < DAY * 2) return 'yesterday';

  // Older than 2 days: show "Jan 15" format
  const date = new Date(isoTimestamp);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Get the first non-empty line of a potentially multi-line summary string.
 *
 * Used to display a preview of the AI-generated session summary in the
 * session list card without showing the full (potentially long) text.
 *
 * @param summary - The full session summary (may be null)
 * @returns The first line, or null if the summary is empty/null
 */
export function getFirstLine(summary: string | null): string | null {
  if (!summary) return null;
  const firstLine = summary.split('\n').find((line) => line.trim().length > 0);
  return firstLine?.trim() || null;
}
