/**
 * Onboarding Checklist Modal
 *
 * A bottom-sheet modal that displays tier-specific onboarding steps with
 * completion status. Appears when the user's onboarding_completed_at is null.
 * Each step is tappable and navigates to the relevant screen. The modal can
 * be dismissed (skip) or completed when all steps are done.
 *
 * Uses the useOnboarding hook for data and NativeWind for styling.
 */

import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator } from 'react-native';
import { useCallback } from 'react';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { ChecklistStep } from '../hooks/useOnboarding';
import type { SubscriptionTier } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the OnboardingModal component.
 */
interface OnboardingModalProps {
  /** Whether the modal is currently visible */
  visible: boolean;
  /** Callback to close/dismiss the modal */
  onDismiss: () => void;
  /** The onboarding checklist steps with completion status */
  steps: ChecklistStep[];
  /** Number of completed steps */
  completedCount: number;
  /** Total number of steps */
  totalCount: number;
  /** The user's subscription tier, displayed in the welcome message */
  tier: SubscriptionTier;
  /** Whether a markComplete operation is in progress */
  isMarkingComplete?: boolean;
  /** Callback to mark onboarding as complete */
  onComplete: () => Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Display-friendly tier names for the welcome message.
 */
// WHY display labels diverge from the stored value: Phase 6 collapsed the
// public ladder to Pro + Growth (`.audit/styrby-fulltest.md` Decision #9).
// Server records still carry the legacy values `'power'` and `'team'` for
// back-compat, so we map them at the display boundary rather than running
// a destructive migration.
const TIER_DISPLAY_NAMES: Record<SubscriptionTier, string> = {
  free: 'Free',
  pro: 'Pro',
  power: 'Growth',
  team: 'Growth',
};

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a bottom-sheet style modal with the onboarding checklist.
 *
 * The modal presents:
 * 1. A welcome message showing the user's subscription tier
 * 2. A progress bar indicating how many steps are completed
 * 3. A list of tappable steps that navigate to relevant screens
 * 4. A "Skip for now" button to dismiss without completing
 * 5. A "Complete Setup" button enabled when all steps are done
 *
 * @param visible - Controls modal visibility
 * @param onDismiss - Called when the user dismisses the modal
 * @param steps - Checklist steps from useOnboarding
 * @param completedCount - Number of completed steps
 * @param totalCount - Total step count
 * @param tier - User's subscription tier
 * @param isMarkingComplete - Loading state for completion action
 * @param onComplete - Called when the user completes onboarding
 * @returns The onboarding modal JSX
 *
 * @example
 * <OnboardingModal
 *   visible={showModal}
 *   onDismiss={() => setShowModal(false)}
 *   steps={steps}
 *   completedCount={completedCount}
 *   totalCount={totalCount}
 *   tier={tier}
 *   onComplete={markComplete}
 * />
 */
export function OnboardingModal({
  visible,
  onDismiss,
  steps,
  completedCount,
  totalCount,
  tier,
  isMarkingComplete = false,
  onComplete,
}: OnboardingModalProps) {
  const allComplete = completedCount === totalCount && totalCount > 0;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  /**
   * Navigates to the route for a specific checklist step and closes the modal.
   *
   * WHY: We dismiss the modal before navigating so the user does not see the
   * modal overlaid on the destination screen when they navigate back.
   *
   * @param step - The checklist step to navigate to
   */
  const handleStepPress = useCallback(
    (step: ChecklistStep) => {
      onDismiss();
      // Small delay to let modal animation complete before navigation
      setTimeout(() => {
        router.push(step.route as never);
      }, 300);
    },
    [onDismiss],
  );

  /**
   * Handles the "Complete Setup" button press.
   * Calls onComplete and then dismisses the modal on success.
   */
  const handleComplete = useCallback(async () => {
    try {
      await onComplete();
      onDismiss();
    } catch {
      // Error is handled by the hook's error state, modal stays open
    }
  }, [onComplete, onDismiss]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onDismiss}
    >
      {/* Backdrop */}
      <Pressable
        className="flex-1 bg-black/50"
        onPress={onDismiss}
        accessibilityLabel="Close onboarding modal"
      />

      {/* Bottom sheet content */}
      <View className="bg-zinc-900 rounded-t-3xl px-6 pt-6 pb-10 border-t border-zinc-800">
        {/* Drag indicator */}
        <View className="items-center mb-4">
          <View className="w-10 h-1 rounded-full bg-zinc-700" />
        </View>

        {/* Header */}
        <View className="flex-row items-center justify-between mb-2">
          <Text className="text-white text-xl font-bold">Welcome to Styrby</Text>
          <View className="px-2.5 py-1 rounded-full bg-orange-500/15">
            <Text className="text-xs font-semibold text-orange-400">
              {TIER_DISPLAY_NAMES[tier]}
            </Text>
          </View>
        </View>

        <Text className="text-zinc-400 text-sm mb-5">
          Complete these steps to get the most out of your {TIER_DISPLAY_NAMES[tier]} plan.
        </Text>

        {/* Progress bar */}
        <View className="mb-5">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-zinc-500 text-xs font-medium">PROGRESS</Text>
            <Text className="text-zinc-500 text-xs">
              {completedCount}/{totalCount} complete
            </Text>
          </View>
          <View className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <View
              className="h-full bg-brand rounded-full"
              style={{ width: `${progressPercent}%` }}
            />
          </View>
        </View>

        {/* Checklist */}
        <ScrollView
          style={{ maxHeight: 280 }}
          showsVerticalScrollIndicator={false}
          accessibilityRole="list"
          accessibilityLabel="Onboarding checklist"
        >
          {steps.map((step) => (
            <Pressable
              key={step.id}
              onPress={() => handleStepPress(step)}
              className={`flex-row items-center py-3.5 px-4 mb-2 rounded-xl ${
                step.completed ? 'bg-zinc-800/50' : 'bg-zinc-800'
              }`}
              accessibilityRole="button"
              accessibilityLabel={`${step.label}, ${step.completed ? 'completed' : 'not completed'}`}
              accessibilityState={{ checked: step.completed }}
            >
              {/* Completion indicator */}
              <View
                className={`w-8 h-8 rounded-full items-center justify-center mr-3 ${
                  step.completed ? 'bg-green-500/20' : 'bg-zinc-700'
                }`}
              >
                <Ionicons
                  name={step.completed ? 'checkmark' : (step.icon as keyof typeof Ionicons.glyphMap)}
                  size={step.completed ? 18 : 16}
                  color={step.completed ? '#22c55e' : '#a1a1aa'}
                />
              </View>

              {/* Step label */}
              <Text
                className={`flex-1 text-base ${
                  step.completed ? 'text-zinc-500 line-through' : 'text-zinc-100'
                }`}
              >
                {step.label}
              </Text>

              {/* Navigate arrow */}
              {!step.completed && (
                <Ionicons name="chevron-forward" size={18} color="#71717a" />
              )}
            </Pressable>
          ))}
        </ScrollView>

        {/* Action buttons */}
        <View className="mt-5">
          {/* Complete button (enabled when all steps are done) */}
          <Pressable
            onPress={handleComplete}
            disabled={!allComplete || isMarkingComplete}
            className={`py-3.5 rounded-xl items-center mb-3 ${
              allComplete && !isMarkingComplete
                ? 'bg-brand active:opacity-80'
                : 'bg-zinc-700'
            }`}
            accessibilityRole="button"
            accessibilityLabel="Complete onboarding setup"
            accessibilityState={{ disabled: !allComplete || isMarkingComplete }}
          >
            {isMarkingComplete ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Text
                className={`font-semibold text-base ${
                  allComplete ? 'text-white' : 'text-zinc-500'
                }`}
              >
                Complete Setup
              </Text>
            )}
          </Pressable>

          {/* Skip button */}
          <Pressable
            onPress={onDismiss}
            className="py-2.5 items-center"
            accessibilityRole="button"
            accessibilityLabel="Skip onboarding for now"
          >
            <Text className="text-zinc-500 text-sm">Skip for now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
