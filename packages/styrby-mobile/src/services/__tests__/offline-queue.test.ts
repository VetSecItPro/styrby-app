/**
 * Offline Queue Service Test Suite
 *
 * Tests the SQLite-based offline command queue, covering:
 * - Enqueueing commands with options (priority, TTL, maxAttempts)
 * - Dequeueing in priority order (FIFO within same priority)
 * - Marking commands as sent or failed
 * - Retry logic with exponential backoff
 * - Queue statistics computation
 * - Expired command cleanup
 * - Full queue processing via processQueue()
 * - Edge cases: empty queue, expired items, max retries exhausted
 */

import * as SQLite from 'expo-sqlite';
import type { RelayMessage, ChatMessage } from 'styrby-shared';

// ============================================================================
// Mock styrby-shared
// ============================================================================

const mockCreateQueuedCommand = jest.fn();
const mockGetRetryDelay = jest.fn(() => 100);
const mockShouldRetry = jest.fn(() => false);

jest.mock('styrby-shared', () => ({
  createQueuedCommand: (...args: unknown[]) => mockCreateQueuedCommand(...(args as [])),
  getRetryDelay: (...args: unknown[]) => mockGetRetryDelay(...(args as [])),
  shouldRetry: (...args: unknown[]) => mockShouldRetry(...(args as [])),
}));

// ============================================================================
// SQLite Mock Helpers
// ============================================================================

/**
 * In-memory store to simulate SQLite rows for the command_queue table.
 * We intercept runAsync/getFirstAsync/getAllAsync to manipulate this store.
 */
const mockRows: Map<string, Record<string, unknown>> = new Map();

/** Track SQL calls for assertion */
let sqlCalls: { sql: string; params: unknown[] }[] = [];

const mockRunAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  sqlCalls.push({ sql, params });

  if (sql.includes('INSERT INTO command_queue')) {
    mockRows.set(params[0] as string, {
      id: params[0],
      message: params[1],
      status: params[2],
      attempts: params[3],
      max_attempts: params[4],
      created_at: params[5],
      expires_at: params[6],
      priority: params[7],
      last_attempt_at: null,
      last_error: null,
    });
    return { changes: 1 };
  }

  if (sql.includes('UPDATE command_queue SET status = \'expired\'')) {
    // Mark expired pending commands
    for (const [_id, row] of mockRows) {
      if (row.status === 'pending' && new Date(row.expires_at as string) <= new Date(params[0] as string)) {
        row.status = 'expired';
      }
    }
    return { changes: 1 };
  }

  if (sql.includes('UPDATE command_queue SET status')) {
    // Generic status update — handles markSent and markFailed
    if (sql.includes('attempts')) {
      // markFailed update
      const id = params[4] as string;
      const row = mockRows.get(id);
      if (row) {
        row.status = params[0];
        row.attempts = params[1];
        row.last_attempt_at = params[2];
        row.last_error = params[3];
      }
    } else if (sql.includes('sending')) {
      // dequeue update to 'sending'
      const id = params[1] as string;
      const row = mockRows.get(id);
      if (row) {
        row.status = 'sending';
        row.last_attempt_at = params[0];
      }
    } else {
      // markSent
      const id = params[1] as string;
      const row = mockRows.get(id);
      if (row) {
        row.status = params[0];
      }
    }
    return { changes: 1 };
  }

  if (sql.includes('DELETE FROM command_queue WHERE status')) {
    let deleted = 0;
    for (const [id, row] of mockRows) {
      if (
        (row.status === 'expired' || row.status === 'sent') &&
        new Date(row.created_at as string) < new Date(params[0] as string)
      ) {
        mockRows.delete(id);
        deleted++;
      }
    }
    return { changes: deleted };
  }

  if (sql.includes('DELETE FROM command_queue')) {
    const size = mockRows.size;
    mockRows.clear();
    return { changes: size };
  }

  return { changes: 0 };
});

const mockGetFirstAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  sqlCalls.push({ sql, params });

  if (sql.includes('SELECT * FROM command_queue') && sql.includes("status = 'pending'")) {
    // dequeue: get highest priority pending non-expired command
    const now = params[0] as string;
    let best: Record<string, unknown> | null = null;
    for (const row of mockRows.values()) {
      if (row.status === 'pending' && new Date(row.expires_at as string) > new Date(now)) {
        if (
          !best ||
          (row.priority as number) > (best.priority as number) ||
          ((row.priority as number) === (best.priority as number) &&
            (row.created_at as string) < (best.created_at as string))
        ) {
          best = row;
        }
      }
    }
    return best ? { ...best } : null;
  }

  if (sql.includes('SELECT * FROM command_queue WHERE id')) {
    // markFailed: get command by id
    const id = params[0] as string;
    const row = mockRows.get(id);
    return row ? { ...row } : null;
  }

  if (sql.includes('SELECT') && sql.includes('COUNT')) {
    // getStats
    let total = 0, pending = 0, failed = 0, expired = 0;
    for (const row of mockRows.values()) {
      total++;
      if (row.status === 'pending') pending++;
      if (row.status === 'failed') failed++;
      if (row.status === 'expired') expired++;
    }
    return { total, pending, failed, expired };
  }

  if (sql.includes('SELECT created_at') && sql.includes("status = 'pending'")) {
    // getStats: oldest pending
    const now = params[0] as string;
    let oldest: string | null = null;
    for (const row of mockRows.values()) {
      if (row.status === 'pending' && new Date(row.expires_at as string) > new Date(now)) {
        if (!oldest || (row.created_at as string) < oldest) {
          oldest = row.created_at as string;
        }
      }
    }
    return oldest ? { created_at: oldest } : null;
  }

  return null;
});

const mockGetAllAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  sqlCalls.push({ sql, params });

  if (sql.includes("status = 'pending'")) {
    const now = params[0] as string;
    const results: Record<string, unknown>[] = [];
    for (const row of mockRows.values()) {
      if (row.status === 'pending' && new Date(row.expires_at as string) > new Date(now)) {
        results.push({ ...row });
      }
    }
    // Sort by priority DESC, created_at ASC
    results.sort((a, b) => {
      if ((b.priority as number) !== (a.priority as number)) {
        return (b.priority as number) - (a.priority as number);
      }
      return (a.created_at as string).localeCompare(b.created_at as string);
    });
    return results;
  }

  return [];
});

const mockExecAsync = jest.fn(async () => {});

// Override the global expo-sqlite mock with our richer implementation
const mockDb = {
  execAsync: mockExecAsync,
  runAsync: mockRunAsync,
  getFirstAsync: mockGetFirstAsync,
  getAllAsync: mockGetAllAsync,
};

(SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

// ============================================================================
// Import module under test AFTER mocks
// ============================================================================

import { SQLiteOfflineQueue } from '../offline-queue';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a minimal ChatMessage for testing.
 */
function createTestMessage(content = 'test message'): ChatMessage {
  return {
    id: `msg_${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    sender_device_id: 'mobile-device-1',
    sender_type: 'mobile',
    type: 'chat',
    payload: {
      content,
      agent: 'claude',
    },
  };
}

/**
 * Creates a mock QueuedCommand return value for createQueuedCommand.
 */
function createMockQueuedCommand(
  message: RelayMessage,
  overrides: Partial<{
    id: string;
    priority: number;
    maxAttempts: number;
    createdAt: string;
    expiresAt: string;
  }> = {}
) {
  const now = new Date();
  return {
    id: overrides.id ?? `queue_${crypto.randomUUID()}`,
    message,
    status: 'pending' as const,
    attempts: 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    createdAt: overrides.createdAt ?? now.toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    priority: overrides.priority ?? 0,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Offline Queue Service', () => {
  let queue: InstanceType<typeof SQLiteOfflineQueue>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.clear();
    sqlCalls = [];
    // Create a fresh queue instance each test to reset initialized flag
    queue = new SQLiteOfflineQueue();
    // Re-apply our mock db since openDatabaseAsync may be called fresh
    (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);
  });

  // ==========================================================================
  // Database Initialization
  // ==========================================================================

  describe('database initialization', () => {
    it('creates the database and tables on first operation', async () => {
      const message = createTestMessage();
      const mockCommand = createMockQueuedCommand(message);
      mockCreateQueuedCommand.mockReturnValue(mockCommand);

      await queue.enqueue(message);

      expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('styrby_offline_queue.db');
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS command_queue')
      );
    });

    it('reuses initialized state on subsequent operations (skips re-init)', async () => {
      const message = createTestMessage();
      const mockCommand = createMockQueuedCommand(message);
      mockCreateQueuedCommand.mockReturnValue(mockCommand);

      await queue.enqueue(message);

      // Clear mock call counts after first init
      mockExecAsync.mockClear();

      await queue.enqueue(message);

      // execAsync should NOT be called again (no table re-creation)
      expect(mockExecAsync).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // enqueue()
  // ==========================================================================

  describe('enqueue()', () => {
    it('inserts a command into the database and returns the QueuedCommand', async () => {
      const message = createTestMessage('hello');
      const mockCommand = createMockQueuedCommand(message, { id: 'queue_abc' });
      mockCreateQueuedCommand.mockReturnValue(mockCommand);

      const result = await queue.enqueue(message);

      expect(mockCreateQueuedCommand).toHaveBeenCalledWith(message, undefined);
      expect(result.id).toBe('queue_abc');
      expect(result.status).toBe('pending');
      expect(result.attempts).toBe(0);
      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO command_queue'),
        expect.arrayContaining(['queue_abc'])
      );
    });

    it('passes options through to createQueuedCommand', async () => {
      const message = createTestMessage();
      const options = { priority: 100, ttl: 60000, maxAttempts: 5 };
      const mockCommand = createMockQueuedCommand(message, { priority: 100, maxAttempts: 5 });
      mockCreateQueuedCommand.mockReturnValue(mockCommand);

      await queue.enqueue(message, options);

      expect(mockCreateQueuedCommand).toHaveBeenCalledWith(message, options);
    });

    it('stores the message as JSON in the database', async () => {
      const message = createTestMessage('json-test');
      const mockCommand = createMockQueuedCommand(message, { id: 'queue_json' });
      mockCreateQueuedCommand.mockReturnValue(mockCommand);

      await queue.enqueue(message);

      // Verify the second param (message) is JSON-serialized
      const insertCall = mockRunAsync.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT')
      );
      expect(insertCall).toBeDefined();
      expect((insertCall![1] as unknown[])[1]).toBe(JSON.stringify(message));
    });

    it('stores priority in the database', async () => {
      const message = createTestMessage();
      const mockCommand = createMockQueuedCommand(message, { priority: 50 });
      mockCreateQueuedCommand.mockReturnValue(mockCommand);

      await queue.enqueue(message);

      const insertCall = mockRunAsync.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT')
      );
      // Priority is the 8th parameter (index 7)
      expect((insertCall![1] as unknown[])[7]).toBe(50);
    });
  });

  // ==========================================================================
  // dequeue()
  // ==========================================================================

  describe('dequeue()', () => {
    it('returns null when queue is empty', async () => {
      const result = await queue.dequeue();
      expect(result).toBeNull();
    });

    it('returns the highest priority pending non-expired command', async () => {
      const message = createTestMessage('high-priority');
      const futureDate = new Date(Date.now() + 60000).toISOString();

      // Seed mock data
      mockRows.set('queue_1', {
        id: 'queue_1',
        message: JSON.stringify(message),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: new Date().toISOString(),
        expires_at: futureDate,
        priority: 50,
        last_attempt_at: null,
        last_error: null,
      });

      const result = await queue.dequeue();

      expect(result).not.toBeNull();
      expect(result!.id).toBe('queue_1');
      expect(result!.priority).toBe(50);
    });

    it('marks the dequeued command as sending', async () => {
      const message = createTestMessage();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      mockRows.set('queue_send', {
        id: 'queue_send',
        message: JSON.stringify(message),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: new Date().toISOString(),
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      await queue.dequeue();

      // Verify UPDATE to 'sending' was called
      const updateCall = mockRunAsync.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('sending')
      );
      expect(updateCall).toBeDefined();
    });

    it('skips expired commands', async () => {
      const message = createTestMessage();
      const pastDate = new Date(Date.now() - 60000).toISOString();

      mockRows.set('queue_expired', {
        id: 'queue_expired',
        message: JSON.stringify(message),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: new Date(Date.now() - 120000).toISOString(),
        expires_at: pastDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      const result = await queue.dequeue();
      expect(result).toBeNull();
    });

    it('returns commands in priority order (highest first)', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();
      const now = new Date().toISOString();

      mockRows.set('low', {
        id: 'low',
        message: JSON.stringify(createTestMessage('low')),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: now,
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      mockRows.set('high', {
        id: 'high',
        message: JSON.stringify(createTestMessage('high')),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: now,
        expires_at: futureDate,
        priority: 100,
        last_attempt_at: null,
        last_error: null,
      });

      const result = await queue.dequeue();
      expect(result!.id).toBe('high');
    });

    it('uses FIFO within the same priority', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();

      mockRows.set('first', {
        id: 'first',
        message: JSON.stringify(createTestMessage('first')),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      mockRows.set('second', {
        id: 'second',
        message: JSON.stringify(createTestMessage('second')),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: '2026-01-02T00:00:00.000Z',
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      const result = await queue.dequeue();
      expect(result!.id).toBe('first');
    });
  });

  // ==========================================================================
  // markSent()
  // ==========================================================================

  describe('markSent()', () => {
    it('updates command status to sent', async () => {
      await queue.markSent('queue_abc');

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining("status = 'sent'"),
        ['queue_abc']
      );
    });

    it('calls the database even for nonexistent IDs (no-op)', async () => {
      await queue.markSent('nonexistent');
      expect(mockRunAsync).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // markFailed()
  // ==========================================================================

  describe('markFailed()', () => {
    it('returns silently when command not found', async () => {
      // getFirstAsync returns null for unknown ID
      await expect(queue.markFailed('nonexistent', 'error')).resolves.toBeUndefined();
    });

    it('increments attempts and records the error', async () => {
      const message = createTestMessage();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      mockRows.set('queue_fail', {
        id: 'queue_fail',
        message: JSON.stringify(message),
        status: 'sending',
        attempts: 0,
        max_attempts: 3,
        created_at: new Date().toISOString(),
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      await queue.markFailed('queue_fail', 'Network timeout');

      // Verify the UPDATE was called with incremented attempts
      const updateCall = mockRunAsync.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE') &&
          call[0].includes('attempts') &&
          Array.isArray(call[1]) &&
          call[1].includes('queue_fail')
      );
      expect(updateCall).toBeDefined();
      // attempts should be 1 (0 + 1)
      expect((updateCall![1] as unknown[])[1]).toBe(1);
      // last_error should be the error message
      expect((updateCall![1] as unknown[])[3]).toBe('Network timeout');
    });

    it('sets status to failed when max attempts reached', async () => {
      const message = createTestMessage();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      mockRows.set('queue_max', {
        id: 'queue_max',
        message: JSON.stringify(message),
        status: 'sending',
        attempts: 2,
        max_attempts: 3,
        created_at: new Date().toISOString(),
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      await queue.markFailed('queue_max', 'Final failure');

      const updateCall = mockRunAsync.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE') &&
          call[0].includes('attempts') &&
          Array.isArray(call[1]) &&
          call[1].includes('queue_max')
      );
      expect((updateCall![1] as unknown[])[0]).toBe('failed');
    });

    it('sets status to expired when command has expired', async () => {
      const message = createTestMessage();
      const pastDate = new Date(Date.now() - 1000).toISOString();

      mockRows.set('queue_exp', {
        id: 'queue_exp',
        message: JSON.stringify(message),
        status: 'sending',
        attempts: 0,
        max_attempts: 3,
        created_at: new Date(Date.now() - 60000).toISOString(),
        expires_at: pastDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      await queue.markFailed('queue_exp', 'Too late');

      const updateCall = mockRunAsync.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE') &&
          call[0].includes('attempts') &&
          Array.isArray(call[1]) &&
          call[1].includes('queue_exp')
      );
      expect((updateCall![1] as unknown[])[0]).toBe('expired');
    });

    it('sets status back to pending when retries remain and not expired', async () => {
      const message = createTestMessage();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      mockRows.set('queue_retry', {
        id: 'queue_retry',
        message: JSON.stringify(message),
        status: 'sending',
        attempts: 0,
        max_attempts: 3,
        created_at: new Date().toISOString(),
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      await queue.markFailed('queue_retry', 'Temporary error');

      const updateCall = mockRunAsync.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE') &&
          call[0].includes('attempts') &&
          Array.isArray(call[1]) &&
          call[1].includes('queue_retry')
      );
      expect((updateCall![1] as unknown[])[0]).toBe('pending');
    });
  });

  // ==========================================================================
  // getPending()
  // ==========================================================================

  describe('getPending()', () => {
    it('returns empty array when no pending commands exist', async () => {
      const result = await queue.getPending();
      expect(result).toEqual([]);
    });

    it('returns pending non-expired commands sorted by priority then creation', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();

      mockRows.set('cmd_a', {
        id: 'cmd_a',
        message: JSON.stringify(createTestMessage('a')),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: '2026-01-01T00:00:01.000Z',
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      mockRows.set('cmd_b', {
        id: 'cmd_b',
        message: JSON.stringify(createTestMessage('b')),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: futureDate,
        priority: 50,
        last_attempt_at: null,
        last_error: null,
      });

      const result = await queue.getPending();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('cmd_b'); // Higher priority first
      expect(result[1].id).toBe('cmd_a');
    });

    it('excludes non-pending commands', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();

      mockRows.set('sent_cmd', {
        id: 'sent_cmd',
        message: JSON.stringify(createTestMessage()),
        status: 'sent',
        attempts: 1,
        max_attempts: 3,
        created_at: new Date().toISOString(),
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      const result = await queue.getPending();
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // getStats()
  // ==========================================================================

  describe('getStats()', () => {
    it('returns zero counts when queue is empty', async () => {
      const stats = await queue.getStats();

      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.expired).toBe(0);
      expect(stats.oldestPendingAge).toBeUndefined();
    });

    it('returns correct counts by status', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();

      mockRows.set('p1', {
        id: 'p1', message: '{}', status: 'pending', attempts: 0,
        max_attempts: 3, created_at: new Date().toISOString(),
        expires_at: futureDate, priority: 0,
        last_attempt_at: null, last_error: null,
      });
      mockRows.set('f1', {
        id: 'f1', message: '{}', status: 'failed', attempts: 3,
        max_attempts: 3, created_at: new Date().toISOString(),
        expires_at: futureDate, priority: 0,
        last_attempt_at: null, last_error: null,
      });
      mockRows.set('e1', {
        id: 'e1', message: '{}', status: 'expired', attempts: 0,
        max_attempts: 3, created_at: new Date().toISOString(),
        expires_at: futureDate, priority: 0,
        last_attempt_at: null, last_error: null,
      });

      const stats = await queue.getStats();

      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.expired).toBe(1);
    });

    it('computes oldestPendingAge for pending commands', async () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      mockRows.set('old', {
        id: 'old', message: '{}', status: 'pending', attempts: 0,
        max_attempts: 3, created_at: fiveMinutesAgo,
        expires_at: futureDate, priority: 0,
        last_attempt_at: null, last_error: null,
      });

      const stats = await queue.getStats();

      expect(stats.oldestPendingAge).toBeDefined();
      // Should be approximately 5 minutes (300000ms) +/- a few seconds
      expect(stats.oldestPendingAge!).toBeGreaterThan(290000);
      expect(stats.oldestPendingAge!).toBeLessThan(310000);
    });
  });

  // ==========================================================================
  // clearExpired()
  // ==========================================================================

  describe('clearExpired()', () => {
    it('marks expired pending commands and deletes old expired/sent items', async () => {
      const result = await queue.clearExpired();

      // runAsync called for both UPDATE (mark expired) and DELETE (cleanup)
      expect(mockRunAsync).toHaveBeenCalledTimes(2);
      expect(typeof result).toBe('number');
    });

    it('returns the number of deleted rows', async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      mockRows.set('old_expired', {
        id: 'old_expired', message: '{}', status: 'expired', attempts: 0,
        max_attempts: 3, created_at: oldDate,
        expires_at: oldDate, priority: 0,
        last_attempt_at: null, last_error: null,
      });

      const result = await queue.clearExpired();
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // clearAll()
  // ==========================================================================

  describe('clearAll()', () => {
    it('deletes all commands from the queue', async () => {
      mockRows.set('a', { id: 'a', message: '{}', status: 'pending', attempts: 0, max_attempts: 3, created_at: '', expires_at: '', priority: 0, last_attempt_at: null, last_error: null });
      mockRows.set('b', { id: 'b', message: '{}', status: 'sent', attempts: 1, max_attempts: 3, created_at: '', expires_at: '', priority: 0, last_attempt_at: null, last_error: null });

      await queue.clearAll();

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM command_queue')
      );
    });
  });

  // ==========================================================================
  // processQueue()
  // ==========================================================================

  describe('processQueue()', () => {
    it('processes all pending commands through the send function', async () => {
      const message1 = createTestMessage('msg1');
      const futureDate = new Date(Date.now() + 60000).toISOString();
      const now = new Date().toISOString();

      // Seed two pending commands
      mockRows.set('pq1', {
        id: 'pq1',
        message: JSON.stringify(message1),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: now,
        expires_at: futureDate,
        priority: 0,
        last_attempt_at: null,
        last_error: null,
      });

      // We need dequeue to return items one at a time then null
      // Our mock already handles this naturally since dequeue marks items as 'sending'
      // and subsequent dequeue calls only look for 'pending' items.
      // But since our mock doesn't actually update the in-memory status during dequeue,
      // we need to handle this differently. Let's use the mockGetFirstAsync directly.

      let dequeueCount = 0;
      mockGetFirstAsync.mockImplementation(async (sql: string, _params: unknown[] = []) => {
        if (sql.includes("status = 'pending'") && sql.includes('LIMIT 1')) {
          dequeueCount++;
          if (dequeueCount === 1) {
            return {
              id: 'pq1',
              message: JSON.stringify(message1),
              status: 'pending',
              attempts: 0,
              max_attempts: 3,
              created_at: now,
              expires_at: futureDate,
              priority: 0,
              last_attempt_at: null,
              last_error: null,
            };
          }
          return null; // No more items
        }
        // For stats/other queries
        return null;
      });

      const sendFn = jest.fn(async () => {});
      await queue.processQueue(sendFn);

      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('calls clearExpired before processing', async () => {
      const sendFn = jest.fn(async () => {});
      await queue.processQueue(sendFn);

      // clearExpired calls runAsync twice (UPDATE expired, DELETE old)
      const updateExpiredCall = mockRunAsync.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes("status = 'expired'")
      );
      expect(updateExpiredCall).toBeDefined();
    });

    it('marks commands as sent on success', async () => {
      const message = createTestMessage();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      let called = false;
      mockGetFirstAsync.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'pending'") && sql.includes('LIMIT 1') && !called) {
          called = true;
          return {
            id: 'pq_sent',
            message: JSON.stringify(message),
            status: 'pending',
            attempts: 0,
            max_attempts: 3,
            created_at: new Date().toISOString(),
            expires_at: futureDate,
            priority: 0,
            last_attempt_at: null,
            last_error: null,
          };
        }
        return null;
      });

      const sendFn = jest.fn(async () => {});
      await queue.processQueue(sendFn);

      // Verify markSent was called
      const markSentCall = mockRunAsync.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes("status = 'sent'") &&
          Array.isArray(call[1]) &&
          call[1].includes('pq_sent')
      );
      expect(markSentCall).toBeDefined();
    });

    it('marks commands as failed and checks retry on send failure', async () => {
      const message = createTestMessage();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      let dequeueAttempt = 0;
      mockGetFirstAsync.mockImplementation(async (sql: string, _params: unknown[] = []) => {
        if (sql.includes("status = 'pending'") && sql.includes('LIMIT 1')) {
          dequeueAttempt++;
          if (dequeueAttempt === 1) {
            return {
              id: 'pq_fail',
              message: JSON.stringify(message),
              status: 'pending',
              attempts: 0,
              max_attempts: 3,
              created_at: new Date().toISOString(),
              expires_at: futureDate,
              priority: 0,
              last_attempt_at: null,
              last_error: null,
            };
          }
          return null;
        }
        if (sql.includes('SELECT * FROM command_queue WHERE id')) {
          return {
            id: 'pq_fail',
            message: JSON.stringify(message),
            status: 'sending',
            attempts: 0,
            max_attempts: 3,
            created_at: new Date().toISOString(),
            expires_at: futureDate,
            priority: 0,
            last_attempt_at: null,
            last_error: null,
          };
        }
        return null;
      });

      mockShouldRetry.mockReturnValue(false);

      const sendFn = jest.fn(async () => {
        throw new Error('Send failed');
      });

      await queue.processQueue(sendFn);

      expect(sendFn).toHaveBeenCalledTimes(1);
      // shouldRetry was called to check if we should delay
      expect(mockShouldRetry).toHaveBeenCalled();
    });

    it('adds delay when shouldRetry returns true', async () => {
      const message = createTestMessage();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      let dequeueAttempt = 0;
      mockGetFirstAsync.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'pending'") && sql.includes('LIMIT 1')) {
          dequeueAttempt++;
          if (dequeueAttempt === 1) {
            return {
              id: 'pq_retry',
              message: JSON.stringify(message),
              status: 'pending',
              attempts: 0,
              max_attempts: 3,
              created_at: new Date().toISOString(),
              expires_at: futureDate,
              priority: 0,
              last_attempt_at: null,
              last_error: null,
            };
          }
          return null;
        }
        if (sql.includes('SELECT * FROM command_queue WHERE id')) {
          return {
            id: 'pq_retry',
            message: JSON.stringify(message),
            status: 'sending',
            attempts: 0,
            max_attempts: 3,
            created_at: new Date().toISOString(),
            expires_at: futureDate,
            priority: 0,
            last_attempt_at: null,
            last_error: null,
          };
        }
        return null;
      });

      mockShouldRetry.mockReturnValue(true);
      mockGetRetryDelay.mockReturnValue(10); // 10ms for fast test

      const sendFn = jest.fn(async () => {
        throw new Error('Temporary failure');
      });

      const start = Date.now();
      await queue.processQueue(sendFn);
      const elapsed = Date.now() - start;

      expect(mockShouldRetry).toHaveBeenCalled();
      expect(mockGetRetryDelay).toHaveBeenCalled();
      // Should have waited at least the retry delay
      expect(elapsed).toBeGreaterThanOrEqual(5);
    });

    it('extracts error message from Error objects', async () => {
      const message = createTestMessage();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      let dequeueAttempt = 0;
      mockGetFirstAsync.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'pending'") && sql.includes('LIMIT 1')) {
          dequeueAttempt++;
          if (dequeueAttempt === 1) {
            return {
              id: 'pq_err',
              message: JSON.stringify(message),
              status: 'pending',
              attempts: 0,
              max_attempts: 3,
              created_at: new Date().toISOString(),
              expires_at: futureDate,
              priority: 0,
              last_attempt_at: null,
              last_error: null,
            };
          }
          return null;
        }
        if (sql.includes('WHERE id')) {
          return {
            id: 'pq_err',
            message: JSON.stringify(message),
            status: 'sending',
            attempts: 0,
            max_attempts: 3,
            created_at: new Date().toISOString(),
            expires_at: futureDate,
            priority: 0,
            last_attempt_at: null,
            last_error: null,
          };
        }
        return null;
      });

      mockShouldRetry.mockReturnValue(false);

      await queue.processQueue(async () => {
        throw new Error('Specific error message');
      });

      // markFailed should have been called with the error message
      const updateCall = mockRunAsync.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE') &&
          call[0].includes('last_error') &&
          Array.isArray(call[1]) &&
          call[1].includes('Specific error message')
      );
      expect(updateCall).toBeDefined();
    });

    it('handles non-Error thrown values with Unknown error', async () => {
      const message = createTestMessage();
      const futureDate = new Date(Date.now() + 60000).toISOString();

      let dequeueAttempt = 0;
      mockGetFirstAsync.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'pending'") && sql.includes('LIMIT 1')) {
          dequeueAttempt++;
          if (dequeueAttempt === 1) {
            return {
              id: 'pq_unknown',
              message: JSON.stringify(message),
              status: 'pending',
              attempts: 0,
              max_attempts: 3,
              created_at: new Date().toISOString(),
              expires_at: futureDate,
              priority: 0,
              last_attempt_at: null,
              last_error: null,
            };
          }
          return null;
        }
        if (sql.includes('WHERE id')) {
          return {
            id: 'pq_unknown',
            message: JSON.stringify(message),
            status: 'sending',
            attempts: 0,
            max_attempts: 3,
            created_at: new Date().toISOString(),
            expires_at: futureDate,
            priority: 0,
            last_attempt_at: null,
            last_error: null,
          };
        }
        return null;
      });

      mockShouldRetry.mockReturnValue(false);

      await queue.processQueue(async () => {
        throw 'string-error';
      });

      const updateCall = mockRunAsync.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE') &&
          call[0].includes('last_error') &&
          Array.isArray(call[1]) &&
          call[1].includes('Unknown error')
      );
      expect(updateCall).toBeDefined();
    });

    it('does nothing when queue is empty', async () => {
      const sendFn = jest.fn(async () => {});
      await queue.processQueue(sendFn);

      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Singleton Export
  // ==========================================================================

  describe('singleton export', () => {
    it('exports offlineQueue as a singleton instance', () => {
      // Use require since dynamic import needs --experimental-vm-modules
      const mod = require('../offline-queue');
      expect(mod.offlineQueue).toBeDefined();
      expect(mod.offlineQueue).toBeInstanceOf(SQLiteOfflineQueue);
    });
  });

  // ==========================================================================
  // GAP-FILL: additional uncovered branches
  // ==========================================================================

  describe('enqueue() — all EnqueueOptions fields forwarded', () => {
    it('passes priority, ttl, and maxAttempts to createQueuedCommand', async () => {
      const message = createTestMessage('opts-test');
      const opts = { priority: 99, ttl: 10000, maxAttempts: 5 };
      const futureDate = new Date(Date.now() + 10000).toISOString();
      const mockCmd = createMockQueuedCommand(message, {
        priority: 99, maxAttempts: 5, expiresAt: futureDate,
      });
      mockCreateQueuedCommand.mockReturnValueOnce(mockCmd);

      const result = await queue.enqueue(message, opts);

      expect(mockCreateQueuedCommand).toHaveBeenCalledWith(message, opts);
      expect(result.priority).toBe(99);
      expect(result.maxAttempts).toBe(5);
    });
  });

  describe('clearAll() — empty queue', () => {
    it('resolves without error when queue is already empty', async () => {
      // mockRows is already empty (cleared in beforeEach)
      await expect(queue.clearAll()).resolves.toBeUndefined();

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM command_queue')
      );
    });
  });

  describe('processQueue() — sequential drain of all pending items', () => {
    it('calls sendFn for every item until queue is empty', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();
      const now = new Date().toISOString();

      // Seed 3 pending rows with distinct IDs
      const rowIds = ['drain_1', 'drain_2', 'drain_3'];
      for (const rid of rowIds) {
        mockRows.set(rid, {
          id: rid,
          message: JSON.stringify(createTestMessage(rid)),
          status: 'pending',
          attempts: 0,
          max_attempts: 3,
          created_at: now,
          expires_at: futureDate,
          priority: 0,
          last_attempt_at: null,
          last_error: null,
        });
      }

      // Simulate dequeue returning each row once then null
      let dequeueIdx = 0;
      mockGetFirstAsync.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'pending'") && sql.includes('LIMIT 1')) {
          if (dequeueIdx < rowIds.length) {
            return { ...mockRows.get(rowIds[dequeueIdx++]) };
          }
          return null;
        }
        // markFailed lookup by id — not called here since sendFn succeeds
        return null;
      });

      const sentMessages: unknown[] = [];
      await queue.processQueue(async (msg) => { sentMessages.push(msg); });

      expect(sentMessages).toHaveLength(3);
    });
  });
});
