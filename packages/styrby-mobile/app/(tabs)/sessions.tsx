/**
 * Sessions Screen
 *
 * Displays the user's past coding sessions from Supabase with search,
 * status/agent filtering, infinite-scroll pagination, and pull-to-refresh.
 * Tapping a session card navigates to the chat screen with the session ID.
 */

import {
  View,
  Text,
  SectionList,
  ScrollView,
  Pressable,
  TextInput,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { formatCost } from '../../src/hooks/useCosts';
import {
  useSessions,
  formatRelativeTime,
  getFirstLine,
  type SessionRow,
  type SessionFilters,
} from '../../src/hooks/useSessions';
import type { AgentType } from 'styrby-shared';

// ============================================================================
// Agent Config
// ============================================================================

/**
 * Visual configuration for each supported AI agent.
 * Used for icon badges, background tints, and labels.
 */
const AGENT_CONFIG: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  claude: { label: 'Claude', color: '#a855f7', icon: 'C' },
  codex: { label: 'Codex', color: '#22c55e', icon: 'X' },
  gemini: { label: 'Gemini', color: '#3b82f6', icon: 'G' },
};

/**
 * Look up agent display config, falling back to a neutral grey for
 * unknown agent types.
 *
 * @param agent - The agent_type string from the session row
 * @returns Config object with label, hex colour, and short icon letter
 */
function getAgentConfig(agent: string) {
  return AGENT_CONFIG[agent] ?? { label: agent, color: '#71717a', icon: '?' };
}

// ============================================================================
// Status Config
// ============================================================================

/**
 * Map of session status to display colour.
 * Active statuses are green, terminal errors are red, and everything
 * else (completed/expired/paused) is a neutral grey.
 */
const STATUS_COLORS: Record<string, string> = {
  starting: '#22c55e',
  running: '#22c55e',
  idle: '#22c55e',
  paused: '#eab308',
  stopped: '#71717a',
  error: '#ef4444',
  expired: '#71717a',
};

/**
 * Human-readable label for session statuses shown in the badge.
 */
const STATUS_LABELS: Record<string, string> = {
  starting: 'Starting',
  running: 'Active',
  idle: 'Idle',
  paused: 'Paused',
  stopped: 'Completed',
  error: 'Error',
  expired: 'Expired',
};

// ============================================================================
// Filter Chip Definitions
// ============================================================================

/** Status filter options displayed as chips. */
const STATUS_CHIPS: Array<{ label: string; value: SessionFilters['status'] }> = [
  { label: 'All', value: null },
  { label: 'Active', value: 'active' },
  { label: 'Completed', value: 'completed' },
];

/** Agent filter options displayed as chips. */
const AGENT_CHIPS: Array<{ label: string; value: AgentType | null }> = [
  { label: 'All', value: null },
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
  { label: 'Gemini', value: 'gemini' },
];

/** Scope filter options for personal vs team sessions. */
const SCOPE_CHIPS: Array<{ label: string; value: 'mine' | 'team' | null }> = [
  { label: 'My Sessions', value: 'mine' },
  { label: 'Team Sessions', value: 'team' },
];

// ============================================================================
// Date Grouping Helpers
// ============================================================================

/**
 * Short day-of-week names for section headers.
 *
 * WHY: Hoisted to module level so this array is allocated once at import time.
 */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Short month names for section headers.
 */
