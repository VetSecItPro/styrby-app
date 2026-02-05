/**
 * Onboarding Flow
 *
 * 3-step onboarding: Welcome → Install CLI → Scan QR → Success
 */

import { View, Text, Pressable, Dimensions } from 'react-native';
import { useState, useRef, useCallback } from 'react';
import { router } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

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

export default function OnboardingScreen() {
  const pagerRef = useRef<PagerView>(null);
  const [currentPage, setCurrentPage] = useState(0);

  /**
   * Tracks which command was recently copied so the UI can show
   * a checkmark icon for 2 seconds as visual confirmation.
   * Value is 'install' | 'pair' | null.
   */
  const [copiedCommand, setCopiedCommand] = useState<'install' | 'pair' | null>(null);

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

  const handleNext = () => {
    if (currentPage < STEPS.length - 1) {
      pagerRef.current?.setPage(currentPage + 1);
    } else {
      // Go to scan screen
      router.replace('/(auth)/scan');
    }
  };

  const handleSkip = () => {
    router.replace('/(tabs)');
  };

  const isLastStep = currentPage === STEPS.length - 1;

  return (
    <View className="flex-1 bg-background">
      {/* Skip button */}
      <View className="absolute top-16 right-4 z-10">
        <Pressable onPress={handleSkip} className="px-4 py-2">
          <Text className="text-zinc-400 text-base">Skip</Text>
        </Pressable>
      </View>

      {/* Pager */}
      <PagerView
        ref={pagerRef}
        style={{ flex: 1 }}
        initialPage={0}
        onPageSelected={(e) => setCurrentPage(e.nativeEvent.position)}
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
        {/* Page indicators */}
        <View className="flex-row justify-center mb-8">
          {STEPS.map((_, index) => (
            <View
              key={index}
              className={`w-2 h-2 rounded-full mx-1 ${
                index === currentPage ? 'bg-brand w-6' : 'bg-zinc-700'
              }`}
            />
          ))}
        </View>

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
