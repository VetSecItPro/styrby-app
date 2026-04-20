/**
 * Settings Hub (Orchestrator)
 *
 * The primary settings screen. Renders navigation rows that push the user
 * into focused sub-screens. Each row shows a contextual subtitle (subscription
 * tier, push enabled, theme, etc.) loaded lazily.
 *
 * WHY orchestrator pattern: per `feedback_orchestrator_page_pattern.md`, page
 * files are orchestrators only — state, fetching, grid layout — max 200 LOC.
 * All settings logic lives in sub-screens. The hub fetches only the minimum
 * data needed to display subtitles: subscription tier + push_enabled.
 *
 * Navigation:
 *   router.push('/settings/account')        → Account sub-screen
 *   router.push('/settings/notifications')  → Notifications sub-screen
 *   router.push('/settings/appearance')     → Appearance sub-screen
 *   router.push('/settings/voice')          → Voice Input sub-screen
 *   router.push('/settings/agents')         → Agents sub-screen
 *   router.push('/settings/metrics')        → Metrics Export sub-screen
 *   router.push('/settings/support')        → Support sub-screen
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 0
 */

import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { useState, useEffect } from 'react';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { supabase } from '../../src/lib/supabase';
import { useCurrentUser } from '../../src/hooks/useCurrentUser';
import { useSubscriptionTier } from '../../src/hooks/useSubscriptionTier';
import { SectionHeader, SettingRow } from '../../src/components/ui';
import { THEME_PREFERENCE_KEY } from '../../src/contexts/ThemeContext';

// ============================================================================
// Constants
// ============================================================================

/**
 * App version string for the footer.
 * WHY module-scope: the version never changes at runtime, so reading it once
 * avoids unnecessary re-reads on every render.
 */
const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0';
const BUILD_NUMBER = Constants.expoConfig?.ios?.buildNumber ?? '1';

// ============================================================================
// Component
// ============================================================================

/**
 * Settings hub orchestrator screen.
 *
 * Fetches:
 * - useCurrentUser() → display name + email for the profile header
 * - useSubscriptionTier() → tier subtitle on Account row
 * - push_enabled from notification_preferences → subtitle on Notifications row
 * - theme preference from SecureStore → subtitle on Appearance row
 *
 * Everything else is loaded lazily on the sub-screen it belongs to.
 *
 * @returns React element
 */
