/**
 * NotificationFeedList
 *
 * FlatList-based orchestrator for the in-app notification feed.
 *
 * WHY FlatList over ScrollView: Notifications are unbounded in length.
 * FlatList virtualizes off-screen rows (removeClippedSubviews) to avoid
 * the memory spike that a ScrollView would cause with 100+ notifications.
 *
 * @param notifications - Ordered list of notifications (newest first)
 * @param loading - Whether the initial fetch is in progress
 * @param loadingMore - Whether the next page is loading
 * @param hasMore - Whether additional pages exist
 * @param error - Error message if fetch failed
 * @param onPressItem - Called when a notification row is tapped
 * @param onLoadMore - Called when the user scrolls to the bottom
 * @param onRefresh - Called when the user pulls to refresh
 */

import React, { useCallback } from 'react';
import {
  FlatList,
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  ListRenderItem,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import NotificationFeedItem from './NotificationFeedItem';
import type { InAppNotification } from '@/hooks/useInAppNotifications';

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Skeleton placeholder shown during the initial load.
 * 5 rows at varying opacity simulate the real list content.
 */
function FeedSkeleton() {
  return (
    <View style={styles.skeletonContainer} accessibilityLabel="Loading notifications">
      {[0.9, 0.7, 0.6, 0.5, 0.4].map((opacity, i) => (
        <View key={i} style={[styles.skeletonRow, { opacity }]}>
          <View style={styles.skeletonIcon} />
          <View style={styles.skeletonText}>
            <View style={[styles.skeletonLine, { width: '70%' }]} />
            <View style={[styles.skeletonLine, { width: '45%', marginTop: 6 }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Shown when there are no notifications yet.
 */
function EmptyFeed() {
  return (
    <View style={styles.centerContainer} accessibilityLabel="No notifications yet">
      <Ionicons name="notifications-off-outline" size={48} color="#374151" />
      <Text style={styles.emptyTitle}>No notifications yet</Text>
      <Text style={styles.emptyBody}>
        You will see agent updates, budget alerts, and weekly digests here.
      </Text>
    </View>
  );
}

/**
 * Shown when the fetch fails.
 *
 * @param message - Error message to display
 */
function ErrorState({ message }: { message: string }) {
  return (
    <View style={styles.centerContainer} accessibilityLabel="Error loading notifications">
      <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
      <Text style={styles.errorTitle}>Could not load notifications</Text>
      <Text style={styles.errorBody}>{message}</Text>
    </View>
  );
}

// ============================================================================
// Main component
// ============================================================================

interface NotificationFeedListProps {
  notifications: InAppNotification[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  refreshing?: boolean;
  onPressItem: (notification: InAppNotification) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}

/**
 * The notification feed list component.
 * Handles loading states, empty state, error state, pagination, and pull-to-refresh.
 */
export default function NotificationFeedList({
  notifications,
  loading,
  loadingMore,
  hasMore,
  error,
  refreshing = false,
  onPressItem,
  onLoadMore,
  onRefresh,
}: NotificationFeedListProps) {
  const renderItem: ListRenderItem<InAppNotification> = useCallback(
    ({ item }) => <NotificationFeedItem notification={item} onPress={onPressItem} />,
    [onPressItem]
  );

  const keyExtractor = useCallback((item: InAppNotification) => item.id, []);

  const ListFooter = useCallback(() => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footer} accessibilityLabel="Loading more notifications">
        <ActivityIndicator size="small" color="#f59e0b" />
      </View>
    );
  }, [loadingMore]);

  const handleEndReached = useCallback(() => {
    if (hasMore && !loadingMore) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore]);

  if (loading) {
    return <FeedSkeleton />;
  }

  if (error) {
    return <ErrorState message={error} />;
  }

  return (
    <FlatList
      data={notifications}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListEmptyComponent={EmptyFeed}
      ListFooterComponent={ListFooter}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.2}
      removeClippedSubviews
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#f59e0b"
          colors={['#f59e0b']}
        />
      }
      contentContainerStyle={notifications.length === 0 ? styles.emptyListContent : undefined}
    />
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  skeletonContainer: {
    paddingTop: 8,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  skeletonIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginRight: 12,
  },
  skeletonText: {
    flex: 1,
  },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 64,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#9ca3af',
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: '#4b5563',
    textAlign: 'center',
    lineHeight: 20,
  },
  errorTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#ef4444',
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 20,
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  emptyListContent: {
    flexGrow: 1,
  },
});
