/**
 * NPS Survey Screen
 *
 * Deep-link target for NPS push notifications.
 * Route: /nps/[kind] where kind is 'nps_7d' or 'nps_30d'
 *
 * Query params:
 *   - prompt_id: UUID of the user_feedback_prompts row
 *
 * Renders the NpsSurveySheet pre-opened. On dismiss/submit, navigates back
 * to the home tab.
 *
 * WHY a screen not just a modal: Push notification deep links open to a
 * specific route. Using a dedicated screen + pre-opened sheet is the
 * standard expo-router pattern for push-link destinations.
 *
 * @module app/nps/[kind]
 */

import React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { NpsSurveySheet } from '../../src/components/feedback/NpsSurveySheet';

/**
 * NPS survey deep-link screen.
 *
 * @returns The NPS survey sheet pre-opened over a transparent background
 */
export default function NpsScreen() {
  const router = useRouter();
  const { kind, prompt_id } = useLocalSearchParams<{
    kind: 'nps_7d' | 'nps_30d';
    prompt_id?: string;
  }>();

  // Convert route kind to survey window
  const window: '7d' | '30d' = kind === 'nps_30d' ? '30d' : '7d';

  const handleClose = () => {
    // Navigate back to the main tab after survey completion/dismissal
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)');
    }
  };

  return (
    <View className="flex-1 bg-black/60">
      <NpsSurveySheet
        visible
        window={window}
        promptId={prompt_id}
        onClose={handleClose}
      />
    </View>
  );
}
