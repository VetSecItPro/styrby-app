/**
 * Settings Hub (placeholder scaffold)
 *
 * Thin orchestrator screen for the new settings sub-screen architecture.
 * In the Phase 0.6.1 refactor this file becomes the primary settings UX:
 * a list of navigation rows that push the user into focused sub-screens
 * (Account, Notifications, Appearance, Voice Input, Agents, Metrics Export,
 * Support).
 *
 * ## Current state
 * This is a **scaffold**. The existing monolith at
 * `app/(tabs)/settings.tsx` is still the live settings screen. This file
 * exists so upcoming sub-screen migrations (S5 through S11 of the
 * refactor plan) can be merged one at a time without an all-or-nothing
 * route flip.
 *
 * Until S4 of the refactor ships (tab stub becomes a redirect), no user
 * navigates here. The route is additive and does not affect existing
 * flows.
 *
 * ## Target structure
 * Per the spec, the final hub is under 200 LOC and renders:
 *   - Profile header (avatar, display name, email)
 *   - Navigation rows for each sub-screen with contextual subtitles
 *     (subscription tier, push state, theme name, agent count)
 *   - Version footer
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 0
 */

import { View, Text, ScrollView } from 'react-native';

/**
 * Settings hub screen.
 *
 * @returns Placeholder screen until sub-screens are migrated.
 */
export default function SettingsHubScreen() {
  return (
    <ScrollView
      className="flex-1 bg-zinc-950"
      contentContainerStyle={{ paddingVertical: 24 }}
    >
      <View className="px-6">
        <Text className="text-white text-lg font-semibold mb-2">
          Settings Hub (scaffold)
        </Text>
        <Text className="text-zinc-400 text-sm">
          This hub is a placeholder during the Phase 0.6.1 refactor. The live
          settings screen is still rendered from the tab entry point. Sub-screen
          migrations (Account, Notifications, Appearance, Voice Input, Agents,
          Metrics Export, Support) will populate this hub incrementally.
        </Text>
      </View>
    </ScrollView>
  );
}
