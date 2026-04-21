/**
 * Account Settings — useAccount hook
 *
 * Encapsulates local UI state and async handlers for the Account sub-screen
 * orchestrator. All side-effectful network/storage calls live in
 * `account-io.ts`; this hook orchestrates them and translates results to
 * Alert copy.
 *
 * WHY one hook: every handler depends on `userId` plus 1-2 local state
 * slices. Forcing each section to own its own hook would force the
 * orchestrator to thread `user` and `refresh` into multiple places. A single
 * hook also gives us one obvious place to add audit logging or telemetry
 * across all account flows.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { DELETE_CONFIRMATION_PHRASE } from '@/types/account';
import {
  isValidEmail,
  passwordResetCooldownRemainingSec,
} from './constants';
import {
  deleteAccount,
  exportAccountData,
  fetchMonthlySpend,
  performSignOut,
  requestEmailChange,
  requestPasswordReset,
  updateDisplayName,
} from './account-io';

/** Public surface returned by {@link useAccount}. */
export interface UseAccountResult {
  // Loaded data
  monthlySpend: number;
  isLoadingSpend: boolean;

  // Display name editing
  isEditingDisplayName: boolean;
  displayNameDraft: string;
  isSavingDisplayName: boolean;
  setDisplayNameDraft: (next: string) => void;
  beginEditDisplayName: () => void;
  cancelEditDisplayName: () => void;
  saveDisplayName: () => Promise<void>;

  // Email change
  isEmailModalVisible: boolean;
  newEmailDraft: string;
  isChangingEmail: boolean;
  setNewEmailDraft: (next: string) => void;
  openEmailModal: () => void;
  closeEmailModal: () => void;
  changeEmail: (currentEmail: string | undefined) => Promise<void>;

