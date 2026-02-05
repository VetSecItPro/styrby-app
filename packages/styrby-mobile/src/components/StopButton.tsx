/**
 * Stop Button Component
 *
 * Button to interrupt/cancel a running agent command.
 * Sends SIGINT to the CLI agent process via the relay.
 *
 * @module components/StopButton
 */

import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useState, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the StopButton component.
 */
export interface StopButtonProps {
  /** Whether an operation is currently running and can be stopped */
  isRunning: boolean;
  /** Whether the stop request is in progress */
  isStopping?: boolean;
  /** Callback to handle the stop action */
  onStop: () => Promise<void>;
  /** Optional label override */
  label?: string;
  /** Button size variant */
  size?: 'small' | 'medium' | 'large';
  /** Whether the button is disabled */
  disabled?: boolean;
}

// ============================================================================
// Size Configuration
// ============================================================================

/**
 * Size configurations for the button variants.
 */
const SIZE_CONFIG = {
  small: {
    button: 'px-3 py-1.5',
    icon: 16,
    text: 'text-xs',
  },
  medium: {
    button: 'px-4 py-2',
    icon: 18,
    text: 'text-sm',
  },
  large: {
    button: 'px-5 py-3',
    icon: 20,
    text: 'text-base',
  },
};

// ============================================================================
// Component
// ============================================================================

/**
 * Button to stop a running agent command.
 *
 * When pressed, triggers a haptic feedback and calls the onStop callback.
 * Shows a loading state while the stop request is being processed.
 *
 * @param props - Component props
 * @returns React element
 *
 * @example
 * <StopButton
 *   isRunning={isAgentThinking}
 *   onStop={async () => {
 *     await sendCommand({ action: 'interrupt' });
 *   }}
 * />
 */
export function StopButton({
  isRunning,
  isStopping = false,
  onStop,
  label = 'Stop',
  size = 'medium',
  disabled = false,
}: StopButtonProps) {
  const [localStopping, setLocalStopping] = useState(false);
  const sizeConfig = SIZE_CONFIG[size];

  const isStoppingState = isStopping || localStopping;
  const isDisabled = disabled || !isRunning || isStoppingState;

  /**
   * Handles the stop button press.
   * Triggers haptic feedback and calls the onStop callback.
   */
  const handlePress = useCallback(async () => {
    if (isDisabled) return;

    // Trigger haptic feedback for important action
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    setLocalStopping(true);
    try {
      await onStop();
    } finally {
      setLocalStopping(false);
    }
  }, [isDisabled, onStop]);

  // Don't render if not running
  if (!isRunning && !isStoppingState) {
    return null;
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={isDisabled}
      className={`flex-row items-center rounded-full ${sizeConfig.button} ${
        isDisabled ? 'bg-red-500/30' : 'bg-red-500'
      }`}
      style={{
        opacity: isDisabled ? 0.6 : 1,
      }}
    >
      {isStoppingState ? (
        <ActivityIndicator size="small" color="white" />
      ) : (
        <Ionicons name="stop" size={sizeConfig.icon} color="white" />
      )}
      <Text className={`text-white font-semibold ml-2 ${sizeConfig.text}`}>
        {isStoppingState ? 'Stopping...' : label}
      </Text>
    </Pressable>
  );
}

// ============================================================================
// Floating Variant
// ============================================================================

/**
 * Floating stop button positioned at the bottom of the screen.
 * Animates in when running and out when not.
 *
 * @param props - Component props
 * @returns React element
 *
 * @example
 * <FloatingStopButton
 *   isRunning={isAgentThinking}
 *   onStop={handleStop}
 * />
 */
export function FloatingStopButton({
  isRunning,
  isStopping = false,
  onStop,
  disabled = false,
}: Omit<StopButtonProps, 'size' | 'label'>) {
  const [localStopping, setLocalStopping] = useState(false);

  const isStoppingState = isStopping || localStopping;
  const isDisabled = disabled || !isRunning || isStoppingState;

  /**
   * Handles the stop button press with haptic feedback.
   */
  const handlePress = useCallback(async () => {
    if (isDisabled) return;

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    setLocalStopping(true);
    try {
      await onStop();
    } finally {
      setLocalStopping(false);
    }
  }, [isDisabled, onStop]);

  // Don't render if not running
  if (!isRunning && !isStoppingState) {
    return null;
  }

  return (
    <View className="absolute bottom-24 left-0 right-0 items-center">
      <Pressable
        onPress={handlePress}
        disabled={isDisabled}
        className={`flex-row items-center px-6 py-3 rounded-full shadow-lg ${
          isDisabled ? 'bg-red-500/30' : 'bg-red-500'
        }`}
        style={{
          shadowColor: '#ef4444',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.3,
          shadowRadius: 8,
          elevation: 8,
        }}
      >
        {isStoppingState ? (
          <ActivityIndicator size="small" color="white" />
        ) : (
          <Ionicons name="stop-circle" size={24} color="white" />
        )}
        <Text className="text-white font-bold text-base ml-2">
          {isStoppingState ? 'Stopping...' : 'Stop Generation'}
        </Text>
      </Pressable>
    </View>
  );
}

// ============================================================================
// Icon-Only Variant
// ============================================================================

/**
 * Icon-only stop button for compact spaces.
 *
 * @param props - Component props
 * @returns React element
 *
 * @example
 * <StopButtonIcon
 *   isRunning={isAgentThinking}
 *   onStop={handleStop}
 * />
 */
export function StopButtonIcon({
  isRunning,
  isStopping = false,
  onStop,
  disabled = false,
}: Omit<StopButtonProps, 'size' | 'label'>) {
  const [localStopping, setLocalStopping] = useState(false);

  const isStoppingState = isStopping || localStopping;
  const isDisabled = disabled || !isRunning || isStoppingState;

  /**
   * Handles the stop button press with haptic feedback.
   */
  const handlePress = useCallback(async () => {
    if (isDisabled) return;

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    setLocalStopping(true);
    try {
      await onStop();
    } finally {
      setLocalStopping(false);
    }
  }, [isDisabled, onStop]);

  // Don't render if not running
  if (!isRunning && !isStoppingState) {
    return null;
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={isDisabled}
      className={`w-10 h-10 rounded-full items-center justify-center ${
        isDisabled ? 'bg-red-500/30' : 'bg-red-500'
      }`}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      {isStoppingState ? (
        <ActivityIndicator size="small" color="white" />
      ) : (
        <Ionicons name="stop" size={20} color="white" />
      )}
    </Pressable>
  );
}
