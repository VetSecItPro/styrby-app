/**
 * Login Screen
 *
 * Authentication options: magic link, email/password, GitHub OAuth, passkey.
 *
 * WHY passkey is included here:
 * Passkeys provide phishing-resistant biometric login (NIST AAL3). For users
 * who have already enrolled a passkey, this is the fastest path - no email
 * round-trip, no password. The button is shown for all users; those without
 * a passkey registered will see a graceful "none registered" prompt and can
 * enroll in Settings > Passkeys.
 *
 * WHY we proxy through the web app's API routes:
 * The passkey challenge/verify logic runs in Supabase edge functions and
 * requires the service role key for some operations. The mobile app never
 * holds the service role key. Instead we route through the Next.js proxy
 * (getApiBaseUrl() + /api/auth/passkey/...) which keeps secrets server-side.
 *
 * Standards: WebAuthn L3, FIDO2 CTAP2.2, NIST 800-63B AAL3
 */

import { View, Text, TextInput, Pressable, Alert, ActivityIndicator } from 'react-native';
import { useState } from 'react';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/lib/supabase';
import { getApiBaseUrl } from '../../src/lib/config';
// WHY bare 'expo-passkey' not 'expo-passkey/native': Metro (pre-0.82) does
// not honor the package's `exports` map, so subpath imports fail at bundle
// time. Importing the package name instead lets Metro's platform-aware
// resolution pick up `build/index.native.js` (the native client) over
// `build/index.js` (the guard-rail stub) automatically.
// Types are augmented locally via types/expo-passkey.d.ts.
import ExpoPasskey from 'expo-passkey';

// ============================================================================
// Types
// ============================================================================

type AuthMode = 'magic_link' | 'password' | 'signup';

// ============================================================================
// Constants
// ============================================================================

/**
 * WebAuthn user-facing error name for cancellation / no credential.
 * WHY: We want to show a graceful "no passkey registered" message rather
 * than a generic error when the user has no credentials on this device.
 */
const WEBAUTHN_NOT_ALLOWED = 'NotAllowedError';

// ============================================================================
// Component
// ============================================================================

/**
 * Login screen with OTP, password, OAuth, and passkey options.
 *
 * @returns React Native element
 */
