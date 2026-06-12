/**
 * ThinkingBlock — collapsible "thinking" trace for chat messages.
 *
 * Extracted from ChatMessage.tsx (Cluster A2 split). Renders a `type:
 * 'thinking'` content block as a tappable, collapsed-by-default disclosure.
 *
 * @module components/chat/ThinkingBlock
 */

import { View, Text, Pressable } from 'react-native';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';

/**
 * @param props - the thinking-trace text to disclose.
 */
export function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable
      onPress={() => setExpanded(!expanded)}
      className="bg-zinc-800/50 rounded-lg my-2 overflow-hidden"
      accessibilityRole="button"
      accessibilityLabel={expanded ? 'Collapse thinking trace' : 'Expand thinking trace'}
      accessibilityState={{ expanded }}
    >
      <View className="flex-row items-center px-3 py-2">
        <Ionicons name="bulb-outline" size={14} color="#71717a" />
        <Text className="text-zinc-500 text-xs ml-2 flex-1">Thinking...</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color="#71717a" />
      </View>
      {expanded && (
        <View className="px-3 pb-3 border-t border-zinc-700">
          <Text className="text-zinc-500 text-sm mt-2">{content}</Text>
        </View>
      )}
    </Pressable>
  );
}
