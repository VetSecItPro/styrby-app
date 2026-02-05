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
  FlatList,
  Pressable,
  TextInput,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useCallback } from 'react';
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
    setSearchQuery,
    setFilters,
    refresh,
    loadMore,
  } = useSessions();

  // ---- Navigation ----

  /**
   * Navigate to the chat screen with the selected session's ID and
   * agent type pre-filled.
   *
   * @param session - The session row that was tapped
   */
  const handleSessionPress = useCallback((session: SessionRow) => {
    router.push({
      pathname: '/(tabs)/chat',
      params: {
        sessionId: session.id,
        agent: session.agent_type,
      },
    });
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

  // ---- Infinite scroll ----

  /**
   * FlatList onEndReached callback. Triggers the next page load
   * when the user scrolls close to the bottom.
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
    searchQuery.trim().length > 0;

  return (
    <View className="flex-1 bg-background">
      {/* Search Bar */}
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
        </View>
      </View>

      {/* Filter Chips */}
      <View className="px-4 pb-2">
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
      </View>

      {/* Sessions List */}
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <SessionCard session={item} onPress={handleSessionPress} />
        )}
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
                  setFilters({ status: null, agent: null });
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
          sessions.length === 0 ? { flexGrow: 1 } : undefined
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
