/**
 * SaveCheckpointModal — bottom-sheet form for naming a new checkpoint.
 *
 * Extracted from SessionCheckpoints.tsx (Cluster A2 split). Presentational:
 * all form state + the save action live in useSessionCheckpoints; this renders
 * the sheet and wires the inputs.
 *
 * @module components/session-checkpoints/SaveCheckpointModal
 */

import { View, Text, Pressable, TextInput, ActivityIndicator, Modal } from 'react-native';
import { CHECKPOINT_NAME_MAX } from './checkpoint-format';

/** Props for the save-checkpoint modal. */
export interface SaveCheckpointModalProps {
  visible: boolean;
  newName: string;
  newDescription: string;
  saveError: string | null;
  isSaving: boolean;
  currentMessageCount: number;
  onChangeName: (name: string) => void;
  onChangeDescription: (desc: string) => void;
  onSave: () => void;
  onClose: () => void;
}

/**
 * Bottom-sheet modal for creating a checkpoint.
 *
 * @param props - Modal props.
 */
export function SaveCheckpointModal({
  visible,
  newName,
  newDescription,
  saveError,
  isSaving,
  currentMessageCount,
  onChangeName,
  onChangeDescription,
  onSave,
  onClose,
}: SaveCheckpointModalProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View className="flex-1 bg-black/60 justify-end">
        <View className="bg-zinc-900 rounded-t-3xl px-4 pt-4 pb-8">
          {/* Handle */}
          <View className="w-10 h-1 bg-zinc-700 rounded-full self-center mb-4" />

          <Text className="text-white text-lg font-semibold mb-4">Save Checkpoint</Text>

          {/* Name input */}
          <Text className="text-zinc-400 text-sm mb-1">Name</Text>
          <TextInput
            value={newName}
            onChangeText={onChangeName}
            placeholder="e.g. before-refactor"
            placeholderTextColor="#52525b"
            maxLength={CHECKPOINT_NAME_MAX}
            className="bg-zinc-800 text-white rounded-xl px-4 py-3 mb-3 border border-zinc-700"
            accessibilityLabel="Checkpoint name"
            autoFocus
            returnKeyType="next"
          />

          {/* Description input */}
          <Text className="text-zinc-400 text-sm mb-1">Description (optional)</Text>
          <TextInput
            value={newDescription}
            onChangeText={onChangeDescription}
            placeholder="What's working at this point?"
            placeholderTextColor="#52525b"
            className="bg-zinc-800 text-white rounded-xl px-4 py-3 mb-3 border border-zinc-700"
            accessibilityLabel="Checkpoint description"
            returnKeyType="done"
            onSubmitEditing={onSave}
          />

          {/* Error message */}
          {saveError && <Text className="text-red-400 text-sm mb-3">{saveError}</Text>}

          {/* Current position info */}
          <Text className="text-zinc-600 text-xs mb-4">
            This checkpoint will mark message {currentMessageCount} in the session.
          </Text>

          {/* Action buttons */}
          <Pressable
            onPress={onSave}
            disabled={isSaving || !newName.trim()}
            className="bg-orange-500 rounded-2xl py-4 items-center mb-3 active:opacity-80 disabled:opacity-50"
            accessibilityRole="button"
            accessibilityLabel={isSaving ? 'Saving checkpoint...' : 'Save checkpoint'}
          >
            {isSaving ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold">Save Checkpoint</Text>
            )}
          </Pressable>

          <Pressable
            onPress={onClose}
            className="bg-zinc-800 rounded-2xl py-4 items-center active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text className="text-zinc-300 font-semibold">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
