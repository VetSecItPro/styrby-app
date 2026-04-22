/**
 * Mobile Privacy Links
 *
 * Links to the web Privacy Control Center for features that are web-only
 * on first iteration (data map, encryption details) or that benefit from
 * a larger screen (full privacy page).
 *
 * WHY not replicate the data map on mobile:
 *   The data map table has 17 rows with expandable detail. The mobile screen
 *   real estate is limited; the web page already covers this. A deep link to
 *   the web Privacy Center satisfies parity without bloating the mobile screen.
 *
 * WHY Linking.openURL instead of expo-router push:
 *   The Privacy Center URL is on the web domain (https://styrbyapp.com), not
 *   a mobile route. We open it in the device's default browser.
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { SectionHeader } from '@/components/ui';

/** Deep links to web privacy pages. */
const PRIVACY_LINKS = [
  {
    label: 'Data Map - What We Store',
    description: 'Every table explained, encrypted vs plaintext',
    href: 'https://styrbyapp.com/dashboard/privacy#data-map',
    icon: 'server-outline' as const,
  },
  {
    label: 'Encryption Details',
    description: 'XChaCha20-Poly1305, per-device keys, key rotation',
    href: 'https://styrbyapp.com/dashboard/privacy#encryption',
    icon: 'lock-closed-outline' as const,
  },
] as const;

/**
 * Renders deep links to the web Privacy Control Center.
 */
export function MobilePrivacyLinks() {
  return (
    <>
      <SectionHeader title="Learn More" />
      <View className="bg-background-secondary mx-4 rounded-xl mb-4 overflow-hidden">
        {PRIVACY_LINKS.map((link, index) => {
          const isLast = index === PRIVACY_LINKS.length - 1;
          return (
            <Pressable
              key={link.href}
              onPress={() => Linking.openURL(link.href)}
              accessibilityRole="link"
              accessibilityLabel={link.label}
              className={`flex-row items-center px-4 py-3 active:bg-zinc-800 ${
                !isLast ? 'border-b border-zinc-800' : ''
              }`}
            >
              <Ionicons name={link.icon} size={16} color="#71717a" className="mr-3" />
              <View className="flex-1 ml-3">
                <Text className="text-sm font-medium text-zinc-200">{link.label}</Text>
                <Text className="text-xs text-zinc-500 mt-0.5">{link.description}</Text>
              </View>
              <Ionicons name="open-outline" size={14} color="#71717a" />
            </Pressable>
          );
        })}
      </View>
    </>
  );
}
