/**
 * InviteWrongAccountState
 *
 * Displayed when the API returns 403 EMAIL_MISMATCH — the invitation was
 * sent to a different email address than the one currently signed in.
 *
 * WHY this state exists:
 * A user may tap an invite link on a device where they are signed in with a
 * different account. Rather than silently failing or showing a generic error,
 * we give them two clear recovery options: sign out (to sign back in with the
 * correct account) or switch account (on platforms that support multi-account).
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Props for InviteWrongAccountState.
 */
interface InviteWrongAccountStateProps {
  /** Called when the user taps "Sign Out" */
  onSignOut: () => void;
  /** Called when the user taps "Switch Account" */
  onSwitchAccount: () => void;
}

/**
 * Error screen for EMAIL_MISMATCH (403) — the signed-in user's email does not
 * match the invitation's target email.
 *
 * @param onSignOut - Handler for the Sign Out action
 * @param onSwitchAccount - Handler for the Switch Account action
 * @returns React element
 */
export function InviteWrongAccountState({
  onSignOut,
  onSwitchAccount,
}: InviteWrongAccountStateProps): React.ReactElement {
  return (
    <View className="flex-1 items-center justify-center px-8">
      {/* Icon */}
      <View className="w-16 h-16 rounded-full bg-yellow-500/10 items-center justify-center mb-4">
        <Ionicons name="alert-circle" size={36} color="#f59e0b" accessibilityElementsHidden />
      </View>

      {/* Heading */}
      <Text
        className="text-white text-xl font-semibold mb-2 text-center"
        accessibilityRole="header"
      >
        Wrong account
      </Text>

      {/* Body copy */}
      <Text className="text-zinc-400 text-center mb-8">
        This invitation was sent to a different email address. Sign out and sign in with the
        correct account to accept it.
      </Text>

      {/* Sign Out */}
      <Pressable
        onPress={onSignOut}
        className="w-full py-4 rounded-xl bg-brand items-center mb-3 active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Sign out and use a different account"
      >
        <Text className="text-white font-semibold text-base">Sign Out</Text>
      </Pressable>

      {/* Switch Account */}
      <Pressable
        onPress={onSwitchAccount}
        className="w-full py-4 rounded-xl border border-zinc-700 items-center active:bg-zinc-800"
        accessibilityRole="button"
        accessibilityLabel="Switch to a different account"
      >
        <Text className="text-zinc-300 font-semibold text-base">Switch Account</Text>
      </Pressable>
    </View>
  );
}
