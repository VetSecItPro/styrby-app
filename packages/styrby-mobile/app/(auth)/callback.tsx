/**
 * Auth Callback Screen
 *
 * Handles OAuth and magic link callbacks after the user authenticates
 * via an external provider (GitHub) or clicks a magic link in email.
 *
 * URL pattern: `styrby://auth/callback?code=...&type=...`
 *
 * Flow:
 * 1. Extracts `code` and `type` query parameters from the deep link URL
 * 2. Exchanges the authorization code for a Supabase session
 * 3. On success, redirects the user to the main dashboard `/(tabs)`
 * 4. On failure, shows an error message with a "Try Again" button
 *
 * WHY this is a dedicated screen instead of handling in the root layout:
 * Supabase OAuth and magic link flows redirect to `styrby://auth/callback`
 * with an authorization code. This screen provides visual feedback during
 * the token exchange (loading spinner) and handles errors gracefully rather
 * than silently failing in a background listener.
 */

import { useEffect, useState, useRef } from 'react';
import { View, Text, ActivityIndicator, Pressable } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/lib/supabase';

/** Possible states for the callback processing lifecycle */
type CallbackStatus = 'processing' | 'success' | 'error';

/**
 * Auth callback screen component.
 *
 * Mounts when the app receives a `styrby://auth/callback` deep link.
 * Extracts the authorization code from query parameters, exchanges it
 * for a valid Supabase session, and navigates accordingly.
 *
 * @returns React element showing processing state, success, or error
 */
export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<{ code?: string; type?: string }>();
  const [status, setStatus] = useState<CallbackStatus>('processing');
  const [errorMessage, setErrorMessage] = useState<string>('');

  /**
   * WHY: Prevent the exchange from firing twice in React strict mode or
   * if the component re-mounts. Supabase authorization codes are single-use,
   * so a duplicate call would fail with a confusing "invalid grant" error.
   */
  const hasExchanged = useRef<boolean>(false);

  useEffect(() => {
    handleAuthCallback();
  }, []);

  /**
   * Processes the auth callback by extracting the code from URL params
   * and exchanging it for a Supabase session.
   *
   * @returns void
   */
  async function handleAuthCallback(): Promise<void> {
    // Guard against double execution
    if (hasExchanged.current) return;
    hasExchanged.current = true;

    const { code } = params;

    if (!code) {
      setStatus('error');
      setErrorMessage(
        'No authorization code found. The link may have expired or been used already.'
      );
      return;
    }

    try {
      const { error } = await supabase.auth.exchangeCodeForSession(code);

      if (error) {
        setStatus('error');
        setErrorMessage(error.message);
        return;
      }

      setStatus('success');

      // WHY: Short delay before navigating so the success state is visible
      // and the auth state change listener in _layout.tsx has time to update.
      // Without this, the navigation can race with the auth state listener
      // causing a brief flash of the login screen.
      setTimeout(() => {
        router.replace('/(tabs)');
      }, 500);
    } catch (err) {
      setStatus('error');
      setErrorMessage(
        err instanceof Error ? err.message : 'An unexpected error occurred during sign-in.'
      );
    }
  }

  /**
   * Navigates the user back to the login screen to retry authentication.
   *
   * @returns void
   */
  function handleRetry(): void {
    router.replace('/(auth)/login');
  }

  // --------------------------------------------------------------------------
  // Processing State
  // --------------------------------------------------------------------------

  if (status === 'processing') {
    return (
      <View
        className="flex-1 bg-zinc-950 items-center justify-center px-8"
        accessibilityRole="alert"
        accessibilityLabel="Signing you in"
      >
        <View className="w-20 h-20 rounded-3xl bg-brand/15 items-center justify-center mb-6">
          <ActivityIndicator size="large" color="#f97316" />
        </View>
        <Text className="text-white text-2xl font-bold text-center mb-2">
          Signing You In
        </Text>
        <Text className="text-zinc-400 text-base text-center">
          Completing authentication...
        </Text>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Success State
  // --------------------------------------------------------------------------

  if (status === 'success') {
    return (
      <View
        className="flex-1 bg-zinc-950 items-center justify-center px-8"
        accessibilityRole="alert"
        accessibilityLabel="Sign in successful"
      >
        <View className="w-20 h-20 rounded-3xl bg-green-500/15 items-center justify-center mb-6">
          <Ionicons name="checkmark-circle" size={44} color="#22c55e" />
        </View>
        <Text className="text-white text-2xl font-bold text-center mb-2">
          Welcome Back
        </Text>
        <Text className="text-zinc-400 text-base text-center">
          Redirecting to dashboard...
        </Text>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Error State
  // --------------------------------------------------------------------------

  return (
    <View
      className="flex-1 bg-zinc-950 items-center justify-center px-8"
      accessibilityRole="alert"
      accessibilityLabel="Sign in failed"
    >
      <View className="w-20 h-20 rounded-3xl bg-red-500/15 items-center justify-center mb-6">
        <Ionicons name="alert-circle" size={44} color="#ef4444" />
      </View>
      <Text className="text-white text-2xl font-bold text-center mb-2">
        Sign In Failed
      </Text>
      <Text className="text-zinc-400 text-base text-center mb-2">
        We couldn't complete your sign-in. This can happen if the link
        expired or was already used.
      </Text>
      <Text className="text-zinc-600 text-sm text-center mb-8" numberOfLines={3}>
        {errorMessage}
      </Text>
      <Pressable
        onPress={handleRetry}
        className="bg-brand px-8 py-4 rounded-2xl flex-row items-center active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Try signing in again"
      >
        <Ionicons name="refresh" size={20} color="white" />
        <Text className="text-white text-lg font-semibold ml-2">Try Again</Text>
      </Pressable>
    </View>
  );
}
