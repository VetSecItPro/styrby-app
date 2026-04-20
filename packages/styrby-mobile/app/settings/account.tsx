/**
 * Account Settings Sub-Screen
 *
 * Owns: display name inline edit, email change (inline form), password reset,
 * data export (GDPR Art. 20), subscription row, usage & costs row, sign out,
 * account deletion (iOS Alert.prompt + Android custom modal paths).
 *
 * WHY a sub-screen: the Account section was the most complex block in the
 * 2,720-LOC settings monolith — 12 state variables, 4 async flows, 2 modals,
 * and 2 account-deletion paths (iOS/Android). Extraction gives it dedicated
 * scroll space and eliminates the modal-within-scroll complexity.
 *
 * Security notes:
 * - Account deletion calls the web app's DELETE /api/account/delete endpoint
 *   which uses the Supabase admin client (service role key). The mobile app
 *   never has the service role key. (SOC2 CC6.2, CC6.6)
 * - Data export calls POST /api/account/export — server-side rate-limited.
 *   (GDPR Art. 20)
 * - Email change uses Supabase's built-in verification email flow. The new
 *   email is not applied until the user clicks the verification link.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 1
 */

import {
  View,
  Text,
  TextInput,
  Pressable,
  Switch,
  ScrollView,
  Alert,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Linking,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { supabase, signOut } from '../../src/lib/supabase';
import { clearPairingInfo } from '../../src/services/pairing';
import { useCurrentUser } from '../../src/hooks/useCurrentUser';
import { useSubscriptionTier } from '../../src/hooks/useSubscriptionTier';
import { SectionHeader, SettingRow } from '../../src/components/ui';
import { getApiBaseUrl } from '../../src/lib/config';
import {
  canShowUpgradePrompt,
  POLAR_CUSTOMER_PORTAL_URL,
} from '../../src/lib/platform-billing';

// ============================================================================
// Constants
// ============================================================================

/**
 * SecureStore key for the haptic feedback preference.
 * WHY here: account deletion clears this key as part of local data cleanup.
 */
const HAPTIC_PREFERENCE_KEY = 'styrby_haptic_enabled';

/**
 * Client-side cooldown (ms) between password reset email requests.
 * WHY: Supabase also rate-limits server-side, but the client guard gives
 * immediate feedback without a network round trip. Prevents accidental
 * double-taps from sending multiple emails.
 */
const PASSWORD_RESET_COOLDOWN_MS = 60_000;

// ============================================================================
// Component
// ============================================================================

/**
 * Account sub-screen.
 *
 * @returns React element
 */
export default function AccountScreen() {
  const router = useRouter();
  const { user, isLoading: isLoadingUser, refresh: refreshUser } = useCurrentUser();
  const { tier, isLoading: isLoadingTier } = useSubscriptionTier(user?.id ?? null);

  // --------------------------------------------------------------------------
  // Loading state
  // --------------------------------------------------------------------------

  /** Monthly spend loaded from cost_records */
  const [monthlySpend, setMonthlySpend] = useState<number>(0);
  const [isLoadingSpend, setIsLoadingSpend] = useState(true);

  // --------------------------------------------------------------------------
  // Display name editing state
  // --------------------------------------------------------------------------

  /** Whether the display name edit mode is active */
  const [isEditingDisplayName, setIsEditingDisplayName] = useState(false);
  /** Draft display name while editing */
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  /** Whether the display name save is in progress */
  const [isSavingDisplayName, setIsSavingDisplayName] = useState(false);

  // --------------------------------------------------------------------------
  // Email change state
  // --------------------------------------------------------------------------

  /** Whether the email change modal is visible */
  const [isEmailModalVisible, setIsEmailModalVisible] = useState(false);
  /** New email address typed in the modal */
  const [newEmailDraft, setNewEmailDraft] = useState('');
  /** Whether the email change API call is in progress */
  const [isChangingEmail, setIsChangingEmail] = useState(false);

  // --------------------------------------------------------------------------
  // Password reset state
  // --------------------------------------------------------------------------

  /**
   * Unix timestamp (ms) of the last password reset email sent.
   * WHY tracked: prevents accidental spam by enforcing 60-second cooldown.
   */
  const [lastPasswordResetAt, setLastPasswordResetAt] = useState<number | null>(null);
  /** Whether the password reset email is being sent */
  const [isSendingPasswordReset, setIsSendingPasswordReset] = useState(false);

  // --------------------------------------------------------------------------
  // Data export state
  // --------------------------------------------------------------------------

  /** Whether the data export is in progress */
  const [isExportingData, setIsExportingData] = useState(false);

  // --------------------------------------------------------------------------
  // Sign out / delete state
  // --------------------------------------------------------------------------

  /** Whether sign out is in progress */
  const [isSigningOut, setIsSigningOut] = useState(false);
  /** Whether account deletion is in progress */
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  /**
   * Whether the Android typed-deletion modal is visible.
   * WHY: Alert.prompt is iOS-only. On Android we show a custom modal.
   */
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  /** The text the user has typed into the Android deletion confirmation input */
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // --------------------------------------------------------------------------
  // Mount: Load monthly spend
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!user) return;

    (async () => {
      setIsLoadingSpend(true);
      try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const { data, error } = await supabase
          .from('cost_records')
          .select('cost_usd')
          .eq('user_id', user.id)
          .gte('created_at', monthStart);

        if (!error && data) {
          const total = data.reduce(
            (sum: number, record: { cost_usd: number }) => sum + (record.cost_usd ?? 0),
            0,
          );
          setMonthlySpend(total);
        }
      } catch {
        // Non-fatal: show $0.00
      } finally {
        setIsLoadingSpend(false);
      }
    })();
  }, [user]);

  // --------------------------------------------------------------------------
  // Display Name Handlers
  // --------------------------------------------------------------------------

  /**
   * Begins inline display name editing, prefilling the current name.
   */
  const handleBeginEditDisplayName = useCallback(() => {
    setDisplayNameDraft(user?.displayName ?? '');
    setIsEditingDisplayName(true);
  }, [user?.displayName]);

  /**
   * Cancels display name editing without saving.
   */
  const handleCancelEditDisplayName = useCallback(() => {
    setIsEditingDisplayName(false);
    setDisplayNameDraft('');
  }, []);

  /**
   * Saves the edited display name to the profiles table via Supabase.
   * Uses an optimistic update: updates local state immediately, reverts on error.
   *
   * WHY profiles.display_name: the profiles table is the canonical source for
   * display_name in Styrby. user_metadata is an auth-level field managed by
   * Supabase — writing to profiles is cleaner for our data model.
   */
  const handleSaveDisplayName = useCallback(async () => {
    const trimmed = displayNameDraft.trim();
    if (!trimmed || !user) return;

    setIsEditingDisplayName(false);
    setIsSavingDisplayName(true);

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ display_name: trimmed })
        .eq('id', user.id);

      if (error) {
        Alert.alert('Error', 'Failed to save display name. Please try again.');
        if (__DEV__) {
          console.error('[Account] Failed to save display name:', error);
        }
      } else {
        // Refresh user to pick up new display name from auth cache
        await refreshUser();
      }
    } catch {
      Alert.alert('Error', 'An unexpected error occurred. Please try again.');
    } finally {
      setIsSavingDisplayName(false);
      setDisplayNameDraft('');
    }
  }, [displayNameDraft, user, refreshUser]);

  // --------------------------------------------------------------------------
  // Email Change Handler
  // --------------------------------------------------------------------------

  /**
   * Submits an email change request via Supabase auth.
   * Sends a verification email to the new address; change is not applied
   * until the user clicks the verification link.
   *
   * WHY verification flow: Supabase's built-in email change flow requires
   * the user to verify the new address before it takes effect. This is the
   * correct security model for email changes per OWASP A07.
   */
  const handleChangeEmail = useCallback(async () => {
    const trimmed = newEmailDraft.trim().toLowerCase();

    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }

    if (trimmed === user?.email) {
      Alert.alert('Same Email', 'The new email address is the same as your current one.');
      return;
    }

    setIsChangingEmail(true);

    try {
      const { error } = await supabase.auth.updateUser({ email: trimmed });

      if (error) {
        // WHY: Supabase returns a descriptive error for already-registered emails.
        const message = error.message.includes('already registered')
          ? 'This email address is already in use by another account.'
          : error.message;
        Alert.alert('Email Change Failed', message);
      } else {
        setNewEmailDraft('');
        setIsEmailModalVisible(false);
        Alert.alert(
          'Verification Email Sent',
          `A verification email has been sent to ${trimmed}. Click the link in the email to confirm the change.`,
        );
      }
    } catch (err) {
      Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      if (__DEV__) {
        console.error('[Account] Email change error:', err);
      }
    } finally {
      setIsChangingEmail(false);
    }
  }, [newEmailDraft, user?.email]);

  // --------------------------------------------------------------------------
  // Password Reset Handler
  // --------------------------------------------------------------------------

  /**
   * Sends a password reset email to the user's current email address.
   * Enforces a 60-second client-side cooldown between requests.
   */
  const handlePasswordReset = useCallback(async () => {
    if (!user?.email) {
      Alert.alert('Error', 'No email address on file.');
      return;
    }

    if (lastPasswordResetAt !== null) {
      const elapsed = Date.now() - lastPasswordResetAt;
      if (elapsed < PASSWORD_RESET_COOLDOWN_MS) {
        const remaining = Math.ceil((PASSWORD_RESET_COOLDOWN_MS - elapsed) / 1000);
        Alert.alert('Please Wait', `You can request another reset email in ${remaining} seconds.`);
        return;
      }
    }

    setIsSendingPasswordReset(true);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(user.email);

      if (error) {
        Alert.alert('Error', error.message);
      } else {
        setLastPasswordResetAt(Date.now());
        Alert.alert(
          'Reset Email Sent',
          `A password reset link has been sent to ${user.email}. Check your inbox.`,
        );
      }
    } catch (err) {
      Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      if (__DEV__) {
        console.error('[Account] Password reset error:', err);
      }
    } finally {
      setIsSendingPasswordReset(false);
    }
  }, [user?.email, lastPasswordResetAt]);

  // --------------------------------------------------------------------------
  // Data Export Handler
  // --------------------------------------------------------------------------

  /**
   * Exports all user data (GDPR Art. 20) via the web app's export endpoint
   * and copies the JSON to clipboard.
   *
   * WHY web API: the export endpoint uses the Supabase service role to query
   * 20 tables, write an audit log entry, and enforce hourly rate limits.
   * Reusing the server-side endpoint avoids duplicating this logic on mobile.
   */
  const handleExportData = useCallback(async () => {
    if (!user) return;

    setIsExportingData(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        Alert.alert('Error', 'You must be signed in to export your data.');
        setIsExportingData(false);
        return;
      }

      const response = await fetch(`${getApiBaseUrl()}/api/account/export`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 429) {
          Alert.alert('Rate Limited', 'You can only export your data once per hour. Please try again later.');
        } else {
          Alert.alert('Export Failed', 'Failed to export your data. Please try again.');
        }
        return;
      }

      const exportJson = await response.text();
      await Clipboard.setStringAsync(exportJson);

      Alert.alert(
        'Data Export Ready',
        'Your data has been copied to the clipboard. Paste it into a text editor to save the JSON file.',
        [{ text: 'OK' }],
      );
    } catch (err) {
      Alert.alert('Export Failed', 'Failed to export your data. Please check your connection and try again.');
      if (__DEV__) {
        console.error('[Account] Data export error:', err);
      }
    } finally {
      setIsExportingData(false);
    }
  }, [user]);

  // --------------------------------------------------------------------------
  // Sign Out Handler
  // --------------------------------------------------------------------------

  /**
   * Shows a confirmation alert and, on confirm, executes the full sign-out
   * flow: clear pairing info, clear local SecureStore data, Supabase signOut.
   *
   * WHY clear pairing first: if signOut fails partway through, no orphan
   * pairing data remains to confuse the relay hook in _layout.
   */
  const handleSignOut = useCallback(() => {
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
            try {
              await clearPairingInfo();
              await SecureStore.deleteItemAsync(HAPTIC_PREFERENCE_KEY);
              const { error } = await signOut();

              if (error) {
                Alert.alert('Sign Out Failed', error.message);
                setIsSigningOut(false);
              }
              // On success: root layout auth listener redirects to login
            } catch (error) {
              const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
              Alert.alert('Sign Out Failed', message);
              setIsSigningOut(false);
            }
          },
        },
      ],
    );
  }, []);

  // --------------------------------------------------------------------------
  // Account Deletion Handlers
  // --------------------------------------------------------------------------

  /**
   * Executes account deletion by calling the web API endpoint.
   * Called from both the iOS Alert.prompt path and the Android modal path.
   *
   * WHY web API: the delete endpoint uses the Supabase admin client to ban
   * the user in auth.users. Mobile apps must never contain the service role
   * key. (SOC2 CC6.2, CC6.6)
   */
  const executeAccountDeletion = useCallback(async () => {
    setIsDeletingAccount(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        Alert.alert('Error', 'You must be signed in to delete your account.');
        setIsDeletingAccount(false);
        return;
      }

      const response = await fetch(`${getApiBaseUrl()}/api/account/delete`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        const errorMessage = typeof errorData.error === 'string'
          ? errorData.error
          : 'Failed to delete account. Please try again.';

        if (response.status === 429) {
          Alert.alert(
            'Rate Limited',
            'You can only attempt account deletion once per day. Please try again later.',
          );
        } else {
          Alert.alert('Deletion Failed', errorMessage);
        }

        setIsDeletingAccount(false);
        return;
      }

      // Success: clear local data and sign out
      await clearPairingInfo();
      await SecureStore.deleteItemAsync(HAPTIC_PREFERENCE_KEY);
      await signOut();
      // Root layout auth listener redirects to login on signOut
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'An unexpected error occurred. Please try again.';
      Alert.alert('Deletion Failed', message);
      setIsDeletingAccount(false);
    }
  }, []);

  /**
   * Initiates the account deletion flow with a two-step confirmation.
   *
   * Step 1: Alert explaining what will be deleted.
   * Step 2: Platform-specific typed confirmation.
   *   - iOS: Alert.prompt (native input dialog)
   *   - Android: custom Modal with TextInput (Alert.prompt is iOS-only)
   *
   * WHY two-step: account deletion is irreversible after the 30-day grace
   * period. Requiring a typed confirmation prevents accidental deletions and
   * satisfies GDPR Art. 17 requirements for explicit user consent.
   */
  const handleDeleteAccount = useCallback(() => {
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
                'Type "DELETE MY ACCOUNT" to confirm.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: (input?: string) => {
                      if (input?.trim() === 'DELETE MY ACCOUNT') {
                        void executeAccountDeletion();
                      } else {
                        Alert.alert(
                          'Confirmation Failed',
                          'You must type "DELETE MY ACCOUNT" exactly to proceed.',
                        );
                      }
                    },
                  },
                ],
                'plain-text',
              );
            } else {
              // WHY custom modal: Alert.prompt is iOS-only (React Native limitation).
              // On Android we render a TextInput inside a Modal so the user must
              // still type the exact phrase — same security bar as iOS.
              setDeleteConfirmText('');
              setShowDeleteModal(true);
            }
          },
        },
      ],
    );
  }, [executeAccountDeletion]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (isLoadingUser) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="small" color="#f97316" accessibilityLabel="Loading account data" />
      </View>
    );
  }

  return (
    <>
      <ScrollView className="flex-1 bg-background">
        {/* Profile */}
        <SectionHeader title="Profile" />
        <View className="bg-background-secondary">
          {/* Display Name inline editing */}
          {isEditingDisplayName ? (
            <View className="flex-row items-center px-4 py-3">
              <View
                className="w-8 h-8 rounded-lg items-center justify-center mr-3"
                style={{ backgroundColor: '#f9731620' }}
              >
                <Ionicons name="person" size={18} color="#f97316" />
              </View>
              <TextInput
                className="flex-1 text-white bg-zinc-800 rounded-lg px-3 py-2 text-base mr-2"
                value={displayNameDraft}
                onChangeText={setDisplayNameDraft}
                placeholder="Display name"
                placeholderTextColor="#71717a"
                autoFocus
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={() => void handleSaveDisplayName()}
                accessibilityLabel="Display name input"
              />
              <Pressable
                onPress={() => void handleSaveDisplayName()}
                disabled={isSavingDisplayName || !displayNameDraft.trim()}
                className="p-2"
                accessibilityRole="button"
                accessibilityLabel="Save display name"
              >
                {isSavingDisplayName ? (
                  <ActivityIndicator size="small" color="#22c55e" />
                ) : (
                  <Ionicons name="checkmark" size={22} color="#22c55e" />
                )}
              </Pressable>
              <Pressable
                onPress={handleCancelEditDisplayName}
                className="p-2 ml-1"
                accessibilityRole="button"
                accessibilityLabel="Cancel display name edit"
              >
                <Ionicons name="close" size={22} color="#71717a" />
              </Pressable>
            </View>
          ) : (
            <SettingRow
              icon="person"
              iconColor="#f97316"
              title={user?.displayName ?? 'Set Display Name'}
              subtitle="Tap edit to change your name"
              trailing={
                <Pressable
                  onPress={handleBeginEditDisplayName}
                  className="p-1"
                  accessibilityRole="button"
                  accessibilityLabel="Edit display name"
                >
                  <Ionicons name="pencil" size={18} color="#71717a" />
                </Pressable>
              }
            />
          )}

          <SettingRow
            icon="mail"
            iconColor="#3b82f6"
            title="Change Email"
            subtitle={user?.email ?? 'Not signed in'}
            onPress={() => {
              setNewEmailDraft('');
              setIsEmailModalVisible(true);
            }}
          />

          <SettingRow
            icon="key"
            iconColor="#eab308"
            title="Reset Password"
            subtitle="Send reset link to your email"
            onPress={() => void handlePasswordReset()}
            trailing={
              isSendingPasswordReset ? (
                <ActivityIndicator size="small" color="#eab308" />
              ) : undefined
            }
          />
        </View>

        {/* Data */}
        <SectionHeader title="Data" />
        <View className="bg-background-secondary">
          <SettingRow
            icon="download"
            iconColor="#22c55e"
            title="Export My Data"
            subtitle="Download all your data (GDPR Art. 20)"
            onPress={() => void handleExportData()}
            trailing={
              isExportingData ? (
                <ActivityIndicator size="small" color="#22c55e" />
              ) : undefined
            }
          />
        </View>

        {/* Billing */}
        <SectionHeader title="Billing" />
        <View className="bg-background-secondary">
          {/* WHY iOS conditional: Apple §3.1.3(a) prohibits linking to external
              payment flows from within the app. Android shows the upgrade link;
              iOS shows the subscription row as read-only. */}
          <SettingRow
            icon="card"
            iconColor="#22c55e"
            title="Subscription"
            subtitle={isLoadingTier ? 'Loading...' : `${tier.charAt(0).toUpperCase() + tier.slice(1)} Plan`}
            onPress={canShowUpgradePrompt()
              ? () => Linking.openURL(POLAR_CUSTOMER_PORTAL_URL)
              : undefined}
          />
          <SettingRow
            icon="stats-chart"
            iconColor="#3b82f6"
            title="Usage & Costs"
            subtitle={isLoadingSpend ? 'Loading...' : `$${monthlySpend.toFixed(2)} this month`}
            onPress={() => router.push('/(tabs)/costs')}
          />
        </View>

        {/* Sign Out & Delete */}
        <View className="mt-4 mb-8 gap-3">
          <Pressable
            className="mx-4 py-3 rounded-xl border border-red-500/30 items-center active:bg-red-500/10"
            onPress={handleSignOut}
            disabled={isSigningOut || isDeletingAccount}
            accessibilityRole="button"
            accessibilityLabel="Sign out of your account"
          >
            {isSigningOut ? (
              <ActivityIndicator size="small" color="#ef4444" />
            ) : (
              <Text className="text-red-500 font-semibold">Sign Out</Text>
            )}
          </Pressable>

          {/* WHY separate button: delete is visually distinct from sign out to
              signal higher severity. Red border + red text = destructive action. */}
          <Pressable
            className="mx-4 py-3 rounded-xl border border-red-500/50 items-center active:bg-red-500/10"
            onPress={handleDeleteAccount}
            disabled={isDeletingAccount || isSigningOut}
            accessibilityRole="button"
            accessibilityLabel="Delete your account permanently"
          >
            {isDeletingAccount ? (
              <ActivityIndicator size="small" color="#ef4444" />
            ) : (
              <Text className="text-red-500 font-semibold">Delete Account</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>

      {/* Change Email Modal */}
      <Modal
        visible={isEmailModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setIsEmailModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          className="flex-1 justify-end"
        >
          <Pressable
            className="flex-1"
            onPress={() => setIsEmailModalVisible(false)}
            accessibilityLabel="Close email change modal"
          />
          <View className="bg-zinc-900 rounded-t-3xl px-6 pt-6 pb-10 border-t border-zinc-800">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-white text-lg font-semibold">Change Email</Text>
              <Pressable
                onPress={() => setIsEmailModalVisible(false)}
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
              <Text className="text-zinc-300 text-sm">{user?.email}</Text>
            </View>

            <TextInput
              className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-base mb-4"
              placeholder="New email address"
              placeholderTextColor="#71717a"
              value={newEmailDraft}
              onChangeText={setNewEmailDraft}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => void handleChangeEmail()}
              accessibilityLabel="New email address input"
            />

            <Pressable
              onPress={() => void handleChangeEmail()}
              disabled={isChangingEmail || !newEmailDraft.trim()}
              className={`py-3 rounded-xl items-center ${
                isChangingEmail || !newEmailDraft.trim()
                  ? 'bg-zinc-700'
                  : 'bg-brand active:opacity-80'
              }`}
              accessibilityRole="button"
              accessibilityLabel="Submit email change"
            >
              {isChangingEmail ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text className="text-white font-semibold">Send Verification Email</Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Android Account Deletion Confirmation Modal.
          WHY: Alert.prompt is iOS-only. This modal provides a TextInput so
          Android users also must type "DELETE MY ACCOUNT" — same security bar. */}
      {Platform.OS !== 'ios' && (
        <Modal
          visible={showDeleteModal}
          animationType="slide"
          transparent
          onRequestClose={() => setShowDeleteModal(false)}
        >
          <KeyboardAvoidingView
            behavior="height"
            className="flex-1 justify-end"
          >
            <Pressable
              className="flex-1"
              onPress={() => setShowDeleteModal(false)}
              accessibilityLabel="Close deletion confirmation"
            />
            <View className="bg-zinc-900 rounded-t-3xl px-6 pt-6 pb-10 border-t border-zinc-800">
              <View className="flex-row items-center justify-between mb-4">
                <Text className="text-white text-lg font-semibold">Confirm Deletion</Text>
                <Pressable
                  onPress={() => setShowDeleteModal(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel account deletion"
                >
                  <Ionicons name="close" size={24} color="#71717a" />
                </Pressable>
              </View>

              <Text className="text-zinc-400 text-sm mb-4">
                Type <Text className="text-white font-mono font-semibold">DELETE MY ACCOUNT</Text> to permanently delete your account.
              </Text>

              <TextInput
                className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-base mb-4"
                placeholder="DELETE MY ACCOUNT"
                placeholderTextColor="#71717a"
                value={deleteConfirmText}
                onChangeText={setDeleteConfirmText}
                autoCapitalize="characters"
                autoCorrect={false}
                accessibilityLabel="Type DELETE MY ACCOUNT to confirm"
              />

              <Pressable
                className={`py-3 rounded-xl items-center ${
                  deleteConfirmText === 'DELETE MY ACCOUNT'
                    ? 'bg-red-600 active:bg-red-700'
                    : 'bg-zinc-700 opacity-50'
                }`}
                disabled={deleteConfirmText !== 'DELETE MY ACCOUNT' || isDeletingAccount}
                onPress={() => {
                  setShowDeleteModal(false);
                  void executeAccountDeletion();
                }}
                accessibilityRole="button"
                accessibilityLabel="Confirm permanent account deletion"
              >
                {isDeletingAccount ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Text className="text-white font-semibold">Delete My Account</Text>
                )}
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}
    </>
  );
}
