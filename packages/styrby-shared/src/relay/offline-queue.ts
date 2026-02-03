/**
 * Offline Command Queue
 *
 * Queues commands when the device is offline and syncs when reconnected.
 * Uses SQLite on mobile and IndexedDB on web for persistence.
 *
 * This module defines the types and interface - platform-specific
 * implementations are in styrby-mobile and styrby-web.
 */

import type { RelayMessage, AgentType } from './types.js';

// ============================================================================
// Queue Item Types
// ============================================================================

/**
 * Status of a queued command
 */
export type QueueItemStatus =
  | 'pending'    // Waiting to be sent
  | 'sending'    // Currently being sent
  | 'sent'       // Successfully sent
  | 'failed'     // Failed to send (will retry)
  | 'expired';   // Expired before sending

/**
 * A command queued for sending when online
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
 * Queue statistics
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
 * Interface for offline command queue implementations.
 * Platform-specific implementations should implement this interface.
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
 * Options for enqueueing a command
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
 * Generate a unique queue item ID
 */
export function generateQueueId(): string {
  return `queue_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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
