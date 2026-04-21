/**
 * SessionsSearchBar — search input + real-time connection indicator.
 *
 * WHY: Pulled out of the orchestrator to keep responsibilities focused.
 * Owns no state — fully controlled by the parent screen.
 */

import { View, TextInput, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Props for SessionsSearchBar.
 */
export interface SessionsSearchBarProps {
  /** Current search query (controlled). */
  searchQuery: string;
  /** Setter for the search query. */
  onSearchChange: (next: string) => void;
  /** Whether the Supabase Realtime subscription is currently connected. */
  isRealtimeConnected: boolean;
}

/**
 * Search input with clear button and real-time connection indicator dot.
 *
 * @param props - SessionsSearchBarProps
 */
export function SessionsSearchBar({
  searchQuery,
  onSearchChange,
  isRealtimeConnected,
}: SessionsSearchBarProps) {
  return (
    <View className="px-4 py-3">
      <View className="flex-row items-center bg-background-secondary rounded-xl px-4 py-3">
        <Ionicons name="search" size={20} color="#71717a" />
        <TextInput
          className="flex-1 text-white text-base ml-2"
          placeholder="Search sessions..."
          placeholderTextColor="#71717a"
          value={searchQuery}
          onChangeText={onSearchChange}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityRole="search"
          accessibilityLabel="Search sessions by title or summary"
        />
        {/* Clear button - only visible when there is text */}
        {searchQuery.length > 0 && (
          <Pressable
            onPress={() => onSearchChange('')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Ionicons name="close-circle" size={20} color="#71717a" />
          </Pressable>
        )}
        {/* Real-time connection indicator
            WHY: Users need to know whether the list updates automatically or
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
  );
}
