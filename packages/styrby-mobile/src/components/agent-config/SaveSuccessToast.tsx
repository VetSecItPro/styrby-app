/**
 * Agent Configuration — SaveSuccessToast
 *
 * Inline green confirmation banner shown briefly after a successful save.
 *
 * WHY: A separate component so the orchestrator only needs to flip a boolean
 * to control visibility, and so we can later swap the implementation for a
 * proper animated toast without touching the screen file.
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export interface SaveSuccessToastProps {
  /** When true, the banner renders; otherwise this component returns null. */
  visible: boolean;
}

/**
 * Brief in-screen confirmation banner for successful saves.
 *
 * @param props - Visibility flag.
 * @returns React element or null
 */
export function SaveSuccessToast({ visible }: SaveSuccessToastProps) {
  if (!visible) return null;
  return (
    <View className="mx-4 mb-4 bg-green-500/15 rounded-xl px-4 py-3 flex-row items-center">
      <Ionicons name="checkmark-circle" size={20} color="#22c55e" />
      <Text className="text-green-400 font-medium ml-2">Configuration saved</Text>
    </View>
  );
}
