/**
 * InviteErrorState
 *
 * Generic failure screen for unexpected errors — network failures, 5xx
 * responses, or any error code that does not have a dedicated terminal state.
 *
 * Unlike EXPIRED or INVALID, this state is recoverable: the user can retry
 * the request.
 *
 * WHY retry vs navigate away:
 * NETWORK_ERROR and server errors are transient. Showing a retry button
 * keeps the user in the invite flow rather than forcing them back to the
 * dashboard where they have no path to the invitation.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Props for InviteErrorState.
 */
interface InviteErrorStateProps {
  /** The error message to display to the user */
  message: string;
  /** Called when the user taps the Retry button */
  onRetry: () => void;
}

/**
 * Recoverable error screen with a Retry button.
 *
 * @param message - Human-readable error description
 * @param onRetry - Handler to re-attempt the invitation accept request
 * @returns React element
 */
export function InviteErrorState({ message, onRetry }: InviteErrorStateProps): React.ReactElement {
  return (
    <View className="flex-1 items-center justify-center px-8">
      {/* Icon */}
      <View className="w-16 h-16 rounded-full bg-red-500/10 items-center justify-center mb-4">
        <Ionicons name="alert-circle" size={36} color="#ef4444" accessibilityElementsHidden />
      </View>

      {/* Heading */}
      <Text
        className="text-white text-xl font-semibold mb-2 text-center"
        accessibilityRole="header"
      >
        Something went wrong
      </Text>

      {/* Error detail */}
      <Text className="text-zinc-400 text-center mb-8">{message}</Text>

      {/* Retry */}
      <Pressable
        onPress={onRetry}
        className="flex-row items-center px-8 py-4 rounded-xl bg-brand active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Retry joining the team"
      >
        <Ionicons name="refresh" size={20} color="white" accessibilityElementsHidden />
        <Text className="text-white font-semibold text-base ml-2">Try Again</Text>
      </Pressable>
    </View>
  );
}
