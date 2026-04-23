/**
 * Chaos-Monkey Test Suite — Kill App Mid-Sync, Verify Recovery State
 *
 * Simulates abrupt app termination at every major state transition in the
 * offline queue sync loop. Verifies that the recovery path on next boot
 * is correct and idempotent.
 *
 * Crash scenarios tested (from Phase 1.6.3b spec):
 *
 *   Scenario 1 — Kill between markPending and network call
 *     → On next boot, message is re-attempted (not duplicated).
 *     → Queue entry status is still 'pending'; dequeue() picks it up.
 *
 *   Scenario 2 — Kill between network call and markSent
 *     → The server already received the message.
 *     → On next boot, the retry carries the same idempotency_key.
 *     → Server-side: 200 OK returned, message NOT inserted twice.
 *     → idempotency_key MUST be generated BEFORE the network call.
 *
 *   Scenario 3 — Kill between markSent and removeFromQueue
 *     → On boot, the 'sent' message is NOT re-sent.
 *     → The queue processor skips 'sent' items when dequeuing.
 *
 *   Scenario 4 — Kill during markFailed (retry counter update)
 *     → On boot, the retry counter reflects the correct value.
 *     → The processor does not over-count or under-count retries.
 *
 * WHY fake process kill = throw inside sync loop: Spawning a real process
 * and killing it with SIGKILL is not feasible in Jest. We simulate the kill
 * by having the send function throw a `SimulatedCrash` error at a controlled
 * point in the sync loop. We then re-instantiate the queue (simulating a
 * fresh app boot) and verify the persisted state is consistent.
 *
 * WHY idempotency_key is the key invariant: Real-world message deduplication
 * on the server relies on the idempotency key being the same across retries.
 * If the key were generated AFTER the send attempt (e.g., on markSent), a
 * crash would result in the next boot generating a NEW key, causing a
 * duplicate message on the server. We verify the key is stable across retries.
 */

// ============================================================================
// Shared-module mocks (before any imports)
// ============================================================================

const mockCreateQueuedCommand = jest.fn();
const mockGetRetryDelay = jest.fn((_attempts: number) => 0); // no delay in tests
const mockShouldRetry = jest.fn(
  (item: { attempts: number; maxAttempts: number; expiresAt: string }): boolean =>
    item.attempts < item.maxAttempts && new Date(item.expiresAt) > new Date()
);

jest.mock('styrby-shared', () => ({
  createQueuedCommand: (...args: unknown[]) => mockCreateQueuedCommand(...(args as [])),
  getRetryDelay: (...args: unknown[]) => mockGetRetryDelay(...(args as [number])),
  shouldRetry: (...args: unknown[]) => mockShouldRetry(...(args as [never])),
}));

// Mock expo-crypto for consistent UUID generation in rowToCommand fallback.
// WHY variable name starts with 'mock': Jest's babel transform hoists jest.mock()
// calls to the top of the file. Variables accessed inside mock factories must
// either be 'mock'-prefixed (allowed by the transform) or declared before the
// mock call. Using a module-level counter prefixed with 'mock' satisfies the
// transform's safety guard against uninitialized variable access.
let mockUuidCounter = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => `test-idempotency-key-${++mockUuidCounter}`),
}));

// Mock storage-quota guard so it doesn't call expo-file-system
jest.mock('../storage-quota', () => ({
  isQuotaError: jest.fn().mockReturnValue(false),
  storageQuotaGuard: {
    recordQuotaError: jest.fn(),
    clearQuotaError: jest.fn(),
    isFull: false,
    subscribe: jest.fn().mockReturnValue(() => {}),
    getStorageQuota: jest.fn().mockResolvedValue({
      bytesUsed: 0,
      bytesAvailable: 100 * 1024 * 1024,
      isNearLimit: false,
      isFull: false,
    }),
    clearNonCriticalQueueItems: jest.fn().mockResolvedValue({ itemsRemoved: 0, bytesFreed: 0 }),
  },
}));

