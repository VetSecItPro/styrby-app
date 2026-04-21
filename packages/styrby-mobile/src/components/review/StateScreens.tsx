/**
 * StateScreens — Loading + NotFound full-screen placeholders for the review flow.
 *
 * Bundled together because they share the same centered-on-dark-background
 * layout and are mutually exclusive renders from the orchestrator.
 *
 * @module components/review/StateScreens
 */

import React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLOR_ACCENT, COLOR_BACKGROUND, COLOR_MUTED } from './constants';

/**
 * Full-screen loading spinner shown while the review is being fetched.
 *
 * @returns React element
 */
export function ReviewLoadingScreen() {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: COLOR_BACKGROUND,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <ActivityIndicator size="large" color={COLOR_ACCENT} />
      <Text style={{ color: COLOR_MUTED, marginTop: 12, fontSize: 14 }}>Loading review...</Text>
    </View>
  );
}

/**
 * Full-screen 404 state shown when the review ID couldn't be resolved.
 *
 * @param props.onBack - Called when the user taps "Go Back" to dismiss the screen
 * @returns React element
 */
export function ReviewNotFoundScreen({ onBack }: { onBack: () => void }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: COLOR_BACKGROUND,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <Ionicons name="alert-circle" size={48} color="#ef4444" />
      <Text
        style={{
          color: 'white',
          fontSize: 18,
          fontWeight: '600',
          marginTop: 16,
          textAlign: 'center',
        }}
      >
        Review Not Found
      </Text>
      <Text style={{ color: COLOR_MUTED, marginTop: 8, textAlign: 'center' }}>
        This code review may have expired or already been submitted.
      </Text>
      <Pressable
        onPress={onBack}
        style={{
          marginTop: 24,
          paddingHorizontal: 20,
          paddingVertical: 12,
          borderRadius: 12,
          backgroundColor: COLOR_ACCENT,
        }}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Text style={{ color: 'white', fontWeight: '700' }}>Go Back</Text>
      </Pressable>
    </View>
  );
}
