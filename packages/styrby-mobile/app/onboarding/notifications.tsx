/**
 * Notifications Permission Screen
 *
 * Requests push notification permissions during onboarding.
 * Users can enable notifications to stay informed about:
 * - Permission requests from AI agents
 * - Session starts/ends
 * - Budget alerts
 *
 * Skipping is allowed since notifications are optional.
 */

import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useState } from 'react';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { OnboardingProgress } from '../../src/components/OnboardingProgress';
import { registerForPushNotifications, savePushToken } from '../../src/services/notifications';

/** Total number of steps in the onboarding flow */
const TOTAL_STEPS = 5;
/** Current step number for the notifications screen */
const CURRENT_STEP = 4;

/**
 * Notification benefit items displayed to explain the value of enabling notifications.
 */
const NOTIFICATION_BENEFITS = [
  {
    icon: 'shield-checkmark' as const,
    title: 'Permission Requests',
    description: 'Get alerted when your AI agent needs approval for risky operations.',
  },
  {
    icon: 'flash' as const,
    title: 'Real-time Updates',
    description: 'Know immediately when sessions start, complete, or encounter errors.',
  },
  {
    icon: 'wallet' as const,
    title: 'Budget Alerts',
    description: 'Stay informed when spending approaches your configured limits.',
  },
];

export default function NotificationsScreen() {
  const [isLoading, setIsLoading] = useState(false);

  /**
   * Handles enabling push notifications.
   * Registers for push notifications and saves the token to Supabase.
   * Navigates to the completion screen regardless of success (non-blocking).
   */
  const handleEnable = async () => {
    setIsLoading(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      const token = await registerForPushNotifications();
      if (token) {
        await savePushToken(token);
      }
    } catch (error) {
      // Non-fatal: user can enable notifications later in settings
      if (__DEV__) {
        console.log('Push notification registration failed:', error);
      }
    }

    setIsLoading(false);
    router.push('/onboarding/complete');
  };

  /**
   * Handles skipping notification permission.
   * User can enable notifications later from the settings screen.
   */
  const handleSkip = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/onboarding/complete');
  };

  /**
   * Handles navigating back to the previous onboarding step.
   */
  const handleBack = () => {
    router.back();
  };

  return (
    <View className="flex-1 bg-background">
      {/* Header with back button and progress */}
      <View className="pt-16 px-4">
        <Pressable
          onPress={handleBack}
          className="flex-row items-center mb-2"
          accessibilityLabel="Go back to QR scan"
          accessibilityRole="button"
        >
          <Ionicons name="chevron-back" size={24} color="#71717a" />
          <Text className="text-zinc-500 ml-1">Back</Text>
        </Pressable>
        <OnboardingProgress currentStep={CURRENT_STEP} totalSteps={TOTAL_STEPS} />
      </View>

      {/* Main content */}
      <View className="flex-1 px-8 pt-8">
        {/* Icon */}
        <View className="items-center mb-6">
          <View className="w-20 h-20 rounded-3xl bg-blue-500/15 items-center justify-center">
            <Ionicons name="notifications" size={44} color="#3b82f6" />
          </View>
        </View>

        {/* Title and description */}
        <Text className="text-white text-2xl font-bold text-center mb-3">
          Stay in the Loop
        </Text>
        <Text className="text-zinc-400 text-center text-base leading-6 mb-8">
          Get notified when your AI agent needs approval or completes a task.
        </Text>

        {/* Benefits list */}
        <View className="gap-4">
          {NOTIFICATION_BENEFITS.map(({ icon, title, description }) => (
            <View key={title} className="flex-row items-start gap-4">
              <View className="bg-zinc-800 p-3 rounded-xl">
                <Ionicons name={icon} size={24} color="#f97316" />
              </View>
              <View className="flex-1">
                <Text className="text-white font-semibold text-base">{title}</Text>
                <Text className="text-zinc-400 text-sm mt-1 leading-5">
                  {description}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      {/* Bottom actions */}
      <View className="px-8 pb-12">
        <Pressable
          onPress={handleEnable}
          disabled={isLoading}
          className={`py-4 rounded-xl items-center flex-row justify-center ${
            isLoading ? 'bg-brand/50' : 'bg-brand'
          }`}
          accessibilityLabel="Enable push notifications"
          accessibilityRole="button"
        >
          {isLoading ? (
            <ActivityIndicator color="white" />
          ) : (
            <>
              <Ionicons name="notifications" size={20} color="white" />
              <Text className="text-white font-semibold text-lg ml-2">
                Enable Notifications
              </Text>
            </>
          )}
        </Pressable>

        <Pressable
          onPress={handleSkip}
          disabled={isLoading}
          className="py-4 items-center mt-3"
          accessibilityLabel="Skip enabling notifications"
          accessibilityRole="button"
        >
          <Text className="text-zinc-500">Maybe Later</Text>
        </Pressable>

        <Text className="text-zinc-600 text-xs text-center mt-4">
          You can enable notifications anytime in Settings
        </Text>
      </View>
    </View>
  );
}
