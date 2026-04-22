/**
 * QuarantinePanel — Failed Message Review UI
 *
 * Displays messages that exhausted all retry attempts and could not be
 * delivered to the CLI. Users can individually retry or discard each
 * message, or clear/retry the entire quarantine in bulk.
 *
 * Renders nothing when the quarantine list is empty. This allows the
 * orchestrator to unconditionally include `<QuarantinePanel />` in the
 * screen tree — the component self-hides when there is nothing to show.
 *
 * Accessibility:
 * - Each message row has `accessibilityLabel` and `accessibilityHint`
 *   for VoiceOver/TalkBack users.
 * - The list container has `accessibilityLiveRegion="polite"` so that
 *   screen readers announce count changes (retry/discard) without
 *   interrupting active speech.
 * - Action buttons carry `accessibilityRole="button"` explicitly to
 *   avoid relying on Pressable's implicit role assignment.
 * - Error messages are wrapped in `accessibilityRole="alert"` to
 *   trigger an immediate announcement.
 *
 * WHY no modal: The quarantine panel is designed to be embedded inline
 * in a screen (e.g., below the connection status bar) rather than as a
 * full-screen modal. The orchestrator decides layout; this component
 * provides the content.
 *
 * @module components/offline-queue/QuarantinePanel
 */

import React from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { useQuarantine } from './useQuarantine';
import type { QuarantinedMessage } from '../../types/offline-queue';

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Props for an individual quarantine row.
 */
interface QuarantineRowProps {
  /** The quarantined message to display */
  item: QuarantinedMessage;
  /** Callback when the user taps "Retry" */
  onRetry: (id: string) => void;
  /** Callback when the user taps "Discard" */
  onDiscard: (id: string) => void;
}

/**
 * A single row in the quarantine panel showing message info and actions.
 *
 * @param props - QuarantineRowProps
 */
