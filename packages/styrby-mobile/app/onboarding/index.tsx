/**
 * Onboarding Flow
 *
 * 5-step onboarding flow:
 * 1. Welcome (pager step 1)
 * 2. Install CLI (pager step 2)
 * 3. Scan QR (pager step 3 -> navigates to scan screen)
 * 4. Notifications (separate screen after scan)
 * 5. Complete (final screen)
 *
 * This screen handles the first 3 steps via a swipeable pager.
 * The remaining steps are separate screens for focused user interaction.
 *
 * Step persistence:
 * The current onboarding step is persisted to SecureStore so users can resume
 * where they left off if the app is closed mid-onboarding. On mount, the screen
 * checks what the user has already completed (authentication, pairing, push token)
 * and resumes from the first incomplete step.
 */

import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useState, useRef, useCallback, useEffect } from 'react';
import { router } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { OnboardingProgress } from '../../src/components/OnboardingProgress';
import { isPaired } from '../../src/services/pairing';
import { supabase } from '../../src/lib/supabase';

/** Total number of steps in the complete onboarding flow */
const TOTAL_ONBOARDING_STEPS = 5;

/**
 * SecureStore key for persisting the current onboarding pager step index.
 * WHY: If a user closes the app during onboarding, they should resume from
 * their last step rather than restarting from Welcome. We use SecureStore
 * (not AsyncStorage) because it is already available in the project and avoids
 * adding another dependency.
 */
const ONBOARDING_STEP_KEY = 'styrby_onboarding_step';

/**
 * SecureStore key for marking onboarding as fully completed.
 * WHY: Separate from the step key because completion indicates the entire
 * flow is done, not just a particular pager step.
 */
const ONBOARDING_COMPLETE_KEY = 'styrby_onboarding_complete';

interface OnboardingStep {
  title: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  iconBg: string;
  content?: React.ReactNode;
}

const STEPS: OnboardingStep[] = [
  {
    title: 'Welcome to Styrby',
    description: 'Control your AI coding agents from anywhere. Track costs, approve permissions, manage sessions — all from your pocket.',
    icon: 'rocket',
    iconColor: '#f97316',
    iconBg: 'rgba(249, 115, 22, 0.15)',
  },
  {
    title: 'Install the CLI',
    description: 'Install Styrby CLI on your development machine to connect your AI agents.',
    icon: 'terminal',
    iconColor: '#22c55e',
    iconBg: 'rgba(34, 197, 94, 0.15)',
  },
  {
    title: 'Scan QR Code',
    description: 'Run `styrby pair` in your terminal and scan the QR code to connect.',
    icon: 'qr-code',
    iconColor: '#3b82f6',
    iconBg: 'rgba(59, 130, 246, 0.15)',
  },
];

/** Terminal command for CLI installation (step 2). */
const INSTALL_COMMAND = 'npm install -g styrby';

/** Terminal command for device pairing (step 3). */
const PAIR_COMMAND = 'styrby pair';

/**
 * Determines the first incomplete onboarding pager step by checking
 * which actions the user has already completed.
 *
 * Smart resume logic:
 * - If the user is authenticated, step 0 (Welcome) is complete
 * - If pairing info exists in SecureStore, step 2 (Scan QR) is done
 * - Step 1 (Install CLI) is inferred as done if pairing exists (can't pair without CLI)
 *
 * @returns The zero-based pager index to resume from
 *
 * @example
 * const step = await computeResumeStep();
 * pagerRef.current?.setPage(step);
 */
async function computeResumeStep(): Promise<number> {
  try {
    // Check if device is already paired — implies CLI installed + QR scanned
    const paired = await isPaired();
    if (paired) {
      // WHY: If already paired, the user has completed steps 0-2 (Welcome, Install CLI,
      // Scan QR). Return the last pager step so they can proceed to the scan screen
      // and then on to notifications.
      return STEPS.length - 1;
    }

    // Check if user is authenticated — implies Welcome step is done
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      // Check if there's a saved step that's further along
      const savedStep = await SecureStore.getItemAsync(ONBOARDING_STEP_KEY);
      if (savedStep !== null) {
        const parsed = parseInt(savedStep, 10);
        // WHY: Clamp to valid range to prevent crashes if stored value is corrupted
        if (!isNaN(parsed) && parsed >= 0 && parsed < STEPS.length) {
          return Math.max(1, parsed); // At minimum step 1, since they're authenticated
        }
      }
      return 1; // Skip Welcome, go to Install CLI
    }

    return 0; // Start from the beginning
  } catch {
    // On any error, start from step 0 — safe fallback
    return 0;
  }
}

