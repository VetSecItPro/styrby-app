/**
 * UpgradePrompt — shown to free users who lack access to session replay.
 *
 * Extracted from SessionReplay.tsx (Cluster A2 split).
 *
 * @module components/session-replay/UpgradePrompt
 */

import { View, Text, Pressable, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  getUpgradeMessage,
  getUpgradeButtonLabel,
  getIosManageNote,
  POLAR_CUSTOMER_PORTAL_URL,
} from '../../lib/platform-billing';

/**
 * Shown to free users who don't have access to replay.
 *
 * WHY platform-conditional rendering:
 * Apple App Store §3.1.3(a) classifies Styrby as a Reader App and prohibits
 * showing upgrade buttons, pricing, or links to external payment flows on iOS.
 * Android has no such restriction, so the full upgrade CTA is shown there.
 *
 * @param props.onExit - Optional callback when user presses "Go Back".
 */
export function UpgradePrompt({ onExit }: { onExit?: () => void }) {
  const upgradeButtonLabel = getUpgradeButtonLabel('pro');
  const iosManageNote = getIosManageNote();

  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <View className="w-16 h-16 rounded-2xl bg-orange-500/20 items-center justify-center mb-4">
        <Ionicons name="play-circle" size={32} color="#f97316" />
      </View>
      <Text className="text-white text-xl font-semibold text-center mb-2">
        Session Replay
      </Text>
      <Text className="text-zinc-500 text-center mb-6">
        {getUpgradeMessage('Session Replay', 'pro')}
      </Text>

      {/* WHY: Only render the upgrade button on Android. Apple Reader App rules
          (§3.1.3(a)) prohibit showing purchase CTAs or external payment links
          on iOS. On iOS we show an informational note instead. */}
      {upgradeButtonLabel !== null ? (
        <Pressable
          className="bg-brand px-6 py-3 rounded-xl active:opacity-80"
          onPress={() => Linking.openURL(POLAR_CUSTOMER_PORTAL_URL).catch(() => null)}
          accessibilityRole="button"
          accessibilityLabel={upgradeButtonLabel}
        >
          <Text className="text-white font-semibold">{upgradeButtonLabel}</Text>
        </Pressable>
      ) : (
        // iOS: informational note only — no button, no price, no external link
        iosManageNote !== null && (
          <Text className="text-zinc-600 text-xs text-center">{iosManageNote}</Text>
        )
      )}

      {onExit && (
        <Pressable
          onPress={onExit}
          className="mt-4 px-4 py-2"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text className="text-zinc-500">Go Back</Text>
        </Pressable>
      )}
    </View>
  );
}
