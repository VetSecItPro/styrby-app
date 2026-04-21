/**
 * SessionsFilterBar — chip rows for scope, bookmark, status, agent,
 * date range, and tags.
 *
 * WHY: Consolidated all filter chips into a single presentational
 * component so the orchestrator file only wires state + handlers.
 * The bar owns no state — every value is controlled by the parent.
 */

import { View, Text, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';
import type {
  SessionFilters,
  DateRangeFilter,
} from '../../hooks/useSessions';
import {
  AGENT_CHIPS,
  DATE_RANGE_CHIPS,
  SCOPE_CHIPS,
  STATUS_CHIPS,
  getAgentConfig,
} from './constants';

/**
 * Props for SessionsFilterBar.
 */
export interface SessionsFilterBarProps {
  /** Current filter state from useSessions(). */
  filters: SessionFilters;
  /** Whether to show only bookmarked sessions. */
  showBookmarkedOnly: boolean;
  /** Currently active tag filter (null = all tags). */
  tagFilter: string | null;
  /** All unique tags across the loaded sessions, alphabetically sorted. */
  allTags: string[];
  /** Map of tag → count of sessions with that tag. */
  tagCounts: Record<string, number>;
  /** Whether the user is a member of any team (gates Team Sessions chip). */
  isTeamMember: boolean;
  /** Update the status filter while preserving the rest. */
  onStatusChange: (status: SessionFilters['status']) => void;
  /** Update the agent filter while preserving the rest. */
  onAgentChange: (agent: AgentType | null) => void;
  /** Update the scope filter (mine vs team). */
  onScopeChange: (scope: 'mine' | 'team' | null) => void;
  /** Update the date range filter. */
  onDateRangeChange: (dateRange: DateRangeFilter) => void;
  /** Toggle the bookmark-only filter. */
  onBookmarkedToggle: () => void;
  /** Update the tag filter (null = all). */
  onTagChange: (tag: string | null) => void;
}

/**
 * Renders the full stack of filter chip rows shown above the sessions list.
 *
 * @param props - SessionsFilterBarProps
 */
export function SessionsFilterBar({
  filters,
  showBookmarkedOnly,
  tagFilter,
  allTags,
  tagCounts,
  isTeamMember,
  onStatusChange,
  onAgentChange,
  onScopeChange,
  onDateRangeChange,
  onBookmarkedToggle,
  onTagChange,
}: SessionsFilterBarProps) {
  return (
    <View className="px-4 pb-2">
      {/* Scope Filters (My Sessions / Team Sessions) + Bookmarked toggle */}
      {/* WHY: Team Sessions toggle is only shown when the user is a team member.
          Non-team users have no team sessions to filter by, so showing the
          toggle would only create confusion. */}
      <View className="flex-row mb-2 flex-wrap">
        {SCOPE_CHIPS.filter(
          // Hide "Team Sessions" chip for non-team members (P10 gate)
          (chip) => chip.value !== 'team' || isTeamMember,
        ).map((chip) => {
          const isSelected =
            filters.scope === chip.value ||
            (chip.value === 'mine' && !filters.scope);
          return (
            <Pressable
              key={chip.label}
              onPress={() => onScopeChange(chip.value)}
              className={`px-3 py-1.5 rounded-full mr-2 mb-1 ${
                isSelected ? 'bg-brand' : 'bg-zinc-800'
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

        {/* Bookmarked filter chip
            WHY: Placed alongside scope chips so all "session source" filters
            are grouped together at the top. A star icon provides instant
            visual affordance for what the filter does. */}
        <Pressable
          onPress={onBookmarkedToggle}
          className="flex-row items-center px-3 py-1.5 rounded-full mr-2 mb-1"
          style={{
            backgroundColor: showBookmarkedOnly ? undefined : '#27272a',
            borderWidth: showBookmarkedOnly ? 1 : 0,
            borderColor: '#f97316',
          }}
          accessibilityRole="button"
          accessibilityLabel={
            showBookmarkedOnly
              ? 'Showing bookmarked sessions — tap to show all'
              : 'Show only bookmarked sessions'
          }
          accessibilityState={{ selected: showBookmarkedOnly }}
        >
          <Ionicons
            name={showBookmarkedOnly ? 'star' : 'star-outline'}
            size={14}
            color={showBookmarkedOnly ? '#f97316' : '#a1a1aa'}
            style={{ marginRight: 4 }}
          />
          <Text
            className="text-sm font-medium"
            style={{ color: showBookmarkedOnly ? '#f97316' : '#a1a1aa' }}
          >
            Bookmarked
          </Text>
        </Pressable>
      </View>

      {/* Status Filters */}
      <View className="flex-row mb-2">
        {STATUS_CHIPS.map((chip) => {
          const isSelected = filters.status === chip.value;
          return (
            <Pressable
              key={chip.label}
              onPress={() => onStatusChange(chip.value)}
              className={`px-3 py-1.5 rounded-full mr-2 ${
                isSelected ? 'bg-brand' : 'bg-zinc-800'
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
          const agentConfig = chip.value ? getAgentConfig(chip.value) : null;

          return (
            <Pressable
              key={chip.label}
              onPress={() => onAgentChange(chip.value)}
              className={`flex-row items-center px-3 py-1.5 rounded-full mr-2 ${
                isSelected ? '' : 'bg-zinc-800'
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

      {/* Date Range Filter Chips (P13)
          WHY: Date range filtering is a common "where did that session go?"
          pattern — users often remember roughly when they worked on something
          but not the exact title. Server-side filtering via .gte() on
          started_at keeps results accurate even when pagination is active. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="mt-2"
        contentContainerStyle={{ paddingRight: 16 }}
      >
        {DATE_RANGE_CHIPS.map((chip) => {
          const isSelected =
            chip.value === 'all'
              ? !filters.dateRange || filters.dateRange === 'all'
              : filters.dateRange === chip.value;
          return (
            <Pressable
              key={chip.value}
              onPress={() => onDateRangeChange(chip.value)}
              className="px-3 py-1.5 rounded-full mr-2"
              style={{
                backgroundColor: isSelected ? undefined : '#27272a',
                borderWidth: isSelected ? 1 : 0,
                borderColor: '#f97316',
              }}
              accessibilityRole="button"
              accessibilityLabel={`Filter by date: ${chip.label}`}
              accessibilityState={{ selected: isSelected }}
            >
              <Text
                className="text-sm font-medium"
                style={{ color: isSelected ? '#f97316' : '#a1a1aa' }}
              >
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Tag Filter Bar
          WHY: Tags are user-defined labels on sessions. Showing them as a
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
            onPress={() => onTagChange(null)}
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
                onPress={() => onTagChange(isSelected ? null : tag)}
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
  );
}
