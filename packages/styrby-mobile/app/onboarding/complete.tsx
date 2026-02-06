/**
 * Onboarding Complete Screen
 *
 * Final screen of the onboarding flow, shown after device pairing
 * and optional notification permission. Provides:
 * - Success haptic feedback
 * - Visual celebration (checkmark animation)
 * - Quick tips for getting started
 * - Navigation to the main dashboard
 */

import { View, Text, Pressable } from 'react-native';
import { useEffect } from 'react';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { OnboardingProgress } from '../../src/components/OnboardingProgress';

/** Total number of steps in the onboarding flow */
const TOTAL_STEPS = 5;
/** Current step number for the complete screen */
const CURRENT_STEP = 5;

/**
 * Quick tips displayed to help users get started with Styrby.
 */
const QUICK_TIPS = [
  {
    icon: 'terminal' as const,
    text: 'Run `styrby start` on your computer to begin a session',
  },
  {
    icon: 'refresh' as const,
    text: 'Pull down on the dashboard to refresh sessions',
  },
  {
    icon: 'chatbubble' as const,
    text: 'Tap a session to view chat and approve actions',
  },
  {
    icon: 'wallet' as const,
    text: 'Set budget alerts to stay on top of spending',
  },
];

export default function CompleteScreen() {
  /**
   * WHY: Trigger success haptic feedback when the screen mounts.
   * This provides a satisfying tactile confirmation that the
   * onboarding process is complete, reinforcing the positive moment.
   */
  useEffect(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  /**
   * Navigates to the main dashboard, replacing the onboarding stack
   * so the user cannot navigate back to onboarding.
   */
  const handleContinue = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.replace('/(tabs)');
  };

  return (
    <View className="flex-1 bg-background">
      {/* Progress indicator */}
      <View className="pt-16 px-4">
        <OnboardingProgress currentStep={CURRENT_STEP} totalSteps={TOTAL_STEPS} />
      </View>

      {/* Main content */}
      <View className="flex-1 px-8 pt-8 items-center">
        {/* Success icon */}
        <View className="w-24 h-24 rounded-full bg-green-500/15 items-center justify-center mb-6">
          <Ionicons name="checkmark-circle" size={64} color="#22c55e" />
        </View>

        {/* Title and description */}
        <Text className="text-white text-2xl font-bold text-center mb-3">
          You're All Set!
        </Text>
        <Text className="text-zinc-400 text-center text-base leading-6 mb-8">
          Your device is paired and ready to control your AI coding agents.
        </Text>

        {/* Quick tips card */}
        <View className="w-full bg-zinc-900 rounded-2xl p-5">
          <Text className="text-white font-semibold text-base mb-4">
            Quick Tips
          </Text>
          <View className="gap-4">
            {QUICK_TIPS.map(({ icon, text }, index) => (
              <View key={index} className="flex-row items-start gap-3">
                <View className="w-8 h-8 rounded-lg bg-zinc-800 items-center justify-center mt-0.5">
                  <Ionicons name={icon} size={16} color="#f97316" />
                </View>
                <Text className="flex-1 text-zinc-300 text-sm leading-5">
                  {text}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </View>

      {/* Bottom action */}
      <View className="px-8 pb-12">
        <Pressable
          onPress={handleContinue}
          className="bg-brand py-4 rounded-xl items-center flex-row justify-center"
          accessibilityLabel="Go to dashboard"
          accessibilityRole="button"
        >
          <Text className="text-white font-semibold text-lg">
            Go to Dashboard
          </Text>
          <Ionicons name="arrow-forward" size={20} color="white" style={{ marginLeft: 8 }} />
        </Pressable>

        <Text className="text-zinc-600 text-xs text-center mt-4">
          You can access settings and help from the dashboard
        </Text>
      </View>
    </View>
  );
}
