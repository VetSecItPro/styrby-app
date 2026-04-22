/**
 * FeedbackButton — persistent "Send feedback" affordance for mobile.
 *
 * Used in the Settings screen (and anywhere else we want a one-tap feedback
 * entry point). Opens the FeedbackSheet when pressed.
 *
 * WHY a dedicated component: The feedback button appears on multiple screens
 * (settings, session summary). Centralising it avoids duplication.
 *
 * @module components/feedback/FeedbackButton
 */

import React, { useState, useCallback } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FeedbackSheet } from './FeedbackSheet';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for FeedbackButton.
 */
export interface FeedbackButtonProps {
  /** Current screen route name (for context capture, no PII) */
  currentRoute?: string;
  /** Optional style override for the button container */
  className?: string;
  /** Button variant */
  variant?: 'row' | 'pill';
}

// ============================================================================
// Component
// ============================================================================

/**
 * Feedback entry button that opens the FeedbackSheet. See module doc.
 *
 * @param props - FeedbackButtonProps
 */
export function FeedbackButton({
  currentRoute,
  className = '',
  variant = 'row',
}: FeedbackButtonProps) {
  const [sheetOpen, setSheetOpen] = useState(false);

  const handlePress = useCallback(() => setSheetOpen(true), []);
  const handleClose = useCallback(() => setSheetOpen(false), []);

  return (
    <>
      {variant === 'row' ? (
        <Pressable
          onPress={handlePress}
          className={`flex-row items-center justify-between border-b border-zinc-800 px-4 py-4 active:bg-zinc-800 ${className}`}
          accessibilityRole="button"
          accessibilityLabel="Send feedback"
        >
          <View className="flex-row items-center gap-3">
            <Ionicons name="chatbubble-outline" size={20} color="#818cf8" />
            <Text className="text-sm text-zinc-200">Send feedback</Text>
          </View>
          <Text className="text-zinc-500">›</Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={handlePress}
          className={`flex-row items-center gap-2 rounded-full border border-zinc-700 bg-zinc-800 px-4 py-2 active:opacity-70 ${className}`}
          accessibilityRole="button"
          accessibilityLabel="Send feedback"
        >
          <Ionicons name="chatbubble-outline" size={14} color="#818cf8" />
          <Text className="text-sm text-zinc-300">Feedback</Text>
        </Pressable>
      )}

      <FeedbackSheet
        visible={sheetOpen}
        currentRoute={currentRoute}
        onClose={handleClose}
      />
    </>
  );
}
