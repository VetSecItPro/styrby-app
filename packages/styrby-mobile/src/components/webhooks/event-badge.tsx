/**
 * EventBadge
 *
 * Small colored pill badge representing a single webhook event type
 * (e.g., "Session Started"). Used in both the list row and detail sheet.
 */

import { View, Text } from 'react-native';
import type { WebhookEvent } from '../../types/webhooks';
import { EVENT_COLORS, EVENT_OPTIONS } from './webhook-helpers';

interface EventBadgeProps {
  /** Event type string (raw value, may be unknown if backend adds new events) */
  event: string;
}

/**
 * Renders a tinted pill for a webhook event type.
 *
 * WHY a fallback color for unknown events:
 * The backend may add new event types ahead of the mobile app shipping a
 * release. Falling back to a neutral zinc color avoids a crash while still
 * showing the raw event string so power users can recognize it.
 *
 * @param props - Badge props
 * @returns React element
 */
export function EventBadge({ event }: EventBadgeProps) {
  const colors = EVENT_COLORS[event as WebhookEvent] ?? { bg: '#3f3f4620', text: '#a1a1aa' };
  const label = EVENT_OPTIONS.find((o) => o.value === event)?.label ?? event;
  return (
    <View
      className="px-2 py-0.5 rounded-full mr-1 mb-1"
      style={{ backgroundColor: colors.bg }}
    >
      <Text style={{ color: colors.text, fontSize: 11, fontWeight: '600' }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
