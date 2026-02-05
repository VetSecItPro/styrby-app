/**
 * Settings Screen
 *
 * User preferences, account settings, and app configuration.
 * Loads the authenticated user on mount, persists preferences to Supabase
 * (notification_preferences) and SecureStore (local-only settings like haptic
 * feedback), and implements the sign-out flow.
 */

import { View, Text, ScrollView, Pressable, Switch, Alert, ActivityIndicator } from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { supabase, signOut } from '../../src/lib/supabase';
import { clearPairingInfo } from '../../src/services/pairing';

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
      {trailing || (onPress && <Ionicons name="chevron-forward" size={20} color="#71717a" />)}
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
 * Shows a native alert indicating that a feature is not yet available.
 *
 * @param featureName - Human-readable name of the feature for the alert message
 */
function showComingSoonAlert(featureName: string): void {
  Alert.alert(
    'Coming Soon',
    `${featureName} will be available in a future update.`,
  );
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
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [pushEnabled, setPushEnabled] = useState(true);
  const [hapticEnabled, setHapticEnabled] = useState(true);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);

  /**
   * WHY: We track notification preference ID so we can distinguish between
   * UPDATE (row exists) and INSERT (no row yet) when saving push toggle changes.
   */
  const [notifPrefId, setNotifPrefId] = useState<string | null>(null);

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

      // Fetch notification preferences
      const { data: notifPrefs, error: notifError } = await supabase
        .from('notification_preferences')
        .select('id, user_id, push_enabled, email_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end')
        .eq('user_id', user.id)
        .single();

      if (notifError && notifError.code === 'PGRST116') {
        // WHY: PGRST116 means "no rows returned". This happens for new users
        // who haven't had a notification_preferences row created yet.
        // We create one with sensible defaults.
        const { data: newPrefs, error: insertError } = await supabase
          .from('notification_preferences')
          .insert({ user_id: user.id, push_enabled: true })
          .select('id, user_id, push_enabled, email_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end')
          .single();

        if (!insertError && newPrefs) {
          setNotifPrefId(newPrefs.id);
          setPushEnabled(newPrefs.push_enabled);
        }
      } else if (!notifError && notifPrefs) {
        setNotifPrefId(notifPrefs.id);
        setPushEnabled(notifPrefs.push_enabled);
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
   * Loads device-local preferences from SecureStore.
   * Currently only haptic feedback preference is stored locally.
   */
  const loadLocalPreferences = useCallback(async () => {
    try {
      const hapticValue = await SecureStore.getItemAsync(HAPTIC_PREFERENCE_KEY);

      // WHY: If no value is stored, default to true (haptics enabled).
      // We only store explicitly when the user toggles the setting.
      if (hapticValue !== null) {
        setHapticEnabled(hapticValue === 'true');
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
        <SettingRow
          icon="person"
          iconColor="#f97316"
          title="Profile"
          subtitle={userInfo?.email ?? 'Not signed in'}
          onPress={() => showComingSoonAlert('Profile editing')}
        />
        <SettingRow
          icon="card"
          iconColor="#22c55e"
          title="Subscription"
          subtitle="Pro Plan"
          onPress={() => showComingSoonAlert('Subscription management')}
        />
        <SettingRow
          icon="stats-chart"
          iconColor="#3b82f6"
          title="Usage & Costs"
          subtitle="$12.45 this month"
          onPress={() => showComingSoonAlert('Usage & Costs')}
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
          onPress={() => showComingSoonAlert('Agent configurations')}
        />
        <SettingRow
          icon="terminal"
          iconColor="#22c55e"
          title="Codex"
          subtitle="Not connected"
          onPress={() => showComingSoonAlert('Agent configurations')}
        />
        <SettingRow
          icon="terminal"
          iconColor="#3b82f6"
          title="Gemini"
          subtitle="Not connected"
          onPress={() => showComingSoonAlert('Agent configurations')}
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
          onPress={() => showComingSoonAlert('Auto-approve configuration')}
        />
        <SettingRow
          icon="moon"
          iconColor="#6366f1"
          title="Quiet Hours"
          subtitle="10:00 PM - 7:00 AM"
          onPress={() => showComingSoonAlert('Quiet Hours configuration')}
        />
      </View>

      {/* Support Section */}
      <SectionHeader title="Support" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="help-circle"
          iconColor="#71717a"
          title="Help & FAQ"
          onPress={() => showComingSoonAlert('Help & FAQ')}
        />
        <SettingRow
          icon="chatbox"
          iconColor="#71717a"
          title="Send Feedback"
          onPress={() => showComingSoonAlert('Send Feedback')}
        />
        <SettingRow
          icon="document-text"
          iconColor="#71717a"
          title="Privacy Policy"
          onPress={() => showComingSoonAlert('Privacy Policy')}
        />
        <SettingRow
          icon="document-text"
          iconColor="#71717a"
          title="Terms of Service"
          onPress={() => showComingSoonAlert('Terms of Service')}
        />
      </View>

      {/* Sign Out */}
      <View className="mt-4 mb-8">
        <Pressable
          className="mx-4 py-3 rounded-xl border border-red-500/30 items-center active:bg-red-500/10"
          onPress={handleSignOut}
          disabled={isSigningOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out of your account"
        >
          {isSigningOut ? (
            <ActivityIndicator size="small" color="#ef4444" />
          ) : (
            <Text className="text-red-500 font-semibold">Sign Out</Text>
          )}
        </Pressable>
      </View>

      {/* Version */}
      <Text className="text-zinc-600 text-center text-xs mb-8">
        Styrby v{APP_VERSION} ({BUILD_NUMBER})
      </Text>
    </ScrollView>
  );
}
