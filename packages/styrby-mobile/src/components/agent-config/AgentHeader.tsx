/**
 * Agent Configuration — AgentHeader
 *
 * Top-of-screen branding block: brand-tinted icon tile, agent name, and
 * a static subtitle describing the screen's purpose.
 *
 * WHY: Pure presentation. Splitting it out keeps the orchestrator's render
 * tree free of color-arithmetic noise (`${color}20`) and makes it trivial to
 * reuse the same header on a future "agent details" screen.
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentMeta } from '@/types/agent-config';

export interface AgentHeaderProps {
  /** Static metadata for the agent being configured. */
  meta: AgentMeta;
}

/**
 * Header section displaying the agent's icon, name, and tagline.
 *
 * @param props - The agent metadata block to render.
 * @returns React element
 */
export function AgentHeader({ meta }: AgentHeaderProps) {
  return (
    <View className="items-center pt-6 pb-4">
      <View
        className="w-16 h-16 rounded-2xl items-center justify-center mb-3"
        style={{ backgroundColor: `${meta.color}20` }}
      >
        <Ionicons name={meta.icon} size={32} color={meta.color} />
      </View>
      <Text className="text-white text-xl font-bold">{meta.displayName}</Text>
      <Text className="text-zinc-500 text-sm mt-1">Configure agent behavior and limits</Text>
    </View>
  );
}
