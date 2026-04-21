/**
 * Agent Configuration — ActionButtons
 *
 * Bottom action area: a primary Save button (disabled when there are no
 * unsaved changes or a save is in flight) and a secondary Reset button.
 *
 * WHY: The save button has three visual states (idle-clean, idle-dirty,
 * saving-spinner) tied to two booleans. Encapsulating that logic here keeps
 * the orchestrator from owning conditional-style spaghetti at the bottom of
 * the JSX tree.
 */

import { View, Pressable, Text, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export interface ActionButtonsProps {
  /** Whether the form has changes vs the last-saved state. */
  dirty: boolean;
  /** Whether a save network request is currently in flight. */
  isSaving: boolean;
  /** Callback fired when the Save button is tapped. */
  onSave: () => void;
  /** Callback fired when the Reset button is tapped. */
  onReset: () => void;
}

/**
 * Save + Reset buttons rendered at the bottom of the screen.
 *
 * @param props - Action button state and handlers.
 * @returns React element
 */
export function ActionButtons({ dirty, isSaving, onSave, onReset }: ActionButtonsProps) {
  return (
    <View className="px-4 mt-6">
      {/* Save Button */}
      <Pressable
        className={`py-3.5 rounded-xl items-center flex-row justify-center active:opacity-80 ${
          dirty ? 'bg-brand' : 'bg-zinc-800'
        }`}
        onPress={onSave}
        disabled={isSaving || !dirty}
        accessibilityRole="button"
        accessibilityLabel="Save agent configuration"
        accessibilityState={{ disabled: isSaving || !dirty }}
      >
        {isSaving ? (
          <ActivityIndicator size="small" color="white" />
        ) : (
          <>
            <Ionicons
              name="checkmark-circle"
              size={20}
              color={dirty ? 'white' : '#52525b'}
            />
            <Text
              className={`font-semibold ml-2 ${
                dirty ? 'text-white' : 'text-zinc-600'
              }`}
            >
              {dirty ? 'Save Changes' : 'No Changes'}
            </Text>
          </>
        )}
      </Pressable>

      {/* Reset Button */}
      <Pressable
        className="mt-3 py-3.5 rounded-xl items-center border border-zinc-800 active:bg-zinc-900"
        onPress={onReset}
        accessibilityRole="button"
        accessibilityLabel="Reset configuration to defaults"
      >
        <Text className="text-zinc-400 font-semibold">Reset to Defaults</Text>
      </Pressable>
    </View>
  );
}
