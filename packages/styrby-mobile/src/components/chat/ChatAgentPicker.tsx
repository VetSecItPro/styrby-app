/**
 * ChatAgentPicker
 *
 * Horizontal pill-style picker shown above the chat message list, letting
 * the user switch between supported AI agents mid-session.
 *
 * WHY a dedicated component: Extracts the picker rendering from the
 * orchestrator so the orchestrator only owns state. Mirrors the broader
 * `AgentSelector` component but is intentionally minimal — fits in the
 * tight horizontal strip above the message list.
 */

import { View, Text, Pressable } from 'react-native';
import type { AgentType } from 'styrby-shared';
import { AGENT_CONFIG, SELECTABLE_AGENTS } from './agent-config';

/**
 * Props for {@link ChatAgentPicker}.
 */
export interface ChatAgentPickerProps {
  /** Currently selected agent (null = none selected, defaults to claude in chat flow) */
  selectedAgent: AgentType | null;
  /** Called with the new agent when the user taps a pill */
  onSelect: (agent: AgentType) => void;
}

/**
 * Renders the horizontal agent-selection strip.
 *
 * @param props - {@link ChatAgentPickerProps}
 * @returns React element for the picker row
 */
export function ChatAgentPicker({ selectedAgent, onSelect }: ChatAgentPickerProps) {
  return (
    <View className="flex-row px-4 py-2 border-b border-zinc-800">
      {SELECTABLE_AGENTS.map((agent) => {
        const config = AGENT_CONFIG[agent];
        const isSelected = selectedAgent === agent;
        return (
          <Pressable
            key={agent}
            onPress={() => onSelect(agent)}
            className={`flex-row items-center px-3 py-1.5 rounded-full mr-2 ${
              isSelected ? '' : 'opacity-50'
            }`}
            style={{ backgroundColor: isSelected ? config.bgColor : 'transparent' }}
            accessibilityRole="button"
            accessibilityLabel={`Select ${config.name} agent`}
            accessibilityState={{ selected: isSelected }}
          >
            <View
              style={{ backgroundColor: config.color }}
              className="w-4 h-4 rounded-md items-center justify-center"
            >
              <Text className="text-white text-xs font-bold">{config.name[0]}</Text>
            </View>
            <Text
              style={{ color: isSelected ? config.color : '#71717a' }}
              className="text-sm font-medium ml-2"
            >
              {config.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
