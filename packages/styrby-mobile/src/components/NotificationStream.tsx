/**
 * Notification Stream
 *
 * Unified stream of notifications from all agents.
 * Shows permission requests, errors, completions, and other events.
 */

import { View, Text, Pressable, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';

/**
 * Notification types
 */
export type NotificationType =
  | 'permission_request'
  | 'error'
  | 'completion'
  | 'cost_alert'
  | 'session_start'
  | 'session_end'
  | 'info';

/**
 * Notification item
 */
export interface Notification {
  id: string;
  type: NotificationType;
  agentType: AgentType;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  actionable?: boolean;
  sessionId?: string;
}

interface NotificationStreamProps {
  notifications: Notification[];
  onNotificationPress: (notification: Notification) => void;
  onMarkRead: (id: string) => void;
  maxItems?: number;
}

const AGENT_COLORS: Record<AgentType, string> = {
  claude: '#f97316',
  codex: '#22c55e',
  gemini: '#3b82f6',
};

const TYPE_CONFIG: Record<NotificationType, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  permission_request: { icon: 'shield-checkmark', color: '#f97316' },
  error: { icon: 'alert-circle', color: '#ef4444' },
  completion: { icon: 'checkmark-circle', color: '#22c55e' },
  cost_alert: { icon: 'wallet', color: '#eab308' },
  session_start: { icon: 'play-circle', color: '#3b82f6' },
  session_end: { icon: 'stop-circle', color: '#71717a' },
  info: { icon: 'information-circle', color: '#71717a' },
};

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function NotificationItem({
  notification,
  onPress,
}: {
  notification: Notification;
  onPress: () => void;
}) {
  const typeConfig = TYPE_CONFIG[notification.type];
  const agentColor = AGENT_COLORS[notification.agentType];

  return (
    <Pressable
      onPress={onPress}
      className={`flex-row p-3 border-b border-zinc-800 ${
        !notification.read ? 'bg-zinc-900/50' : ''
      }`}
    >
      {/* Icon */}
      <View
        style={{ backgroundColor: `${typeConfig.color}20` }}
        className="w-10 h-10 rounded-full items-center justify-center"
      >
        <Ionicons name={typeConfig.icon} size={20} color={typeConfig.color} />
      </View>

      {/* Content */}
      <View className="flex-1 ml-3">
        <View className="flex-row items-center">
          {/* Agent indicator */}
          <View
            style={{ backgroundColor: agentColor }}
            className="w-2 h-2 rounded-full mr-2"
          />
          <Text
            className={`flex-1 ${notification.read ? 'text-zinc-300' : 'text-zinc-100 font-medium'}`}
            numberOfLines={1}
          >
            {notification.title}
          </Text>
          <Text className="text-zinc-600 text-xs ml-2">
            {formatTimestamp(notification.timestamp)}
          </Text>
        </View>
        <Text className="text-zinc-500 text-sm mt-0.5" numberOfLines={2}>
          {notification.message}
        </Text>

        {/* Action indicator */}
        {notification.actionable && !notification.read && (
          <View className="flex-row items-center mt-2">
            <View className="bg-orange-500/20 px-2 py-1 rounded">
              <Text className="text-orange-400 text-xs font-medium">Action required</Text>
            </View>
          </View>
        )}
      </View>

      {/* Unread indicator */}
      {!notification.read && (
        <View className="w-2 h-2 rounded-full bg-brand ml-2 mt-2" />
      )}
    </Pressable>
  );
}

export function NotificationStream({
  notifications,
  onNotificationPress,
  onMarkRead,
  maxItems = 10,
}: NotificationStreamProps) {
  const displayNotifications = notifications.slice(0, maxItems);
  const unreadCount = notifications.filter((n) => !n.read).length;

  if (notifications.length === 0) {
    return (
      <View className="p-6 items-center">
        <Ionicons name="notifications-off-outline" size={32} color="#71717a" />
        <Text className="text-zinc-400 text-center mt-3">No notifications</Text>
        <Text className="text-zinc-600 text-sm text-center mt-1">
          You'll see agent updates here
        </Text>
      </View>
    );
  }

  return (
    <View>
      {/* Header */}
      {unreadCount > 0 && (
        <View className="flex-row items-center justify-between px-4 py-2 border-b border-zinc-800">
          <Text className="text-zinc-400 text-sm">
            {unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}
          </Text>
          <Pressable onPress={() => notifications.forEach((n) => onMarkRead(n.id))}>
            <Text className="text-brand text-sm">Mark all read</Text>
          </Pressable>
        </View>
      )}

      {/* Notification list */}
      <FlatList
        data={displayNotifications}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <NotificationItem
            notification={item}
            onPress={() => {
              onNotificationPress(item);
              if (!item.read) onMarkRead(item.id);
            }}
          />
        )}
        scrollEnabled={false}
      />

      {/* Show more */}
      {notifications.length > maxItems && (
        <Pressable className="p-3 items-center border-t border-zinc-800">
          <Text className="text-brand text-sm">
            View all {notifications.length} notifications
          </Text>
        </Pressable>
      )}
    </View>
  );
}
