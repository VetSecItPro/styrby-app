/**
 * Root Layout
 *
 * Sets up the navigation stack, auth state, and global providers.
 */

// WHY Sentry must be initialised before any other imports in _layout.tsx:
// @sentry/react-native wraps React Native's global error handler and the
// React error boundary machinery at init time. If any navigation or component
// code runs first, JS crashes that occur before this point escape Sentry
// capture. The import side-effect is intentional — do not move this block.
import { initMobileSentry } from '../src/observability/sentry';
initMobileSentry();

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
import { startConnectivityListener } from '../src/services/offline-sync';
import { useInviteLinkHandler } from '../src/hooks/useInviteLinkHandler';
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

  /**
   * WHY at root layout: useInviteLinkHandler must be called exactly once at
   * the app root so it can intercept both cold-start and warm-start invite
   * deep-links regardless of which screen is currently active. Placing it
   * here (RootLayout) guarantees it mounts before any route renders.
   */
  useInviteLinkHandler();

  // Re-register push token when user signs in (token may have been obtained
  // before auth was available, so savePushToken would have silently failed).
  useEffect(() => {
    if (session && !isPushRegistered) {
      registerPush();
    }
  }, [session, isPushRegistered, registerPush]);

  // WHY: Start the offline sync connectivity listener when the user is
  // authenticated. This uses @react-native-community/netinfo to detect
  // online/offline transitions and automatically syncs locally stored
  // commands to the Supabase offline_command_queue table when the device
  // comes back online. The listener is cleaned up on unmount or sign-out.
  useEffect(() => {
    if (!session) return;

    const unsubscribe = startConnectivityListener();
    return unsubscribe;
  }, [session]);

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
    // WHY: The shared session viewer is a public deep-link target. It does not
    // require authentication — anyone with the share link should be able to view
    // the session replay. We exempt it from the auth/onboarding redirect guards.
    const inShared = segments[0] === 'shared';
    // WHY: The invite accept screen is a deep-link entry point that handles its
    // own auth check internally (redirects to login with returnTo if no session).
    // A brand-new user arriving via an invite link must reach InviteAcceptScreen
    // before we know whether onboarding is needed — exempting it here lets
    // InviteAcceptScreen's own returnTo logic fire correctly after auth completes.
    const inInvite = segments[0] === 'invite';

    // Not onboarded → show onboarding (public screens exempt)
    if (!hasOnboarded && !inOnboarding && !inShared && !inInvite) {
      router.replace('/onboarding');
      return;
    }

    // Onboarded but not logged in → show login (unless already in auth, shared, or invite)
    if (hasOnboarded && !session && !inAuthGroup && !inShared && !inInvite) {
      router.replace('/(auth)/login');
      return;
    }

    // Logged in → go to tabs (unless already there or on a public screen)
    if (session && !inTabs && !inAuthGroup && !inShared) {
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
        <Stack.Screen
          name="team/invite"
          options={{
            title: 'Invite Member',
            presentation: 'card',
          }}
        />
        {/*
         * Shared session viewer - public screen, no auth required.
         * Handles the deep link: styrby://shared/{shareId}
         * Expo Router maps the file app/shared/[shareId].tsx to this route.
         */}
        <Stack.Screen
          name="shared/[shareId]"
          options={{
            title: 'Session Replay',
            presentation: 'card',
          }}
        />
        {/*
         * Team invitation deep-link route.
         * Handles: https://styrbyapp.com/invite/<token>
         *          styrby://invite/<token>
         *
         * The `[token]` segment is extracted by Expo Router and forwarded to
         * InviteAcceptScreen via useLocalSearchParams(). No auth is checked
         * here — InviteAcceptScreen handles the auth guard internally and
         * redirects to login with a returnTo param if the user is not signed in.
         */}
        <Stack.Screen
          name="invite/[token]"
          options={{
            title: 'Team Invitation',
            presentation: 'card',
          }}
        />
        {/*
         * Settings route group scaffold - additive during Phase 0.6.1 refactor.
         * Registering the group here lets Expo Router know that `/settings`
         * is a valid deep-link target. The hub itself is still a scaffold
         * until sub-screens S5-S11 are migrated; the tab `(tabs)/settings.tsx`
         * remains the live settings UI until S4 flips it to a redirect.
         *
         * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 2
         */}
        <Stack.Screen
          name="settings"
          options={{
            headerShown: false,
          }}
        />
        {/*
         * MCP approval deep-link route.
         * Handles: styrby://mcp-approval/<approvalId>
         *
         * Routed to from useNotifications when a push payload arrives with
         * data.screen='mcp_approval' (sent by the audit_log push trigger after
         * the CLI's `styrby mcp serve` records mcp_approval_requested).
         *
         * `presentation: 'modal'` so a foregrounded user keeps their context
         * underneath; backgrounded users get a normal stack push from the
         * deep-link handler.
         */}
        <Stack.Screen
          name="mcp-approval/[approvalId]"
          options={{
            title: 'Approval requested',
            presentation: 'modal',
          }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}
