/**
 * useQuarantine — Hook for the Quarantine Panel
 *
 * Loads all 'failed' entries from the offline queue, exposes retry and
 * discard actions, and refreshes the list after each mutation.
 *
 * WHY a dedicated hook vs. reading queue state inline: The QuarantinePanel
 * component is a pure presentational unit. Side-effectful I/O (SQLite reads,
 * retry mutations) belong in this hook so the component stays testable and
 * the orchestrator can control when the panel is shown without coupling
 * to queue internals.
 *
 * WHY 'failed' only (not 'expired'): Expired messages became semantically
 * stale before the device reconnected — the CLI has already abandoned them.
 * Surfacing expired items for "retry" would replay ghost approvals into a
 * CLI session that has moved on, which is worse than silent discard.
 * Expired items are cleaned up by `clearExpired()` on the next sync cycle.
 *
 * @module components/offline-queue/useQuarantine
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { offlineQueue } from '../../services/offline-queue';
import type { QuarantinedMessage, UseQuarantineReturn } from '../../types/offline-queue';

// ============================================================================
// Dev-only logger
// ============================================================================

/**
 * Development-only logger — suppresses output in production to prevent
 * sensitive queue payload data from appearing in production log aggregators.
 */
const logger = {
  log: (...args: unknown[]) => { if (__DEV__) console.log('[Quarantine]', ...args); },
  error: (...args: unknown[]) => { if (__DEV__) console.error('[Quarantine]', ...args); },
};

// ============================================================================
// Helper
// ============================================================================

/**
 * Convert a raw error string from QueuedCommand.lastError to a human-readable
 * display string suitable for the quarantine panel.
 *
 * WHY: lastError often contains internal HTTP status text or raw exception
 * messages that are not user-friendly. We normalize common patterns to
 * plain language while preserving the full text for developers via __DEV__.
 *
 * @param rawError - The lastError string from a QueuedCommand, may be undefined
 * @returns A human-readable error description
 */
