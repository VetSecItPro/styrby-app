/**
 * WebhookListItem
 *
 * A single row in the webhooks FlatList. Shows the webhook name, truncated
 * URL, event-type badges, active/paused status, created date, and any
 * consecutive-failure warning.
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Webhook } from '../../types/webhooks';
import { EventBadge } from './event-badge';
import { formatDate, truncateUrl } from './webhook-helpers';

interface WebhookListItemProps {
  /** The webhook to display */
  webhook: Webhook;
  /** Called when the row is tapped */
  onPress: (webhook: Webhook) => void;
}

/**
 * Renders one webhook row.
 *
 * WHY the failure warning lives in the row (not just the detail sheet):
 * Users need at-a-glance signal that a hook is broken without having to open
 * each row. The row badge mirrors the orange warning shown in the detail sheet
 * so the two views agree on health state.
 *
 * @param props - Component props
 * @returns React element
 */
export function WebhookListItem({ webhook, onPress }: WebhookListItemProps) {
  return (
    <Pressable
      className="bg-zinc-900 rounded-2xl p-4 mb-3 mx-4 active:opacity-80"
      onPress={() => onPress(webhook)}
      accessibilityRole="button"
      accessibilityLabel={`Webhook ${webhook.name}, ${webhook.is_active ? 'active' : 'paused'}`}
    >
      {/* Header: name + status */}
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-white font-semibold text-base flex-1 mr-2" numberOfLines={1}>
          {webhook.name}
        </Text>
        <View
          className="px-2 py-0.5 rounded-full"
          style={{ backgroundColor: webhook.is_active ? '#16a34a20' : '#71717a20' }}
        >
          <Text
            style={{
              color: webhook.is_active ? '#4ade80' : '#71717a',
              fontSize: 11,
              fontWeight: '600',
            }}
          >
            {webhook.is_active ? 'Active' : 'Paused'}
          </Text>
        </View>
      </View>

      {/* URL */}
      <Text className="text-zinc-400 text-sm mb-2" numberOfLines={1}>
        {truncateUrl(webhook.url)}
      </Text>

      {/* Event badges */}
      <View className="flex-row flex-wrap mb-2">
        {webhook.events.map((event) => (
          <EventBadge key={event} event={event} />
        ))}
      </View>

      {/* Footer: created date + failure warning */}
      <View className="flex-row items-center justify-between">
        <Text className="text-zinc-500 text-xs">
          Created {formatDate(webhook.created_at)}
        </Text>
        {webhook.consecutive_failures > 0 && (
          <View className="flex-row items-center">
            <Ionicons name="warning" size={12} color="#fb923c" />
            <Text className="text-orange-400 text-xs ml-1">
              {webhook.consecutive_failures} failed
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}