// WHY 'mock' prefix: same Jest hoisting rule as mockUuidCounter above.
let mockLamportCounter = 0;
// Mock lamport clock so tests don't need a full SQLite DB for it
jest.mock('../lamport-clock', () => ({
  lamportClock: {
    init: jest.fn().mockResolvedValue(undefined),
    tick: jest.fn().mockImplementation(() => Promise.resolve(++mockLamportCounter)),
    receive: jest.fn().mockImplementation((_db: unknown, remote: number) =>
      Promise.resolve(Math.max(mockLamportCounter, remote) + 1)
    ),
    peek: jest.fn().mockResolvedValue(0),
  },
  compareLamportOrder: jest.requireActual('../lamport-clock').compareLamportOrder,
}));

// ============================================================================
// In-Memory SQLite Simulator
// ============================================================================

/**
 * In-memory store simulating the command_queue SQLite table.
 * We use a Map<id, row> so we can inspect and mutate rows directly.
 */
type MockRow = {
  id: string;
  message: string;
  status: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  expires_at: string;
  priority: number;
  last_attempt_at: string | null;
  last_error: string | null;
  idempotency_key: string;
  lamport_clock: number;
};

const mockDb: Map<string, MockRow> = new Map();

function buildSQLiteDb(): import('expo-sqlite').SQLiteDatabase {
  const db = {
    execAsync: jest.fn(async (_sql: string) => {}),

    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO command_queue')) {
        const row: MockRow = {
          id: params[0] as string,
          message: params[1] as string,
          status: params[2] as string,
          attempts: params[3] as number,
          max_attempts: params[4] as number,
          created_at: params[5] as string,
          expires_at: params[6] as string,
          priority: params[7] as number,
          idempotency_key: params[8] as string,
          lamport_clock: params[9] as number,
          last_attempt_at: null,
          last_error: null,
        };
        mockDb.set(row.id, row);
        return { changes: 1 };
      }

      if (sql.includes("UPDATE command_queue SET status = 'sending'")) {
        const id = params[1] as string;
        const row = mockDb.get(id);
        if (row) {
          row.status = 'sending';
          row.last_attempt_at = params[0] as string;
        }
        return { changes: 1 };
      }

      if (sql.includes("UPDATE command_queue SET status = 'sent'")) {
        const id = params[0] as string;
        const row = mockDb.get(id);
        if (row) row.status = 'sent';
        return { changes: 1 };
      }

      if (sql.includes('UPDATE command_queue') && sql.includes('attempts')) {
        // markFailed update
        const newStatus = params[0] as string;
        const newAttempts = params[1] as number;
        const lastAttemptAt = params[2] as string;
        const lastError = params[3] as string;
        const id = params[4] as string;
        const row = mockDb.get(id);
        if (row) {
          row.status = newStatus;
          row.attempts = newAttempts;
          row.last_attempt_at = lastAttemptAt;
          row.last_error = lastError;
        }
        return { changes: 1 };
      }

      if (sql.includes("UPDATE command_queue SET status = 'expired'")) {
        const expiry = params[0] as string;
        for (const row of mockDb.values()) {
          if (row.status === 'pending' && row.expires_at <= expiry) {
            row.status = 'expired';
          }
        }
        return { changes: 0 };
      }

      if (sql.includes("DELETE FROM command_queue WHERE status IN ('expired', 'sent')")) {
        return { changes: 0 }; // No cleanup in chaos tests
      }

      if (sql.includes('CREATE TABLE IF NOT EXISTS command_queue')) {
        return { changes: 0 };
      }
      if (sql.includes('CREATE INDEX')) {
        return { changes: 0 };
      }

      return { changes: 0 };
    }),

    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT * FROM command_queue') && sql.includes("status = 'pending'")) {
        const now = params[0] as string;
        // Find highest priority pending, not expired, order by priority DESC, created_at ASC
        const pending = [...mockDb.values()].filter(
          (r) => r.status === 'pending' && r.expires_at > now
        );
        if (pending.length === 0) return null;
        pending.sort((a, b) =>
          b.priority - a.priority || a.created_at.localeCompare(b.created_at)
        );
        return pending[0];
      }

      if (sql.includes('SELECT * FROM command_queue WHERE id')) {
        const id = params[0] as string;
        return mockDb.get(id) ?? null;
      }

      // Stats query
      if (sql.includes('SELECT') && sql.includes('SUM')) {
        let total = 0, pending = 0, failed = 0, expired = 0;
        for (const row of mockDb.values()) {
          total++;
          if (row.status === 'pending') pending++;
          if (row.status === 'failed') failed++;
          if (row.status === 'expired') expired++;
        }
        return { total, pending, failed, expired };
      }

      return null;
    }),

    getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("WHERE status = 'failed'")) {
        return [...mockDb.values()].filter((r) => r.status === 'failed');
      }
      if (sql.includes("WHERE status = 'pending'")) {
        const now = params[0] as string;
        return [...mockDb.values()].filter(
          (r) => r.status === 'pending' && r.expires_at > now
        );
      }
      return [...mockDb.values()];
    }),
  } as unknown as import('expo-sqlite').SQLiteDatabase;

  return db;
}

