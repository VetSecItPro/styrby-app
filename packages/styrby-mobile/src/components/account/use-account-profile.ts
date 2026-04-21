/**
 * Account Profile hook — `useAccountProfile`
 *
 * Manages profile state and I/O for the Account sub-screen: loading the
 * monthly spend summary, editing the display name, changing the email
 * address, and requesting a password reset.
 *
 * All side-effectful network/storage calls are delegated to `account-io.ts`;
 * this hook translates results into Alert copy and local loading state.
 *
 * WHY separate from use-account-danger: profile operations are low-risk and
 * reversible. Danger-zone operations (delete, sign-out, data export) carry
 * irreversible consequences and need a different confirmation surface.
 * Splitting them keeps each hook below 300 LOC and testable in isolation.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { isValidEmail, passwordResetCooldownRemainingSec } from './constants';
import {
  fetchMonthlySpend,
  requestEmailChange,
  requestPasswordReset,
  updateDisplayName,
} from './account-io';

/** Arguments for {@link useAccountProfile}. */
export interface UseAccountProfileArgs {
  /** Current user id (null while still loading). */
  userId: string | null;
  /** Current display name from profiles.display_name (null when unset). */
  userDisplayName: string | null | undefined;
  /** Refresh the cached user after a profile update succeeds. */
  refreshUser: () => Promise<void> | void;
}

/** State and handlers returned by {@link useAccountProfile}. */
export interface UseAccountProfileResult {
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
}

/**
 * Manages profile state and I/O: monthly spend, display name, email change,
 * and password reset. See {@link UseAccountProfileResult} for the full API.
 *
 * @param args - User identity and refresh callback.
 * @returns Profile state and handler functions.
 */
export function useAccountProfile(args: UseAccountProfileArgs): UseAccountProfileResult {
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
  };
}
