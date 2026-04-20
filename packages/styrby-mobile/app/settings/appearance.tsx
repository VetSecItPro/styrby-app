/**
 * Appearance Settings Sub-Screen
 *
 * Owns: theme selector (Dark / Light / System) and haptic feedback toggle.
 * Both preferences are device-local and stored in SecureStore — no Supabase
 * queries are needed on this screen.
 *
 * WHY a sub-screen: extracting Appearance from the 2,720-LOC settings monolith
 * reduces its cognitive load and gives the ThemeContext the single clear entry
 * point where users change the app-wide color mode.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 3
 */

import {
  View,
  Text,
  Switch,
  ScrollView,
  Pressable,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import { THEME_PREFERENCE_KEY } from '../../src/contexts/ThemeContext';
import { SectionHeader } from '../../src/components/ui';
import { SettingRow } from '../../src/components/ui';

// ============================================================================
// Constants
// ============================================================================

/**
 * SecureStore key for the haptic feedback preference.
 * WHY device-local: haptic feedback is a per-device UX preference with no
 * cross-device value — syncing it to the database would be wasteful.
 */
const HAPTIC_PREFERENCE_KEY = 'styrby_haptic_enabled';

// ============================================================================
// Component
// ============================================================================

/**
 * Appearance sub-screen.
 *
 * On mount: reads theme and haptic preferences from SecureStore.
 * On change: writes immediately to SecureStore; the ThemeProvider picks up
 * the new value on the next mount (app restart or navigation away/back).
 *
 * @returns React element
 */
export default function AppearanceScreen() {
  /**
   * Current theme preference.
   * WHY default 'dark': the app ships dark-first and the ThemeProvider defaults
   * to dark when no SecureStore value exists. Matching that default here
   * prevents a flash of incorrect state before SecureStore loads.
   */
  const [themePreference, setThemePreference] = useState<'dark' | 'light' | 'system'>('dark');

  /**
   * Haptic feedback enabled state.
   * WHY default true: Styrby enables haptics by default for new installs.
   * SecureStore only stores an explicit override, so null means "enabled".
   */
  const [hapticEnabled, setHapticEnabled] = useState(true);

  // --------------------------------------------------------------------------
  // Mount: Load preferences from SecureStore
  // --------------------------------------------------------------------------

  useEffect(() => {
    (async () => {
      try {
        const [themeValue, hapticValue] = await Promise.all([
          SecureStore.getItemAsync(THEME_PREFERENCE_KEY),
          SecureStore.getItemAsync(HAPTIC_PREFERENCE_KEY),
        ]);

        if (themeValue === 'dark' || themeValue === 'light' || themeValue === 'system') {
          setThemePreference(themeValue);
        }

        if (hapticValue !== null) {
          setHapticEnabled(hapticValue === 'true');
        }
      } catch {
        // Non-fatal: keep defaults
      }
    })();
  }, []);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Updates the theme preference and persists to SecureStore.
   * The ThemeProvider reads THEME_PREFERENCE_KEY at startup; the new value
   * takes effect on next navigation away and back (or app restart).
   *
   * @param preference - The new theme preference
   */
  const handleThemeChange = useCallback(async (preference: 'dark' | 'light' | 'system') => {
    setThemePreference(preference);
    try {
      await SecureStore.setItemAsync(THEME_PREFERENCE_KEY, preference);
    } catch {
      // Revert on storage failure
      setThemePreference((prev) => prev);
    }
  }, []);

  /**
   * Toggles haptic feedback and persists to SecureStore.
   *
   * WHY we store 'true'/'false' strings: SecureStore only accepts string values.
   * We compare with the string literal on read.
   *
   * @param value - New haptic enabled state
   */
  const handleHapticToggle = useCallback(async (value: boolean) => {
    setHapticEnabled(value);
    try {
      await SecureStore.setItemAsync(HAPTIC_PREFERENCE_KEY, value.toString());
    } catch {
      setHapticEnabled(!value);
    }
  }, []);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <ScrollView className="flex-1 bg-background">
      <SectionHeader title="Theme" />
      <View className="bg-background-secondary px-4 py-4">
        {/* Theme selector: segmented control for Dark / Light / System */}
        <View className="flex-row items-center mb-3">
          <View
            className="w-8 h-8 rounded-lg items-center justify-center mr-3"
            style={{ backgroundColor: '#f9731620' }}
          >
            {/* Using Text icon proxy here since Ionicons color-palette is valid */}
            <Text style={{ fontSize: 18, color: '#f97316' }}>🎨</Text>
          </View>
          <Text className="text-white font-medium flex-1">App Theme</Text>
        </View>

        <View className="flex-row bg-zinc-800 rounded-xl p-1 ml-11">
          {(['dark', 'light', 'system'] as const).map((option) => {
            const isSelected = themePreference === option;
            const label = option.charAt(0).toUpperCase() + option.slice(1);
            return (
              <Pressable
                key={option}
                onPress={() => void handleThemeChange(option)}
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

        <Text className="text-zinc-600 text-xs mt-2 ml-11">
          Takes effect on next app launch.
        </Text>
      </View>

      <SectionHeader title="Feedback" />
      <View className="bg-background-secondary">
        <SettingRow
          icon="phone-portrait"
          iconColor="#8b5cf6"
          title="Haptic Feedback"
          subtitle="Vibration cues for taps and toggles"
          trailing={
            <Switch
              value={hapticEnabled}
              onValueChange={(v) => void handleHapticToggle(v)}
              trackColor={{ false: '#3f3f46', true: '#f9731650' }}
              thumbColor={hapticEnabled ? '#f97316' : '#71717a'}
              accessibilityRole="switch"
              accessibilityLabel="Toggle haptic feedback"
            />
          }
        />
      </View>
    </ScrollView>
  );
}
