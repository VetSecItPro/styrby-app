/**
 * Account Settings — Danger Section
 *
 * Renders the destructive Sign Out and Delete Account buttons at the bottom
 * of the screen. Both buttons trigger handlers in the orchestrator hook
 * which manage their own confirmation flows.
 */

import { View, Pressable, Text, ActivityIndicator } from 'react-native';

/**
 * Props consumed by {@link DangerSection}.
 */
export interface DangerSectionProps {
  isSigningOut: boolean;
  isDeleting: boolean;
  onSignOut: () => void;
  onDelete: () => void;
}

/**
 * Danger section: sign out + delete account buttons.
 *
 * WHY separate buttons (not menu items): destructive actions deserve
 * visual weight so users register the severity. Both buttons disable the
 * other while one is in flight to prevent double-execution.
 */
export function DangerSection({ isSigningOut, isDeleting, onSignOut, onDelete }: DangerSectionProps) {
  return (
    <View className="mt-4 mb-8 gap-3">
      <Pressable
        className="mx-4 py-3 rounded-xl border border-red-500/30 items-center active:bg-red-500/10"
        onPress={onSignOut}
        disabled={isSigningOut || isDeleting}
        accessibilityRole="button"
        accessibilityLabel="Sign out of your account"
      >
        {isSigningOut ? (
          <ActivityIndicator size="small" color="#ef4444" />
        ) : (
          <Text className="text-red-500 font-semibold">Sign Out</Text>
        )}
      </Pressable>

      {/* WHY separate button: delete is visually distinct from sign out to
          signal higher severity. Red border + red text = destructive action. */}
      <Pressable
        className="mx-4 py-3 rounded-xl border border-red-500/50 items-center active:bg-red-500/10"
        onPress={onDelete}
        disabled={isDeleting || isSigningOut}
        accessibilityRole="button"
        accessibilityLabel="Delete your account permanently"
      >
        {isDeleting ? (
          <ActivityIndicator size="small" color="#ef4444" />
        ) : (
          <Text className="text-red-500 font-semibold">Delete Account</Text>
        )}
      </Pressable>
    </View>
  );
}
