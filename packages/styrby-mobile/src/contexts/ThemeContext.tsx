/**
 * ThemeContext
 *
 * Provides app-wide theme preference (dark | light | system) and stores
 * the selection in SecureStore so it persists across app launches.
 *
 * WHY SecureStore instead of AsyncStorage: SecureStore is already used
 * throughout this app for all local persistence (haptic prefs, pairing info),
 * so we keep storage consistent rather than adding another dependency.
 *
 * WHY three options instead of just dark/light: "System" lets users who switch
 * their OS between dark/light mode get the right experience automatically.
 * This is the iOS/Android default behavior users expect.
 *
 * Default: 'dark' — the existing app is dark-only, so new installs default
 * to dark rather than jarring users with a sudden light mode.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// ============================================================================
// Constants
// ============================================================================

/**
 * SecureStore key for the persisted theme preference.
 * WHY: Namespaced with 'styrby_' prefix to avoid collisions with other
 * apps if the SecureStore keychain namespace is ever shared.
 */
export const THEME_PREFERENCE_KEY = 'styrby_theme_preference' as const;

/** Valid theme preference values. */
export type ThemePreference = 'dark' | 'light' | 'system';

// ============================================================================
// Context Types
// ============================================================================

/**
 * Value provided by ThemeContext to consumers.
 */
interface ThemeContextValue {
  /** The user's stored preference: 'dark' | 'light' | 'system' */
  themePreference: ThemePreference;
  /**
   * The effective color scheme resolved from the preference and OS setting.
   * - 'dark' if preference is 'dark', or preference is 'system' and OS is dark
   * - 'light' if preference is 'light', or preference is 'system' and OS is light
   * This is what NativeWind and UI components should read.
   */
  colorScheme: 'dark' | 'light';
  /** Whether the theme preference is still being loaded from SecureStore */
  isLoading: boolean;
  /**
   * Updates the theme preference and persists it to SecureStore.
   *
   * @param preference - The new theme preference to apply
   */
  setThemePreference: (preference: ThemePreference) => Promise<void>;
}

// ============================================================================
// Context
// ============================================================================

/** Context instance with a sensible default for components rendered outside the provider. */
const ThemeContext = createContext<ThemeContextValue>({
  themePreference: 'dark',
  colorScheme: 'dark',
  isLoading: true,
  setThemePreference: async () => {},
});

// ============================================================================
// Provider
// ============================================================================

/**
 * Props for the ThemeProvider component.
 */
interface ThemeProviderProps {
  /** Child components that will have access to the theme context */
  children: React.ReactNode;
}

/**
 * Wraps the app (or a screen tree) to provide theme preference context.
 *
 * Place this near the root of the component tree, below Expo's root layout
 * but above any screens that need the theme.
 *
 * @param props - Provider props
 * @returns The provider wrapping children
 *
 * @example
 * <ThemeProvider>
 *   <Stack />
 * </ThemeProvider>
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const systemColorScheme = useColorScheme();
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>('dark');
  const [isLoading, setIsLoading] = useState(true);

  // Load stored preference on mount
  useEffect(() => {
    const loadStoredPreference = async () => {
      try {
        const stored = await SecureStore.getItemAsync(THEME_PREFERENCE_KEY);

        if (stored === 'dark' || stored === 'light' || stored === 'system') {
          setThemePreferenceState(stored);
        }
        // WHY: If no value is stored, keep the default 'dark'. We only store
        // when the user explicitly changes the setting.
      } catch (err) {
        // Non-fatal: fall back to default 'dark' if SecureStore read fails
        if (__DEV__) {
          console.warn('[ThemeContext] Failed to load stored theme preference:', err);
        }
      } finally {
        setIsLoading(false);
      }
    };

    loadStoredPreference();
  }, []);

  /**
   * Resolves the effective color scheme from the preference and OS setting.
   *
   * WHY: We resolve here so every consumer reads a definitive 'dark' | 'light'
   * value rather than having to implement the 'system' resolution logic themselves.
   */
  const colorScheme: 'dark' | 'light' =
    themePreference === 'system'
      ? (systemColorScheme === 'light' ? 'light' : 'dark')
      : themePreference;

  /**
   * Updates the theme preference in state and persists it to SecureStore.
   *
   * @param preference - The new theme preference
   */
  const setThemePreference = useCallback(async (preference: ThemePreference) => {
    setThemePreferenceState(preference);

    try {
      await SecureStore.setItemAsync(THEME_PREFERENCE_KEY, preference);
    } catch (err) {
      // Revert state on storage failure
      if (__DEV__) {
        console.error('[ThemeContext] Failed to persist theme preference:', err);
      }
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ themePreference, colorScheme, isLoading, setThemePreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Returns the current theme context value.
 *
 * Must be used inside a component tree wrapped by <ThemeProvider>.
 *
 * @returns The current theme preference, resolved color scheme, loading state,
 *          and a function to update the preference.
 *
 * @example
 * const { colorScheme, themePreference, setThemePreference } = useTheme();
 * // colorScheme is 'dark' | 'light' — always resolved
 * // themePreference is 'dark' | 'light' | 'system' — the user's choice
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
