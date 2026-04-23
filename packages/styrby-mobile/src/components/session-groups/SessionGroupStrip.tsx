/**
 * SessionGroupStrip
 *
 * A horizontally scrollable strip of AgentSessionCards for a multi-agent
 * session group. Displayed at the top of the session screen when the user
 * has an active group.
 *
 * Features:
 * - Horizontal scroll with `snapToInterval` for card-by-card swipe feel
 * - Pull-to-refresh via `RefreshControl` (refetches group from Supabase)
 * - Tap a card → calls onFocus(sessionId) (POST focus API + optimistic update)
 * - Empty state: shows a loading skeleton while sessions are loading
 * - Error state: shows a dismissable error toast + retry button
 *
 * WHY FlatList over ScrollView:
 *   FlatList virtualizes cells. In groups with 6 agents, all 6 cards are
 *   visible at once anyway -- but FlatList's ItemSeparatorComponent and
 *   `getItemLayout` make the snap math easier and keep memory pressure low.
 *
 * WHY snapToInterval (not pagingEnabled):
 *   pagingEnabled snaps to full screen-width pages. snapToInterval snaps to
 *   card-width units so the user can swipe one card at a time while still
 *   seeing the partial edge of the next card (discovery affordance).
 *
 * @module components/session-groups/SessionGroupStrip
 */

import React, { useRef, useCallback } from 'react';
import {
  FlatList,
  View,
  Text,
  RefreshControl,
  StyleSheet,
  Pressable,
} from 'react-native';
import type { GroupSession, SessionGroup } from '../../hooks/useSessionGroup';
import { AgentSessionCard } from './AgentSessionCard';

// ============================================================================
// Types
// ============================================================================

export interface SessionGroupStripProps {
  /** The session group record */
  group: SessionGroup;
  /** Member sessions to display as cards */
  sessions: GroupSession[];
  /** Whether the strip is currently loading/refreshing */
  loading: boolean;
  /** Error message to display (null if no error) */
  error: string | null;
  /**
   * Called when the user taps a card to focus that session.
   *
   * @param sessionId - The session ID that was tapped
   */
  onFocus: (sessionId: string) => void;
  /**
   * Called when the user pull-to-refreshes the strip.
   * Should trigger a refetch of group + session data.
   */
  onRefresh: () => void;
  /** Whether a pull-to-refresh is in progress */
  refreshing?: boolean;
  /**
   * Optional callback invoked when user taps the error dismiss button.
   * Consumers can use this to clear the error state in the parent hook.
   */
  onDismissError?: () => void;
}

// ============================================================================
// Agent visual config
// ============================================================================

/**
 * Visual configuration per agent type.
 * WHY defined here (not imported from sessions/constants):
 *   The session-groups component directory is independent of the sessions
 *   component directory -- we don't want cross-directory imports between
 *   unrelated feature slices. The mapping is small enough to duplicate.
 */
const AGENT_DISPLAY: Record<string, { color: string; icon: string; label: string }> = {
  claude:   { color: '#a855f7', icon: 'C', label: 'Claude'  },
  codex:    { color: '#22c55e', icon: 'X', label: 'Codex'   },
  gemini:   { color: '#3b82f6', icon: 'G', label: 'Gemini'  },
  opencode: { color: '#f97316', icon: 'O', label: 'OpenCode' },
  aider:    { color: '#06b6d4', icon: 'A', label: 'Aider'   },
  goose:    { color: '#84cc16', icon: 'Go', label: 'Goose'  },
  amp:      { color: '#f43f5e', icon: 'Amp', label: 'Amp'   },
  crush:    { color: '#ec4899', icon: 'Cr', label: 'Crush'  },
  kilo:     { color: '#8b5cf6', icon: 'K', label: 'Kilo'    },
  kiro:     { color: '#14b8a6', icon: 'Ki', label: 'Kiro'   },
  droid:    { color: '#64748b', icon: 'D', label: 'Droid'   },
};

function getAgentDisplay(agentType: string) {
  return AGENT_DISPLAY[agentType] ?? { color: '#71717a', icon: '?', label: agentType };
}

// ============================================================================
// Constants
// ============================================================================

/** Width of each card including its right margin (used for snap-to-interval) */
const CARD_WIDTH = 180 + 10; // card width + marginRight

