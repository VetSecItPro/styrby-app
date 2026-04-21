/**
 * Agent Configuration — BlockedToolsSection
 *
 * Renders the "Blocked Tools" group: a free-text input for adding a tool
 * name plus a wrap-flow of removable chips for each currently-blocked tool.
 *
 * WHY: Owns both the input field and chip rendering so the orchestrator just
 * supplies the list and the add/remove handlers. Internal `BlockedToolChip`
 * is private here because no other screen uses it.
 */

import { View, Text, TextInput, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SectionHeader } from './SectionHeader';

export interface BlockedToolsSectionProps {
  /** Current list of tool names that the agent must never invoke. */
  blockedTools: string[];
  /** Controlled value of the "new tool" input. */
  newBlockedTool: string;
  /** Setter for the controlled input. */
  onNewBlockedToolChange: (value: string) => void;
  /** Callback fired when the user submits the input or taps Add. */
  onAdd: () => void;
  /** Callback fired when the user removes a chip. */
  onRemove: (tool: string) => void;
}

/**
 * A blocked tool chip with a remove button.
 *
 * @param props - Tool name and remove callback
 * @returns React element
 */
function BlockedToolChip({
  tool,
  onRemove,
}: {
  /** The tool name to display */
  tool: string;
  /** Callback when the remove button is tapped */
  onRemove: () => void;
}) {
  return (
    <View className="flex-row items-center bg-zinc-800 rounded-lg px-3 py-2 mr-2 mb-2">
      <Text className="text-zinc-300 text-sm mr-2">{tool}</Text>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove blocked tool ${tool}`}
      >
        <Ionicons name="close-circle" size={18} color="#71717a" />
      </Pressable>
    </View>
  );
}

/**
 * Renders the Blocked Tools section with input + chip list.
 *
 * @param props - Section props.
 * @returns React element
 */
export function BlockedToolsSection({
  blockedTools,
  newBlockedTool,
  onNewBlockedToolChange,
  onAdd,
  onRemove,
}: BlockedToolsSectionProps) {
  return (
    <>
      <SectionHeader title="Blocked Tools" />
      <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden p-4">
        <Text className="text-zinc-500 text-sm mb-3">
          Tools listed here will never be allowed, regardless of auto-approve settings.
        </Text>

        {/* Add tool input */}
        <View className="flex-row items-center mb-3">
          <TextInput
            className="flex-1 bg-zinc-800 text-white rounded-lg px-3 py-2.5 mr-2 text-sm"
            placeholder='e.g., "rm", "git push --force"'
            placeholderTextColor="#52525b"
            value={newBlockedTool}
            onChangeText={onNewBlockedToolChange}
            onSubmitEditing={onAdd}
            returnKeyType="done"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Enter tool name to block"
            accessibilityHint="Type a tool name and tap Add to block it"
          />
          <Pressable
            className="bg-zinc-800 px-4 py-2.5 rounded-lg active:bg-zinc-700"
            onPress={onAdd}
            accessibilityRole="button"
            accessibilityLabel="Add blocked tool"
          >
            <Text className="text-brand font-semibold text-sm">Add</Text>
          </Pressable>
        </View>

        {/* Blocked tools list */}
        {blockedTools.length > 0 ? (
          <View className="flex-row flex-wrap">
            {blockedTools.map((tool) => (
              <BlockedToolChip key={tool} tool={tool} onRemove={() => onRemove(tool)} />
            ))}
          </View>
        ) : (
          <Text className="text-zinc-600 text-sm italic">No blocked tools configured</Text>
        )}
      </View>
    </>
  );
}