export default function SettingsHubScreen() {
  const router = useRouter();
  const { user, isLoading: isLoadingUser } = useCurrentUser();
  const { tier } = useSubscriptionTier(user?.id ?? null);

  /**
   * Push notifications enabled state from notification_preferences.
   * WHY load here: displayed in the Notifications row subtitle so the user
   * can see at a glance whether push is on without navigating in.
   */
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null);

  /**
   * Current theme preference loaded from SecureStore.
   * WHY load here: displayed in the Appearance row subtitle.
   */
  const [themeLabel, setThemeLabel] = useState<string>('System');

  // --------------------------------------------------------------------------
  // Mount: Load hub-level data
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!user) return;

    // Load push_enabled for Notifications row subtitle
    (async () => {
      try {
        const { data } = await supabase
          .from('notification_preferences')
          .select('push_enabled')
          .eq('user_id', user.id)
          .single();

        if (data) {
          setPushEnabled(data.push_enabled);
        }
      } catch {
        // Non-fatal: subtitle shows nothing
      }
    })();

    // Load theme from SecureStore for Appearance row subtitle
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(THEME_PREFERENCE_KEY);
        if (stored === 'dark' || stored === 'light' || stored === 'system') {
          setThemeLabel(stored.charAt(0).toUpperCase() + stored.slice(1));
        }
      } catch {
        // Non-fatal: keep default 'System'
      }
    })();
  }, [user]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <ScrollView className="flex-1 bg-background">
      {/* Profile Header */}
      <View className="items-center py-6">
        {isLoadingUser ? (
          <ActivityIndicator size="small" color="#f97316" accessibilityLabel="Loading profile" />
        ) : (
          <>
            <View
              className="w-16 h-16 rounded-full items-center justify-center mb-3"
              style={{ backgroundColor: '#f9731620' }}
            >
              <Text className="text-2xl font-bold text-brand">
                {user?.initial ?? '?'}
              </Text>
            </View>
            <Text className="text-white font-semibold text-lg">
              {user?.displayName ?? user?.email ?? 'Settings'}
            </Text>
            {user?.email && user.displayName && (
              <Text className="text-zinc-500 text-sm">{user.email}</Text>
            )}
          </>
        )}
      </View>

      {/* Account & Billing */}
      <SectionHeader title="Account" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="person-circle"
          iconColor="#f97316"
          title="Account"
          subtitle={tier ? `${tier.charAt(0).toUpperCase() + tier.slice(1)} Plan` : 'Manage profile & billing'}
          onPress={() => router.push('/settings/account')}
        />
        {/*
         * WHY passkeys is a sibling of account (not nested inside it):
         * Passkey management has its own fetch/enroll/revoke lifecycle.
         * A top-level settings row keeps the Account sub-screen lean and
         * surfaces passkeys prominently so users can find it without drilling
         * into Account > Security.
         */}
        <SettingRow
          icon="key"
          iconColor="#f59e0b"
          title="Passkeys"
          subtitle="Sign in with Face ID or Touch ID"
          onPress={() => router.push('/settings/passkeys')}
        />
      </View>

      {/* Preferences */}
      <SectionHeader title="Preferences" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="notifications"
          iconColor="#eab308"
          title="Notifications"
          subtitle={pushEnabled === null ? 'Push, email, quiet hours' : pushEnabled ? 'Push enabled' : 'Push disabled'}
          onPress={() => router.push('/settings/notifications')}
        />
        <SettingRow
          icon="color-palette"
          iconColor="#f97316"
          title="Appearance"
          subtitle={`Theme: ${themeLabel}`}
          onPress={() => router.push('/settings/appearance')}
        />
        <SettingRow
          icon="mic"
          iconColor="#f97316"
          title="Voice Input"
          subtitle="Speech-to-text transcription"
          onPress={() => router.push('/settings/voice')}
        />
      </View>

      {/* Developer */}
      <SectionHeader title="Developer" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="terminal"
          iconColor="#f97316"
          title="Agents"
          subtitle="Configure your AI agents"
          onPress={() => router.push('/settings/agents')}
        />
        <SettingRow
          icon="pulse"
          iconColor="#8b5cf6"
          title="Metrics Export"
          subtitle={tier === 'power' ? 'OTEL export' : 'Power plan required'}
          onPress={() => router.push('/settings/metrics')}
        />
        <SettingRow
          icon="git-network"
          iconColor="#8b5cf6"
          title="Webhooks"
          subtitle="Real-time event notifications"
          onPress={() => router.push('/webhooks')}
        />
        <SettingRow
          icon="code-slash"
          iconColor="#3b82f6"
          title="API Keys"
          subtitle="Programmatic API access"
          onPress={() => router.push('/api-keys')}
        />
        <SettingRow
          icon="hardware-chip"
          iconColor="#f97316"
          title="Paired Devices"
          subtitle="Manage paired CLI machines"
          onPress={() => router.push('/devices')}
        />
      </View>

      {/* Support */}
      <SectionHeader title="Support" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="help-circle"
          iconColor="#71717a"
          title="Help & Feedback"
          subtitle="FAQ, send feedback, legal"
          onPress={() => router.push('/settings/support')}
        />
      </View>

      {/* Version footer */}
      <Text className="text-zinc-600 text-center text-xs mt-4 mb-8">
        Styrby v{APP_VERSION} ({BUILD_NUMBER})
      </Text>
    </ScrollView>
  );
}