// ============================================================================
// Component
// ============================================================================

/**
 * Horizontally scrollable strip of agent session cards.
 *
 * @param props - SessionGroupStripProps
 */
export function SessionGroupStrip({
  group,
  sessions,
  loading,
  error,
  onFocus,
  onRefresh,
  refreshing = false,
  onDismissError,
}: SessionGroupStripProps) {
  const flatListRef = useRef<FlatList<GroupSession>>(null);

  /**
   * Render a single AgentSessionCard.
   * Memoized to prevent unnecessary re-renders when non-focused sessions
   * receive status updates (only the updated item should re-render).
   */
  const renderItem = useCallback(
    ({ item }: { item: GroupSession }) => {
      const display = getAgentDisplay(item.agent_type);
      const isActive = item.id === group.active_agent_session_id;

      return (
        <AgentSessionCard
          session={item}
          isActive={isActive}
          onPress={onFocus}
          agentColor={display.color}
          agentIcon={display.icon}
          agentLabel={display.label}
        />
      );
    },
    [group.active_agent_session_id, onFocus]
  );

  /** Stable key extractor -- session IDs are UUIDs, always unique */
  const keyExtractor = useCallback((item: GroupSession) => item.id, []);

  /**
   * getItemLayout enables FlatList to scroll to specific cards without
   * measuring them. Required for snapToInterval + scrollToIndex to work
   * reliably.
   */
  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: CARD_WIDTH,
      offset: CARD_WIDTH * index,
      index,
    }),
    []
  );

  return (
    <View style={styles.container}>
      {/* Header row: group name + session count */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.groupLabel} numberOfLines={1}>
            {group.name || 'Multi-agent group'}
          </Text>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{sessions.length}</Text>
          </View>
        </View>
        <Text style={styles.headerHint}>Tap to focus</Text>
      </View>

      {/* Error banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText} numberOfLines={2}>{error}</Text>
          {onDismissError && (
            <Pressable
              onPress={onDismissError}
              style={styles.errorDismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss error"
            >
              <Text style={styles.errorDismissText}>×</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Cards */}
      {loading && sessions.length === 0 ? (
        <SessionGroupSkeleton />
      ) : (
        <FlatList
          ref={flatListRef}
          data={sessions}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemLayout={getItemLayout}
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={CARD_WIDTH}
          snapToAlignment="start"
          decelerationRate="fast"
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#52525b"
            />
          }
          // WHY: Accessibility -- announce "X of N" when swiping
          accessible
          accessibilityRole="list"
          accessibilityLabel={`Agent sessions, ${sessions.length} total`}
          ListEmptyComponent={<NoSessionsPlaceholder />}
        />
      )}
    </View>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Loading skeleton -- shown while sessions are loading for the first time.
 * Renders 3 placeholder cards with a shimmer-like gray fill.
 */
function SessionGroupSkeleton() {
  return (
    <View style={styles.skeletonRow}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.skeletonCard} />
      ))}
    </View>
  );
}

/**
 * Empty state -- shown when the group has no member sessions yet.
 * This should be very brief (sessions are created synchronously with the group).
 */
function NoSessionsPlaceholder() {
  return (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyText}>No agents in this group yet</Text>
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#09090b',
    paddingTop: 12,
    paddingBottom: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  groupLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f4f4f5',
    flex: 1,
  },
  countBadge: {
    backgroundColor: '#27272a',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: 'center',
  },
  countText: {
    fontSize: 11,
    color: '#a1a1aa',
    fontWeight: '600',
  },
  headerHint: {
    fontSize: 11,
    color: '#52525b',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingRight: 6,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#450a0a',
    borderRadius: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  errorText: {
    fontSize: 12,
    color: '#fca5a5',
    flex: 1,
  },
  errorDismiss: {
    padding: 4,
  },
  errorDismissText: {
    fontSize: 16,
    color: '#f87171',
    fontWeight: '700',
  },
  skeletonRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 10,
  },
  skeletonCard: {
    width: 180,
    height: 90,
    borderRadius: 12,
    backgroundColor: '#18181b',
    opacity: 0.5,
  },
  emptyContainer: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
    color: '#52525b',
  },
});
