/**
 * Root Layout
 *
 * Sets up the navigation stack, auth state, and global providers.
 */

import { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SecureStore from 'expo-secure-store';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../src/lib/supabase';
import { useNotifications } from '../src/hooks/useNotifications';
import type { Session } from '@supabase/supabase-js';

import type { ErrorBoundaryProps } from 'expo-router';

import '../global.css';

// Prevent auto-hide splash screen
SplashScreen.preventAutoHideAsync();

/**
 * Root-level error boundary.
 *
 * Catches unhandled rendering errors from any route that doesn't define its
 * own ErrorBoundary. Displays a full-screen recovery UI with the error
 * message and a retry action.
 *
 * @param error - The error thrown during rendering
 * @param retry - Callback that clears the error and re-renders the route
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <View
        className="flex-1 bg-zinc-950 items-center justify-center px-8"
        accessibilityRole="alert"
      >
        <View className="w-20 h-20 rounded-3xl bg-red-500/15 items-center justify-center mb-6">
          <Ionicons name="alert-circle" size={44} color="#ef4444" />
        </View>
        <Text className="text-white text-2xl font-bold text-center mb-2">
          Unexpected Error
        </Text>
        <Text className="text-zinc-400 text-base text-center mb-2">
          Something went wrong. You can try again or restart the app.
        </Text>
        <Text className="text-zinc-600 text-sm text-center mb-8" numberOfLines={3}>
          {error.message}
        </Text>
        <Pressable
          onPress={retry}
          className="bg-brand px-8 py-4 rounded-2xl flex-row items-center active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Retry after error"
        >
          <Ionicons name="refresh" size={20} color="white" />
          <Text className="text-white text-lg font-semibold ml-2">Try Again</Text>
        </Pressable>
      </View>
    </GestureHandlerRootView>
  );
}

const ONBOARDING_KEY = 'styrby_onboarded';

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const [session, setSession] = useState<Session | null>(null);
  const [hasOnboarded, setHasOnboarded] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [initError, setInitError] = useState<Error | null>(null);

  /**
   * WHY: useNotifications handles push token registration, foreground
   * notification listeners, and tap-to-navigate routing. It is called
   * unconditionally here (hooks cannot be conditional) but its internal
   * savePushToken() gracefully handles the case where no user is
   * authenticated yet. We call `register` again when a session becomes
   * available to ensure the token is persisted to the device_tokens table.
   */
  const { isRegistered: isPushRegistered, register: registerPush } = useNotifications();

  // Re-register push token when user signs in (token may have been obtained
  // before auth was available, so savePushToken would have silently failed).
  useEffect(() => {
    if (session && !isPushRegistered) {
      registerPush();
    }
  }, [session, isPushRegistered, registerPush]);

  /**
   * Runs the initialization sequence: checks onboarding status and
   * fetches the current auth session. Sets `initError` on failure so
   * the UI can display a recovery screen instead of silently failing.
   */
  const initialize = useCallback(async () => {
    setInitError(null);
    setIsLoading(true);

    try {
      // Check onboarding status
      const onboarded = await SecureStore.getItemAsync(ONBOARDING_KEY);
      setHasOnboarded(onboarded === 'true');

      // Get current session
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);
    } catch (error) {
      // WHY: Initialization failures (e.g. SecureStore inaccessible, Supabase
      // unreachable) leave the app in an unusable state. Rather than showing a
      // blank screen, we capture the error and render a recovery UI with a
      // retry button so users can recover without force-quitting the app.
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      setInitError(normalizedError);
    } finally {
      setIsLoading(false);
      SplashScreen.hideAsync();
    }
  }, []);

  // Check auth state and onboarding status
  useEffect(() => {
    initialize();

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, [initialize]);

  // Handle routing based on auth state
  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === '(auth)';
    const inOnboarding = segments[0] === 'onboarding';
    const inTabs = segments[0] === '(tabs)';

    // Not onboarded → show onboarding
    if (!hasOnboarded && !inOnboarding) {
      router.replace('/onboarding');
      return;
    }

    // Onboarded but not logged in → show login (unless already in auth)
    if (hasOnboarded && !session && !inAuthGroup) {
      router.replace('/(auth)/login');
      return;
    }

    // Logged in → go to tabs (unless already there)
    if (session && !inTabs && !inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [session, hasOnboarded, segments, isLoading, router]);

  // Mark onboarding complete
  useEffect(() => {
    const markOnboarded = async () => {
      if (session && !hasOnboarded) {
        await SecureStore.setItemAsync(ONBOARDING_KEY, 'true');
        setHasOnboarded(true);
      }
    };
    markOnboarded();
  }, [session, hasOnboarded]);

  // Initialization failed — show a recovery screen with retry action.
  // This prevents the app from appearing blank or frozen when SecureStore,
  // Supabase, or the network are unavailable during startup.
  if (initError) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar style="light" />
        <View
          className="flex-1 bg-zinc-950 items-center justify-center px-8"
          accessibilityRole="alert"
        >
          {/* Error Icon */}
          <View className="w-20 h-20 rounded-3xl bg-red-500/15 items-center justify-center mb-6">
            <Ionicons name="alert-circle" size={44} color="#ef4444" />
          </View>

          {/* Error Message */}
          <Text className="text-white text-2xl font-bold text-center mb-2">
            Something went wrong
          </Text>
          <Text className="text-zinc-400 text-base text-center mb-2">
            Styrby couldn't start properly. This is usually caused by a
            network issue or a problem reading local data.
          </Text>
          <Text className="text-zinc-600 text-sm text-center mb-8" numberOfLines={2}>
            {initError.message}
          </Text>

          {/* Retry Button */}
          <Pressable
            onPress={initialize}
            className="bg-brand px-8 py-4 rounded-2xl flex-row items-center active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel="Retry app initialization"
          >
            <Ionicons name="refresh" size={20} color="white" />
            <Text className="text-white text-lg font-semibold ml-2">Retry</Text>
          </Pressable>
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#09090b' },
          headerTintColor: '#fff',
          contentStyle: { backgroundColor: '#09090b' },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen
          name="onboarding"
          options={{
            headerShown: false,
            gestureEnabled: false,
          }}
        />
        <Stack.Screen
          name="agent-config"
          options={{
            title: 'Agent Configuration',
            presentation: 'card',
          }}
        />
        <Stack.Screen
          name="budget-alerts"
          options={{
            title: 'Budget Alerts',
            presentation: 'card',
          }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}
