/**
 * Auth Layout
 *
 * Navigation stack for authentication screens (login, QR scan).
 * Exports an ErrorBoundary so auth-related rendering errors display
 * a recovery UI instead of crashing the app.
 */

import { Stack } from 'expo-router';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ErrorBoundaryProps } from 'expo-router';

/**
 * Error boundary for auth route screens.
 *
 * Catches rendering errors in login and scan screens, showing
 * an auth-specific recovery message with retry action.
 *
 * @param error - The error thrown during rendering
 * @param retry - Callback that clears the error and re-renders the route
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View className="flex-1 bg-zinc-950 items-center justify-center px-6">
      <View className="w-16 h-16 rounded-2xl bg-red-500/20 items-center justify-center mb-4">
        <Ionicons name="warning" size={32} color="#ef4444" />
      </View>
      <Text className="text-white text-xl font-semibold text-center mb-2">
        Authentication Error
      </Text>
      <Text className="text-zinc-400 text-center mb-1">
        Something went wrong loading the sign-in screen.
      </Text>
      <Text className="text-zinc-600 text-sm text-center mb-6" numberOfLines={3}>
        {error.message}
      </Text>
      <Pressable
        onPress={retry}
        className="bg-brand px-6 py-3 rounded-xl flex-row items-center active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Try again"
      >
        <Ionicons name="refresh" size={18} color="white" />
        <Text className="text-white font-semibold ml-2">Try Again</Text>
      </Pressable>
    </View>
  );
}

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#09090b' },
        animation: 'fade',
      }}
    >
      <Stack.Screen name="login" />
      <Stack.Screen name="scan" />
    </Stack>
  );
}
