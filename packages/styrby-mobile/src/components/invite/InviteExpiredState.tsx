/**
 * InviteExpiredState
 *
 * Terminal screen displayed when the API returns 410 EXPIRED — the invitation
 * token has passed its expiry time and can no longer be accepted.
 *
 * This is a terminal state with no retry: the token cannot be refreshed from
 * the mobile side. The user must ask the team admin to send a new invitation.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Props for InviteExpiredState.
 */
interface InviteExpiredStateProps {
  /** Called when the user taps the "Go to Dashboard" button */
  onGoHome: () => void;
}

/**
 * Terminal screen for EXPIRED (410) invitation tokens.
 *
 * @param onGoHome - Handler to navigate back to the app home screen
 * @returns React element
 */
export function InviteExpiredState({ onGoHome }: InviteExpiredStateProps): React.ReactElement {
  return (
    <View className="flex-1 items-center justify-center px-8">
      {/* Icon */}
      <View className="w-16 h-16 rounded-full bg-zinc-700/50 items-center justify-center mb-4">
        <Ionicons name="close-circle" size={36} color="#71717a" accessibilityElementsHidden />
      </View>

      {/* Heading */}
      <Text
        className="text-white text-xl font-semibold mb-2 text-center"
        accessibilityRole="header"
      >
        Invitation expired
      </Text>

      {/* Body copy */}
      <Text className="text-zinc-400 text-center mb-8">
        This invitation link has expired. Ask your team admin to send you a new invitation.
      </Text>

      {/* Go to Dashboard */}
      <Pressable
        onPress={onGoHome}
        className="px-8 py-4 rounded-xl bg-brand items-center active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Go to dashboard"
      >
        <Text className="text-white font-semibold text-base">Go to Dashboard</Text>
      </Pressable>
    </View>
  );
}
