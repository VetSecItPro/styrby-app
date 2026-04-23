/**
 * NotificationFeedItem
 *
 * Renders a single row in the in-app notification feed.
 *
 * WHY Ionicons: @expo/vector-icons is the standard icon library across
 * styrby-mobile (see CostCard, SessionTagEditor, PermissionCard). lucide-react-native
 * is not installed in this package.
 *
 * @param notification - The notification data to render
 * @param onPress - Called when the row is tapped (marks as read + optional deep-link)
 */

import React, { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { InAppNotification } from '@/hooks/useInAppNotifications';

/**
 * Icon and color config for each notification type.
 * Maps Supabase notification type strings to Ionicons glyph + color.
 */
interface TypeConfig {
  iconName: keyof typeof Ionicons.glyphMap;
  color: string;
  label: string;
}

/**
 * Returns display config for a notification type.
 *
 * @param type - The notification type from the database
 * @returns Icon name, accent color, and human-readable label
 */
function getTypeConfig(type: string): TypeConfig {
  switch (type) {
    case 'agent_finished':
      return { iconName: 'checkmark-circle', color: '#22c55e', label: 'Agent done' };
    case 'budget_threshold':
      return { iconName: 'warning', color: '#f59e0b', label: 'Budget alert' };
    case 'weekly_digest':
      return { iconName: 'bar-chart', color: '#3b82f6', label: 'Weekly digest' };
    case 'weekly_summary_push':
      return { iconName: 'calendar', color: '#8b5cf6', label: 'Weekly summary' };
    case 'referral_reward':
      return { iconName: 'gift', color: '#f59e0b', label: 'Referral reward' };
    case 'reconnect':
      return { iconName: 'wifi', color: '#06b6d4', label: 'Reconnected' };
    default:
      return { iconName: 'notifications', color: '#6b7280', label: 'Notification' };
  }
}

/**
 * Format a UTC ISO timestamp as a relative time string.
 *
 * @param isoString - ISO 8601 date string
 * @returns Human-readable relative time like "2h ago", "just now"
 */
export function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface NotificationFeedItemProps {
  notification: InAppNotification;
  onPress: (notification: InAppNotification) => void;
}

/**
 * Single notification row component.
 * Memoized to avoid re-renders when sibling notifications update.
 */
const NotificationFeedItem = memo(function NotificationFeedItem({
  notification,
  onPress,
}: NotificationFeedItemProps) {
  const config = getTypeConfig(notification.type);
  const isRead = !!notification.read_at;

  return (
    <TouchableOpacity
      style={[styles.row, isRead ? styles.rowRead : styles.rowUnread]}
      onPress={() => onPress(notification)}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${config.label}: ${notification.title}${isRead ? '' : ', unread'}`}
    >
      {/* Unread indicator dot */}
      {!isRead && <View style={styles.unreadDot} />}

      {/* Type icon */}
      <View style={[styles.iconContainer, { backgroundColor: config.color + '20' }]}>
        <Ionicons name={config.iconName} size={20} color={config.color} />
      </View>

      {/* Text content */}
      <View style={styles.content}>
        <Text
          style={[styles.title, isRead ? styles.titleRead : styles.titleUnread]}
          numberOfLines={1}
        >
          {notification.title}
        </Text>
        {notification.body ? (
          <Text style={styles.body} numberOfLines={2}>
            {notification.body}
          </Text>
        ) : null}
        <Text style={styles.timestamp}>
          {formatRelativeTime(notification.created_at)}
        </Text>
      </View>
    </TouchableOpacity>
  );
});

export default NotificationFeedItem;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
    position: 'relative',
  },
  rowUnread: {
    backgroundColor: 'rgba(245,158,11,0.04)',
  },
  rowRead: {
    backgroundColor: 'transparent',
  },
  unreadDot: {
    position: 'absolute',
    left: 6,
    top: 18,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#f59e0b',
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  content: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 15,
    lineHeight: 20,
  },
  titleUnread: {
    color: '#f9fafb',
    fontWeight: '600',
  },
  titleRead: {
    color: '#9ca3af',
    fontWeight: '400',
  },
  body: {
    fontSize: 13,
    lineHeight: 18,
    color: '#6b7280',
  },
  timestamp: {
    fontSize: 12,
    color: '#4b5563',
    marginTop: 2,
  },
});
