/**
 * Account Danger-Zone hook — `useAccountDanger`
 *
 * Manages irreversible account operations: sign out, data export, and account
 * deletion (including the two-step confirmation flow).
 *
 * All network/storage calls are delegated to `account-io.ts`; this hook
 * translates results into Alert copy and local loading state.
 *
 * WHY separate from use-account-profile: danger-zone operations are
 * irreversible or require elevated confirmation UX (two-step delete, typed
 * phrase). Isolating them here makes the confirmation logic easier to audit
 * and test without profile-state noise.
 */

import { useCallback, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { DELETE_CONFIRMATION_PHRASE } from '@/types/account';
import { deleteAccount, exportAccountData, performSignOut } from './account-io';

/** Arguments for {@link useAccountDanger}. */
export interface UseAccountDangerArgs {
  /** Current user id (null while still loading). */
  userId: string | null;
}

/** State and handlers returned by {@link useAccountDanger}. */
export interface UseAccountDangerResult {
  // Data export
  isExportingData: boolean;
  exportData: () => Promise<void>;

  // Sign out / delete
  isSigningOut: boolean;
  isDeletingAccount: boolean;
  showDeleteModal: boolean;
  deleteConfirmText: string;
  setDeleteConfirmText: (next: string) => void;
  closeDeleteModal: () => void;
  signOutAccount: () => void;
  beginDeleteAccount: () => void;
  confirmDeleteAccountFromModal: () => void;
}

/**
 * Manages danger-zone state and I/O: data export, sign out, and account
 * deletion with two-step confirmation. See {@link UseAccountDangerResult}.
 *
 * @param args - User identity needed to guard export against unauthenticated calls.
 * @returns Danger-zone state and handler functions.
 */
export function useAccountDanger(args: UseAccountDangerArgs): UseAccountDangerResult {
  const { userId } = args;

  // --- Data export ----------------------------------------------------------
  const [isExportingData, setIsExportingData] = useState(false);

  // --- Sign out / delete ----------------------------------------------------
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  // WHY: Alert.prompt is iOS-only. On Android we show a custom modal.
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // --------------------------------------------------------------------------
  // Data export
  // --------------------------------------------------------------------------
  const exportData = useCallback(async () => {
    if (!userId) return;
    setIsExportingData(true);
    const result = await exportAccountData();
    setIsExportingData(false);

    if (!result.ok) {
      Alert.alert(result.status === 429 ? 'Rate Limited' : 'Export Failed', result.message);
      return;
    }

    Alert.alert(
      'Data Export Ready',
      'Your data has been copied to the clipboard. Paste it into a text editor to save the JSON file.',
      [{ text: 'OK' }],
    );
  }, [userId]);

  // --------------------------------------------------------------------------
  // Sign out
  // --------------------------------------------------------------------------
  const signOutAccount = useCallback(() => {
    Alert.alert(
      'Sign Out?',
      "You'll need to re-pair with your CLI after signing back in.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            setIsSigningOut(true);
            const result = await performSignOut();
            if (!result.ok) {
              Alert.alert('Sign Out Failed', result.message);
              setIsSigningOut(false);
            }
            // On success: root layout auth listener redirects to login
          },
        },
      ],
    );
  }, []);

  // --------------------------------------------------------------------------
  // Account deletion
  // --------------------------------------------------------------------------
  const executeAccountDeletion = useCallback(async () => {
    setIsDeletingAccount(true);
    const result = await deleteAccount();
    if (!result.ok) {
      Alert.alert(result.status === 429 ? 'Rate Limited' : 'Deletion Failed', result.message);
      setIsDeletingAccount(false);
    }
    // On success: signOut inside deleteAccount triggers the root layout redirect.
  }, []);

  /**
   * Initiates the account deletion flow with a two-step confirmation: an
   * explanatory Alert, then a typed-confirmation prompt (Alert.prompt on iOS,
   * custom Modal on Android — Alert.prompt is iOS-only).
   *
   * WHY two-step: account deletion is irreversible after the 30-day grace
   * period. Typed confirmation satisfies GDPR Art. 17 explicit-consent.
   */
  const beginDeleteAccount = useCallback(() => {
    Alert.alert(
      'Delete Account?',
      'This will permanently delete your account and all associated data, including sessions, cost records, team memberships, and preferences.\n\nYour data will be recoverable for 30 days, after which it is permanently removed.\n\nThis action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            if (Platform.OS === 'ios') {
              Alert.prompt(
                'Confirm Deletion',
                `Type "${DELETE_CONFIRMATION_PHRASE}" to confirm.`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: (input?: string) => {
                      if (input?.trim() === DELETE_CONFIRMATION_PHRASE) {
                        void executeAccountDeletion();
                      } else {
                        Alert.alert(
                          'Confirmation Failed',
                          `You must type "${DELETE_CONFIRMATION_PHRASE}" exactly to proceed.`,
                        );
                      }
                    },
                  },
                ],
                'plain-text',
              );
            } else {
              // WHY custom modal: Alert.prompt is iOS-only (RN limitation).
              // On Android we render a TextInput inside a Modal so the user
              // must still type the exact phrase — same security bar as iOS.
              setDeleteConfirmText('');
              setShowDeleteModal(true);
            }
          },
        },
      ],
    );
  }, [executeAccountDeletion]);

  const closeDeleteModal = useCallback(() => {
    setShowDeleteModal(false);
  }, []);

  const confirmDeleteAccountFromModal = useCallback(() => {
    setShowDeleteModal(false);
    void executeAccountDeletion();
  }, [executeAccountDeletion]);

  return {
    isExportingData,
    exportData,

    isSigningOut,
    isDeletingAccount,
    showDeleteModal,
    deleteConfirmText,
    setDeleteConfirmText,
    closeDeleteModal,
    signOutAccount,
    beginDeleteAccount,
    confirmDeleteAccountFromModal,
  };
}