  // Password reset
  isSendingPasswordReset: boolean;
  sendPasswordReset: (currentEmail: string | undefined) => Promise<void>;

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

/** Hook arguments — minimal so the hook stays decoupled from useCurrentUser. */
export interface UseAccountArgs {
  /** Current user id (null while still loading) */
  userId: string | null;
  /** Current display name from profiles.display_name (null when unset in auth) */
  userDisplayName: string | null | undefined;
  /** Refresh the cached user after a profile update succeeds */
  refreshUser: () => Promise<void> | void;
  // WHY no userEmail: per-call email is passed in by the orchestrator
  // (changeEmail / sendPasswordReset accept their own `currentEmail` args
  // for clarity), so threading it as a hook-construction arg was redundant.
  // Removed in PR follow-up to the batch-2 reviewer's #4 finding.
}

/**
 * Account hook. See {@link UseAccountResult} for the returned API.
 */
export function useAccount(args: UseAccountArgs): UseAccountResult {
  const { userId, userDisplayName, refreshUser } = args;

  // --- Loaded data ----------------------------------------------------------
  const [monthlySpend, setMonthlySpend] = useState<number>(0);
  const [isLoadingSpend, setIsLoadingSpend] = useState(true);

  // --- Display name editing -------------------------------------------------
  const [isEditingDisplayName, setIsEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [isSavingDisplayName, setIsSavingDisplayName] = useState(false);

  // --- Email change ---------------------------------------------------------
  const [isEmailModalVisible, setIsEmailModalVisible] = useState(false);
  const [newEmailDraft, setNewEmailDraft] = useState('');
  const [isChangingEmail, setIsChangingEmail] = useState(false);

  // --- Password reset -------------------------------------------------------
  // WHY tracked: prevents accidental spam by enforcing 60-second cooldown.
  const [lastPasswordResetAt, setLastPasswordResetAt] = useState<number | null>(null);
  const [isSendingPasswordReset, setIsSendingPasswordReset] = useState(false);

  // --- Data export ----------------------------------------------------------
  const [isExportingData, setIsExportingData] = useState(false);

  // --- Sign out / delete ----------------------------------------------------
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  // WHY: Alert.prompt is iOS-only. On Android we show a custom modal.
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // --------------------------------------------------------------------------
  // Mount: load monthly spend
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!userId) return;
    setIsLoadingSpend(true);
    void (async () => {
      const total = await fetchMonthlySpend(userId);
      setMonthlySpend(total);
      setIsLoadingSpend(false);
    })();
  }, [userId]);

  // --------------------------------------------------------------------------
  // Display name handlers
  // --------------------------------------------------------------------------
  const beginEditDisplayName = useCallback(() => {
    setDisplayNameDraft(userDisplayName ?? '');
    setIsEditingDisplayName(true);
  }, [userDisplayName]);

  const cancelEditDisplayName = useCallback(() => {
    setIsEditingDisplayName(false);
    setDisplayNameDraft('');
  }, []);

  const saveDisplayName = useCallback(async () => {
    const trimmed = displayNameDraft.trim();
    if (!trimmed || !userId) return;

    setIsEditingDisplayName(false);
    setIsSavingDisplayName(true);

    const result = await updateDisplayName(userId, trimmed);
    if (!result.ok) {
      Alert.alert('Error', result.message);
    } else {
      await refreshUser();
    }
    setIsSavingDisplayName(false);
    setDisplayNameDraft('');
  }, [displayNameDraft, userId, refreshUser]);

  // --------------------------------------------------------------------------
  // Email change
  // --------------------------------------------------------------------------
  const openEmailModal = useCallback(() => {
    setNewEmailDraft('');
    setIsEmailModalVisible(true);
  }, []);

  const closeEmailModal = useCallback(() => {
    setIsEmailModalVisible(false);
  }, []);

  const changeEmail = useCallback(async (currentEmail: string | undefined) => {
    const trimmed = newEmailDraft.trim().toLowerCase();

    if (!isValidEmail(trimmed)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }
    if (trimmed === currentEmail) {
      Alert.alert('Same Email', 'The new email address is the same as your current one.');
      return;
    }

    setIsChangingEmail(true);
    const result = await requestEmailChange(trimmed);
    setIsChangingEmail(false);

    if (!result.ok) {
      Alert.alert('Email Change Failed', result.message);
      return;
    }

    setNewEmailDraft('');
    setIsEmailModalVisible(false);
    Alert.alert(
      'Verification Email Sent',
      `A verification email has been sent to ${trimmed}. Click the link in the email to confirm the change.`,
    );
  }, [newEmailDraft]);

  // --------------------------------------------------------------------------
  // Password reset
  // --------------------------------------------------------------------------
  const sendPasswordReset = useCallback(async (currentEmail: string | undefined) => {
    if (!currentEmail) {
      Alert.alert('Error', 'No email address on file.');
      return;
    }

    const remaining = passwordResetCooldownRemainingSec(lastPasswordResetAt);
    if (remaining > 0) {
      Alert.alert('Please Wait', `You can request another reset email in ${remaining} seconds.`);
      return;
    }

    setIsSendingPasswordReset(true);
    const result = await requestPasswordReset(currentEmail);
    setIsSendingPasswordReset(false);

    if (!result.ok) {
      Alert.alert('Error', result.message);
      return;
    }

    setLastPasswordResetAt(Date.now());
    Alert.alert(
      'Reset Email Sent',
      `A password reset link has been sent to ${currentEmail}. Check your inbox.`,
    );
  }, [lastPasswordResetAt]);

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
    monthlySpend,
    isLoadingSpend,

    isEditingDisplayName,
    displayNameDraft,
    isSavingDisplayName,
    setDisplayNameDraft,
    beginEditDisplayName,
    cancelEditDisplayName,
    saveDisplayName,

    isEmailModalVisible,
    newEmailDraft,
    isChangingEmail,
    setNewEmailDraft,
    openEmailModal,
    closeEmailModal,
    changeEmail,

    isSendingPasswordReset,
    sendPasswordReset,

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
