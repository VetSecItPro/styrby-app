/**
 * Offline Queue Service for Styrby Web Dashboard.
 *
 * WHY: When users are offline (e.g., on a train, in an airplane), they should
 * still be able to queue actions like creating budget alerts. These actions
 * are synced when connectivity is restored, providing a seamless experience.
 *
 * Uses IndexedDB via the 'idb' library for persistent storage that survives
 * page reloads and browser restarts.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Represents a command queued for offline execution.
 */
interface QueuedCommand {
  /** Unique command identifier (UUID) */
  id: string;
  /** Command type determines which API endpoint to call */
  type: string;
  /** Command payload (varies by type) */
  payload: Record<string, unknown>;
  /** Higher priority commands are processed first */
  priority: number;
  /** Timestamp when the command was queued */
  createdAt: number;
  /** Number of execution attempts */
  attempts: number;
  /** Maximum retry attempts before giving up */
  maxAttempts: number;
  /** Time-to-live in milliseconds (command expires after this) */
  ttlMs: number;
}

/**
 * Input for enqueueing a new command (id, createdAt, attempts auto-generated).
 */
type QueuedCommandInput = Omit<QueuedCommand, 'id' | 'createdAt' | 'attempts'>;

/**
 * IndexedDB schema definition for type safety.
 */
interface OfflineQueueDB extends DBSchema {
  commands: {
    key: string;
    value: QueuedCommand;
    indexes: {
      'by-priority': number;
      'by-created': number;
    };
  };
}

/* ──────────────────────────── Constants ──────────────────────────── */

const DB_NAME = 'styrby-offline-queue';
const DB_VERSION = 1;

/**
 * Priority levels for queued commands.
 * Higher values are processed first.
 */
export const PRIORITY = {
  /** Critical operations that must happen ASAP */
  CRITICAL: 100,
  /** High priority - user-initiated actions */
  HIGH: 50,
  /** Normal priority - background syncs */
  NORMAL: 0,
  /** Low priority - can wait */
  LOW: -50,
} as const;

/**
 * Default TTL values in milliseconds.
 */
export const TTL = {
  /** 1 hour */
  SHORT: 60 * 60 * 1000,
  /** 24 hours */
  MEDIUM: 24 * 60 * 60 * 1000,
  /** 7 days */
  LONG: 7 * 24 * 60 * 60 * 1000,
} as const;

/* ──────────────────────────── Offline Queue Class ──────────────────────────── */

/**
 * Web offline queue using IndexedDB for persistent storage.
 *
 * This class manages a queue of commands that should be executed when online.
 * Commands are persisted to IndexedDB, sorted by priority and creation time,
 * and automatically processed when connectivity is restored.
 *
 * @example
 * // Queue a budget alert creation
 * await offlineQueue.enqueue({
 *   type: 'budget_alert_create',
 *   payload: { name: 'Daily limit', threshold_usd: 10, period: 'daily' },
 *   priority: PRIORITY.HIGH,
 *   maxAttempts: 3,
 *   ttlMs: TTL.MEDIUM,
 * });
 *
 * // Queue will auto-process when online
 */
class WebOfflineQueue {
  private db: IDBPDatabase<OfflineQueueDB> | null = null;
  private isProcessing = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initializes the IndexedDB database and sets up online listener.
   * Safe to call multiple times - will only initialize once.
   */
  async init(): Promise<void> {
    // Return existing init promise if already initializing
    if (this.initPromise) return this.initPromise;

    // Return immediately if already initialized
    if (this.db) return;

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  /**
   * Internal initialization logic.
   */
  private async doInit(): Promise<void> {
    try {
      this.db = await openDB<OfflineQueueDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          // Create the commands object store with indexes
          const store = db.createObjectStore('commands', { keyPath: 'id' });
          store.createIndex('by-priority', 'priority');
          store.createIndex('by-created', 'createdAt');
        },
      });

