/**
 * Account Settings — Email Change Modal
 *
 * Bottom-sheet modal that collects the new email address and triggers the
 * Supabase email-change flow. Sending is owned by the orchestrator hook;
 * this component is presentation-only.
 */

import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Props consumed by {@link EmailChangeModal}.
 */
export interface EmailChangeModalProps {
  visible: boolean;
  currentEmail: string | undefined;
  draft: string;
  isSubmitting: boolean;
  onDraftChange: (next: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

/**
 * Email change bottom sheet.
 */
export function EmailChangeModal(props: EmailChangeModalProps) {
  const { visible, currentEmail, draft, isSubmitting, onDraftChange, onSubmit, onClose } = props;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-end"
      >
        <Pressable
          className="flex-1"
          onPress={onClose}
          accessibilityLabel="Close email change modal"
        />
        <View className="bg-zinc-900 rounded-t-3xl px-6 pt-6 pb-10 border-t border-zinc-800">
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-white text-lg font-semibold">Change Email</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close email change modal"
            >
              <Ionicons name="close" size={24} color="#71717a" />
            </Pressable>
          </View>

          <Text className="text-zinc-400 text-sm mb-4">
            A verification email will be sent to your new address. Your email will not change until you confirm it.
          </Text>

          <View className="mb-3">
            <Text className="text-zinc-500 text-xs mb-1">Current Email</Text>
            <Text className="text-zinc-300 text-sm">{currentEmail}</Text>
          </View>

          <TextInput
            className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-base mb-4"
            placeholder="New email address"
            placeholderTextColor="#71717a"
            value={draft}
            onChangeText={onDraftChange}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
            accessibilityLabel="New email address input"
          />

          <Pressable
            onPress={onSubmit}
            disabled={isSubmitting || !draft.trim()}
            className={`py-3 rounded-xl items-center ${
              isSubmitting || !draft.trim()
                ? 'bg-zinc-700'
                : 'bg-brand active:opacity-80'
            }`}
            accessibilityRole="button"
            accessibilityLabel="Submit email change"
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text className="text-white font-semibold">Send Verification Email</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
