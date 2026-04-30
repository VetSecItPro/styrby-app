/**
 * Mobile Delete Section — GDPR Art. 17 Right to Erasure
 *
 * Two-step account deletion on mobile:
 *   Step 1: Info sheet — what will be deleted and the 30-day grace window.
 *   Step 2: On iOS, native Alert.prompt for email confirmation.
 *           On Android, a Modal with a TextInput (same as DeleteAccountModal
 *           in the account screen — we reuse it here).
 *
 * WHY reuse the existing deletion flow from use-account-danger.ts:
 *   The account-io.ts deleteAccount() function already handles the API call,
 *   clears pairing info, and signs the user out. Re-implementing would be a
 *   maintenance risk. We call deleteAccount() directly from this component.
 *
 * GDPR Art. 17 — Right to Erasure
 * SOC2 CC6.5   — Access revocation on account deletion
 */

import { View, Text, Pressable, ActivityIndicator, Alert, Platform } from 'react-native';
import { useState, useCallback } from 'react';
import { SectionHeader } from '@/components/ui';
import { DeleteAccountModal } from '@/components/account/DeleteAccountModal';
import { deleteAccount } from '@/components/account/account-io';
import { DELETE_CONFIRMATION_PHRASE } from '@/types/account';

/** Props for {@link MobileDeleteSection}. */
export interface MobileDeleteSectionProps {
  /** User's email - shown in the info step for context */
  userEmail: string;
  /** User's display name - shown in the info step */
  userDisplayName?: string;
}

/**
 * 2-step account deletion panel for mobile settings.
 *
 * @param props - User identity for contextual display
 */
export function MobileDeleteSection({ userEmail, userDisplayName }: MobileDeleteSectionProps) {
  const [showInfoSheet, setShowInfoSheet] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  /**
   * iOS path: use native Alert.prompt for email confirmation.
   * Android path: open the Modal with TextInput.
   *
   * WHY platform split: Alert.prompt is iOS-only. On Android we render
   * a custom Modal (same pattern as the account screen's DeleteAccountModal).
   */
  const handleBeginDelete = useCallback(() => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Confirm Account Deletion',
        `Type "${DELETE_CONFIRMATION_PHRASE}" to permanently delete your account and all data.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async (value) => {
              if (value?.trim() !== DELETE_CONFIRMATION_PHRASE) {
                Alert.alert(
                  'Confirmation Required',
                  `Please type "${DELETE_CONFIRMATION_PHRASE}" exactly to proceed.`,
                );
                return;
              }
              await executeDelete();
            },
          },
        ],
        'plain-text',
      );
    } else {
      setDeleteConfirmText('');
      setShowDeleteModal(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Execute the account deletion via account-io.deleteAccount().
   *
   * WHY: deleteAccount() handles the full cascade: API call, pairing
   * info cleared, sign out. Keeps network logic out of this component.
   */
  const executeDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      const result = await deleteAccount();
      if (!result.ok) {
        Alert.alert(
          'Deletion Failed',
          result.message ?? 'Failed to delete account. Please try again or contact support.',
        );
      }
      // On success, deleteAccount() calls signOut() which triggers the
      // root layout auth listener to redirect to login.
    } finally {
      setIsDeleting(false);
      setShowDeleteModal(false);
    }
  }, []);

  const handleModalConfirm = useCallback(() => {
    if (deleteConfirmText !== DELETE_CONFIRMATION_PHRASE) return;
    executeDelete();
  }, [deleteConfirmText, executeDelete]);

  return (
    <>
      <SectionHeader title="Danger Zone" />
      <View className="bg-background-secondary mx-4 rounded-xl mb-4 overflow-hidden border border-red-500/20">

        {!showInfoSheet ? (
          <Pressable
            onPress={() => setShowInfoSheet(true)}
            disabled={isDeleting}
            accessibilityRole="button"
            accessibilityLabel="Begin account deletion process"
            className="flex-row items-center px-4 py-4 active:bg-red-500/10"
          >
            <View className="flex-1">
              <Text className="text-sm font-medium text-red-400">Delete Account</Text>
              <Text className="text-xs text-zinc-500 mt-0.5">
                Permanently delete your account and all data (GDPR Art. 17)
              </Text>
            </View>
          </Pressable>
        ) : (
          <View className="px-4 py-4">
            {/* WHY: Surface the account identity in the info step so the user
                can confirm they are deleting the right account before they
                commit. Documented in the component contract above. */}
            <Text className="text-xs text-zinc-500 mb-1">Account</Text>
            <Text className="text-sm text-zinc-200 mb-3">
              {userDisplayName ? `${userDisplayName} (${userEmail})` : userEmail}
            </Text>
            <Text className="text-sm font-semibold text-red-400 mb-2">
              What will be deleted:
            </Text>
            <Text className="text-xs text-zinc-400 mb-1">- All sessions and message history</Text>
            <Text className="text-xs text-zinc-400 mb-1">- Machine pairings and encryption keys</Text>
            <Text className="text-xs text-zinc-400 mb-1">- Agent configs and budget alerts</Text>
            <Text className="text-xs text-zinc-400 mb-1">- Billing history and subscription</Text>
            <Text className="text-xs text-zinc-400 mb-3">- Audit log and all settings</Text>

            <View className="rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 mb-4">
              <Text className="text-xs text-zinc-300 font-medium mb-0.5">30-day grace window</Text>
              <Text className="text-xs text-zinc-500">
                Your account is deactivated immediately. All data is permanently and
                irreversibly removed after 30 days.
              </Text>
            </View>

            <View className="flex-row gap-3">
              <Pressable
                onPress={() => setShowInfoSheet(false)}
                disabled={isDeleting}
                className="flex-1 py-2 rounded-xl border border-zinc-700 items-center active:bg-zinc-800"
                accessibilityRole="button"
                accessibilityLabel="Cancel account deletion"
              >
                <Text className="text-sm text-zinc-400">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleBeginDelete}
                disabled={isDeleting}
                className="flex-1 py-2 rounded-xl border border-red-500/50 items-center active:bg-red-500/10"
                accessibilityRole="button"
                accessibilityLabel="Continue to account deletion confirmation"
              >
                {isDeleting ? (
                  <ActivityIndicator size="small" color="#ef4444" />
                ) : (
                  <Text className="text-sm text-red-400 font-medium">Continue</Text>
                )}
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* Android modal */}
      <DeleteAccountModal
        visible={showDeleteModal}
        confirmText={deleteConfirmText}
        isDeleting={isDeleting}
        onConfirmTextChange={setDeleteConfirmText}
        onConfirm={handleModalConfirm}
        onClose={() => {
          setShowDeleteModal(false);
          setDeleteConfirmText('');
        }}
      />
    </>
  );
}