      // Listen for online status changes
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => {
          this.processQueue();
        });
      }
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  /**
   * Adds a command to the offline queue.
   *
   * @param command - The command to queue (without id, createdAt, attempts)
   * @returns The unique ID assigned to the queued command
   *
   * @example
   * const id = await offlineQueue.enqueue({
   *   type: 'budget_alert_create',
   *   payload: { name: 'Daily limit', threshold_usd: 10 },
   *   priority: PRIORITY.HIGH,
   *   maxAttempts: 3,
   *   ttlMs: TTL.MEDIUM,
   * });
   */
  async enqueue(command: QueuedCommandInput): Promise<string> {
    await this.init();

    const id = crypto.randomUUID();
    const queuedCommand: QueuedCommand = {
      ...command,
      id,
      createdAt: Date.now(),
      attempts: 0,
    };

    await this.db!.put('commands', queuedCommand);

    // Try to process immediately if online
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      // Don't await - process in background
      this.processQueue();
    }

    return id;
  }

  /**
   * Processes all queued commands in priority order.
   * Called automatically when coming online, but can be called manually.
   *
   * Commands are processed in order of:
   * 1. Priority (highest first)
   * 2. Creation time (oldest first, for same priority)
   *
   * Failed commands are retried up to maxAttempts times.
   * Expired commands (past TTL) are removed without execution.
   */
  async processQueue(): Promise<void> {
    // Skip if already processing or offline
    if (this.isProcessing) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    await this.init();
    this.isProcessing = true;

    try {
      const commands = await this.db!.getAllFromIndex('commands', 'by-priority');

      // Sort by priority (higher first), then by created (older first)
      commands.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt - b.createdAt;
      });

      for (const command of commands) {
        // Check TTL - remove expired commands
        if (Date.now() - command.createdAt > command.ttlMs) {
          await this.db!.delete('commands', command.id);
          continue;
        }

        // Check max attempts - remove commands that have failed too many times
        if (command.attempts >= command.maxAttempts) {
          await this.db!.delete('commands', command.id);
          continue;
        }

        try {
          await this.executeCommand(command);
          // Success - remove from queue
          await this.db!.delete('commands', command.id);
        } catch {
          // Increment attempts and save
          command.attempts++;
          await this.db!.put('commands', command);

          // If this was a network error and we're now offline, stop processing
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            break;
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Executes a single command by routing to the appropriate API endpoint.
   *
   * @param command - The command to execute
   * @throws Error if the API request fails
   */
  private async executeCommand(command: QueuedCommand): Promise<void> {
    const response = await this.routeCommand(command);

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Routes a command to the appropriate API endpoint.
   *
   * @param command - The command to route
   * @returns The fetch Response
   */
  private async routeCommand(command: QueuedCommand): Promise<Response> {
    switch (command.type) {
      case 'budget_alert_create':
        return fetch('/api/budget-alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command.payload),
        });

      case 'budget_alert_update':
        return fetch('/api/budget-alerts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command.payload),
        });

      case 'budget_alert_delete':
        return fetch('/api/budget-alerts', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command.payload),
        });

      case 'notification_preferences_update':
        return fetch('/api/notification-preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command.payload),
        });

      case 'session_bookmark':
        return fetch('/api/session-bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command.payload),
        });

      case 'session_unbookmark':
        return fetch('/api/session-bookmarks', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command.payload),
        });

      default:
        // Unknown command type - log and return success to remove from queue
        console.warn(`[OfflineQueue] Unknown command type: ${command.type}`);
        return new Response(null, { status: 200 });
    }
  }

  /**
   * Returns the current number of commands in the queue.
   *
   * @returns Number of queued commands
   */
  async getQueueLength(): Promise<number> {
    await this.init();
    return this.db!.count('commands');
  }

  /**
   * Returns all queued commands (for debugging/display purposes).
   *
   * @returns Array of queued commands
   */
  async getAll(): Promise<QueuedCommand[]> {
    await this.init();
    return this.db!.getAll('commands');
  }

  /**
   * Removes a specific command from the queue.
   *
   * @param id - The command ID to remove
   */
  async remove(id: string): Promise<void> {
    await this.init();
    await this.db!.delete('commands', id);
  }

  /**
   * Clears all commands from the queue.
   * Use with caution - this will remove all pending operations.
   */
  async clear(): Promise<void> {
    await this.init();
    await this.db!.clear('commands');
  }
}

/* ──────────────────────────── Export ──────────────────────────── */

/**
 * Singleton instance of the offline queue.
 * Import this in components/hooks to enqueue offline commands.
 *
 * @example
 * import { offlineQueue, PRIORITY, TTL } from '@/lib/offlineQueue';
 *
 * await offlineQueue.enqueue({
 *   type: 'budget_alert_create',
 *   payload: { name: 'My alert', threshold_usd: 5 },
 *   priority: PRIORITY.HIGH,
 *   maxAttempts: 3,
 *   ttlMs: TTL.MEDIUM,
 * });
 */
export const offlineQueue = new WebOfflineQueue();