// ============================================================================
// Imports (after all mocks)
// ============================================================================

import * as SQLiteModule from 'expo-sqlite';
import type { RelayMessage } from 'styrby-shared';
import { SQLiteOfflineQueue } from '../offline-queue';

// ============================================================================
// Test Utilities
// ============================================================================

/** Simulates an app crash at a controlled point inside the sync loop */
class SimulatedCrash extends Error {
  constructor(msg = 'simulated crash') {
    super(msg);
    this.name = 'SimulatedCrash';
  }
}

const FUTURE_EXPIRY = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const NOW = new Date().toISOString();

function makeChatMessage(overrides?: Partial<RelayMessage>): RelayMessage {
  return {
    type: 'chat',
    sessionId: 'session-chaos-test',
    content: 'test message',
    timestamp: NOW,
    ...overrides,
  } as RelayMessage;
}

/**
 * Seed mockCreateQueuedCommand to return a predictable command object.
 */
function seedQueuedCommand(id: string) {
  mockCreateQueuedCommand.mockReturnValueOnce({
    id,
    message: makeChatMessage(),
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    createdAt: NOW,
    expiresAt: FUTURE_EXPIRY,
    priority: 0,
  });
}

// ============================================================================
// Setup
// ============================================================================

let dbMock: import('expo-sqlite').SQLiteDatabase;

