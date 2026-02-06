/**
 * Onboarding Progress Indicator
 *
 * Visual progress indicator showing the current step in the onboarding flow.
 * Uses animated dots that expand when active, providing clear feedback on
 * where the user is in the multi-step onboarding process.
 */

import { View } from 'react-native';

/**
 * Props for the OnboardingProgress component.
 */
interface OnboardingProgressProps {
  /** The current step number (1-indexed) */
  currentStep: number;
  /** Total number of steps in the onboarding flow */
  totalSteps: number;
}

/**
 * Renders a horizontal row of dots indicating onboarding progress.
 * Active and completed steps are highlighted with the brand color and
 * an expanded width, while upcoming steps remain muted.
 *
 * @param currentStep - The current step (1-indexed)
 * @param totalSteps - Total number of steps
 * @returns A row of progress indicator dots
 *
 * @example
 * <OnboardingProgress currentStep={2} totalSteps={5} />
 */
export function OnboardingProgress({ currentStep, totalSteps }: OnboardingProgressProps) {
  return (
    <View
      className="flex-row justify-center items-center gap-2 py-4"
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${currentStep} of ${totalSteps}`}
      accessibilityValue={{
        min: 1,
        max: totalSteps,
        now: currentStep,
      }}
    >
      {Array.from({ length: totalSteps }).map((_, index) => {
        const stepNumber = index + 1;
        const isActive = stepNumber === currentStep;
        const isCompleted = stepNumber < currentStep;

        return (
          <View
            key={index}
            className={`h-2 rounded-full ${
              isActive || isCompleted
                ? 'bg-brand'
                : 'bg-zinc-700'
            } ${
              isActive
                ? 'w-8'
                : 'w-2'
            }`}
          />
        );
      })}
    </View>
  );
}
