/**
 * Settings Screen
 *
 * User preferences, account settings, and app configuration.
 * Loads the authenticated user on mount, persists preferences to Supabase
 * (notification_preferences) and SecureStore (local-only settings like haptic
 * feedback), and implements the sign-out flow.
 */

import {
  View,
  Text,
  ScrollView,
  Pressable,
  Switch,
  Alert,
  ActivityIndicator,
  Linking,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { supabase, signOut } from '../../src/lib/supabase';
import { clearPairingInfo } from '../../src/services/pairing';
import { THEME_PREFERENCE_KEY } from '../../src/contexts/ThemeContext';

// ============================================================================
// Constants
// ============================================================================

/**
 * SecureStore key for the haptic feedback preference.
 * WHY: Haptic feedback is a device-local preference that does not need to sync
 * across devices, so we store it in SecureStore rather than the database.
 */
const HAPTIC_PREFERENCE_KEY = 'styrby_haptic_enabled';

/**
 * App version string derived from expo-constants.
 * WHY: We read this once at module scope because the version never changes
 * at runtime and avoids unnecessary re-reads inside the component render.
 */
const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0';

/**
 * iOS build number from expo-constants, used in the version footer.
 */
const BUILD_NUMBER = Constants.expoConfig?.ios?.buildNumber ?? '1';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents the subset of notification_preferences columns that this screen
 * reads and writes. Matches the Supabase table schema.
 */
interface NotificationPreferences {
  /** Primary key */
  id: string;
  /** Foreign key to profiles */
  user_id: string;
  /** Master push notification toggle */
  push_enabled: boolean;
  /** Whether email notifications are enabled */
  email_enabled: boolean;
  /** Whether quiet hours are active */
  quiet_hours_enabled: boolean;
  /** Quiet hours start time (HH:MM:SS format) */
  quiet_hours_start: string | null;
  /** Quiet hours end time (HH:MM:SS format) */
  quiet_hours_end: string | null;
  /** Priority threshold for smart notifications (1-5, default 3) */
  priority_threshold: number;
}

/**
 * Authenticated user data loaded on mount.
 */
interface UserInfo {
  /** Supabase user ID */
  id: string;
  /** User's email address */
  email: string;
  /** Display name from user_metadata, if available */
  displayName: string | null;
  /** First letter of the display name or email for the avatar */
  initial: string;
}

// ============================================================================
// Sub-Components
// ============================================================================

interface SettingRowProps {
  /** Ionicons icon name */
  icon: keyof typeof Ionicons.glyphMap;
  /** Background tint color for the icon badge */
  iconColor?: string;
  /** Primary label text */
  title: string;
  /** Secondary description text */
  subtitle?: string;
  /** Press handler — row shows a chevron when provided (without trailing) */
  onPress?: () => void;
  /** Custom trailing element (e.g. a Switch) */
  trailing?: React.ReactNode;
}

/**
 * A single settings row with an icon, title, optional subtitle, and
 * either a trailing element or a chevron indicator.
 *
 * @param props - Row configuration
 * @returns React element
 */
function SettingRow({
  icon,
  iconColor = '#71717a',
  title,
  subtitle,
  onPress,
  trailing,
}: SettingRowProps) {
  return (
    <Pressable
      className="flex-row items-center px-4 py-3 active:bg-zinc-900"
      onPress={onPress}
      disabled={!onPress && !trailing}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
    >
      <View
        className="w-8 h-8 rounded-lg items-center justify-center mr-3"
        style={{ backgroundColor: `${iconColor}20` }}
      >
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View className="flex-1">
        <Text className="text-white font-medium">{title}</Text>
        {subtitle && <Text className="text-zinc-500 text-sm">{subtitle}</Text>}
      </View>
      {trailing ? <>{trailing}</> : onPress ? <Ionicons name="chevron-forward" size={20} color="#71717a" /> : null}
    </Pressable>
  );
}

/**
 * Section header label for grouping related settings.
 *
 * @param props - Contains the section title string
 * @returns React element
 */
function SectionHeader({ title }: { title: string }) {
  return (
    <Text className="text-zinc-500 text-xs font-semibold uppercase px-4 py-2 bg-background">
      {title}
    </Text>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Polar customer portal URL for subscription management.
 * WHY: Polar is our merchant of record. Users manage billing, plan changes,
 * and cancellations through the Polar customer portal.
 */
const POLAR_CUSTOMER_PORTAL_URL = 'https://polar.sh/styrby/portal';

/** External URLs for support and legal pages */
const HELP_URL = 'https://styrbyapp.com/help';
const PRIVACY_URL = 'https://styrbyapp.com/privacy';
const TERMS_URL = 'https://styrbyapp.com/terms';

/**
 * Formats a time string from HH:MM:SS database format to human-readable
 * 12-hour format (e.g., "10:00 PM").
 *
 * @param time - Time string in HH:MM:SS format, or null
 * @returns Human-readable time string, or the fallback if null
 */
function formatTime(time: string | null, fallback: string): string {
  if (!time) return fallback;
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
}

/**
 * Extracts user display information from Supabase auth user metadata.
 *
 * WHY: Supabase stores display_name in user_metadata but the field name can
 * vary depending on the auth provider (full_name for GitHub, display_name for
 * email). We check both and fall back gracefully.
 *
 * @param user - The Supabase auth user object
 * @returns Normalized UserInfo with email, display name, and initial
 */
function extractUserInfo(user: { id: string; email?: string; user_metadata?: Record<string, unknown> }): UserInfo {
  const email = user.email ?? 'unknown';
  const metadata = user.user_metadata ?? {};

  // Check common metadata fields for display name
  const displayName =
    (metadata.display_name as string | undefined) ??
    (metadata.full_name as string | undefined) ??
    (metadata.name as string | undefined) ??
    null;

  // Derive initial from display name or email
  const initial = displayName
    ? displayName.charAt(0).toUpperCase()
    : email.charAt(0).toUpperCase();

  return { id: user.id, email, displayName, initial };
}

// ============================================================================
// Screen Component
// ============================================================================

/**
 * Settings screen component.
 *
 * On mount:
 * 1. Fetches the authenticated user via supabase.auth.getUser()
 * 2. Loads notification_preferences from Supabase (creates defaults if missing)
 * 3. Loads haptic feedback preference from SecureStore
 *
 * Persists changes:
 * - Push notification toggle -> notification_preferences.push_enabled in Supabase
 * - Haptic feedback toggle -> SecureStore (device-local)
 *
 * Sign out:
 * - Confirmation alert -> supabase.auth.signOut() + clearPairingInfo()
 * - Root layout auth listener handles redirect to login
 *
 * @returns React element
 */
export default function SettingsScreen() {
  const router = useRouter();
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [pushEnabled, setPushEnabled] = useState(true);
  const [hapticEnabled, setHapticEnabled] = useState(true);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);

  /**
   * Whether account deletion is in progress (API call + sign-out flow).
   * WHY: Separate from isSigningOut so both buttons can show independent loading states.
   */
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  /**
   * The user's current subscription tier from the subscriptions table.
   * WHY: Displayed in the Account section to show the user which plan they
   * are on. Defaults to 'free' if no subscription row exists.
   */
  const [subscriptionTier, setSubscriptionTier] = useState<string>('free');

  /**
   * The user's total spend for the current calendar month, aggregated from
   * cost_records. Displayed as a dollar amount in the Usage & Costs row.
   */
  const [monthlySpend, setMonthlySpend] = useState<number>(0);

  /**
   * Whether billing data (subscription + cost) is still loading.
   * WHY: Separate from isLoadingUser so the profile header can render while
   * billing data is still being fetched from Supabase.
   */
  const [isLoadingBilling, setIsLoadingBilling] = useState(true);

  /**
   * WHY: We track notification preference ID so we can distinguish between
   * UPDATE (row exists) and INSERT (no row yet) when saving push toggle changes.
   */
  const [notifPrefId, setNotifPrefId] = useState<string | null>(null);

  /**
   * Whether the Android typed-deletion modal is visible.
   * WHY: Alert.prompt is iOS-only. On Android we show a custom modal so the
   * user still has to type "DELETE MY ACCOUNT" — same security bar as iOS.
   */
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  /**
   * The text the user has typed into the Android deletion confirmation input.
   */
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  /** Whether the feedback modal is visible */
  const [isFeedbackModalVisible, setIsFeedbackModalVisible] = useState(false);

  /** The text content of the feedback being composed */
  const [feedbackText, setFeedbackText] = useState('');

  /** Whether the feedback is currently being submitted to Supabase */
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);

  /**
   * Whether auto-approve for low-risk operations is enabled.
   * WHY: This maps to the `auto_approve_low_risk` field on the user's default
   * agent_configs row. Low-risk operations (read-only file access, etc.)
   * can be approved automatically to reduce notification noise.
   */
  const [autoApproveEnabled, setAutoApproveEnabled] = useState(false);

  /**
   * Quiet hours start/end times from notification_preferences.
   * WHY: Displayed in the Quiet Hours row and used when showing/editing
   * quiet hours configuration.
   */
  const [quietHoursStart, setQuietHoursStart] = useState<string | null>('22:00:00');
  const [quietHoursEnd, setQuietHoursEnd] = useState<string | null>('07:00:00');

  /** Whether quiet hours are enabled from notification_preferences */
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);

  /**
   * Priority threshold for smart notifications (1-5).
   * Lower values = fewer notifications (more filtering).
   * WHY: Pro+ users can filter notifications by importance to reduce fatigue.
   */
  const [priorityThreshold, setPriorityThreshold] = useState(3);

  /**
   * Whether the priority threshold is currently being saved.
   */
  const [prioritySaving, setPrioritySaving] = useState(false);

  /**
   * Whether email notifications are enabled from notification_preferences.
   * WHY: This is loaded alongside push_enabled from the same row and follows
   * the same pattern — optimistic update with Supabase upsert on toggle.
   */
  const [emailEnabled, setEmailEnabled] = useState(false);

  // --------------------------------------------------------------------------
  // Display name editing state
  // --------------------------------------------------------------------------

  /**
   * Whether the display name edit mode is active (shows TextInput).
   * WHY: We use inline editing (edit icon → TextInput + save/cancel) rather than
   * a modal so the user sees the current name while editing.
   */
  const [isEditingDisplayName, setIsEditingDisplayName] = useState(false);

  /** The in-progress display name while editing */
  const [displayNameDraft, setDisplayNameDraft] = useState('');

  /** Whether the display name save is in progress */
  const [isSavingDisplayName, setIsSavingDisplayName] = useState(false);

  // --------------------------------------------------------------------------
  // Email change state
  // --------------------------------------------------------------------------

  /** Whether the email change modal is visible */
  const [isEmailModalVisible, setIsEmailModalVisible] = useState(false);

  /** The new email address typed in the email change modal */
  const [newEmailDraft, setNewEmailDraft] = useState('');

  /** Whether the email change API call is in progress */
  const [isChangingEmail, setIsChangingEmail] = useState(false);

  // --------------------------------------------------------------------------
  // Password reset state
  // --------------------------------------------------------------------------

  /**
   * Unix timestamp (ms) of the last password reset email sent.
   * WHY: We enforce a 60-second cooldown client-side to prevent accidental
   * double-taps from sending multiple emails in quick succession.
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
  // Theme state
  // --------------------------------------------------------------------------

  /**
   * The user's theme preference: 'dark' | 'light' | 'system'.
   * WHY: We use local state here (loaded from SecureStore) rather than a
   * context provider because settings.tsx is the only screen that needs to
   * write it. Other screens that need to read it use useTheme() from context.
   */
  const [themePreference, setThemePreferenceState] = useState<'dark' | 'light' | 'system'>('dark');

  /**
   * Whether the user is on a paid tier (Pro/Power) that enables smart notifications.
   */
  const isPaidTier = subscriptionTier === 'pro' || subscriptionTier === 'power';

  // --------------------------------------------------------------------------
  // Mount: Load user data and preferences
  // --------------------------------------------------------------------------

  useEffect(() => {
    loadUserData();
    loadLocalPreferences();
  }, []);

  /**
   * Fetches the authenticated user and their notification preferences from
   * Supabase. If no notification_preferences row exists for the user, creates
   * one with default values.
   */
  const loadUserData = useCallback(async () => {
    setIsLoadingUser(true);
    try {
      // Fetch authenticated user
      const { data: { user }, error: userError } = await supabase.auth.getUser();

      if (userError || !user) {
        // WHY: If getUser fails, the user is likely unauthenticated.
        // The root layout auth listener will redirect to login.
        setIsLoadingUser(false);
        return;
      }

      setUserInfo(extractUserInfo(user));

      // Fetch billing data (subscription tier + monthly spend)
      loadBillingData(user.id);

      // Fetch notification preferences
      const { data: notifPrefs, error: notifError } = await supabase
        .from('notification_preferences')
        .select('id, user_id, push_enabled, email_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, priority_threshold')
        .eq('user_id', user.id)
        .single();

      if (notifError && notifError.code === 'PGRST116') {
        // WHY: PGRST116 means "no rows returned". This happens for new users
        // who haven't had a notification_preferences row created yet.
        // We create one with sensible defaults.
        const { data: newPrefs, error: insertError } = await supabase
          .from('notification_preferences')
          .insert({ user_id: user.id, push_enabled: true, priority_threshold: 3 })
          .select('id, user_id, push_enabled, email_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, priority_threshold')
          .single();

        if (!insertError && newPrefs) {
          setNotifPrefId(newPrefs.id);
          setPushEnabled(newPrefs.push_enabled);
          setEmailEnabled(newPrefs.email_enabled ?? false);
          setQuietHoursEnabled(newPrefs.quiet_hours_enabled);
          setQuietHoursStart(newPrefs.quiet_hours_start);
          setQuietHoursEnd(newPrefs.quiet_hours_end);
          setPriorityThreshold(newPrefs.priority_threshold ?? 3);
        }
      } else if (!notifError && notifPrefs) {
        setNotifPrefId(notifPrefs.id);
        setPushEnabled(notifPrefs.push_enabled);
        setEmailEnabled(notifPrefs.email_enabled ?? false);
        setQuietHoursEnabled(notifPrefs.quiet_hours_enabled);
        setQuietHoursStart(notifPrefs.quiet_hours_start);
        setQuietHoursEnd(notifPrefs.quiet_hours_end);
        setPriorityThreshold(notifPrefs.priority_threshold ?? 3);
      }

      // Fetch auto-approve setting from default agent config
      const { data: agentConfig } = await supabase
        .from('agent_configs')
        .select('auto_approve_low_risk')
        .eq('user_id', user.id)
        .limit(1)
        .single();

      if (agentConfig) {
        setAutoApproveEnabled(agentConfig.auto_approve_low_risk ?? false);
      }
    } catch (error) {
      // Non-fatal: UI will show fallback values
      if (__DEV__) {
        console.error('[Settings] Failed to load user data:', error);
      }
    } finally {
      setIsLoadingUser(false);
    }
  }, []);

  /**
   * Fetches the user's subscription tier and current month's total spend.
   *
   * WHY: These are displayed in the Account section to replace the previously
   * hardcoded "Pro Plan" and "$12.45 this month" values. We query both in
   * parallel for performance.
   *
   * @param userId - The authenticated user's Supabase ID
   */
  const loadBillingData = useCallback(async (userId: string) => {
    setIsLoadingBilling(true);
    try {
      // Build the start-of-month timestamp for filtering cost_records
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      // Fetch subscription tier and monthly spend in parallel
      const [subResult, costResult] = await Promise.all([
        supabase
          .from('subscriptions')
          .select('tier')
          .eq('user_id', userId)
          .single(),
        supabase
          .from('cost_records')
          .select('cost_usd')
          .eq('user_id', userId)
          .gte('created_at', monthStart),
      ]);

      // Set subscription tier (default to 'free' if no row exists)
      if (!subResult.error && subResult.data) {
        setSubscriptionTier(subResult.data.tier);
      } else {
        setSubscriptionTier('free');
      }

      // Sum up the monthly spend from individual cost records
      if (!costResult.error && costResult.data) {
        const total = costResult.data.reduce(
          (sum: number, record: { cost_usd: number }) => sum + (record.cost_usd ?? 0),
          0
        );
        setMonthlySpend(total);
      } else {
        setMonthlySpend(0);
      }
    } catch (error) {
      if (__DEV__) {
        console.error('[Settings] Failed to load billing data:', error);
      }
    } finally {
      setIsLoadingBilling(false);
    }
  }, []);

  /**
   * Loads device-local preferences from SecureStore.
   * Currently only haptic feedback preference is stored locally.
   */
  const loadLocalPreferences = useCallback(async () => {
    try {
      const [hapticValue, themeValue] = await Promise.all([
        SecureStore.getItemAsync(HAPTIC_PREFERENCE_KEY),
        SecureStore.getItemAsync(THEME_PREFERENCE_KEY),
      ]);

      // WHY: If no value is stored, default to true (haptics enabled).
      // We only store explicitly when the user toggles the setting.
      if (hapticValue !== null) {
        setHapticEnabled(hapticValue === 'true');
      }

      // WHY: Load theme preference from SecureStore so settings shows the
      // current value. Default 'dark' if not set.
      if (themeValue === 'dark' || themeValue === 'light' || themeValue === 'system') {
        setThemePreferenceState(themeValue);
      }
    } catch (error) {
      if (__DEV__) {
        console.error('[Settings] Failed to load local preferences:', error);
      }
    }
  }, []);

  // --------------------------------------------------------------------------
  // Preference Handlers
  // --------------------------------------------------------------------------

  /**
   * Toggles the push notification preference and persists it to Supabase.
   *
   * @param value - The new push notification enabled state
   */
  const handlePushToggle = useCallback(async (value: boolean) => {
    // Optimistic update for responsive UI
    setPushEnabled(value);

    try {
      if (!userInfo) return;

      if (notifPrefId) {
        // Update existing row
        const { error } = await supabase
          .from('notification_preferences')
          .update({ push_enabled: value })
          .eq('id', notifPrefId);

        if (error) {
          // Revert optimistic update on failure
          setPushEnabled(!value);
          if (__DEV__) {
            console.error('[Settings] Failed to update push preference:', error);
          }
        }
      } else {
        // Insert new row (edge case: row was deleted between mount and toggle)
        const { data, error } = await supabase
          .from('notification_preferences')
          .insert({ user_id: userInfo.id, push_enabled: value })
          .select('id')
          .single();

        if (error) {
          setPushEnabled(!value);
          if (__DEV__) {
            console.error('[Settings] Failed to insert push preference:', error);
          }
        } else if (data) {
          setNotifPrefId(data.id);
        }
      }
    } catch (error) {
      setPushEnabled(!value);
      if (__DEV__) {
        console.error('[Settings] Push toggle error:', error);
      }
    }
  }, [userInfo, notifPrefId]);

  /**
   * Toggles the email notification preference and persists it to Supabase.
   *
   * Follows the same pattern as handlePushToggle: optimistic update,
   * update existing row or insert new row, revert on error.
   *
   * @param value - The new email notification enabled state
   */
  const handleEmailToggle = useCallback(async (value: boolean) => {
    // Optimistic update for responsive UI
    setEmailEnabled(value);

    try {
      if (!userInfo) return;

      if (notifPrefId) {
        const { error } = await supabase
          .from('notification_preferences')
          .update({ email_enabled: value })
          .eq('id', notifPrefId);

        if (error) {
          setEmailEnabled(!value);
          if (__DEV__) {
            console.error('[Settings] Failed to update email preference:', error);
          }
        }
      } else {
        const { data, error } = await supabase
          .from('notification_preferences')
          .insert({ user_id: userInfo.id, email_enabled: value })
          .select('id')
          .single();

        if (error) {
          setEmailEnabled(!value);
          if (__DEV__) {
            console.error('[Settings] Failed to insert email preference:', error);
          }
        } else if (data) {
          setNotifPrefId(data.id);
        }
      }
    } catch (error) {
      setEmailEnabled(!value);
      if (__DEV__) {
        console.error('[Settings] Email toggle error:', error);
      }
    }
  }, [userInfo, notifPrefId]);

  // --------------------------------------------------------------------------
  // Display Name Handlers
  // --------------------------------------------------------------------------

  /**
   * Begins inline display name editing.
   * Prefills the draft input with the current display name.
   */
  const handleBeginEditDisplayName = useCallback(() => {
    setDisplayNameDraft(userInfo?.displayName ?? '');
    setIsEditingDisplayName(true);
  }, [userInfo?.displayName]);

  /**
   * Cancels display name editing without saving.
   */
  const handleCancelEditDisplayName = useCallback(() => {
    setIsEditingDisplayName(false);
    setDisplayNameDraft('');
  }, []);

  /**
   * Saves the edited display name to the profiles table via Supabase.
   * Uses an optimistic update pattern: updates local state immediately,
   * then reverts on error.
   *
   * WHY we update profiles.display_name instead of user_metadata:
   * The profiles table is the canonical source for display_name in Styrby.
   * user_metadata can also be updated for auth-level consistency, but the
   * app always reads from profiles for display purposes.
   */
  const handleSaveDisplayName = useCallback(async () => {
    const trimmed = displayNameDraft.trim();
    if (!trimmed || !userInfo) return;

    const previous = userInfo.displayName;

    // Optimistic update
    setUserInfo((prev) => prev ? { ...prev, displayName: trimmed, initial: trimmed.charAt(0).toUpperCase() } : prev);
    setIsEditingDisplayName(false);
    setIsSavingDisplayName(true);

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ display_name: trimmed })
        .eq('id', userInfo.id);

      if (error) {
        // Revert optimistic update
        setUserInfo((prev) => prev ? { ...prev, displayName: previous, initial: previous ? previous.charAt(0).toUpperCase() : prev.email.charAt(0).toUpperCase() } : prev);
        Alert.alert('Error', 'Failed to save display name. Please try again.');
        if (__DEV__) {
          console.error('[Settings] Failed to save display name:', error);
        }
      }
    } catch (err) {
      setUserInfo((prev) => prev ? { ...prev, displayName: previous, initial: previous ? previous.charAt(0).toUpperCase() : prev.email.charAt(0).toUpperCase() } : prev);
      Alert.alert('Error', 'An unexpected error occurred. Please try again.');
    } finally {
      setIsSavingDisplayName(false);
      setDisplayNameDraft('');
    }
  }, [displayNameDraft, userInfo]);

  // --------------------------------------------------------------------------
  // Email Change Handler
  // --------------------------------------------------------------------------

  /**
   * Submits an email address change request.
   *
   * Calls supabase.auth.updateUser({ email }) which sends a verification
   * email to the new address. The change is not applied until the user
   * clicks the verification link.
   *
   * WHY: This uses Supabase's built-in email change flow which sends a
   * verification email to the new address for security. We do NOT change
   * the email immediately — the user must verify the new address first.
   */
  const handleChangeEmail = useCallback(async () => {
    const trimmed = newEmailDraft.trim().toLowerCase();

    // Basic email format validation
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }

    if (trimmed === userInfo?.email) {
      Alert.alert('Same Email', 'The new email address is the same as your current one.');
      return;
    }

    setIsChangingEmail(true);

    try {
      const { error } = await supabase.auth.updateUser({ email: trimmed });

      if (error) {
        // WHY: Supabase returns 422 for emails already in use. Surface a clear message.
        const message = error.message.includes('already registered')
          ? 'This email address is already in use by another account.'
          : error.message;
        Alert.alert('Email Change Failed', message);
      } else {
        setNewEmailDraft('');
        setIsEmailModalVisible(false);
        Alert.alert(
          'Verification Email Sent',
          `A verification email has been sent to ${trimmed}. Please click the link in the email to confirm the change.`,
        );
      }
    } catch (err) {
      Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      if (__DEV__) {
        console.error('[Settings] Email change error:', err);
      }
    } finally {
      setIsChangingEmail(false);
    }
  }, [newEmailDraft, userInfo?.email]);

  // --------------------------------------------------------------------------
  // Password Reset Handler
  // --------------------------------------------------------------------------

  /**
   * Sends a password reset email to the user's current email address.
   *
   * WHY: We enforce a 60-second cooldown between requests to prevent
   * accidental double-taps from sending multiple emails. The cooldown is
   * tracked in component state (not persisted) so it resets on app restart.
   *
   * @returns void
   */
  const handlePasswordReset = useCallback(async () => {
    if (!userInfo?.email) {
      Alert.alert('Error', 'No email address on file.');
      return;
    }

    // WHY: 60-second cooldown prevents accidental spam. Supabase also
    // rate-limits this endpoint server-side, but the client guard gives
    // immediate feedback without a network round trip.
    const PASSWORD_RESET_COOLDOWN_MS = 60_000;
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
      const { error } = await supabase.auth.resetPasswordForEmail(userInfo.email);

      if (error) {
        Alert.alert('Error', error.message);
      } else {
        setLastPasswordResetAt(Date.now());
        Alert.alert(
          'Reset Email Sent',
          `A password reset link has been sent to ${userInfo.email}. Check your inbox.`,
        );
      }
    } catch (err) {
      Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      if (__DEV__) {
        console.error('[Settings] Password reset error:', err);
      }
    } finally {
      setIsSendingPasswordReset(false);
    }
  }, [userInfo?.email, lastPasswordResetAt]);

  // --------------------------------------------------------------------------
  // Data Export Handler
  // --------------------------------------------------------------------------

  /**
   * Exports all user data (GDPR Art. 20) via the web app's export endpoint
   * and copies a summary to clipboard, or triggers a share if supported.
   *
   * WHY we call the web API instead of querying Supabase directly:
   * The web endpoint runs server-side with the Supabase service role and handles
   * 20 table queries, audit log writing, and rate limiting in one shot. Reusing
   * it keeps export logic in one place (DRY) and avoids duplicating the rate
   * limit logic on mobile.
   *
   * The raw JSON is copied to clipboard for users to paste into a file manager.
   * This approach works without expo-file-system or expo-sharing dependencies.
   *
   * @returns void
   */
  const handleExportData = useCallback(async () => {
    if (!userInfo) return;

    setIsExportingData(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        Alert.alert('Error', 'You must be signed in to export your data.');
        setIsExportingData(false);
        return;
      }

      // WHY POST: The web export endpoint is POST (not GET) because it writes
      // an audit log entry and should not be cached or prefetched.
      const response = await fetch('https://styrbyapp.com/api/account/export', {
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

      // Copy JSON to clipboard so the user can save it
      await Clipboard.setStringAsync(exportJson);

      Alert.alert(
        'Data Export Ready',
        'Your data has been copied to the clipboard. Paste it into a text editor or notes app to save the JSON file.',
        [{ text: 'OK' }],
      );
    } catch (err) {
      Alert.alert('Export Failed', 'Failed to export your data. Please check your connection and try again.');
      if (__DEV__) {
        console.error('[Settings] Data export error:', err);
      }
    } finally {
      setIsExportingData(false);
    }
  }, [userInfo]);

  // --------------------------------------------------------------------------
  // Theme Handler
  // --------------------------------------------------------------------------

  /**
   * Updates the theme preference in local state and persists it to SecureStore.
   * The ThemeProvider will read this value on next mount and apply it.
   *
   * @param preference - The new theme preference
   */
  const handleThemeChange = useCallback(async (preference: 'dark' | 'light' | 'system') => {
    setThemePreferenceState(preference);

    try {
      await SecureStore.setItemAsync(THEME_PREFERENCE_KEY, preference);
    } catch (err) {
      // Revert on storage failure
      if (__DEV__) {
        console.error('[Settings] Failed to save theme preference:', err);
      }
    }
  }, []);

  /**
   * Toggles the haptic feedback preference and persists it to SecureStore.
   *
   * @param value - The new haptic feedback enabled state
   */
  const handleHapticToggle = useCallback(async (value: boolean) => {
    setHapticEnabled(value);

    try {
      await SecureStore.setItemAsync(HAPTIC_PREFERENCE_KEY, value.toString());
    } catch (error) {
      // Revert on storage failure
      setHapticEnabled(!value);
      if (__DEV__) {
        console.error('[Settings] Failed to save haptic preference:', error);
      }
    }
  }, []);

  // --------------------------------------------------------------------------
  // Auto-Approve Handler
  // --------------------------------------------------------------------------

  /**
   * Toggles the auto-approve low-risk setting and persists it to the user's
   * default agent_configs row in Supabase.
   *
   * WHY: Auto-approve for read-only operations reduces notification noise for
   * power users who trust their agent configurations. The setting is stored
   * per-user on the agent_configs table.
   *
   * @param value - The new auto-approve enabled state
   */
  const handleAutoApproveToggle = useCallback(async (value: boolean) => {
    // Optimistic update
    setAutoApproveEnabled(value);

    try {
      if (!userInfo) return;

      const { error } = await supabase
        .from('agent_configs')
        .update({ auto_approve_low_risk: value })
        .eq('user_id', userInfo.id);

      if (error) {
        // Revert on failure
        setAutoApproveEnabled(!value);
        if (__DEV__) {
          console.error('[Settings] Failed to update auto-approve:', error);
        }
      }
    } catch (error) {
      setAutoApproveEnabled(!value);
      if (__DEV__) {
        console.error('[Settings] Auto-approve toggle error:', error);
      }
    }
  }, [userInfo]);

  // --------------------------------------------------------------------------
  // Quiet Hours Handler
  // --------------------------------------------------------------------------

  /**
   * Toggles quiet hours on/off and persists to notification_preferences.
   *
   * WHY: Quiet hours prevent notifications from being sent during sleeping
   * hours. Toggling this on uses the stored start/end times (defaulting to
   * 10 PM - 7 AM). Users can also tap through to configure the actual times.
   *
   * @param value - Whether quiet hours should be enabled
   */
  const handleQuietHoursToggle = useCallback(async (value: boolean) => {
    setQuietHoursEnabled(value);

    try {
      if (!notifPrefId) return;

      const updateData: Record<string, unknown> = { quiet_hours_enabled: value };

      // When enabling quiet hours for the first time, set default times
      if (value && !quietHoursStart) {
        updateData.quiet_hours_start = '22:00:00';
        updateData.quiet_hours_end = '07:00:00';
        setQuietHoursStart('22:00:00');
        setQuietHoursEnd('07:00:00');
      }

      const { error } = await supabase
        .from('notification_preferences')
        .update(updateData)
        .eq('id', notifPrefId);

      if (error) {
        setQuietHoursEnabled(!value);
        if (__DEV__) {
          console.error('[Settings] Failed to update quiet hours:', error);
        }
      }
    } catch (error) {
      setQuietHoursEnabled(!value);
      if (__DEV__) {
        console.error('[Settings] Quiet hours toggle error:', error);
      }
    }
  }, [notifPrefId, quietHoursStart]);

  // --------------------------------------------------------------------------
  // Priority Threshold Handler
  // --------------------------------------------------------------------------

  /**
   * Returns the label text for a priority threshold level.
   */
  const getPriorityLabel = (value: number): string => {
    switch (value) {
      case 1: return 'Urgent only';
      case 2: return 'High priority';
      case 3: return 'Medium priority';
      case 4: return 'Most notifications';
      case 5: return 'All notifications';
      default: return 'Medium priority';
    }
  };

  /**
   * Returns an estimated percentage of notifications at a given threshold.
   */
  const getPriorityPercentage = (value: number): number => {
    switch (value) {
      case 1: return 5;
      case 2: return 15;
      case 3: return 50;
      case 4: return 85;
      case 5: return 100;
      default: return 50;
    }
  };

  /**
   * Updates the notification priority threshold and persists to Supabase.
   *
   * WHY: Smart notifications filter by importance to reduce notification fatigue.
   * Pro+ users can set their threshold; free users receive all notifications.
   *
   * @param value - New priority threshold (1-5)
   */
  const handlePriorityChange = useCallback(async (value: number) => {
    setPriorityThreshold(value);
    setPrioritySaving(true);

    try {
      if (!notifPrefId) return;

      const { error } = await supabase
        .from('notification_preferences')
        .update({ priority_threshold: value })
        .eq('id', notifPrefId);

      if (error) {
        // Revert on failure
        setPriorityThreshold(priorityThreshold);
        if (__DEV__) {
          console.error('[Settings] Failed to update priority threshold:', error);
        }
      }
    } catch (error) {
      setPriorityThreshold(priorityThreshold);
      if (__DEV__) {
        console.error('[Settings] Priority threshold update error:', error);
      }
    } finally {
      setPrioritySaving(false);
    }
  }, [notifPrefId, priorityThreshold]);

  // --------------------------------------------------------------------------
  // Feedback Handler
  // --------------------------------------------------------------------------

  /**
   * Submits user feedback to the user_feedback table in Supabase.
   * Clears the text and closes the modal on success, shows an error alert
   * on failure.
   */
  const handleSubmitFeedback = useCallback(async () => {
    const trimmed = feedbackText.trim();
    if (!trimmed || !userInfo) return;

    setIsSubmittingFeedback(true);
    try {
      // WHY: user_feedback uses `message` (not feedback), `platform` (not source),
      // and requires `feedback_type` (NOT NULL enum).
      const { error } = await supabase
        .from('user_feedback')
        .insert({
          user_id: userInfo.id,
          feedback_type: 'general',
          message: trimmed,
          platform: 'ios',
        });

      if (error) {
        Alert.alert('Error', 'Failed to submit feedback. Please try again.');
        if (__DEV__) {
          console.error('[Settings] Failed to submit feedback:', error);
        }
      } else {
        setFeedbackText('');
        setIsFeedbackModalVisible(false);
        Alert.alert('Thank You', 'Your feedback has been submitted.');
      }
    } catch (error) {
      Alert.alert('Error', 'An unexpected error occurred. Please try again.');
      if (__DEV__) {
        console.error('[Settings] Feedback submission error:', error);
      }
    } finally {
      setIsSubmittingFeedback(false);
    }
  }, [feedbackText, userInfo]);

  // --------------------------------------------------------------------------
  // Sign Out
  // --------------------------------------------------------------------------

  /**
   * Shows a confirmation alert and, on confirm, executes the full sign-out
   * flow: Supabase auth sign out, clear pairing info, and clear cached data.
   *
   * WHY: We show a confirmation because sign out is destructive — the user
   * will need to re-pair with their CLI after signing back in. The root layout
   * auth listener handles the redirect to the login screen after sign out.
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
              // Step 1: Clear pairing info from SecureStore
              // WHY: Clear pairing first so there is no orphan pairing data if
              // signOut fails partway through. The relay hook in _layout will
              // detect the missing pairing info and disconnect.
              await clearPairingInfo();

              // Step 2: Clear local preferences from SecureStore
              await SecureStore.deleteItemAsync(HAPTIC_PREFERENCE_KEY);

              // Step 3: Sign out from Supabase Auth
              // This clears the session tokens and triggers onAuthStateChange
              // in the root layout, which redirects to the login screen.
              const { error } = await signOut();

              if (error) {
                Alert.alert('Sign Out Failed', error.message);
                setIsSigningOut(false);
              }
              // On success, the root layout auth listener redirects to login,
              // so we do not need to navigate here.
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
  // Account Deletion
  // --------------------------------------------------------------------------

  /**
   * Executes the account deletion by calling the web API endpoint and
   * signing the user out on success.
   *
   * WHY: Separated from handleDeleteAccount for clarity and because it is
   * called from multiple code paths (iOS prompt vs Android fallback).
   *
   * @throws Shows an error alert if the API call fails
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

      // WHY: The web app at styrbyapp.com hosts the account deletion endpoint
      // which uses the Supabase admin client to ban the user and soft-delete data.
      const response = await fetch('https://styrbyapp.com/api/account/delete', {
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

      // WHY: The root layout auth listener will detect the sign-out and redirect
      // to the login screen. We don't navigate manually here.
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
   * Step 1: Alert explaining what will be deleted
   * Step 2: Prompt to type "DELETE MY ACCOUNT" to confirm
   *
   * On confirmation, calls the web app's DELETE /api/account/delete endpoint
   * which performs a soft-delete (data recoverable for 30 days) and bans the user.
   *
   * WHY two-step: Account deletion is irreversible after the 30-day grace period.
   * Requiring a typed confirmation prevents accidental deletions and satisfies
   * compliance requirements for explicit user consent.
   *
   * WHY web API: The delete endpoint requires a Supabase service role key to ban
   * the user in auth.users. Mobile apps must never contain service role keys,
   * so we delegate to the server-side endpoint.
   */
  const handleDeleteAccount = useCallback(() => {
    // Step 1: Initial confirmation
    Alert.alert(
      'Delete Account?',
      'This will permanently delete your account and all associated data, including sessions, cost records, team memberships, and preferences.\n\nYour data will be recoverable for 30 days, after which it is permanently removed.\n\nThis action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            // Step 2: Type confirmation
            // WHY: Alert.prompt is iOS-only but this is an iOS app (Expo).
            // On Android, we use a simpler confirmation since Alert.prompt is unavailable.
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
                        executeAccountDeletion();
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
              // WHY: Alert.prompt is iOS-only (React Native limitation). On Android
              // we open a custom modal that renders a TextInput so the user still
              // must type the exact phrase — same security bar as iOS.
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

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Profile Header */}
      {isLoadingUser ? (
        <View className="items-center py-6">
          <ActivityIndicator
            size="small"
            color="#f97316"
            accessibilityLabel="Loading user data"
          />
        </View>
      ) : null}

      {/* Account Section */}
      <SectionHeader title="Account" />
      <View className="bg-background-secondary">
        {/* Display Name — inline editing */}
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
              onSubmitEditing={handleSaveDisplayName}
              accessibilityLabel="Display name input"
            />
            <Pressable
              onPress={handleSaveDisplayName}
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
            title={userInfo?.displayName ?? 'Set Display Name'}
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
          subtitle={userInfo?.email ?? 'Not signed in'}
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
          onPress={handlePasswordReset}
          trailing={
            isSendingPasswordReset ? (
              <ActivityIndicator size="small" color="#eab308" />
            ) : undefined
          }
        />

        <SettingRow
          icon="download"
          iconColor="#22c55e"
          title="Export My Data"
          subtitle="Download all your data (GDPR)"
          onPress={handleExportData}
          trailing={
            isExportingData ? (
              <ActivityIndicator size="small" color="#22c55e" />
            ) : undefined
          }
        />

        <SettingRow
          icon="card"
          iconColor="#22c55e"
          title="Subscription"
          subtitle={isLoadingBilling ? 'Loading...' : `${subscriptionTier.charAt(0).toUpperCase() + subscriptionTier.slice(1)} Plan`}
          onPress={() => Linking.openURL(POLAR_CUSTOMER_PORTAL_URL)}
        />
        <SettingRow
          icon="stats-chart"
          iconColor="#3b82f6"
          title="Usage & Costs"
          subtitle={isLoadingBilling ? 'Loading...' : `$${monthlySpend.toFixed(2)} this month`}
          onPress={() => router.push('/(tabs)/costs')}
        />
      </View>

      {/* Agents Section */}
      <SectionHeader title="Agents" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="terminal"
          iconColor="#f97316"
          title="Claude Code"
          subtitle="Connected"
          onPress={() => router.push({ pathname: '/agent-config', params: { agent: 'claude' } })}
        />
        <SettingRow
          icon="terminal"
          iconColor="#22c55e"
          title="Codex"
          subtitle="Not connected"
          onPress={() => router.push({ pathname: '/agent-config', params: { agent: 'codex' } })}
        />
        <SettingRow
          icon="terminal"
          iconColor="#3b82f6"
          title="Gemini"
          subtitle="Not connected"
          onPress={() => router.push({ pathname: '/agent-config', params: { agent: 'gemini' } })}
        />
        <SettingRow
          icon="document-text"
          iconColor="#a855f7"
          title="Context Templates"
          subtitle="Reusable project context"
          onPress={() => router.push('/templates')}
        />
      </View>

      {/* Preferences Section */}
      <SectionHeader title="Preferences" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="notifications"
          iconColor="#eab308"
          title="Push Notifications"
          trailing={
            <Switch
              value={pushEnabled}
              onValueChange={handlePushToggle}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={pushEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle push notifications"
            />
          }
        />
        <SettingRow
          icon="mail"
          iconColor="#3b82f6"
          title="Email Notifications"
          trailing={
            <Switch
              value={emailEnabled}
              onValueChange={handleEmailToggle}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={emailEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle email notifications"
            />
          }
        />

        {/* Theme selector: Dark / Light / System */}
        <View className="px-4 py-3">
          <View className="flex-row items-center mb-2">
            <View
              className="w-8 h-8 rounded-lg items-center justify-center mr-3"
              style={{ backgroundColor: '#f9731620' }}
            >
              <Ionicons name="color-palette" size={18} color="#f97316" />
            </View>
            <Text className="text-white font-medium flex-1">Theme</Text>
          </View>
          <View className="flex-row bg-zinc-800 rounded-xl p-1 ml-11">
            {(['dark', 'light', 'system'] as const).map((option) => {
              const isSelected = themePreference === option;
              const label = option.charAt(0).toUpperCase() + option.slice(1);
              return (
                <Pressable
                  key={option}
                  onPress={() => handleThemeChange(option)}
                  className={`flex-1 py-2 rounded-lg items-center ${isSelected ? 'bg-brand' : ''}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={`Set theme to ${label}`}
                >
                  <Text
                    className={`text-xs font-semibold ${isSelected ? 'text-white' : 'text-zinc-500'}`}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <SettingRow
          icon="phone-portrait"
          iconColor="#8b5cf6"
          title="Haptic Feedback"
          trailing={
            <Switch
              value={hapticEnabled}
              onValueChange={handleHapticToggle}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={hapticEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle haptic feedback"
            />
          }
        />
        <SettingRow
          icon="shield-checkmark"
          iconColor="#06b6d4"
          title="Auto-Approve Low Risk"
          subtitle="Auto-approve read-only operations"
          trailing={
            <Switch
              value={autoApproveEnabled}
              onValueChange={handleAutoApproveToggle}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={autoApproveEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle auto-approve for low-risk operations"
            />
          }
        />
        <SettingRow
          icon="moon"
          iconColor="#6366f1"
          title="Quiet Hours"
          subtitle={quietHoursEnabled
            ? `${formatTime(quietHoursStart, '10:00 PM')} - ${formatTime(quietHoursEnd, '7:00 AM')}`
            : 'Disabled'}
          trailing={
            <Switch
              value={quietHoursEnabled}
              onValueChange={handleQuietHoursToggle}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={quietHoursEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle quiet hours"
            />
          }
        />
      </View>

      {/* Smart Notifications Section */}
      <SectionHeader title="Smart Notifications" />
      <View className="bg-background-secondary px-4 py-4">
        {/* Header with Pro badge */}
        <View className="flex-row items-center justify-between mb-3">
          <View className="flex-row items-center">
            <Ionicons name="funnel" size={18} color="#f97316" />
            <Text className="text-white font-medium ml-2">Notification Sensitivity</Text>
            {!isPaidTier && (
              <View className="ml-2 px-2 py-0.5 rounded-full bg-orange-500/10">
                <Text className="text-xs font-medium text-orange-400">Pro</Text>
              </View>
            )}
          </View>
          {prioritySaving && (
            <Text className="text-xs text-zinc-500">Saving...</Text>
          )}
        </View>

        {/* Priority Slider - disabled for free users */}
        <View style={{ opacity: isPaidTier ? 1 : 0.5 }} pointerEvents={isPaidTier ? 'auto' : 'none'}>
          {/* Slider buttons for each level */}
          <View className="flex-row justify-between mb-2">
            {[1, 2, 3, 4, 5].map((level) => (
              <Pressable
                key={level}
                onPress={() => handlePriorityChange(level)}
                disabled={!isPaidTier || prioritySaving}
                className={`flex-1 mx-0.5 py-3 rounded-lg items-center ${
                  priorityThreshold === level ? 'bg-orange-500' : 'bg-zinc-800'
                }`}
                accessibilityRole="button"
                accessibilityLabel={`Set priority to ${getPriorityLabel(level)}`}
              >
                <Text
                  className={`text-xs font-medium ${
                    priorityThreshold === level ? 'text-white' : 'text-zinc-400'
                  }`}
                >
                  {level}
                </Text>
              </Pressable>
            ))}
          </View>
          <View className="flex-row justify-between">
            <Text className="text-xs text-zinc-500">Urgent only</Text>
            <Text className="text-xs text-zinc-500">All</Text>
          </View>

          {/* Current level description */}
          <View className="mt-4 p-3 rounded-lg bg-zinc-800/50 border border-zinc-700">
            <Text className="text-sm font-medium text-white mb-1">
              {getPriorityLabel(priorityThreshold)}
            </Text>
            <Text className="text-xs text-zinc-400 mb-2">
              You will receive approximately {getPriorityPercentage(priorityThreshold)}% of notifications.
            </Text>
            <View className="space-y-1">
              <Text className="text-xs text-zinc-500 font-medium">Examples at this level:</Text>
              {priorityThreshold >= 1 && (
                <Text className="text-xs text-zinc-500">- Budget exceeded, dangerous tool permissions</Text>
              )}
              {priorityThreshold >= 2 && (
                <Text className="text-xs text-zinc-500">- Budget warnings, session errors</Text>
              )}
              {priorityThreshold >= 3 && (
                <Text className="text-xs text-zinc-500">- Session completions with significant cost</Text>
              )}
              {priorityThreshold >= 4 && (
                <Text className="text-xs text-zinc-500">- Low-cost session completions</Text>
              )}
              {priorityThreshold >= 5 && (
                <Text className="text-xs text-zinc-500">- Session started, all updates</Text>
              )}
            </View>
          </View>
        </View>

        {/* Pro upgrade CTA for free users */}
        {!isPaidTier && (
          <View className="mt-4 p-3 rounded-lg bg-orange-500/5 border border-orange-500/20">
            <Text className="text-sm text-orange-400 mb-2">
              Smart notifications filter by importance to reduce notification fatigue.
            </Text>
            <Pressable
              onPress={() => Linking.openURL(POLAR_CUSTOMER_PORTAL_URL)}
              accessibilityRole="link"
              accessibilityLabel="Upgrade to Pro"
            >
              <Text className="text-sm font-medium text-orange-500">
                Upgrade to Pro to enable
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Support Section */}
      <SectionHeader title="Support" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="ticket"
          iconColor="#f97316"
          title="Support Tickets"
          subtitle="View or create support tickets"
          onPress={() => router.push('/support')}
        />
        <SettingRow
          icon="help-circle"
          iconColor="#71717a"
          title="Help & FAQ"
          onPress={() => Linking.openURL(HELP_URL)}
        />
        <SettingRow
          icon="chatbox"
          iconColor="#71717a"
          title="Send Feedback"
          onPress={() => setIsFeedbackModalVisible(true)}
        />
        <SettingRow
          icon="document-text"
          iconColor="#71717a"
          title="Privacy Policy"
          onPress={() => Linking.openURL(PRIVACY_URL)}
        />
        <SettingRow
          icon="document-text"
          iconColor="#71717a"
          title="Terms of Service"
          onPress={() => Linking.openURL(TERMS_URL)}
        />
      </View>

      {/* Sign Out & Delete Account */}
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

        {/* WHY: Delete Account is separate from Sign Out and placed below it
            to indicate higher severity. Red text + red border signals destructive
            action while maintaining visual consistency with Sign Out. */}
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

      {/* Version */}
      <Text className="text-zinc-600 text-center text-xs mb-8">
        Styrby v{APP_VERSION} ({BUILD_NUMBER})
      </Text>

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
            {/* Modal Header */}
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

            {/* Current email */}
            <View className="mb-3">
              <Text className="text-zinc-500 text-xs mb-1">Current Email</Text>
              <Text className="text-zinc-300 text-sm">{userInfo?.email}</Text>
            </View>

            {/* New email input */}
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
              onSubmitEditing={handleChangeEmail}
              accessibilityLabel="New email address input"
            />

            {/* Submit Button */}
            <Pressable
              onPress={handleChangeEmail}
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

      {/* Android Account Deletion Confirmation Modal */}
      {/* WHY: Alert.prompt is iOS-only. This modal provides a TextInput so Android
          users also have to type "DELETE MY ACCOUNT" — same security bar as iOS.
          Only rendered on Android to keep the iOS flow unchanged. */}
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
              {/* Modal Header */}
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

              {/* Confirm Delete Button — only active when text matches exactly */}
              <Pressable
                className={`py-3 rounded-xl items-center ${
                  deleteConfirmText === 'DELETE MY ACCOUNT'
                    ? 'bg-red-600 active:bg-red-700'
                    : 'bg-zinc-700 opacity-50'
                }`}
                disabled={deleteConfirmText !== 'DELETE MY ACCOUNT' || isDeletingAccount}
                onPress={() => {
                  setShowDeleteModal(false);
                  executeAccountDeletion();
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

      {/* Feedback Modal */}
      <Modal
        visible={isFeedbackModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setIsFeedbackModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          className="flex-1 justify-end"
        >
          <Pressable
            className="flex-1"
            onPress={() => setIsFeedbackModalVisible(false)}
            accessibilityLabel="Close feedback modal"
          />
          <View className="bg-zinc-900 rounded-t-3xl px-6 pt-6 pb-10 border-t border-zinc-800">
            {/* Modal Header */}
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-white text-lg font-semibold">Send Feedback</Text>
              <Pressable
                onPress={() => setIsFeedbackModalVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close feedback modal"
              >
                <Ionicons name="close" size={24} color="#71717a" />
              </Pressable>
            </View>

            <Text className="text-zinc-400 text-sm mb-4">
              Tell us what you think, report a bug, or suggest a feature.
            </Text>

            {/* Feedback Text Input */}
            <TextInput
              className="bg-zinc-800 text-white rounded-xl p-4 min-h-[120px] text-base mb-4"
              placeholder="Your feedback..."
              placeholderTextColor="#71717a"
              multiline
              textAlignVertical="top"
              value={feedbackText}
              onChangeText={setFeedbackText}
              maxLength={2000}
              accessibilityLabel="Feedback text input"
            />

            {/* Character Count */}
            <Text className="text-zinc-600 text-xs text-right mb-4">
              {feedbackText.length}/2000
            </Text>

            {/* Submit Button */}
            <Pressable
              className={`py-3 rounded-xl items-center ${
                feedbackText.trim().length > 0 && !isSubmittingFeedback
                  ? 'bg-brand active:opacity-80'
                  : 'bg-zinc-700'
              }`}
              onPress={handleSubmitFeedback}
              disabled={feedbackText.trim().length === 0 || isSubmittingFeedback}
              accessibilityRole="button"
              accessibilityLabel="Submit feedback"
            >
              {isSubmittingFeedback ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text className="text-white font-semibold">Submit Feedback</Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}
