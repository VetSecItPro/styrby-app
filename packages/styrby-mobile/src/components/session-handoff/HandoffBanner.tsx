/**
 * Handoff Banner — Mobile
 *
 * Dismissible banner shown when a user opens an existing session on a
 * different device from the one that last wrote a snapshot within the
 * past 5 minutes.
 *
 * WHY same UX as web: Both surfaces present the same two choices (Resume /
 * Start fresh) so users do not need to re-learn the interaction when
 * switching between the app and the browser.
 *
 * Accessibility: Uses `accessibilityRole="alert"` so VoiceOver/TalkBack
 * announces the banner immediately. All interactive elements have
 * `accessibilityLabel` set for clarity.
 *
 * @module components/session-handoff/HandoffBanner
 */

import { useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { HandoffResponse } from '@styrby/shared/session-handoff';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the mobile HandoffBanner.
 */
export interface HandoffBannerProps {
  /**
   * The non-`available: false` handoff response that triggered the banner.
   * Guaranteed to have `available: true` at the call site.
   */
  handoff: Extract<HandoffResponse, { available: true }>;

  /**
   * Called when the user taps "Resume" — caller should restore cursor,
   * scroll, and draft state from the handoff data.
   */
  onResume: (handoff: Extract<HandoffResponse, { available: true }>) => void;

  /**
   * Called when the user taps "Start fresh" or the dismiss X.
   */
  onDismiss: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Maps device kind to a human-readable label for the banner copy.
 *
 * @param kind - Device kind from the handoff response
 * @returns Display string
 */
function deviceLabel(kind: string): string {
  switch (kind) {
    case 'mobile_ios':
      return 'iPhone';
    case 'mobile_android':
      return 'Android';
    case 'cli':
      return 'terminal';
    case 'web':
    default:
      return 'Mac/PC';
  }
}

/**
 * Formats snapshot age in milliseconds to a short string.
 *
 * @param ageMs - Age in milliseconds
 * @returns E.g. "just now", "2 min ago"
 */
function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  return `${minutes} min ago`;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Mobile handoff prompt banner.
 *
 * Displays above the session view when a recent snapshot from a different
 * device is available. Provides "Resume" and "Start fresh" CTAs.
 *
 * @param props - HandoffBannerProps
 * @returns The banner element, or null if dismissed
 *
 * @example
 * {handoff?.available && (
 *   <HandoffBanner
 *     handoff={handoff}
 *     onResume={handleResume}
 *     onDismiss={() => setHandoff(null)}
 *   />
 * )}
 */
export function HandoffBanner({ handoff, onResume, onDismiss }: HandoffBannerProps) {
  const [visible, setVisible] = useState(true);

  const handleResume = useCallback(() => {
    setVisible(false);
    onResume(handoff);
  }, [handoff, onResume]);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    onDismiss();
  }, [onDismiss]);

  if (!visible) return null;

  const label = deviceLabel(handoff.lastDeviceKind);
  const age = formatAge(handoff.ageMs);
  const hasDraft = Boolean(handoff.activeDraft);

  return (
    <View
      style={styles.container}
      accessibilityRole="alert"
      accessibilityLabel={`Session handoff available from ${label}`}
      testID="handoff-banner"
    >
      {/* Info icon */}
      <Ionicons name="information-circle-outline" size={18} color="#3b82f6" style={styles.icon} />

      {/* Message */}
      <View style={styles.messageContainer}>
        <Text style={styles.messageText}>
          Pick up where you left off on{' '}
          <Text style={styles.deviceLabel}>{label}</Text>
          {' '}
          <Text style={styles.ageText}>({age})</Text>
        </Text>
        {hasDraft && (
          <Text style={styles.draftHint}>Unsent message restored</Text>
        )}
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <Pressable
          onPress={handleResume}
          style={({ pressed }) => [styles.resumeButton, pressed && styles.pressedOpacity]}
          accessibilityLabel="Resume session from other device"
          accessibilityRole="button"
          testID="handoff-resume-button"
        >
          <Text style={styles.resumeText}>Resume</Text>
        </Pressable>

        <Pressable
          onPress={handleDismiss}
          style={({ pressed }) => [styles.freshButton, pressed && styles.pressedOpacity]}
          accessibilityLabel="Start fresh on this device"
          accessibilityRole="button"
          testID="handoff-start-fresh-button"
        >
          <Text style={styles.freshText}>Fresh</Text>
        </Pressable>

        {/* Dismiss X */}
        <Pressable
          onPress={handleDismiss}
          style={({ pressed }) => [styles.dismissButton, pressed && styles.pressedOpacity]}
          accessibilityLabel="Dismiss handoff prompt"
          accessibilityRole="button"
          testID="handoff-dismiss-button"
        >
          <Ionicons name="close" size={16} color="#6b7280" />
        </Pressable>
      </View>
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    gap: 8,
  },
  icon: {
    flexShrink: 0,
  },
  messageContainer: {
    flex: 1,
    gap: 2,
  },
  messageText: {
    fontSize: 13,
    color: '#1e3a5f',
    lineHeight: 18,
  },
  deviceLabel: {
    fontWeight: '600',
  },
  ageText: {
    color: '#3b82f6',
  },
  draftHint: {
    fontSize: 11,
    color: '#3b82f6',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  resumeButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  resumeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  freshButton: {
    borderWidth: 1,
    borderColor: '#93c5fd',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  freshText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#1d4ed8',
  },
  dismissButton: {
    padding: 4,
    borderRadius: 4,
  },
  pressedOpacity: {
    opacity: 0.7,
  },
});
