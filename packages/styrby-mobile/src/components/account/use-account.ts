/**
 * Account Settings — `useAccount` compositor hook
 *
 * Thin compositor that delegates to two focused sub-hooks:
 * - `useAccountProfile` — profile I/O (monthly spend, display name, email, password reset)
 * - `useAccountDanger`  — danger-zone I/O (sign out, data export, account deletion)
 *
 * The combined return value preserves the identical public surface that
 * callers depend on, so no call-site changes are required.
 *
 * WHY compositor pattern: splitting concerns keeps each sub-hook under 300
 * LOC and independently testable, while this file stays trivially small.
 * Callers import `useAccount` and `UseAccountResult` exactly as before.
 */

import { useAccountDanger } from './use-account-danger';
import { useAccountProfile } from './use-account-profile';

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
 * Composes profile and danger-zone sub-hooks into a single unified result.
 *
 * @param args - User identity and refresh callback.
 * @returns Combined {@link UseAccountResult} — identical public API to the
 *   pre-split monolith; no callers need to change.
 */
export function useAccount(args: UseAccountArgs): UseAccountResult {
  const profile = useAccountProfile(args);
  const danger = useAccountDanger({ userId: args.userId });

  return {
    ...profile,
    ...danger,
  };
}
