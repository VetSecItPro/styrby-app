/**
 * Agent Configuration — CustomPromptSection
 *
 * Renders the "Custom System Prompt" group: a multiline TextInput where the
 * user can append additional system-prompt instructions for this agent.
 *
 * WHY: Plain controlled multiline input. Lives on its own so the
 * orchestrator's render tree stays a flat sequence of section components.
 */

import { View, Text, TextInput } from 'react-native';
import { SectionHeader } from './SectionHeader';

export interface CustomPromptSectionProps {
  /** Current prompt text (may be empty). */
  value: string;
  /** Setter receiving the raw input string. */
  onChange: (text: string) => void;
}

/**
 * Renders the Custom System Prompt section with multiline input.
 *
 * @param props - Section props.
 * @returns React element
 */
export function CustomPromptSection({ value, onChange }: CustomPromptSectionProps) {
  return (
    <>
      <SectionHeader title="Custom System Prompt" />
      <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden p-4">
        <Text className="text-zinc-500 text-sm mb-3">
          Additional instructions appended to the agent's default system prompt. Use this to customize behavior for your workflow.
        </Text>
        <TextInput
          className="bg-zinc-800 text-white rounded-lg px-3 py-3 text-sm min-h-[100px]"
          placeholder="e.g., Always use TypeScript strict mode..."
          placeholderTextColor="#52525b"
          value={value}
          onChangeText={onChange}
          multiline
          textAlignVertical="top"
          accessibilityLabel="Custom system prompt"
          accessibilityHint="Enter additional instructions for the agent"
        />
      </View>
    </>
  );
}