/**
 * Persists the current onboarding pager step to SecureStore.
 *
 * @param stepIndex - The zero-based pager step index to save
 */
async function saveOnboardingStep(stepIndex: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(ONBOARDING_STEP_KEY, stepIndex.toString());
  } catch {
    // Non-fatal: persistence failure just means the user restarts from an earlier step
    if (__DEV__) {
      console.warn('[Onboarding] Failed to save step index:', stepIndex);
    }
  }
}

/**
 * Marks onboarding as fully completed in SecureStore and clears the step key.
 * Called when the user navigates past the final pager step to the scan screen.
 */
async function markOnboardingPagerComplete(): Promise<void> {
  try {
    await SecureStore.setItemAsync(ONBOARDING_COMPLETE_KEY, 'true');
    await SecureStore.deleteItemAsync(ONBOARDING_STEP_KEY);
  } catch {
    if (__DEV__) {
      console.warn('[Onboarding] Failed to mark pager complete');
    }
  }
}

export default function OnboardingScreen() {
  const pagerRef = useRef<PagerView>(null);
  const [currentPage, setCurrentPage] = useState(0);

  /**
   * Whether the screen is still computing the resume step.
   * WHY: We need to determine the correct starting page before rendering
   * the pager, otherwise the user sees a flash of step 0 before jumping.
   */
  const [isRestoringStep, setIsRestoringStep] = useState(true);

  /**
   * Tracks which command was recently copied so the UI can show
   * a checkmark icon for 2 seconds as visual confirmation.
   * Value is 'install' | 'pair' | null.
   */
  const [copiedCommand, setCopiedCommand] = useState<'install' | 'pair' | null>(null);

  /**
   * On mount, compute the resume step and set the pager to it.
   * WHY: If a user closes the app mid-onboarding, they should resume from
   * their last step (or from the first incomplete step based on what they've
   * already accomplished — authenticated, paired, etc.).
   */
  useEffect(() => {
    let isMounted = true;

    const restoreStep = async () => {
      const resumeStep = await computeResumeStep();
      if (isMounted) {
        setCurrentPage(resumeStep);
        // WHY: setPage must be called after the PagerView has mounted.
        // Using requestAnimationFrame ensures the pager is ready.
        requestAnimationFrame(() => {
          pagerRef.current?.setPageWithoutAnimation(resumeStep);
        });
        setIsRestoringStep(false);
      }
    };

    restoreStep();

    return () => {
      isMounted = false;
    };
  }, []);

  /**
   * Copies a terminal command to the system clipboard and shows
   * brief visual feedback (checkmark icon for 2 seconds).
   *
   * @param text - The command string to copy
   * @param id - Identifier for which button to animate ('install' or 'pair')
   */
  const handleCopy = useCallback(async (text: string, id: 'install' | 'pair') => {
    await Clipboard.setStringAsync(text);
    setCopiedCommand(id);
    setTimeout(() => setCopiedCommand(null), 2000);
  }, []);

  /**
   * Advances to the next pager step, or navigates to the scan screen
   * when the last pager step is reached. Persists the new step index
   * to SecureStore for resume support.
   */
  const handleNext = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (currentPage < STEPS.length - 1) {
      const nextPage = currentPage + 1;
      pagerRef.current?.setPage(nextPage);
      await saveOnboardingStep(nextPage);
    } else {
      // Mark pager steps as complete before navigating to scan
      await markOnboardingPagerComplete();
      // Go to scan screen (step 3 completion leads to camera scanner)
      router.push('/(auth)/scan');
    }
  };

  /**
   * Skips onboarding and goes directly to the dashboard.
   * Only available for users who are already paired.
   */
  const handleSkip = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await markOnboardingPagerComplete();
    router.replace('/(tabs)');
  };

  const isLastStep = currentPage === STEPS.length - 1;

  /** Calculate the current step in the overall flow (1-indexed for display) */
  const currentOverallStep = currentPage + 1;

  /**
   * Handles pager page changes from both swipe gestures and programmatic navigation.
   * Persists the new step index for resume support.
   *
   * @param position - The zero-based index of the newly selected page
   */
  const handlePageSelected = useCallback((position: number) => {
    setCurrentPage(position);
    // Fire-and-forget persistence — non-blocking for UI responsiveness
    saveOnboardingStep(position);
  }, []);

  // WHY: Show a loading indicator while computing the resume step to prevent
  // a flash of step 0 before jumping to the correct step.
  if (isRestoringStep) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header with skip button and progress indicator */}
      <View className="pt-16 px-4">
        <View className="flex-row justify-end mb-2">
          <Pressable
            onPress={handleSkip}
            className="px-4 py-2"
            accessibilityLabel="Skip onboarding"
            accessibilityRole="button"
          >
            <Text className="text-zinc-400 text-base">Skip</Text>
          </Pressable>
        </View>
        <OnboardingProgress
          currentStep={currentOverallStep}
          totalSteps={TOTAL_ONBOARDING_STEPS}
        />
      </View>

      {/* Pager */}
      <PagerView
        ref={pagerRef}
        style={{ flex: 1 }}
        initialPage={currentPage}
        onPageSelected={(e) => handlePageSelected(e.nativeEvent.position)}
      >
        {STEPS.map((step, index) => (
          <View key={index} className="flex-1 items-center justify-center px-8">
            {/* Icon */}
            <View
              style={{ backgroundColor: step.iconBg }}
              className="w-24 h-24 rounded-3xl items-center justify-center mb-8"
            >
              <Ionicons name={step.icon} size={48} color={step.iconColor} />
            </View>

            {/* Title */}
            <Text className="text-white text-2xl font-bold text-center mb-4">
              {step.title}
            </Text>

            {/* Description */}
            <Text className="text-zinc-400 text-lg text-center leading-7">
              {step.description}
            </Text>

            {/* CLI install command for step 2 */}
            {index === 1 && (
              <View className="mt-8 bg-zinc-900 rounded-xl p-4 w-full">
                <View className="flex-row items-center justify-between mb-2">
                  <Text className="text-zinc-500 text-sm">Terminal</Text>
                  <Pressable
                    className="flex-row items-center"
                    onPress={() => handleCopy(INSTALL_COMMAND, 'install')}
                    accessibilityLabel="Copy install command to clipboard"
                    accessibilityRole="button"
                  >
                    <Ionicons
                      name={copiedCommand === 'install' ? 'checkmark' : 'copy-outline'}
                      size={14}
                      color={copiedCommand === 'install' ? '#22c55e' : '#71717a'}
                    />
                    <Text
                      className={`text-sm ml-1 ${copiedCommand === 'install' ? 'text-green-500' : 'text-zinc-500'}`}
                    >
                      {copiedCommand === 'install' ? 'Copied!' : 'Copy'}
                    </Text>
                  </Pressable>
                </View>
                <Text className="text-green-400 font-mono text-base">
                  {INSTALL_COMMAND}
                </Text>
              </View>
            )}

            {/* Pair command for step 3 */}
            {index === 2 && (
              <View className="mt-8 bg-zinc-900 rounded-xl p-4 w-full">
                <View className="flex-row items-center justify-between mb-2">
                  <Text className="text-zinc-500 text-sm">Terminal</Text>
                  <Pressable
                    className="flex-row items-center"
                    onPress={() => handleCopy(PAIR_COMMAND, 'pair')}
                    accessibilityLabel="Copy pair command to clipboard"
                    accessibilityRole="button"
                  >
                    <Ionicons
                      name={copiedCommand === 'pair' ? 'checkmark' : 'copy-outline'}
                      size={14}
                      color={copiedCommand === 'pair' ? '#22c55e' : '#71717a'}
                    />
                    <Text
                      className={`text-sm ml-1 ${copiedCommand === 'pair' ? 'text-green-500' : 'text-zinc-500'}`}
                    >
                      {copiedCommand === 'pair' ? 'Copied!' : 'Copy'}
                    </Text>
                  </Pressable>
                </View>
                <Text className="text-blue-400 font-mono text-base">{PAIR_COMMAND}</Text>
              </View>
            )}
          </View>
        ))}
      </PagerView>

      {/* Bottom section */}
      <View className="px-8 pb-12">
        {/* Action button */}
        <Pressable
          onPress={handleNext}
          className="bg-brand py-4 rounded-xl flex-row items-center justify-center"
        >
          <Text className="text-white font-semibold text-lg">
            {isLastStep ? 'Scan QR Code' : 'Continue'}
          </Text>
          <Ionicons
            name={isLastStep ? 'qr-code' : 'arrow-forward'}
            size={20}
            color="white"
            style={{ marginLeft: 8 }}
          />
        </Pressable>

        {/* Already have account */}
        <Pressable onPress={handleSkip} className="mt-4 py-2">
          <Text className="text-zinc-500 text-center">
            Already paired?{' '}
            <Text className="text-brand">Go to Dashboard</Text>
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