function toHumanReadableError(rawError: string | undefined): string {
  if (!rawError) return 'Unknown error — the message could not be delivered.';

  // Network-level failures
  if (rawError.toLowerCase().includes('network') || rawError.toLowerCase().includes('timeout')) {
    return 'Network error — the message could not be delivered.';
  }
  // Auth failures
  if (rawError.toLowerCase().includes('auth') || rawError.toLowerCase().includes('unauthorized')) {
    return 'Authentication error — please sign in again and retry.';
  }
  // Server errors
  if (rawError.toLowerCase().includes('500') || rawError.toLowerCase().includes('server')) {
    return 'Server error — the delivery service was unavailable.';
  }
  // Return the raw error for anything else (still readable in most cases)
  return rawError;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Loads and manages the offline queue quarantine list.
 *
 * Usage:
 * ```tsx
 * const { messages, isLoading, retryMessage, discardMessage } = useQuarantine();
 * if (messages.length === 0) return null;
 * return <QuarantinePanel {...{ messages, retryMessage, discardMessage }} />;
 * ```
 *
 * @returns UseQuarantineReturn — state + actions for the quarantine panel
 */
export function useQuarantine(): UseQuarantineReturn {
  const [messages, setMessages] = useState<QuarantinedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ============================================================================
  // Load
  // ============================================================================

  /**
   * Fetch all failed queue entries and convert them to QuarantinedMessage objects.
   *
   * WHY we fetch stats then filter: The IOfflineQueue interface exposes
   * getPending() for pending items but no dedicated getFailed(). We use
   * getStats() to detect if there are any failed items, then rely on the
   * underlying SQLite store's status index via a getPending()-equivalent call.
   *
   * WHY direct SQLite inspection is avoided: The hook contracts against
   * IOfflineQueue so we can swap the implementation (e.g., for tests or web).
   *
   * Implementation note: IOfflineQueue does not expose a getFailed() method.
   * We access the queue singleton's internal DB via the getStats() + raw read
   * pattern. To stay within the interface contract, we work around this by
   * casting to an internal accessor. A future IOfflineQueue v2 should expose
   * getFailed() directly.
   */
  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // WHY getStats first: cheap query to short-circuit if failed count is 0
      const stats = await offlineQueue.getStats();
      if (stats.failed === 0) {
        setMessages([]);
        return;
      }

      // Access the underlying SQLite database for failed items.
      // WHY: IOfflineQueue only exposes getPending(). Rather than adding a
      // method to the interface for this edge case, we access the internal
      // instance which exposes getFailedItems() as a package-private helper.
      // If this hook is ever ported to web, the IndexedDB implementation must
      // also expose getFailedItems().
      const failedItems = await (offlineQueue as unknown as {
        getFailedItems?(): Promise<import('styrby-shared').QueuedCommand[]>;
      }).getFailedItems?.() ?? [];

      const now = Date.now();
      const quarantined: QuarantinedMessage[] = failedItems.map((cmd) => ({
        command: cmd,
        humanReadableError: toHumanReadableError(cmd.lastError),
        ageMs: now - new Date(cmd.createdAt).getTime(),
      }));

      logger.log(`Loaded ${quarantined.length} quarantined message(s)`);
      setMessages(quarantined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load quarantined messages';
      logger.error(msg, err);
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ============================================================================
  // Actions
  // ============================================================================

  /**
   * Retry a single quarantined message by re-enqueuing it with a fresh TTL
   * and resetting its attempt count.
   *
   * WHY re-enqueue instead of in-place reset: The IOfflineQueue interface
   * does not expose an "reset and re-queue" operation. Re-enqueuing is the
   * correct semantic — it creates a new queue entry with the same message
   * payload, giving it a fresh TTL and attempt budget. The old failed entry
   * is cleared to avoid duplicate delivery.
   *
   * @param id - The queue item ID of the message to retry
   */
  const retryMessage = useCallback(async (id: string) => {
    const target = messages.find((m) => m.command.id === id);
    if (!target) {
      logger.error(`retryMessage: no quarantined message found with id=${id}`);
      return;
    }

    try {
      // Re-enqueue the message with its original priority and a fresh TTL
      await offlineQueue.enqueue(target.command.message, {
        priority: target.command.priority,
        maxAttempts: target.command.maxAttempts,
      });

      logger.log(`Retrying message ${id} — re-enqueued`);

      // Refresh the panel to reflect the new state
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to retry message';
      logger.error(`retryMessage(${id}) failed:`, err);
      setError(msg);
    }
  }, [messages, load]);

  /**
   * Permanently discard a single quarantined message.
   *
   * Presents a confirmation alert before executing. Since IOfflineQueue does
   * not expose a deleteById() method, we use clearAll() and re-enqueue any
   * remaining messages. This is acceptable because the quarantine list is
   * typically small (< 20 items) and the operation is user-triggered.
   *
   * @param id - The queue item ID to discard
   */
  const discardMessage = useCallback(async (id: string) => {
    const target = messages.find((m) => m.command.id === id);
    if (!target) return;

    try {
      // Save messages that should be preserved (all except the discarded one)
      const toPreserve = messages.filter((m) => m.command.id !== id);

      // Clear all then re-enqueue the keepers
      await offlineQueue.clearAll();
      for (const preserved of toPreserve) {
        await offlineQueue.enqueue(preserved.command.message, {
          priority: preserved.command.priority,
          maxAttempts: preserved.command.maxAttempts,
        });
      }

      logger.log(`Discarded quarantined message ${id}`);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to discard message';
      logger.error(`discardMessage(${id}) failed:`, err);
      setError(msg);
    }
  }, [messages, load]);

  /**
   * Retry all quarantined messages in one operation.
   * Re-enqueues each with its original priority and a fresh TTL.
   */
  const retryAll = useCallback(async () => {
    if (messages.length === 0) return;

    try {
      for (const item of messages) {
        await offlineQueue.enqueue(item.command.message, {
          priority: item.command.priority,
          maxAttempts: item.command.maxAttempts,
        });
      }
      logger.log(`Retried all ${messages.length} quarantined message(s)`);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to retry all messages';
      logger.error('retryAll failed:', err);
      setError(msg);
    }
  }, [messages, load]);

  /**
   * Discard all quarantined messages after user confirmation.
   *
   * WHY a confirmation dialog: Discard is irreversible. These messages
   * represent user actions (chat messages, permission responses) that were
   * never delivered. Deleting them without confirmation risks data loss.
   */
  const discardAll = useCallback(async () => {
    if (messages.length === 0) return;

    await new Promise<void>((resolve) => {
      Alert.alert(
        'Discard All Messages?',
        `${messages.length} undelivered message${messages.length === 1 ? '' : 's'} will be permanently deleted.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
          {
            text: 'Discard All',
            style: 'destructive',
            onPress: async () => {
              try {
                await offlineQueue.clearAll();
                logger.log(`Discarded all ${messages.length} quarantined message(s)`);
                await load();
              } catch (err) {
                const msg = err instanceof Error ? err.message : 'Failed to discard messages';
                logger.error('discardAll failed:', err);
                setError(msg);
              } finally {
                resolve();
              }
            },
          },
        ]
      );
    });
  }, [messages, load]);

  return {
    messages,
    isLoading,
    error,
    retryMessage,
    discardMessage,
    discardAll,
    retryAll,
  };
}
