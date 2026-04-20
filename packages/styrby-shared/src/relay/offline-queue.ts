/**
 * Offline Command Queue
 *
 * Queues commands when the device is offline and syncs when reconnected.
 * Uses SQLite on mobile and IndexedDB on web for persistence.
 *
 * This module defines the types and interface - platform-specific
 * implementations are in styrby-mobile and styrby-web.
 */

import type { RelayMessage } from './types.js';

// ============================================================================
// Queue Item Types
// ============================================================================

/**
 * Lifecycle state of a single item in the offline command queue.
 *
 * WHY explicit states instead of a boolean 'sent' flag: The queue needs to
 * distinguish between commands that are actively being sent (locked to prevent
 * duplicate delivery), commands that failed and are waiting for retry, and
 * commands that expired before the device came back online. Each state drives
 * different UI feedback and retry behavior in `IOfflineQueue.processQueue`.
 */
export type QueueItemStatus =
  | 'pending'    // Waiting to be sent
  | 'sending'    // Currently being sent
  | 'sent'       // Successfully sent
  | 'failed'     // Failed to send (will retry)
  | 'expired';   // Expired before sending

/**
 * A relay message that was queued while the mobile device was offline.
 *
 * When Styrby mobile loses connectivity mid-session, user actions (chat
 * messages, permission responses, cancellations) are stored as QueuedCommands
 * and flushed in priority order when the connection is restored.
 *
 * WHY `expiresAt`: Some commands become semantically meaningless after a
 * timeout. A permission_response queued for 10 minutes is likely stale —
 * the CLI agent will have already timed out waiting. Expiry prevents the CLI
 * from receiving ghost approvals for operations it has already abandoned.
 *
 * WHY `priority`: Critical commands (cancellations, permission responses)
 * must be delivered before low-priority commands (analytics, acks) even if
 * the low-priority commands were queued first.
 */
export interface QueuedCommand {
  /** Unique queue item ID */
  id: string;
  /** The message to send */
  message: RelayMessage;
  /** Current status */
  status: QueueItemStatus;
  /** Number of send attempts */
  attempts: number;
  /** Maximum retry attempts before marking as failed */
  maxAttempts: number;
  /** When the command was queued */
  createdAt: string;
  /** When the command expires (won't be sent after this) */
  expiresAt: string;
  /** Last attempt timestamp */
  lastAttemptAt?: string;
  /** Error message from last failed attempt */
  lastError?: string;
  /** Priority (higher = sent first) */
  priority: number;
}

/**
 * Snapshot of offline queue health, surfaced in the mobile connection status UI.
 *
 * Displayed in the connectivity banner so users know how many commands are
 * waiting to be flushed. A non-zero `failed` count triggers a warning state
 * ("X commands could not be sent") after reconnection.
 */
export interface QueueStats {
  /** Total items in queue */
  total: number;
  /** Pending items */
  pending: number;
  /** Failed items (exhausted retries) */
  failed: number;
  /** Expired items */
  expired: number;
  /** Oldest pending item age in ms */
  oldestPendingAge?: number;
}

// ============================================================================
// Queue Interface
// ============================================================================

/**
 * Platform-agnostic contract for the offline command queue.
 *
 * WHY an interface instead of a single implementation: The persistence layer
 * differs per platform — SQLite via expo-sqlite on mobile, IndexedDB on web,
 * and an in-memory mock in tests. Coding against this interface lets shared
 * relay logic (e.g., `processQueue`) work identically on all three without
 * importing platform-specific modules into styrby-shared.
 *
 * The `processQueue` method is designed to be called repeatedly by a network
 * connectivity listener. It dequeues pending items in priority order, calls
 * `sendFn` for each one, and handles retry/expiry logic.
 */
export interface IOfflineQueue {
  /**
   * Add a command to the queue
   */
  enqueue(message: RelayMessage, options?: EnqueueOptions): Promise<QueuedCommand>;

  /**
   * Get the next pending command to send
   */
  dequeue(): Promise<QueuedCommand | null>;

