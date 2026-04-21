/**
 * SessionCard — single row in the sessions list.
 *
 * Displays the agent icon, title, status badge, cost, relative timestamp,
 * the first line of the AI-generated summary, and a bookmark star icon.
 * Tapping the card triggers navigation; tapping the star toggles the
 * bookmark state without navigating.
 *
 * WHY: Extracted from sessions.tsx so the orchestrator stays under 400
 * LOC and so this presentational unit can be unit-tested independently.
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatCost } from '../../hooks/useCosts';
import { formatRelativeTime, getFirstLine } from '../../hooks/useSessions';
import type { SessionCardProps } from '../../types/sessions';
import {
  getAgentConfig,
  STATUS_COLORS,
  STATUS_LABELS,
} from './constants';

/**
 * A single session list item — see module doc.
 *
 * @param props - SessionCardProps
 */
export function SessionCard({
  session,
  onPress,
  isBookmarked,
  isTogglingBookmark,
  bookmarkError,
  onBookmarkPress,
}: SessionCardProps) {
  const agentConfig = getAgentConfig(session.agent_type);
  const statusColor = STATUS_COLORS[session.status] ?? '#71717a';
  const statusLabel = STATUS_LABELS[session.status] ?? session.status;
  const summaryPreview = getFirstLine(session.summary);

  return (
    <Pressable
      onPress={() => onPress(session)}
      className="px-4 py-3 border-b border-zinc-800/50 active:bg-zinc-900"
      accessibilityRole="button"
      accessibilityLabel={`Session: ${session.title || 'Untitled'}. ${statusLabel}. Cost ${formatCost(Number(session.total_cost_usd))}.${isBookmarked ? ' Bookmarked.' : ''}`}
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
          {/* Title + Timestamp + Bookmark Row */}
          <View className="flex-row items-center justify-between mb-1">
            <Text
              className="text-white font-semibold flex-1 mr-2"
              numberOfLines={1}
            >
              {session.title || 'Untitled Session'}
            </Text>

            <View className="flex-row items-center gap-1">
              <Text className="text-zinc-500 text-xs">
                {formatRelativeTime(session.updated_at)}
              </Text>

              {/* Bookmark star button
                  WHY: Wrapped in its own Pressable so tapping the star doesn't
                  propagate to the card's onPress and navigate away. */}
              <Pressable
                onPress={() => onBookmarkPress(session.id)}
                disabled={isTogglingBookmark}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={
                  isBookmarked ? 'Remove bookmark' : 'Bookmark session'
                }
                accessibilityState={{ checked: isBookmarked }}
                style={{ opacity: isTogglingBookmark ? 0.4 : 1 }}
              >
                <Ionicons
                  name={isBookmarked ? 'star' : 'star-outline'}
                  size={16}
                  color={isBookmarked ? '#f97316' : '#52525b'}
                />
              </Pressable>
            </View>
          </View>

          {/* Bookmark error hint (auto-clears after 4 s via hook) */}
          {bookmarkError && (
            <Text className="text-red-400 text-xs mb-1" numberOfLines={1}>
              {bookmarkError}
            </Text>
          )}

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
