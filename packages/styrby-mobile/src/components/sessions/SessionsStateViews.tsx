/**
 * SessionsStateViews — loading, error, and empty/no-results state UIs.
 *
 * WHY: Grouping the three full-screen state views into one file keeps
 * trivially small siblings together (each is ~10-30 LOC) without
 * fragmenting them across many files.
 */

import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Full-screen "Loading sessions..." spinner.
 */
export function SessionsLoadingState() {
  return (
    <View className="flex-1 bg-background items-center justify-center">
      <ActivityIndicator size="large" color="#f97316" />
      <Text className="text-zinc-500 mt-4">Loading sessions...</Text>
    </View>
  );
}

/**
 * Props for SessionsErrorState.
 */
export interface SessionsErrorStateProps {
  /** Error message to display (typically from useSessions). */
  error: string;
  /** Retry handler — re-fetches the first page. */
  onRetry: () => void;
}

/**
 * Full-screen error view with a retry button. Shown only when the
 * sessions query fails AND there are zero rows already in memory.
 *
 * @param props - SessionsErrorStateProps
 */
export function SessionsErrorState({ error, onRetry }: SessionsErrorStateProps) {
  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
      <Text className="text-white text-lg font-semibold mt-4">
        Failed to Load Sessions
      </Text>
      <Text className="text-zinc-500 text-center mt-2">{error}</Text>
      <Pressable
        onPress={onRetry}
        className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Retry loading sessions"
      >
        <Text className="text-white font-semibold">Try Again</Text>
      </Pressable>
    </View>
  );
}

/**
 * Props for SessionsEmptyState.
 */
export interface SessionsEmptyStateProps {
  /** Whether any filter or search query is currently active. */
  hasActiveFilters: boolean;
  /** Handler invoked when the user taps "Clear Filters". */
  onClearFilters: () => void;
}

/**
 * Empty state shown inside the SectionList when there are zero rows
 * to render. Adapts copy + icon depending on whether filters are
 * active (no-results) vs. truly empty (first-run user).
 *
 * @param props - SessionsEmptyStateProps
 */
export function SessionsEmptyState({
  hasActiveFilters,
  onClearFilters,
}: SessionsEmptyStateProps) {
  return (
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
          onPress={onClearFilters}
          className="bg-zinc-800 px-5 py-2.5 rounded-xl mt-4 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Clear all filters and search"
        >
          <Text className="text-zinc-300 font-medium">Clear Filters</Text>
        </Pressable>
      )}
    </View>
  );
}