function QuarantineRow({ item, onRetry, onDiscard }: QuarantineRowProps) {
  const { command, humanReadableError, ageMs } = item;
  const ageSeconds = Math.floor(ageMs / 1000);
  const ageDisplay =
    ageSeconds < 60
      ? `${ageSeconds}s ago`
      : ageSeconds < 3600
      ? `${Math.floor(ageSeconds / 60)}m ago`
      : `${Math.floor(ageSeconds / 3600)}h ago`;

  // Derive a short description of the message type for display
  const messageType = command.message.type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c: string) => c.toUpperCase());

  const rowLabel = `Failed message: ${messageType}, queued ${ageDisplay}. ${humanReadableError}`;
  const retryHint = 'Double-tap to retry sending this message';
  const discardHint = 'Double-tap to permanently delete this message';

  return (
    <View
      accessibilityRole="none"
      accessibilityLabel={rowLabel}
    >
      {/* Message summary */}
      <View>
        <Text
          accessibilityRole="text"
          numberOfLines={1}
        >
          {messageType}
        </Text>
        <Text
          accessibilityRole="text"
          numberOfLines={1}
        >
          {ageDisplay} - Attempt {command.attempts}/{command.maxAttempts}
        </Text>
      </View>

      {/* Error detail */}
      <Text
        accessibilityRole="text"
        numberOfLines={2}
      >
        {humanReadableError}
      </Text>

      {/* Action buttons */}
      <View>
        <Pressable
          onPress={() => onRetry(command.id)}
          accessibilityRole="button"
          accessibilityLabel={`Retry: ${messageType}`}
          accessibilityHint={retryHint}
        >
          <Text>Retry</Text>
        </Pressable>

        <Pressable
          onPress={() => onDiscard(command.id)}
          accessibilityRole="button"
          accessibilityLabel={`Discard: ${messageType}`}
          accessibilityHint={discardHint}
        >
          <Text>Discard</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ============================================================================
// Public Props
// ============================================================================

/**
 * Props for the QuarantinePanel component.
 *
 * All props are optional — the component manages its own state via
 * useQuarantine(). Props allow the orchestrator to override the hook
 * with pre-fetched data (e.g., from a parent useQuarantine call) to avoid
 * double-fetching.
 */
export interface QuarantinePanelProps {
  /**
   * Maximum number of messages to display before showing "Show more".
   * Defaults to 5 to keep the panel compact.
   */
  maxVisible?: number;
  /**
   * Callback invoked after a successful retry or discard, allowing the
   * orchestrator to refresh other derived state.
   */
  onChanged?: () => void;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Quarantine panel — review and act on failed-to-sync messages.
 *
 * Renders `null` when the queue has no failed entries, so callers can
 * include this unconditionally in any screen layout.
 *
 * @param props - QuarantinePanelProps
 */
export function QuarantinePanel({
  maxVisible = 5,
  onChanged,
}: QuarantinePanelProps = {}) {
  const {
    messages,
    isLoading,
    error,
    retryMessage,
    discardMessage,
    discardAll,
    retryAll,
  } = useQuarantine();

  // WHY render nothing when empty: The component is designed to be included
  // unconditionally in the layout tree. Self-hiding when empty prevents
  // adding conditional logic in every orchestrator that uses it.
  if (isLoading) {
    return (
      <View accessibilityRole="none" accessibilityLabel="Loading quarantine status">
        <ActivityIndicator
          accessibilityLabel="Loading failed messages"
        />
      </View>
    );
  }

  if (messages.length === 0) {
    // Render null — no failed messages to show
    return null;
  }

  const visibleMessages = messages.slice(0, maxVisible);
  const hiddenCount = messages.length - visibleMessages.length;

  const handleRetry = async (id: string) => {
    await retryMessage(id);
    onChanged?.();
  };

  const handleDiscard = async (id: string) => {
    await discardMessage(id);
    onChanged?.();
  };

  const handleRetryAll = async () => {
    await retryAll();
    onChanged?.();
  };

  const handleDiscardAll = async () => {
    await discardAll();
    onChanged?.();
  };

  return (
    <View
      /**
       * WHY accessibilityLiveRegion="polite": When the user retries or discards
       * a message, the count changes. "polite" tells VoiceOver/TalkBack to
       * announce the new count after finishing any active speech, without
       * interrupting the user.
       */
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${messages.length} undelivered message${messages.length === 1 ? '' : 's'} require review`}
    >
      {/* Header */}
      <View>
        <Text accessibilityRole="header">
          {messages.length} Undelivered {messages.length === 1 ? 'Message' : 'Messages'}
        </Text>

        {/* Bulk actions */}
        <View>
          <Pressable
            onPress={handleRetryAll}
            accessibilityRole="button"
            accessibilityLabel="Retry all failed messages"
            accessibilityHint="Double-tap to re-attempt sending all failed messages"
          >
            <Text>Retry All</Text>
          </Pressable>

          <Pressable
            onPress={handleDiscardAll}
            accessibilityRole="button"
            accessibilityLabel="Discard all failed messages"
            accessibilityHint="Double-tap to permanently delete all failed messages after confirmation"
          >
            <Text>Discard All</Text>
          </Pressable>
        </View>
      </View>

      {/* Error state */}
      {error !== null && (
        <Text
          accessibilityRole="alert"
          accessibilityLabel={`Error: ${error}`}
        >
          {error}
        </Text>
      )}

      {/* Message list */}
      <FlatList
        data={visibleMessages}
        keyExtractor={(item) => item.command.id}
        renderItem={({ item }) => (
          <QuarantineRow
            item={item}
            onRetry={handleRetry}
            onDiscard={handleDiscard}
          />
        )}
        accessibilityRole="list"
        accessibilityLabel="Failed messages"
        scrollEnabled={false}
      />

      {/* "Show more" overflow indicator */}
      {hiddenCount > 0 && (
        <Text
          accessibilityRole="text"
          accessibilityLabel={`${hiddenCount} more failed message${hiddenCount === 1 ? '' : 's'} not shown`}
        >
          +{hiddenCount} more
        </Text>
      )}
    </View>
  );
}