  /**
   * Mark a command as sent successfully
   */
  markSent(id: string): Promise<void>;

  /**
   * Mark a command as failed (will retry if attempts remaining)
   */
  markFailed(id: string, error: string): Promise<void>;

  /**
   * Get all pending commands
   */
  getPending(): Promise<QueuedCommand[]>;

  /**
   * Get queue statistics
   */
  getStats(): Promise<QueueStats>;

  /**
   * Clear expired commands
   */
  clearExpired(): Promise<number>;

  /**
   * Clear all commands
   */
  clearAll(): Promise<void>;

  /**
   * Process the queue (call repeatedly while online)
   */
  processQueue(sendFn: (message: RelayMessage) => Promise<void>): Promise<void>;
}

/**
 * Caller-supplied options for controlling how a command is queued.
 *
 * All fields are optional — the queue applies sensible defaults
 * (`DEFAULT_QUEUE_TTL_MS`, `DEFAULT_MAX_ATTEMPTS`, priority from
 * `getMessagePriority`) when omitted. Callers only need to override
 * when they have specific requirements (e.g., a critical cancellation
 * that should never expire should set a long `ttl`).
 */
export interface EnqueueOptions {
  /** Priority (default: 0, higher = sent first) */
  priority?: number;
  /** Time to live in ms (default: 5 minutes) */
  ttl?: number;
  /** Max retry attempts (default: 3) */
  maxAttempts?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Default TTL for queued commands (5 minutes) */
export const DEFAULT_QUEUE_TTL_MS = 5 * 60 * 1000;

/** Default max retry attempts */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Delay between retry attempts (exponential backoff base) */
export const RETRY_BASE_DELAY_MS = 1000;

// ============================================================================
// Priority Constants
// ============================================================================

/**
 * Priority levels for queued commands
 */
export const QueuePriority = {
  /** Critical - permission responses, cancellations */
  CRITICAL: 100,
  /** High - chat messages */
  HIGH: 50,
  /** Normal - most commands */
  NORMAL: 0,
  /** Low - analytics, non-urgent updates */
  LOW: -50,
} as const;

/**
 * Get priority for a message type
 */
export function getMessagePriority(message: RelayMessage): number {
  switch (message.type) {
    case 'permission_response':
      return QueuePriority.CRITICAL;
    case 'command':
      // Cancel and interrupt are critical
      if (message.payload.action === 'cancel' || message.payload.action === 'interrupt') {
        return QueuePriority.CRITICAL;
      }
      return QueuePriority.NORMAL;
    case 'chat':
      return QueuePriority.HIGH;
    case 'ack':
      return QueuePriority.LOW;
    default:
      return QueuePriority.NORMAL;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a unique queue item ID.
 *
 * Uses crypto.randomUUID() for cryptographic uniqueness.
 * Available in Node.js 20+, modern browsers, Deno, Bun, and Hermes (React Native).
 *
 * @returns A unique queue ID string
 */
export function generateQueueId(): string {
  return `queue_${crypto.randomUUID()}`;
}

/**
 * Calculate retry delay with exponential backoff
 */
export function getRetryDelay(attempts: number): number {
  // Exponential backoff: 1s, 2s, 4s, 8s... capped at 30s
  return Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempts), 30000);
}

/**
 * Check if a queued command should be retried
 */
export function shouldRetry(item: QueuedCommand): boolean {
  return (
    item.status === 'failed' &&
    item.attempts < item.maxAttempts &&
    new Date(item.expiresAt) > new Date()
  );
}

/**
 * Create a QueuedCommand from a message
 */
export function createQueuedCommand(
  message: RelayMessage,
  options: EnqueueOptions = {}
): QueuedCommand {
  const now = new Date();
  const ttl = options.ttl ?? DEFAULT_QUEUE_TTL_MS;

  return {
    id: generateQueueId(),
    message,
    status: 'pending',
    attempts: 0,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    priority: options.priority ?? getMessagePriority(message),
  };
}
