/**
 * Login Screen
 *
 * Authentication options: magic link, email/password, GitHub OAuth.
 */

import { View, Text, TextInput, Pressable, Alert, ActivityIndicator } from 'react-native';
import { useState } from 'react';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/lib/supabase';

type AuthMode = 'magic_link' | 'password' | 'signup';

export default function LoginScreen() {
  const [mode, setMode] = useState<AuthMode>('magic_link');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
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
              />
            </View>
          </View>
        )}

        {/* Primary action */}
        {mode === 'magic_link' ? (
          <Pressable
            onPress={handleMagicLink}
            disabled={loading}
            className={`py-4 rounded-xl items-center ${loading ? 'bg-brand/50' : 'bg-brand'}`}
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
            disabled={loading}
            className={`py-4 rounded-xl items-center ${loading ? 'bg-brand/50' : 'bg-brand'}`}
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

        {/* OAuth */}
        <Pressable
          onPress={handleGitHubAuth}
          disabled={loading}
          className="flex-row items-center justify-center py-4 rounded-xl bg-zinc-800"
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