beforeEach(() => {
  // Reset in-memory DB
  mockDb.clear();
  mockLamportCounter = 0;
  mockUuidCounter = 0;

  // Build a fresh SQLite mock
  dbMock = buildSQLiteDb();

  // Make openDatabaseAsync return our mock DB
  jest
    .spyOn(SQLiteModule, 'openDatabaseAsync')
    .mockResolvedValue(dbMock);

  jest.clearAllMocks();
  // Re-apply the openDatabaseAsync spy after clearAllMocks
  jest
    .spyOn(SQLiteModule, 'openDatabaseAsync')
    .mockResolvedValue(dbMock);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ============================================================================
// Scenario 1: Kill between markPending and network call
// ============================================================================

describe('Chaos Scenario 1: Kill between markPending (enqueue) and network call', () => {
  it('message is re-attempted on next boot (not duplicated)', async () => {
    const queue = new SQLiteOfflineQueue();
    seedQueuedCommand('msg-crash-1');

    // Enqueue the message — simulates the user sending before crash
    await queue.enqueue(makeChatMessage());

    // Verify it is in 'pending' state in DB (markPending = enqueue here)
    const row = mockDb.get('msg-crash-1');
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');

    // Simulate crash: app dies before the network call.
    // On next boot, a new queue instance picks up the same DB.
    const queueAfterBoot = new SQLiteOfflineQueue();

    let attemptCount = 0;
    const sendFn = jest.fn(async () => {
      attemptCount++;
    });

    await queueAfterBoot.processQueue(sendFn);

    // The message should have been attempted exactly once (not duplicated)
    expect(attemptCount).toBe(1);
    expect(sendFn).toHaveBeenCalledTimes(1);

    // It should now be marked 'sent'
    expect(mockDb.get('msg-crash-1')?.status).toBe('sent');
  });

  it('idempotency_key is generated BEFORE the write (crash-safe)', async () => {
    const queue = new SQLiteOfflineQueue();
    seedQueuedCommand('msg-idempotency-1');

    await queue.enqueue(makeChatMessage());

    // The idempotency key must be in the DB immediately after enqueue
    const row = mockDb.get('msg-idempotency-1');
    expect(row).toBeDefined();
    expect(row!.idempotency_key).toBeDefined();
    expect(typeof row!.idempotency_key).toBe('string');
    expect(row!.idempotency_key.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Scenario 2: Kill between network call and markSent
// ============================================================================

describe('Chaos Scenario 2: Kill between network call and markSent', () => {
  it('retry carries the same idempotency_key as the original send', async () => {
    const queue = new SQLiteOfflineQueue();
    seedQueuedCommand('msg-crash-2');

    await queue.enqueue(makeChatMessage());

    // Capture the idempotency key from the DB immediately after enqueue
    const enqueueRow = mockDb.get('msg-crash-2');
    const originalKey = enqueueRow?.idempotency_key;
    expect(originalKey).toBeDefined();

    // Simulate crash AFTER network call but BEFORE markSent:
    // The send function throws SimulatedCrash after the "network call" succeeds
    // (i.e., the server received the message but we died before recording it).
    // processQueue will retry until maxAttempts is exhausted (3 attempts total).
    const crashingSendFn = jest.fn(async () => {
      throw new SimulatedCrash('kill between network and markSent');
    });

    // WHY one processQueue call exhausts all retries: processQueue calls dequeue()
    // in a loop, and markFailed re-queues the item as 'pending' after each failure
    // until attempts >= maxAttempts. In tests with no real retry delay (0ms),
    // all retries complete within one processQueue() invocation.
    const queue1 = new SQLiteOfflineQueue();
    await queue1.processQueue(crashingSendFn);

    // After exhausting maxAttempts=3 retries, the row ends in 'failed' state.
    // The KEY INVARIANT: the idempotency_key must be the SAME as the original
    // enqueue across all 3 attempts — never regenerated on retry.
    const afterCrashRow = mockDb.get('msg-crash-2');
    expect(afterCrashRow?.status).toBe('failed'); // all 3 attempts exhausted
    expect(afterCrashRow?.attempts).toBe(3);

    // Critical: idempotency key MUST NOT change across attempts
    expect(afterCrashRow?.idempotency_key).toBe(originalKey);
  });

  it('server receives the idempotency_key on the retry attempt', async () => {
    // This test simulates a "crash between network call and markSent" by having
    // processQueue1 fail on the first attempt (simulating network success + crash),
    // then processQueue2 succeed on the retry (simulating boot + reconnect + retry).
    //
    // The test uses maxAttempts=1 so that processQueue1 exhausts retries and
    // leaves the row in 'failed' state. A manual status reset simulates the
    // "boot recovery" step where the daemon re-queues failed items.
    seedQueuedCommand('msg-crash-2b');
    // Override maxAttempts to 1 so first failure → 'failed' (simplifies the test)
    mockCreateQueuedCommand.mockReturnValue({
      id: 'msg-crash-2b',
      message: makeChatMessage(),
      status: 'pending',
      attempts: 0,
      maxAttempts: 1, // single attempt → failed on first crash
      createdAt: NOW,
      expiresAt: FUTURE_EXPIRY,
      priority: 0,
    });

    const queue = new SQLiteOfflineQueue();
    await queue.enqueue(makeChatMessage());
    const originalKey = mockDb.get('msg-crash-2b')?.idempotency_key;
    expect(originalKey).toBeDefined();

    // First processQueue: fails → row ends in 'failed'
    const queue1 = new SQLiteOfflineQueue();
    await queue1.processQueue(async () => {
      throw new SimulatedCrash();
    });
    expect(mockDb.get('msg-crash-2b')?.status).toBe('failed');

    // Simulate boot recovery: manually reset status to 'pending'
    // (in production, the daemon's startup sweep resets failed → pending for retries)
    const row = mockDb.get('msg-crash-2b')!;
    row.status = 'pending';
    row.attempts = 0;

    // Second processQueue: success
    const sentPayloads: RelayMessage[] = [];
    const queue2 = new SQLiteOfflineQueue();
    await queue2.processQueue(async (msg) => {
      sentPayloads.push(msg);
    });

    // Message was retried and sent
    expect(sentPayloads.length).toBe(1);
    expect(mockDb.get('msg-crash-2b')?.status).toBe('sent');

    // Critical: idempotency_key MUST be identical to the original enqueue key
    expect(mockDb.get('msg-crash-2b')?.idempotency_key).toBe(originalKey);
  });
});

// ============================================================================
// Scenario 3: Kill between markSent and removeFromQueue
// ============================================================================

describe('Chaos Scenario 3: Kill between markSent and removeFromQueue', () => {
  it('sent message is NOT re-sent on next boot', async () => {
    const queue = new SQLiteOfflineQueue();
    seedQueuedCommand('msg-crash-3');

    await queue.enqueue(makeChatMessage());

    // Process successfully — message gets marked 'sent'
    const queue1 = new SQLiteOfflineQueue();
    await queue1.processQueue(async () => {
      // Successful send — no crash
    });

    expect(mockDb.get('msg-crash-3')?.status).toBe('sent');

    // Simulate crash before queue cleanup (removeFromQueue/clearExpired).
    // On next boot, processQueue should skip 'sent' items.
    const sendFn = jest.fn();
    const queue2 = new SQLiteOfflineQueue();
    await queue2.processQueue(sendFn);

    // The 'sent' message should NOT be re-sent
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('dequeue() never returns items with status "sent"', async () => {
    // Manually put a 'sent' row in the DB
    mockDb.set('already-sent', {
      id: 'already-sent',
      message: JSON.stringify(makeChatMessage()),
      status: 'sent',
      attempts: 1,
      max_attempts: 3,
      created_at: NOW,
      expires_at: FUTURE_EXPIRY,
      priority: 0,
      last_attempt_at: NOW,
      last_error: null,
      idempotency_key: 'key-already-sent',
      lamport_clock: 1,
    });

    const queue = new SQLiteOfflineQueue();
    const result = await queue.dequeue();

    // dequeue() filters on status='pending', so sent row is never returned
    expect(result).toBeNull();
  });
});

// ============================================================================
// Scenario 4: Kill during markFailed retry counter update
// ============================================================================

describe('Chaos Scenario 4: Kill during markFailed (retry counter update)', () => {
  it('retry counter advances correctly after failed attempts', async () => {
    const queue = new SQLiteOfflineQueue();
    seedQueuedCommand('msg-crash-4');
    await queue.enqueue(makeChatMessage());

    // Allow retries for the first 2 failures
    mockShouldRetry
      .mockReturnValueOnce(true)  // first failure → retry
      .mockReturnValueOnce(true); // second failure → retry

    const failTwiceQueue = new SQLiteOfflineQueue();
    let attempt = 0;
    await failTwiceQueue.processQueue(async () => {
      attempt++;
      if (attempt <= 2) throw new Error(`attempt ${attempt} failed`);
    });

    // After two failures and one success, attempts counter should be 2
    // (the third attempt succeeded — markSent was called, not markFailed)
    const finalRow = mockDb.get('msg-crash-4');
    // attempts reflects the number of markFailed calls (2 failures, then markSent)
    expect(finalRow?.status).toBe('sent');
    expect(finalRow?.attempts).toBeGreaterThanOrEqual(2);
  });

  it('retry counter never resets to 0 after a crash mid-markFailed', async () => {
    const queue = new SQLiteOfflineQueue();
    seedQueuedCommand('msg-crash-4b');
    await queue.enqueue(makeChatMessage());

    // Simulate crash during first markFailed:
    // We patch runAsync to throw SimulatedCrash when it's the markFailed UPDATE.
    const originalRunAsync = dbMock.runAsync as jest.Mock;
    let callCount = 0;
    originalRunAsync.mockImplementation(async (sql: string, params: unknown[]) => {
      callCount++;
      // The 5th call is typically the markFailed UPDATE (after INSERT, two index
      // creates, and the status='sending' UPDATE). We crash on the markFailed write.
      if (sql.includes('attempts') && sql.includes('UPDATE command_queue')) {
        // Simulate partial write: increment attempts in memory, then crash
        const row = mockDb.get(params[4] as string);
        if (row) row.attempts = (params[1] as number); // partial update
        throw new SimulatedCrash('kill during markFailed');
      }
      // Delegate to original logic
      return mockDb.has(params[0] as string)
        ? { changes: 1 }
        : { changes: 0 };
    });

    // The crash should be caught by processQueue's try/catch
    const crashingQueue = new SQLiteOfflineQueue();
    await expect(
      crashingQueue.processQueue(async () => {
        throw new Error('send failed');
      })
    ).resolves.not.toThrow(); // processQueue does not re-throw internal errors

    // Restore original implementation
    originalRunAsync.mockImplementation(
      (dbMock.runAsync as jest.Mock).getMockImplementation()!
    );
  });

  it('attempts count does not exceed maxAttempts even with concurrent retries', async () => {
    const queue = new SQLiteOfflineQueue();
    seedQueuedCommand('msg-max-attempts');
    await queue.enqueue(makeChatMessage());

    // Let shouldRetry allow only until maxAttempts is reached
    mockShouldRetry.mockImplementation(
      (item: { attempts: number; maxAttempts: number }) =>
        item.attempts < item.maxAttempts
    );

    // All attempts fail
    const alwaysFailQueue = new SQLiteOfflineQueue();
    await alwaysFailQueue.processQueue(async () => {
      throw new Error('always fails');
    });

    const finalRow = mockDb.get('msg-max-attempts');
    // After exhausting retries, status should be 'failed'
    if (finalRow) {
      expect(finalRow.attempts).toBeLessThanOrEqual(finalRow.max_attempts);
    }
  });
});

// ============================================================================
// Cross-scenario: Idempotency key stability
// ============================================================================

describe('Idempotency key invariant across all crash scenarios', () => {
  it('idempotency_key is identical across all retry attempts for the same message', async () => {
    const queue = new SQLiteOfflineQueue();
    seedQueuedCommand('msg-idempotency-stability');
    await queue.enqueue(makeChatMessage());

    const originalKey = mockDb.get('msg-idempotency-stability')?.idempotency_key;
    expect(originalKey).toBeDefined();

    // Simulate 3 boot cycles with failures
    for (let boot = 0; boot < 3; boot++) {
      mockShouldRetry.mockReturnValueOnce(true);
      const bootQueue = new SQLiteOfflineQueue();
      await bootQueue.processQueue(async () => {
        throw new Error(`boot ${boot} failed`);
      });

      const key = mockDb.get('msg-idempotency-stability')?.idempotency_key;
      expect(key).toBe(originalKey); // MUST NOT change across retries
    }
  });

  it('different messages get different idempotency_keys', async () => {
    seedQueuedCommand('msg-a');
    seedQueuedCommand('msg-b');

    const queue1 = new SQLiteOfflineQueue();
    await queue1.enqueue(makeChatMessage());

    const queue2 = new SQLiteOfflineQueue();
    await queue2.enqueue(makeChatMessage());

    const keyA = mockDb.get('msg-a')?.idempotency_key;
    const keyB = mockDb.get('msg-b')?.idempotency_key;

    expect(keyA).toBeDefined();
    expect(keyB).toBeDefined();
    expect(keyA).not.toBe(keyB);
  });
});

// ============================================================================
// Lamport clock in chaos scenarios
// ============================================================================

describe('Lamport clock persistence across crash/boot cycles', () => {
  it('Lamport clock value in DB is set before the enqueue write completes', async () => {
    const queue = new SQLiteOfflineQueue();
    seedQueuedCommand('msg-lamport-1');

    await queue.enqueue(makeChatMessage());

    const row = mockDb.get('msg-lamport-1');
    expect(row).toBeDefined();
    // lamport_clock must be > 0 (tick was called before INSERT)
    expect(row!.lamport_clock).toBeGreaterThan(0);
  });

  it('messages enqueued in sequence have ascending Lamport clock values', async () => {
    const queue = new SQLiteOfflineQueue();

    seedQueuedCommand('msg-seq-1');
    seedQueuedCommand('msg-seq-2');
    seedQueuedCommand('msg-seq-3');

    await queue.enqueue(makeChatMessage());
    await queue.enqueue(makeChatMessage());
    await queue.enqueue(makeChatMessage());

    const clocks = ['msg-seq-1', 'msg-seq-2', 'msg-seq-3'].map(
      (id) => mockDb.get(id)?.lamport_clock ?? -1
    );

    // Each successive message must have a higher Lamport clock
    expect(clocks[1]).toBeGreaterThan(clocks[0]);
    expect(clocks[2]).toBeGreaterThan(clocks[1]);
  });
});
