/**
 * PowerTierGate
 *
 * Full-screen upgrade prompt shown to non-Power-tier users when they reach
 * the Webhooks screen.
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
 * Renders the Power-tier upgrade prompt.
 *
 * WHY platform-conditional rendering:
 * Apple App Store §3.1.3(a) classifies Styrby as a Reader App and prohibits
 * showing upgrade buttons, pricing, or links to external payment flows on iOS.
 * Android shows the full upgrade CTA with a direct link to the Polar portal.
 * `getUpgradeButtonLabel` returns `null` on iOS so we can fall back to the
 * informational `getIosManageNote()` instead of a CTA.
 *
 * @returns React element
 */
export function PowerTierGate() {
  const upgradeButtonLabel = getUpgradeButtonLabel('power');
  const iosManageNote = getIosManageNote();

  return (
    <View className="flex-1 bg-background items-center justify-center px-8">
      <View className="w-20 h-20 rounded-3xl bg-orange-500/15 items-center justify-center mb-6">
        <Ionicons name="key" size={40} color="#f97316" />
      </View>
      <Text className="text-white text-2xl font-bold text-center mb-2">
        Power Plan Required
      </Text>
      <Text className="text-zinc-400 text-center mb-6">
        {getUpgradeMessage('Webhooks', 'power')}
        {'\n\n'}Automate your workflow by receiving real-time event notifications
        to any HTTPS endpoint.
      </Text>

      {/* WHY: Only render upgrade button on Android. Apple Reader App rules
          (§3.1.3(a)) prohibit purchase CTAs or external payment links on iOS. */}
      {upgradeButtonLabel !== null ? (
        <Pressable
          className="bg-brand px-8 py-4 rounded-2xl active:opacity-80"
          onPress={() =>
            Linking.openURL(POLAR_CUSTOMER_PORTAL_URL).catch(() => null)
          }
          accessibilityRole="button"
          accessibilityLabel={upgradeButtonLabel}
        >
          <Text className="text-white font-bold text-base">{upgradeButtonLabel}</Text>
        </Pressable>
      ) : (
        // iOS: informational note only - no button, no price, no external link
        iosManageNote !== null && (
          <Text className="text-zinc-500 text-sm text-center">{iosManageNote}</Text>
        )
      )}
    </View>
  );
}
