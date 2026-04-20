/**
 * Settings Route Group Layout
 *
 * Nested Stack navigator for the settings hub and its seven sub-screens.
 * Pushed from the settings tab so the native back button returns the user
 * to the hub (and then to the tab bar).
 *
 * WHY a Stack and not a Tabs: each sub-screen is full-screen and linear.
 * Tabs would require horizontal swipe between unrelated sections
 * (Appearance vs Voice vs Agents), which hurts orientation and does not
 * match the hub/sub-screen mental model specified in the Phase 0.6.1
 * refactor plan Section 2.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 2
 */

import { Stack } from 'expo-router';

/**
 * Stack layout used by every file in app/settings/.
 * Header style matches the rest of the app (dark background, white text)
 * to preserve visual continuity when navigating in from the settings tab.
 */
export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#09090b' },
        headerTintColor: '#fff',
        contentStyle: { backgroundColor: '#09090b' },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Settings',
        }}
      />
      <Stack.Screen
        name="appearance"
        options={{
          title: 'Appearance',
        }}
      />
      <Stack.Screen
        name="support"
        options={{
          title: 'Support',
        }}
      />
      <Stack.Screen
        name="agents"
        options={{
          title: 'Agents',
        }}
      />
      <Stack.Screen
        name="metrics"
        options={{
          title: 'Metrics Export',
        }}
      />
      <Stack.Screen
        name="voice"
        options={{
          title: 'Voice Input',
        }}
      />
      <Stack.Screen
        name="notifications"
        options={{
          title: 'Notifications',
        }}
      />
      <Stack.Screen
        name="account"
        options={{
          title: 'Account',
        }}
      />
      {/*
       * WHY passkeys is a separate Stack.Screen:
       * Passkey management has its own fetch cycle, enroll flow, and
       * per-row edit state. Keeping it as a sub-screen keeps account.tsx
       * under the 400-line orchestrator limit and isolates the WebAuthn
       * dependencies to one file.
       */}
      <Stack.Screen
        name="passkeys"
        options={{
          title: 'Passkeys',
        }}
      />
    </Stack>
  );
}
