/**
 * InviteInvalidState
 *
 * Terminal screen for 404 NOT_FOUND — the token does not correspond to any
 * known invitation in the system. This covers truly invalid links as well as
 * already-revoked invitations.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Props for InviteInvalidState.
 */
interface InviteInvalidStateProps {
  /** Called when the user taps the "Go to Dashboard" button */
  onGoHome: () => void;
}

/**
 * Terminal screen for NOT_FOUND (404) — the invitation link is invalid or
 * has been revoked.
 *
 * @param onGoHome - Handler to navigate back to the app home screen
 * @returns React element
 */
export function InviteInvalidState({ onGoHome }: InviteInvalidStateProps): React.ReactElement {
  return (
    <View className="flex-1 items-center justify-center px-8">
      {/* Icon */}
      <View className="w-16 h-16 rounded-full bg-red-500/10 items-center justify-center mb-4">
        <Ionicons name="mail-outline" size={36} color="#ef4444" accessibilityElementsHidden />
      </View>

      {/* Heading */}
      <Text
        className="text-white text-xl font-semibold mb-2 text-center"
        accessibilityRole="header"
      >
        Invalid link
      </Text>

      {/* Body copy */}
      <Text className="text-zinc-400 text-center mb-8">
        This invitation link is invalid or has been revoked. Contact your team admin for a new
        invitation.
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
