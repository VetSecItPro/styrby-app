/**
 * Sessions Screen — orchestrator.
 *
 * Displays the user's past coding sessions from Supabase with search,
 * status/agent/scope/date/tag filtering, infinite-scroll pagination,
 * and pull-to-refresh. Tapping a session card navigates to the chat
 * screen (active sessions) or the session detail page (completed).
 *
 * WHY (orchestrator pattern): This file owns state + data fetching +
 * top-level layout only. Presentation lives in
 * `src/components/sessions/*` and `src/hooks/useTeamMembership.ts` so
 * no single file exceeds 400 LOC.
 */

import {
  View,
  Text,
  SectionList,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import {
  useSessions,
  type SessionRow,
  type SessionFilters,
  type DateRangeFilter,
} from '../../src/hooks/useSessions';
import { useBookmarks } from '../../src/hooks/useBookmarks';
import { useTeamMembership } from '../../src/hooks/useTeamMembership';
import { useSessionTags } from '../../src/hooks/useSessionTags';
import {
  SessionCard,
  SessionsSearchBar,
  SessionsFilterBar,
  SessionsLoadingState,
  SessionsErrorState,
  SessionsEmptyState,
  groupSessionsByDate,
} from '../../src/components/sessions';
import type { AgentType } from 'styrby-shared';

/**
 * Sessions list screen — see module doc.
 */
export default function SessionsScreen() {
  const {
    sessions,
    isLoading,
    isRefreshing,
    isLoadingMore,
    hasMore,
    error,
    searchQuery,
    filters,
    isRealtimeConnected,
    setSearchQuery,
    setFilters,
    refresh,
    loadMore,
  } = useSessions();

  const { bookmarkedIds, togglingIds, toggleErrors, toggleBookmark } =
    useBookmarks();

  // ---- Team membership gate (P10) ----
  const { isTeamMember, userTeamId } = useTeamMembership();

  // ---- Bookmark filter ----
  /**
   * When true, only bookmarked sessions are shown in the list.
   * Applied client-side against the already-loaded `sessions` array.
   */
  const [showBookmarkedOnly, setShowBookmarkedOnly] = useState(false);

  // ---- Tag filtering ----
  /**
   * Currently selected tag for client-side filtering.
   * null means "show all tags" (no tag filter active).
   */
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  /**
   * Reset the tag filter whenever the status/agent/scope filters change.
   *
   * WHY: Tag filtering is client-side on the already-loaded session set.
   * If the user changes a scope filter (e.g., switches from "My Sessions"
   * to "Team Sessions"), the new session set may not contain the currently
   * selected tag at all, leaving the list empty with no clear explanation.
   * Resetting to "All Tags" on any filter change prevents this confusing
   * empty state.
   */
  useEffect(() => {
    setTagFilter(null);
  }, [filters]);

  /**
   * Derived alphabetical tag list + per-tag counts for the tag chip bar.
   * See useSessionTags for the reasoning behind extracting this.
   */
  const { allTags, tagCounts } = useSessionTags(sessions);

  /**
   * Sessions filtered by bookmark state and selected tag (both client-side).
   *
   * WHY: Both filters operate on the already-loaded `sessions` array so no
   * additional Supabase queries are needed. Server-side filtering would not
   * integrate cleanly with cursor-based infinite scroll pagination.
   */
  const filteredSessions = useMemo(() => {
    let result = sessions;

    // Bookmark filter — only show sessions the user has starred
    if (showBookmarkedOnly) {
      result = result.filter((s) => bookmarkedIds.has(s.id));
    }

    // Tag filter
    if (tagFilter) {
      result = result.filter((s) => s.tags && s.tags.includes(tagFilter));
    }

    return result;
  }, [sessions, showBookmarkedOnly, bookmarkedIds, tagFilter]);

  /**
   * Sessions grouped by date for the SectionList.
   */
  const sections = useMemo(
    () => groupSessionsByDate(filteredSessions),
    [filteredSessions],
  );

  // ---- Navigation ----
  /**
   * Navigate to the appropriate screen based on session status.
   * - Active sessions: Go to chat for real-time interaction
   * - Completed sessions: Go to session detail for summary and history
   *
   * @param session - The session row that was tapped
   */
  const handleSessionPress = useCallback((session: SessionRow) => {
    const isActive = ['starting', 'running', 'idle', 'paused'].includes(
      session.status,
    );

    if (isActive) {
      // Active sessions go directly to chat for real-time interaction
      router.push({
        pathname: '/(tabs)/chat',
        params: {
          sessionId: session.id,
          agent: session.agent_type,
        },
      });
    } else {
      // Completed sessions go to detail page with summary
      router.push({
        pathname: '/session/[id]',
        params: {
          id: session.id,
        },
      });
    }
  }, []);

  // ---- Filter handlers ----
  /**
   * Update the status filter while preserving the current agent filter.
   *
   * @param status - The new status filter value
   */
  const handleStatusFilterChange = useCallback(
    (status: SessionFilters['status']) => {
      setFilters({ ...filters, status });
    },
    [filters, setFilters],
  );

  /**
   * Update the agent filter while preserving the current status filter.
   *
   * @param agent - The new agent filter value
   */
  const handleAgentFilterChange = useCallback(
    (agent: AgentType | null) => {
      setFilters({ ...filters, agent });
    },
    [filters, setFilters],
  );

  /**
   * Update the scope filter (mine vs team sessions).
   *
   * WHY: Supply userTeamId when switching to team scope so fetchSessions
   * applies `team_id=eq.<teamId>`. Without this the query falls through
   * to the default user_id filter and returns no team sessions.
   *
   * @param scope - The new scope filter value
   */
  const handleScopeFilterChange = useCallback(
    (scope: 'mine' | 'team' | null) => {
      setFilters({
        ...filters,
        scope,
        teamId: scope === 'team' ? userTeamId : null,
      });
    },
    [filters, setFilters, userTeamId],
  );

  /**
   * Update the date range filter while preserving all other active filters.
   *
   * @param dateRange - The new date range value ('all' clears the filter)
   */
  const handleDateRangeFilterChange = useCallback(
    (dateRange: DateRangeFilter) => {
      setFilters({
        ...filters,
        dateRange: dateRange === 'all' ? null : dateRange,
      });
    },
    [filters, setFilters],
  );

  /**
   * Toggle the bookmark-only filter.
   */
  const handleBookmarkedToggle = useCallback(() => {
    setShowBookmarkedOnly((prev) => !prev);
  }, []);

  // ---- Infinite scroll ----
  /**
   * SectionList onEndReached callback. Triggers the next page load
   * when the user scrolls close to the bottom.
   *
   * KNOWN LIMITATION: loadMore fetches the next page of unfiltered sessions
   * from Supabase (filtered only by status/agent/scope, not by tag). If a
   * tag filter is active, the newly loaded sessions may not include any
   * sessions with that tag, causing the list to appear unchanged. A "No
   * more matching sessions" message is shown via ListFooterComponent when
   * this happens. Full server-side tag filtering would require additional
   * query changes that conflict with cursor-based pagination — deferred
   * to a future sprint.
   */
  const handleEndReached = useCallback(() => {
    loadMore();
  }, [loadMore]);

  /**
   * Clear all active filters and the search query.
   */
  const handleClearFilters = useCallback(() => {
    setSearchQuery('');
    setTagFilter(null);
    setShowBookmarkedOnly(false);
    setFilters({
      status: null,
      agent: null,
      scope: null,
      teamId: null,
      dateRange: null,
    });
  }, [setSearchQuery, setFilters]);

  // ---- Render: Loading state ----
  if (isLoading) {
    return <SessionsLoadingState />;
  }

  // ---- Render: Error state ----
  if (error && sessions.length === 0) {
    return <SessionsErrorState error={error} onRetry={refresh} />;
  }

  // ---- Determine empty / no-results state ----
  const hasActiveFilters =
    filters.status !== null ||
    filters.agent !== null ||
    (filters.dateRange !== null && filters.dateRange !== 'all') ||
    tagFilter !== null ||
    showBookmarkedOnly ||
    searchQuery.trim().length > 0;

  return (
    <View className="flex-1 bg-background">
      <SessionsSearchBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isRealtimeConnected={isRealtimeConnected}
      />

      <SessionsFilterBar
        filters={filters}
        showBookmarkedOnly={showBookmarkedOnly}
        tagFilter={tagFilter}
        allTags={allTags}
        tagCounts={tagCounts}
        isTeamMember={isTeamMember}
        onStatusChange={handleStatusFilterChange}
        onAgentChange={handleAgentFilterChange}
        onScopeChange={handleScopeFilterChange}
        onDateRangeChange={handleDateRangeFilterChange}
        onBookmarkedToggle={handleBookmarkedToggle}
        onTagChange={setTagFilter}
      />

      {/* Sessions List (grouped by date) */}
      {/*
        WHY testID="session-list-root":
        The Detox cold-start test (e2e/cold-start.test.ts) waits for this element
        to become visible as the Time-to-Interactive (TTI) signal. It appears only
        after auth hydration, initial Supabase fetch, and tab navigation complete —
        the truest available proxy for "app is ready to use."
        See: packages/styrby-mobile/e2e/cold-start.test.ts
      */}
      <SectionList
        testID="session-list-root"
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            onPress={handleSessionPress}
            isBookmarked={bookmarkedIds.has(item.id)}
            isTogglingBookmark={togglingIds.has(item.id)}
            bookmarkError={toggleErrors.get(item.id)}
            onBookmarkPress={toggleBookmark}
          />
        )}
        renderSectionHeader={({ section }) => (
          <View
            className="bg-background px-4 py-2"
            accessibilityRole="header"
          >
            <Text className="text-zinc-400 text-sm font-semibold uppercase">
              {section.title} ({section.count})
            </Text>
          </View>
        )}
        stickySectionHeadersEnabled
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={refresh}
            tintColor="#f97316"
            colors={['#f97316']}
          />
        }
        ListFooterComponent={
          isLoadingMore ? (
            <View className="py-6 items-center">
              <ActivityIndicator size="small" color="#f97316" />
            </View>
          ) : tagFilter && !hasMore && filteredSessions.length > 0 ? (
            // WHY: When a tag filter is active and there are no more pages
            // to load, inform the user they have seen all matching sessions
            // so they know the list is complete, not stalled.
            <View className="py-4 items-center">
              <Text className="text-zinc-600 text-xs">
                No more sessions with tag &ldquo;{tagFilter}&rdquo;
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <SessionsEmptyState
            hasActiveFilters={hasActiveFilters}
            onClearFilters={handleClearFilters}
          />
        }
        contentContainerStyle={
          filteredSessions.length === 0 ? { flexGrow: 1 } : undefined
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
