/**
 * Account Settings — Delete Account Modal (Android-only path)
 *
 * Renders the typed-confirmation bottom sheet shown on Android. iOS uses
 * the native Alert.prompt API instead (handled in the orchestrator hook).
 *
 * WHY a separate component: keeps the orchestrator decoupled from the
 * platform branch and simplifies snapshot/integration testing.
 */

import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DELETE_CONFIRMATION_PHRASE } from '@/types/account';

/**
 * Props consumed by {@link DeleteAccountModal}.
 */
export interface DeleteAccountModalProps {
  visible: boolean;
  confirmText: string;
  isDeleting: boolean;
  onConfirmTextChange: (next: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Delete account bottom sheet (Android path).
 */
export function DeleteAccountModal(props: DeleteAccountModalProps) {
  const { visible, confirmText, isDeleting, onConfirmTextChange, onConfirm, onClose } = props;
  const matches = confirmText === DELETE_CONFIRMATION_PHRASE;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView behavior="height" className="flex-1 justify-end">
        <Pressable
          className="flex-1"
          onPress={onClose}
          accessibilityLabel="Close deletion confirmation"
        />
        <View className="bg-zinc-900 rounded-t-3xl px-6 pt-6 pb-10 border-t border-zinc-800">
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-white text-lg font-semibold">Confirm Deletion</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel account deletion"
            >
              <Ionicons name="close" size={24} color="#71717a" />
            </Pressable>
          </View>

          <Text className="text-zinc-400 text-sm mb-4">
            Type <Text className="text-white font-mono font-semibold">{DELETE_CONFIRMATION_PHRASE}</Text> to permanently delete your account.
          </Text>

          <TextInput
            className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-base mb-4"
            placeholder={DELETE_CONFIRMATION_PHRASE}
            placeholderTextColor="#71717a"
            value={confirmText}
            onChangeText={onConfirmTextChange}
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel={`Type ${DELETE_CONFIRMATION_PHRASE} to confirm`}
          />

          <Pressable
            className={`py-3 rounded-xl items-center ${
              matches ? 'bg-red-600 active:bg-red-700' : 'bg-zinc-700 opacity-50'
            }`}
            disabled={!matches || isDeleting}
            onPress={onConfirm}
            accessibilityRole="button"
            accessibilityLabel="Confirm permanent account deletion"
          >
            {isDeleting ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text className="text-white font-semibold">Delete My Account</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
