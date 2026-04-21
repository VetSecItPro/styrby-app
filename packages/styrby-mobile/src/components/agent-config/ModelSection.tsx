/**
 * Agent Configuration — ModelSection
 *
 * Renders the "Model" group: a list of selectable model rows for the active
 * agent, with the currently-selected model marked by a brand-colored check.
 *
 * WHY: Owns the radio-list interaction in one place so the orchestrator just
 * passes the meta + current value + change handler. The internal `ModelRow`
 * stays private to this file because it has no other consumers.
 */

import { View, Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentMeta } from '@/types/agent-config';
import { SectionHeader } from './SectionHeader';

export interface ModelSectionProps {
  /** Agent metadata (provides the candidate model list and brand color). */
  meta: AgentMeta;
  /** Currently selected model identifier. */
  selectedModel: string;
  /** Callback fired when the user selects a different model. */
  onSelect: (model: string) => void;
}

/**
 * A single model selection row with checkmark indicator.
 *
 * @param props - Row configuration.
 * @returns React element
 */
function ModelRow({
  model,
  isSelected,
  agentColor,
  onSelect,
}: {
  /** The model identifier string */
  model: string;
  /** Whether this model is currently selected */
  isSelected: boolean;
  /** The agent's brand color for the checkmark */
  agentColor: string;
  /** Callback when the model is tapped */
  onSelect: () => void;
}) {
  return (
    <Pressable
      className="flex-row items-center px-4 py-3 active:bg-zinc-900"
      onPress={onSelect}
      accessibilityRole="radio"
      accessibilityLabel={`Select model ${model}`}
      accessibilityState={{ selected: isSelected }}
    >
      <Text className={`flex-1 ${isSelected ? 'text-white font-semibold' : 'text-zinc-400'}`}>
        {model}
      </Text>
      {isSelected ? (
        <Ionicons name="checkmark-circle" size={22} color={agentColor} />
      ) : (
        <View className="w-[22px] h-[22px] rounded-full border border-zinc-700" />
      )}
    </Pressable>
  );
}

/**
 * Renders the Model section with one row per supported model for the agent.
 *
 * @param props - Section props.
 * @returns React element
 */
export function ModelSection({ meta, selectedModel, onSelect }: ModelSectionProps) {
  return (
    <>
      <SectionHeader title="Model" />
      <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden">
        {meta.models.map((model, index) => (
          <View key={model}>
            {index > 0 ? <View className="h-px bg-zinc-800 mx-4" /> : null}
            <ModelRow
              model={model}
              isSelected={selectedModel === model}
              agentColor={meta.color}
              onSelect={() => onSelect(model)}
            />
          </View>
        ))}
      </View>
    </>
  );
}