const MONTH_ABBREVS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Format a date into a human-friendly section header label.
 *
 * Returns "Today", "Yesterday", or a short date like "Mon Mar 25" for
 * older dates. This matches the web app's date grouping behavior.
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
    (today.getTime() - target.getTime()) / 86_400_000,
  );

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  return `${DAY_NAMES[date.getDay()]} ${MONTH_ABBREVS[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Derive a date-only key string (YYYY-MM-DD) from an ISO timestamp.
 *
 * WHY: We group sessions by the date portion of `started_at`. Using a
 * consistent key format ensures sessions that started on the same calendar
 * day (in the user's local timezone) are grouped together.
 *
 * @param isoTimestamp - An ISO 8601 timestamp string
 * @returns A date key string in YYYY-MM-DD format (local timezone)
 */
function getDateKey(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Section shape for the SectionList. Each section contains a date label,
 * session count, and the sessions that started on that date.
 */
interface SessionSection {
  /** Human-friendly date label (e.g. "Today", "Yesterday", "Mon Mar 25") */
  title: string;
  /** Number of sessions in this section */
  count: number;
  /** Sessions in this section */
  data: SessionRow[];
}

/**
 * Group an array of sessions by their `started_at` date into sections
 * suitable for React Native's SectionList.
 *
 * Preserves the input order within each group (sessions are already sorted
 * by `updated_at DESC` from the hook).
 *
 * @param sessions - Array of session rows to group
 * @returns Array of sections, each with a title, count, and data
 *
 * @example
 * const sections = groupSessionsByDate(filteredSessions);
 * // [{ title: "Today", count: 3, data: [...] }, { title: "Yesterday", count: 1, data: [...] }]
 */
function groupSessionsByDate(sessions: SessionRow[]): SessionSection[] {
  const groupMap = new Map<string, SessionRow[]>();

  for (const session of sessions) {
    const key = getDateKey(session.started_at);
    const existing = groupMap.get(key);
    if (existing) {
      existing.push(session);
    } else {
      groupMap.set(key, [session]);
    }
  }

  const sections: SessionSection[] = [];

  for (const [key, data] of groupMap) {
    // WHY: `new Date("YYYY-MM-DD")` parses as UTC midnight, not local midnight.
    // In negative UTC offsets (e.g., UTC-5) this causes "Mon Mar 25" to render
    // as "Sun Mar 24" because UTC midnight is still the previous day locally.
    // Splitting the key and constructing via (year, month-1, day) uses the
    // local timezone, matching how getDateKey() derived the key in the first place.
    const [year, month, day] = key.split('-').map(Number);
    sections.push({
      title: formatSectionDate(new Date(year, month - 1, day)),
      count: data.length,
      data,
    });
  }

  return sections;
}

// ============================================================================
// Session Card Component
// ============================================================================

/**
 * Props for the SessionCard component.
 */
interface SessionCardProps {
  /** The session data to render */
  session: SessionRow;
  /** Callback fired when the card is tapped */
  onPress: (session: SessionRow) => void;
}

/**
 * A single session list item.
 *
 * Displays the agent icon, session title, status badge, cost, relative
 * timestamp, and the first line of the AI-generated summary. Tapping
 * the card triggers navigation to the chat screen.
 *
 * @param session - Session row from Supabase
 * @param onPress - Navigation handler
 */
function SessionCard({ session, onPress }: SessionCardProps) {
  const agentConfig = getAgentConfig(session.agent_type);
  const statusColor = STATUS_COLORS[session.status] ?? '#71717a';
  const statusLabel = STATUS_LABELS[session.status] ?? session.status;
  const summaryPreview = getFirstLine(session.summary);

  return (
    <Pressable
      onPress={() => onPress(session)}
      className="px-4 py-3 border-b border-zinc-800/50 active:bg-zinc-900"
      accessibilityRole="button"
      accessibilityLabel={`Session: ${session.title || 'Untitled'}. ${statusLabel}. Cost ${formatCost(Number(session.total_cost_usd))}.`}
    >
      <View className="flex-row items-start">
        {/* Agent Icon Badge */}
        <View
          className="w-10 h-10 rounded-full items-center justify-center mr-3"
          style={{ backgroundColor: `${agentConfig.color}20` }}
        >
          <Text
            className="text-base font-bold"
            style={{ color: agentConfig.color }}
          >
            {agentConfig.icon}
          </Text>
        </View>

        {/* Session Info */}
        <View className="flex-1">
          {/* Title + Timestamp Row */}
          <View className="flex-row items-center justify-between mb-1">
            <Text
              className="text-white font-semibold flex-1 mr-2"
              numberOfLines={1}
            >
              {session.title || 'Untitled Session'}
            </Text>
            <Text className="text-zinc-500 text-xs">
              {formatRelativeTime(session.updated_at)}
            </Text>
          </View>

          {/* Summary Preview */}
          {summaryPreview && (
            <Text className="text-zinc-400 text-sm mb-1" numberOfLines={1}>
              {summaryPreview}
            </Text>
          )}

          {/* Badges Row: agent, status, cost, messages */}
          <View className="flex-row items-center flex-wrap mt-1">
            {/* Agent Badge */}
            <View
              className="px-2 py-0.5 rounded mr-2"
              style={{ backgroundColor: `${agentConfig.color}20` }}
            >
              <Text
                className="text-xs font-medium"
                style={{ color: agentConfig.color }}
              >
                {agentConfig.label}
              </Text>
            </View>

            {/* Status Badge */}
            <View
              className="px-2 py-0.5 rounded mr-2"
              style={{ backgroundColor: `${statusColor}20` }}
            >
              <Text
                className="text-xs font-medium"
                style={{ color: statusColor }}
              >
                {statusLabel}
              </Text>
            </View>

            {/* Cost */}
            <Text className="text-zinc-500 text-xs mr-2">
              {formatCost(Number(session.total_cost_usd))}
            </Text>

            {/* Message Count */}
            <Text className="text-zinc-500 text-xs">
              {session.message_count} msg{session.message_count !== 1 ? 's' : ''}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// ============================================================================
// Main Screen
// ============================================================================

/**
 * Sessions list screen.
 *
 * Fetches the authenticated user's sessions from Supabase and renders
 * them in a FlatList with:
 * - A functional search bar (debounced, searches title and summary)
 * - Filter chips for status (All / Active / Completed) and agent
 * - Infinite scroll pagination (20 per page)
 * - Pull-to-refresh
 * - Tap-to-navigate to the chat screen with the session ID
 * - Loading, error, empty, and "no results" states
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
   * If the user changes a scope filter (e.g., switches from "My Sessions" to
   * "Team Sessions"), the new session set may not contain the currently selected
   * tag at all, leaving the list empty with no clear explanation. Resetting to
   * "All Tags" on any filter change prevents this confusing empty state.
   */
  useEffect(() => {
    setTagFilter(null);
  }, [filters]);

  /**
   * Extract unique tags from all loaded sessions, sorted alphabetically.
   *
   * WHY: Tags are user-defined and stored as arrays on each session. We
   * flatten and deduplicate them to build the filter chip bar. Using useMemo
   * avoids recomputing on every render when sessions haven't changed.
   */
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const session of sessions) {
      if (session.tags) {
        for (const tag of session.tags) {
          tagSet.add(tag);
        }
      }
    }
    return [...tagSet].sort();
  }, [sessions]);

  /**
   * Tag counts for each unique tag, used to display counts on filter chips.
   *
   * @example
   * // If 3 sessions have "frontend" tag and 2 have "backend":
   * // tagCounts = { frontend: 3, backend: 2 }
   */
  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const session of sessions) {
      if (session.tags) {
        for (const tag of session.tags) {
          counts[tag] = (counts[tag] || 0) + 1;
        }
      }
    }
    return counts;
  }, [sessions]);

  /**
   * Sessions filtered by the selected tag (client-side).
   *
   * WHY: Tag filtering is done client-side because all sessions are already
   * loaded via the paginated fetch. Server-side tag filtering would require
   * an additional Supabase query parameter and wouldn't work well with
   * infinite scroll since we'd need to re-fetch from offset 0.
   */
  const filteredSessions = useMemo(() => {
    if (!tagFilter) return sessions;
    return sessions.filter(
      (s) => s.tags && s.tags.includes(tagFilter),
    );
  }, [sessions, tagFilter]);

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
    const isActive = ['starting', 'running', 'idle', 'paused'].includes(session.status);

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
   * @param scope - The new scope filter value
   */
  const handleScopeFilterChange = useCallback(
    (scope: 'mine' | 'team' | null) => {
      // For team scope, we would need to fetch the user's team ID
      // For now, this just toggles the scope filter
      setFilters({ ...filters, scope, teamId: null });
    },
    [filters, setFilters],
  );

  // ---- Infinite scroll ----

  /**
   * SectionList onEndReached callback. Triggers the next page load
   * when the user scrolls close to the bottom.
   *
   * KNOWN LIMITATION: loadMore fetches the next page of unfiltered sessions
   * from Supabase (filtered only by status/agent/scope, not by tag). If a tag
   * filter is active, the newly loaded sessions may not include any sessions
   * with that tag, causing the list to appear unchanged. A "No more matching
   * sessions" message is shown via ListFooterComponent when this happens.
   * Full server-side tag filtering would require additional query changes that
   * conflict with cursor-based pagination — deferred to a future sprint.
   */
  const handleEndReached = useCallback(() => {
    loadMore();
  }, [loadMore]);

  // ---- Render: Loading state ----

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading sessions...</Text>
      </View>
    );
  }

  // ---- Render: Error state ----

  if (error && sessions.length === 0) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="text-white text-lg font-semibold mt-4">
          Failed to Load Sessions
        </Text>
        <Text className="text-zinc-500 text-center mt-2">{error}</Text>
        <Pressable
          onPress={refresh}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Retry loading sessions"
        >
          <Text className="text-white font-semibold">Try Again</Text>
        </Pressable>
      </View>
    );
  }

  // ---- Determine empty / no-results state ----

  const hasActiveFilters =
    filters.status !== null ||
    filters.agent !== null ||
    tagFilter !== null ||
    searchQuery.trim().length > 0;

  return (
    <View className="flex-1 bg-background">
      {/* Search Bar with Real-time Indicator */}
      <View className="px-4 py-3">
        <View className="flex-row items-center bg-background-secondary rounded-xl px-4 py-3">
          <Ionicons name="search" size={20} color="#71717a" />
          <TextInput
            className="flex-1 text-white text-base ml-2"
            placeholder="Search sessions..."
            placeholderTextColor="#71717a"
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityRole="search"
            accessibilityLabel="Search sessions by title or summary"
          />
          {/* Clear button - only visible when there is text */}
          {searchQuery.length > 0 && (
            <Pressable
              onPress={() => setSearchQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <Ionicons name="close-circle" size={20} color="#71717a" />
            </Pressable>
          )}
          {/* Real-time connection indicator */}
          {/* WHY: Users need to know whether the list updates automatically or
              requires manual pull-to-refresh. A green dot means live updates;
              orange means the Realtime channel is disconnected. */}
          <View
            className="w-2.5 h-2.5 rounded-full ml-2"
            style={{
              backgroundColor: isRealtimeConnected ? '#22c55e' : '#f97316',
            }}
            accessibilityLabel={
              isRealtimeConnected
                ? 'Real-time updates active'
                : 'Manual refresh mode — pull down to refresh'
            }
            accessibilityRole="text"
          />
        </View>
      </View>

      {/* Filter Chips */}
      <View className="px-4 pb-2">
        {/* Scope Filters (My Sessions / Team Sessions) */}
        <View className="flex-row mb-2">
          {SCOPE_CHIPS.map((chip) => {
            const isSelected = filters.scope === chip.value ||
              (chip.value === 'mine' && !filters.scope);
            return (
              <Pressable
                key={chip.label}
                onPress={() => handleScopeFilterChange(chip.value)}
                className={`px-3 py-1.5 rounded-full mr-2 ${
                  isSelected
                    ? 'bg-brand'
                    : 'bg-zinc-800'
                }`}
                accessibilityRole="button"
                accessibilityLabel={`Filter by ${chip.label}`}
                accessibilityState={{ selected: isSelected }}
              >
                <Text
                  className={`text-sm font-medium ${
                    isSelected ? 'text-white' : 'text-zinc-400'
                  }`}
                >
                  {chip.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Status Filters */}
        <View className="flex-row mb-2">
          {STATUS_CHIPS.map((chip) => {
            const isSelected = filters.status === chip.value;
            return (
              <Pressable
                key={chip.label}
                onPress={() => handleStatusFilterChange(chip.value)}
                className={`px-3 py-1.5 rounded-full mr-2 ${
                  isSelected
                    ? 'bg-brand'
                    : 'bg-zinc-800'
                }`}
                accessibilityRole="button"
                accessibilityLabel={`Filter by ${chip.label} status`}
                accessibilityState={{ selected: isSelected }}
              >
                <Text
                  className={`text-sm font-medium ${
                    isSelected ? 'text-white' : 'text-zinc-400'
                  }`}
                >
                  {chip.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Agent Filters */}
        <View className="flex-row">
          {AGENT_CHIPS.map((chip) => {
            const isSelected = filters.agent === chip.value;
            const agentConfig = chip.value
              ? getAgentConfig(chip.value)
              : null;

            return (
              <Pressable
                key={chip.label}
                onPress={() => handleAgentFilterChange(chip.value)}
                className={`flex-row items-center px-3 py-1.5 rounded-full mr-2 ${
                  isSelected
                    ? ''
                    : 'bg-zinc-800'
                }`}
                style={
                  isSelected && agentConfig
                    ? { backgroundColor: `${agentConfig.color}20` }
                    : isSelected && !agentConfig
                      ? { backgroundColor: '#f9731620' }
                      : undefined
                }
                accessibilityRole="button"
                accessibilityLabel={`Filter by ${chip.label} agent`}
                accessibilityState={{ selected: isSelected }}
              >
                {/* Show a coloured dot for agent chips */}
                {agentConfig && (
                  <View
                    className="w-2 h-2 rounded-full mr-1.5"
                    style={{ backgroundColor: agentConfig.color }}
                  />
                )}
                <Text
                  className="text-sm font-medium"
                  style={{
                    color: isSelected
                      ? agentConfig?.color ?? '#f97316'
                      : '#a1a1aa',
                  }}
                >
                  {chip.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Tag Filter Bar */}
        {/* WHY: Tags are user-defined labels on sessions. Showing them as a
            horizontally scrollable chip bar lets users quickly narrow the list
            to a specific project or topic without typing a search query. */}
        {allTags.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="mt-2"
            contentContainerStyle={{ paddingRight: 16 }}
          >
            {/* "All Tags" chip to clear the tag filter */}
            <Pressable
              onPress={() => setTagFilter(null)}
              className="px-3 py-1.5 rounded-full mr-2"
              style={{
                backgroundColor: tagFilter === null ? undefined : '#27272a',
                borderWidth: tagFilter === null ? 1 : 0,
                borderColor: '#f97316',
              }}
              accessibilityRole="button"
              accessibilityLabel="Show all tags"
              accessibilityState={{ selected: tagFilter === null }}
            >
              <Text
                className="text-sm font-medium"
                style={{
                  color: tagFilter === null ? '#f97316' : '#a1a1aa',
                }}
              >
                All Tags
              </Text>
            </Pressable>

            {allTags.map((tag) => {
              const isSelected = tagFilter === tag;
              const count = tagCounts[tag] || 0;

              return (
                <Pressable
                  key={tag}
                  onPress={() => setTagFilter(isSelected ? null : tag)}
                  className="px-3 py-1.5 rounded-full mr-2"
                  style={{
                    backgroundColor: isSelected ? undefined : '#27272a',
                    borderWidth: isSelected ? 1 : 0,
                    borderColor: '#f97316',
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter by tag: ${tag} (${count} sessions)`}
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text
                    className="text-sm font-medium"
                    style={{
                      color: isSelected ? '#f97316' : '#a1a1aa',
                    }}
                  >
                    {tag} ({count})
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* Sessions List (grouped by date) */}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <SessionCard session={item} onPress={handleSessionPress} />
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
            // WHY: When a tag filter is active and there are no more pages to
            // load, inform the user they have seen all matching sessions so they
            // know the list is complete, not stalled.
            <View className="py-4 items-center">
              <Text className="text-zinc-600 text-xs">
                No more sessions with tag &ldquo;{tagFilter}&rdquo;
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center py-20 px-6">
            <Ionicons
              name={hasActiveFilters ? 'search-outline' : 'chatbubbles-outline'}
              size={48}
              color="#3f3f46"
            />
            <Text className="text-zinc-400 font-semibold text-lg mt-4">
              {hasActiveFilters ? 'No results' : 'No sessions yet'}
            </Text>
            <Text className="text-zinc-500 text-center mt-2">
              {hasActiveFilters
                ? 'Try adjusting your search or filters.'
                : 'Your coding sessions will appear here once you start using Styrby.'}
            </Text>
            {hasActiveFilters && (
              <Pressable
                onPress={() => {
                  setSearchQuery('');
                  setTagFilter(null);
                  setFilters({ status: null, agent: null, scope: null, teamId: null });
                }}
                className="bg-zinc-800 px-5 py-2.5 rounded-xl mt-4 active:opacity-80"
                accessibilityRole="button"
                accessibilityLabel="Clear all filters and search"
              >
                <Text className="text-zinc-300 font-medium">Clear Filters</Text>
              </Pressable>
            )}
          </View>
        }
        contentContainerStyle={
          filteredSessions.length === 0 ? { flexGrow: 1 } : undefined
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