export default function LoginScreen() {
  const [mode, setMode] = useState<AuthMode>('magic_link');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  const handleMagicLink = async () => {
    if (!email.trim()) {
      Alert.alert('Error', 'Please enter your email');
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: 'styrby://auth/callback',
        },
      });

      if (error) throw error;
      setMagicLinkSent(true);
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to send magic link');
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordAuth = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Error', 'Please enter email and password');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password: password.trim(),
        });
        if (error) throw error;
        Alert.alert('Success', 'Check your email to confirm your account');
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password: password.trim(),
        });
        if (error) throw error;
        router.replace('/(tabs)');
      }
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGitHubAuth = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: 'styrby://auth/callback',
        },
      });
      if (error) throw error;
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'GitHub auth failed');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Passkey authentication flow for mobile.
   *
   * Flow:
   *   1. POST challenge-login to web API proxy (returns WebAuthn options)
   *   2. expo-passkey.Passkey.authenticate(options) -- triggers Face ID/Touch ID
   *   3. POST verify-login with assertion response
   *   4. Set Supabase session from returned tokens
   *
   * WHY empty email is allowed:
   * The edge function implements account-enumeration resistance: it returns
   * an empty allowCredentials list for unknown/unregistered emails instead
   * of an error. The device's passkey manager will then show all available
   * credentials rather than filtering by a specific credential ID.
   * This means users can tap the passkey button without typing their email.
   */
  const handlePasskeyLogin = async () => {
    setPasskeyLoading(true);
    try {
      const apiBase = getApiBaseUrl();

      // 1. Request challenge
      const challengeRes = await fetch(`${apiBase}/api/auth/passkey/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'challenge-login',
          email: email.trim() || undefined,
        }),
      });

      if (!challengeRes.ok) {
        const err = await challengeRes.json().catch(() => ({}));
        throw new Error(err.message ?? 'Failed to get passkey challenge');
      }

      const challengeData = await challengeRes.json();

      // 2. Invoke native passkey UI (Face ID / Touch ID / PIN)
      // expo-passkey returns a JSON-string credential per WebAuthn L3.
      const assertionJson = await ExpoPasskey.authenticateWithPasskey({
        requestJson: JSON.stringify(challengeData),
      });
      const assertionResponse = JSON.parse(assertionJson);

      // 3. Verify the assertion
      const verifyRes = await fetch(`${apiBase}/api/auth/passkey/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'verify-login',
          response: assertionResponse,
          email: email.trim() || undefined,
        }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.message ?? 'Passkey verification failed');
      }

      const verifyData = await verifyRes.json();

      // 4. Hydrate the Supabase session
      if (verifyData.access_token && verifyData.refresh_token) {
        await supabase.auth.setSession({
          access_token: verifyData.access_token,
          refresh_token: verifyData.refresh_token,
        });
      }

      router.replace('/(tabs)');
    } catch (error) {
      if (error instanceof Error && error.name === WEBAUTHN_NOT_ALLOWED) {
        // WHY this message: distinguish "no passkey on device" from "auth error"
        // so the user knows to go to Settings > Passkeys to enroll first.
        Alert.alert(
          'No passkey found',
          "You haven't registered a passkey yet. Sign in with email, then add a passkey in Settings - Passkeys.",
        );
      } else {
        Alert.alert(
          'Passkey sign-in failed',
          error instanceof Error ? error.message : 'Try again or use another sign-in method.',
        );
      }
    } finally {
      setPasskeyLoading(false);
    }
  };

  if (magicLinkSent) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-8">
        <View className="w-16 h-16 rounded-2xl bg-green-500/20 items-center justify-center mb-6">
          <Ionicons name="mail" size={32} color="#22c55e" />
        </View>
        <Text className="text-white text-2xl font-bold text-center mb-3">
          Check Your Email
        </Text>
        <Text className="text-zinc-400 text-center mb-8">
          We sent a magic link to{'\n'}
          <Text className="text-zinc-200">{email}</Text>
        </Text>
        <Pressable
          onPress={() => setMagicLinkSent(false)}
          className="py-3"
        >
          <Text className="text-brand">Use a different email</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="items-center pt-20 pb-8">
        <View className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500 to-orange-600 items-center justify-center mb-4">
          <Text className="text-3xl font-bold text-white">S</Text>
        </View>
        <Text className="text-white text-2xl font-bold">Welcome to Styrby</Text>
        <Text className="text-zinc-500 mt-2">Sign in to continue</Text>
      </View>

      {/* Auth Form */}
      <View className="px-8 flex-1">
        {/* Email input */}
        <View className="mb-4">
          <Text className="text-zinc-400 text-sm mb-2">Email</Text>
          <View className="flex-row items-center bg-background-secondary rounded-xl px-4">
            <Ionicons name="mail-outline" size={20} color="#71717a" />
            <TextInput
              className="flex-1 text-white text-base py-4 ml-3"
              placeholder="you@example.com"
              placeholderTextColor="#71717a"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              accessibilityLabel="Email address"
            />
          </View>
        </View>

        {/* Password input (if in password mode) */}
        {(mode === 'password' || mode === 'signup') && (
          <View className="mb-4">
            <Text className="text-zinc-400 text-sm mb-2">Password</Text>
            <View className="flex-row items-center bg-background-secondary rounded-xl px-4">
              <Ionicons name="lock-closed-outline" size={20} color="#71717a" />
              <TextInput
                className="flex-1 text-white text-base py-4 ml-3"
                placeholder="••••••••"
                placeholderTextColor="#71717a"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                accessibilityLabel="Password"
              />
            </View>
          </View>
        )}

        {/* Primary action */}
        {mode === 'magic_link' ? (
          <Pressable
            onPress={handleMagicLink}
            disabled={loading || passkeyLoading}
            className={`py-4 rounded-xl items-center ${loading ? 'bg-brand/50' : 'bg-brand'}`}
            accessibilityRole="button"
            accessibilityLabel="Send magic link"
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold text-base">
                Send Magic Link
              </Text>
            )}
          </Pressable>
        ) : (
          <Pressable
            onPress={handlePasswordAuth}
            disabled={loading || passkeyLoading}
            className={`py-4 rounded-xl items-center ${loading ? 'bg-brand/50' : 'bg-brand'}`}
            accessibilityRole="button"
            accessibilityLabel={mode === 'signup' ? 'Create account' : 'Sign in'}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold text-base">
                {mode === 'signup' ? 'Create Account' : 'Sign In'}
              </Text>
            )}
          </Pressable>
        )}

        {/* Toggle auth mode */}
        <View className="flex-row justify-center mt-4">
          {mode === 'magic_link' ? (
            <Pressable onPress={() => setMode('password')}>
              <Text className="text-zinc-500">
                Use password instead?{' '}
                <Text className="text-brand">Sign in</Text>
              </Text>
            </Pressable>
          ) : mode === 'password' ? (
            <View className="flex-row">
              <Pressable onPress={() => setMode('magic_link')}>
                <Text className="text-brand mr-4">Magic link</Text>
              </Pressable>
              <Pressable onPress={() => setMode('signup')}>
                <Text className="text-brand">Create account</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setMode('password')}>
              <Text className="text-zinc-500">
                Already have an account?{' '}
                <Text className="text-brand">Sign in</Text>
              </Text>
            </Pressable>
          )}
        </View>

        {/* Divider */}
        <View className="flex-row items-center my-8">
          <View className="flex-1 h-px bg-zinc-800" />
          <Text className="text-zinc-600 mx-4">or</Text>
          <View className="flex-1 h-px bg-zinc-800" />
        </View>

        {/* Passkey button */}
        {/*
         * WHY shown before GitHub:
         * Passkeys are the preferred path for users who have enrolled one.
         * They're faster (no email) and more secure (NIST AAL3).
         * GitHub OAuth remains for new users and passkey fallback.
         */}
        <Pressable
          onPress={handlePasskeyLogin}
          disabled={loading || passkeyLoading}
          className="flex-row items-center justify-center py-4 rounded-xl bg-amber-500/10 border border-amber-500/30 mb-3"
          accessibilityRole="button"
          accessibilityLabel="Sign in with passkey"
        >
          {passkeyLoading ? (
            <ActivityIndicator color="#f59e0b" />
          ) : (
            <>
              <Ionicons name="key-outline" size={20} color="#f59e0b" />
              <Text className="text-amber-400 font-semibold text-base ml-3">
                Continue with Passkey
              </Text>
            </>
          )}
        </Pressable>

        {/* OAuth */}
        <Pressable
          onPress={handleGitHubAuth}
          disabled={loading || passkeyLoading}
          className="flex-row items-center justify-center py-4 rounded-xl bg-zinc-800"
          accessibilityRole="button"
          accessibilityLabel="Continue with GitHub"
        >
          <Ionicons name="logo-github" size={20} color="white" />
          <Text className="text-white font-semibold text-base ml-3">
            Continue with GitHub
          </Text>
        </Pressable>
      </View>

      {/* Footer */}
      <View className="px-8 pb-8">
        <Text className="text-zinc-600 text-center text-sm">
          By continuing, you agree to our{' '}
          <Text className="text-zinc-400">Terms of Service</Text> and{' '}
          <Text className="text-zinc-400">Privacy Policy</Text>
        </Text>
      </View>
    </View>
  );
}
