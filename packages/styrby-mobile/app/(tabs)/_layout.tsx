/**
 * Tab Navigation Layout
 *
 * Main app navigation with Dashboard, Chat, Sessions, and Settings tabs.
 * Exports an ErrorBoundary to catch rendering errors in any tab screen,
 * displaying a branded recovery UI instead of crashing the app.
 */

import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, Pressable } from 'react-native';
import type { ErrorBoundaryProps } from 'expo-router';

/**
 * Error boundary for tab routes.
 *
 * Catches unhandled rendering errors thrown by any child tab screen and
 * presents a clean recovery UI with a retry action. Uses the same dark
 * theme and brand styling as the rest of the app.
 *
 * @param error - The error that was thrown during rendering
 * @param retry - Callback that clears the error state and re-renders the route
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View className="flex-1 bg-zinc-900 items-center justify-center px-6">
      {/* Error Icon */}
      <View className="w-16 h-16 rounded-2xl bg-red-500/20 items-center justify-center mb-4">
        <Ionicons name="warning" size={32} color="#ef4444" />
      </View>

      {/* Error Message */}
      <Text className="text-white text-xl font-semibold text-center mb-2">
        Something went wrong
      </Text>
      <Text className="text-zinc-400 text-center mb-1">
        An unexpected error occurred while loading this screen.
      </Text>
      <Text className="text-zinc-600 text-sm text-center mb-6" numberOfLines={3}>
        {error.message}
      </Text>

      {/* Retry Button */}
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

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#f97316', // brand orange
        tabBarInactiveTintColor: '#71717a', // zinc-500
        tabBarStyle: {
          backgroundColor: '#18181b', // zinc-900
          borderTopColor: '#27272a', // zinc-800
        },
        headerStyle: {
          backgroundColor: '#09090b', // zinc-950
        },
        headerTintColor: '#fff',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="grid" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
