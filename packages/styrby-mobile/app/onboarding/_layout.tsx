/**
 * Onboarding Layout
 *
 * Navigation stack for the onboarding flow.
 * Exports an ErrorBoundary so rendering errors during onboarding
 * display a recovery UI instead of crashing the app.
 */

import { Stack } from 'expo-router';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ErrorBoundaryProps } from 'expo-router';

/**
 * Error boundary for the onboarding route.
 *
 * Catches rendering errors during the onboarding pager flow,
 * showing a recovery UI with retry action.
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
        Setup Error
      </Text>
      <Text className="text-zinc-400 text-center mb-1">
        Something went wrong during setup. Please try again.
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

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#09090b' },
        gestureEnabled: false,
        animation: 'fade',
      }}
    >
      <Stack.Screen name="index" />
    </Stack>
  );
}
