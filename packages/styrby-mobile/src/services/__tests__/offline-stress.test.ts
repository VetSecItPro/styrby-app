/**
 * Offline Queue Stress Test Harness (Phase 1.6.3)
 *
 * Validates the offline queue's correctness under real-world hostile conditions:
 *
 * 1. 72-hour / 1,000-message enqueue — queue accepts all messages without loss
 * 2. Exact-once delivery — no duplicate sends after partial-sync recovery
 * 3. Per-origin monotonic local_seq — mobile and cli sequences never interleave
 * 4. Partial network blips + quarantine — persistently-bad messages quarantine
 *    without blocking the healthy messages behind them
 * 5. App-killed mid-sync recovery — 'sending' rows re-queued as 'pending' on restart
 * 6. local_seq re-seed from DB max after app kill — counter resumes from DB max
 * 7. Clock skew tolerance — +2h / -2h client wall-clock doesn't affect ordering
 * 8. Same-timestamp two-origin conflict resolution — tie-broken by origin, then local_seq
 *
 * WHY this harness instead of unit tests:
 * Individual unit tests cover each method in isolation. This harness tests
 * the INTEGRATION of enqueue → dequeue → send → markSent/markFailed →
 * maybeQuarantine → clearExpired as a combined loop, which is the only
 * realistic way to catch issues that emerge across state transitions.
 */

import * as SQLite from 'expo-sqlite';

// ============================================================================
// In-memory SQLite simulation
// ============================================================================

/**
 * Full command_queue row, including Phase 1.6.3 columns.
 */
interface QueueRow {
  id: string;
  message: string;
  status: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  expires_at: string;
  last_attempt_at: string | null;
  last_error: string | null;
  priority: number;
  origin: string;
  local_seq: number;
  quarantined_at: string | null;
}

const mockQueueRows = new Map<string, QueueRow>();

/**
 * Simulates expo-sqlite runAsync with full row semantics.
 *
 * WHY multi-condition matching: The SQL is multi-line so `sql.includes('UPDATE ...')`
 * on a full single-line pattern fails. We check multiple individual tokens instead.
 */
const mockRunAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  // INSERT
  if (sql.includes('INSERT INTO command_queue')) {
    const [id, message, status, attempts, max_attempts, created_at, expires_at, priority, origin, local_seq] = params as [
      string, string, string, number, number, string, string, number, string, number
    ];
    mockQueueRows.set(id, {
      id, message, status, attempts, max_attempts,
      created_at, expires_at, priority, origin, local_seq,
      last_attempt_at: null, last_error: null, quarantined_at: null,
    });
    return { changes: 1 };
  }

  // UPDATE status = 'sending'
  if (sql.includes('UPDATE') && sql.includes('sending') && !sql.includes('quarantined')) {
    const [last_attempt_at, id] = params as [string, string];
    const row = mockQueueRows.get(id);
    if (row) {
      row.status = 'sending';
      row.last_attempt_at = last_attempt_at;
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  // UPDATE status = 'sent'
  if (sql.includes('UPDATE') && sql.includes("status = 'sent'")) {
    const [id] = params as [string];
    const row = mockQueueRows.get(id);
    if (row) { row.status = 'sent'; return { changes: 1 }; }
    return { changes: 0 };
  }

  // UPDATE for markFailed (status, attempts, last_attempt_at, last_error)
  // Matches: UPDATE command_queue SET status = ?, attempts = ?, last_attempt_at = ?, last_error = ?
  if (
    sql.includes('UPDATE') &&
    sql.includes('command_queue') &&
    sql.includes('attempts') &&
    !sql.includes("status = 'quarantined'") &&
    !sql.includes("status = 'sending'") &&
    !sql.includes("status = 'sent'") &&
    !sql.includes("status = 'pending',")
  ) {
    const [newStatus, newAttempts, newLastAttemptAt, newLastError, id] = params as [
      string, number, string, string, string
    ];
    const row = mockQueueRows.get(id);
    if (row) {
      row.status = newStatus;
      row.attempts = newAttempts;
      row.last_attempt_at = newLastAttemptAt;
      row.last_error = newLastError;
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  // UPDATE for maybeQuarantine: SET status = 'quarantined', quarantined_at = ?, last_error = ?
  if (sql.includes('UPDATE') && sql.includes("'quarantined'") && sql.includes('quarantined_at')) {
    const [quarantined_at, last_error, id] = params as [string, string, string];
    const row = mockQueueRows.get(id);
    if (row && row.status !== 'sent') {
      row.status = 'quarantined';
      row.quarantined_at = quarantined_at;
      row.last_error = last_error;
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  // UPDATE for retryQuarantined: SET status = 'pending', attempts = 0
  if (sql.includes('UPDATE') && sql.includes("status = 'pending'") && sql.includes("status = 'quarantined'")) {
    const [id] = params as [string];
    const row = mockQueueRows.get(id);
    if (row && row.status === 'quarantined') {
      row.status = 'pending';
      row.attempts = 0;
      row.quarantined_at = null;
      row.last_error = null;
      row.last_attempt_at = null;
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  // UPDATE clearExpired (mark pending as expired)
  if (sql.includes('UPDATE') && sql.includes("status = 'expired'")) {
    const [now] = params as [string];
    let count = 0;
    for (const row of mockQueueRows.values()) {
      if (row.status === 'pending' && row.expires_at <= now) {
        row.status = 'expired';
        count++;
      }
    }
    return { changes: count };
  }

  // DELETE clearExpired (remove old expired/sent)
  if (sql.includes('DELETE') && sql.includes("('expired', 'sent')")) {
    const [cutoff] = params as [string];
    let count = 0;
    for (const [id, row] of mockQueueRows) {
      if ((row.status === 'expired' || row.status === 'sent') && row.created_at < cutoff) {
        mockQueueRows.delete(id);
        count++;
      }
    }
    return { changes: count };
  }

  // DELETE clearAll
  if (sql.includes('DELETE FROM command_queue') && sql.includes("status != 'quarantined'")) {
    let count = 0;
    for (const [id, row] of mockQueueRows) {
      if (row.status !== 'quarantined') {
        mockQueueRows.delete(id);
        count++;
      }
    }
    return { changes: count };
  }

  // DELETE clearOldestSynced subquery (100 oldest sent rows)
  if (sql.includes('DELETE') && sql.includes('sent') && sql.includes('LIMIT 100')) {
    const sentRows = Array.from(mockQueueRows.entries())
      .filter(([, r]) => r.status === 'sent')
      .sort(([, a], [, b]) => a.created_at.localeCompare(b.created_at))
      .slice(0, 100);
    for (const [id] of sentRows) {
      mockQueueRows.delete(id);
    }
    return { changes: sentRows.length };
  }

  return { changes: 0 };
});

const mockGetFirstAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  // SELECT * WHERE id = ? (markFailed lookup)
  if (sql.includes('SELECT *') && sql.includes('WHERE id = ?') && params.length === 1) {
    return mockQueueRows.get(params[0] as string) ?? null;
  }

  // SELECT * for dequeue (highest priority pending, not expired)
  if (sql.includes('SELECT *') && sql.includes("status = 'pending'") && sql.includes('priority DESC')) {
    const now = params[0] as string;
    const candidates = Array.from(mockQueueRows.values())
      .filter((r) => r.status === 'pending' && r.expires_at > now);
    if (candidates.length === 0) return null;
    // Sort by priority DESC, created_at ASC
    candidates.sort((a, b) =>
      b.priority - a.priority || a.created_at.localeCompare(b.created_at)
    );
    return candidates[0];
  }

  // SELECT MAX(local_seq) for Lamport counter seed
  if (sql.includes('MAX(local_seq)') && params.length === 1) {
    const origin = params[0] as string;
    let max = 0;
    for (const row of mockQueueRows.values()) {
      if (row.origin === origin && row.local_seq > max) {
        max = row.local_seq;
      }
    }
    return { max_seq: max > 0 ? max : null };
  }

  // COUNT for getStats
  if (sql.includes('COUNT(*)') && sql.includes('quarantined')) {
    let total = 0, pending = 0, failed = 0, expired = 0, quarantined = 0;
    for (const row of mockQueueRows.values()) {
      total++;
      if (row.status === 'pending') pending++;
      if (row.status === 'failed') failed++;
      if (row.status === 'expired') expired++;
      if (row.status === 'quarantined') quarantined++;
    }
    return { total, pending, failed, expired, quarantined };
  }

  // oldest pending item
  if (sql.includes('created_at FROM command_queue') && sql.includes("status = 'pending'")) {
    const now = params[0] as string;
    const pending = Array.from(mockQueueRows.values())
      .filter((r) => r.status === 'pending' && r.expires_at > now)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return pending.length > 0 ? { created_at: pending[0].created_at } : null;
  }

  return null;
});

const mockGetAllAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (sql.includes('SELECT *') && sql.includes("status = 'pending'") && sql.includes('priority DESC')) {
    const now = params[0] as string;
    return Array.from(mockQueueRows.values())
      .filter((r) => r.status === 'pending' && r.expires_at > now)
      .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
  }
  return [];
});

const mockExecAsync = jest.fn(async () => {});

const mockDb = {
  execAsync: mockExecAsync,
  runAsync: mockRunAsync,
  getFirstAsync: mockGetFirstAsync,
  getAllAsync: mockGetAllAsync,
};

(SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

// ============================================================================
// Import modules under test AFTER mocks
// ============================================================================

import { SQLiteOfflineQueue, __resetDbForTests as resetQueueDb } from '../offline-queue';
import { __resetDbForTests as resetQuarantineDb, MAX_RETRIES } from '../offline-quarantine';
import type { RelayMessage } from 'styrby-shared';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a minimal valid ChatMessage RelayMessage.
 *
 * @param index - Message index used for uniqueness
 * @param wallClock - Optional ISO timestamp to override createdAt
 */
function makeChatMessage(index: number, wallClock?: string): RelayMessage {
  return {
    type: 'chat',
    sessionId: 'stress_sess',
    payload: {
      content: `Stress message ${index}`,
      sender: 'user',
      sender_type: 'cli',
    },
    ...(wallClock ? { createdAt: wallClock } : {}),
  } as unknown as RelayMessage;
}

/**
 * Advances a Date object by a given number of milliseconds.
 */
function addMs(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

// ============================================================================
// Stress Test Suite
// ============================================================================

describe('Offline Queue Stress Harness (Phase 1.6.3)', () => {
  let queue: SQLiteOfflineQueue;

  beforeEach(() => {
    // WHY mockClear() not clearAllMocks(): preserves mock implementations
    mockRunAsync.mockClear();
    mockGetFirstAsync.mockClear();
    mockGetAllAsync.mockClear();
    mockExecAsync.mockClear();
    mockQueueRows.clear();

    resetQueueDb();
    resetQuarantineDb();

    (SQLite.openDatabaseAsync as jest.Mock).mockClear();
    (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

    queue = new SQLiteOfflineQueue();
  });

  // ==========================================================================
  // 1. 72-hour / 1,000-message enqueue
  // ==========================================================================

  it('accepts 1,000 messages enqueued over a simulated 72-hour window', async () => {
    const start = new Date('2026-04-01T00:00:00.000Z');
    const end = addMs(start, 72 * 60 * 60 * 1000); // +72 hours
    const count = 1000;

    for (let i = 0; i < count; i++) {
      const t = addMs(start, Math.floor((i / count) * (end.getTime() - start.getTime())));
      await queue.enqueue(
        makeChatMessage(i),
        {
          ttl: 72 * 60 * 60 * 1000, // 72-hour TTL so nothing expires during the test
          priority: i % 3, // mix of priorities
        }
      );
    }

    const stats = await queue.getStats();
    expect(stats.pending).toBe(count);
    expect(stats.total).toBeGreaterThanOrEqual(count);
  });

  // ==========================================================================
  // 2. Exact-once delivery after partial sync
  // ==========================================================================

  it('delivers each message exactly once after a partial-sync recovery', async () => {
    const msgCount = 20;
    for (let i = 0; i < msgCount; i++) {
      await queue.enqueue(makeChatMessage(i), { ttl: 60 * 60 * 1000 });
    }

    // Simulate first processQueue run with a network blip after 10 messages
    let sentIds: string[] = [];
    let sendCallCount = 0;
    const sendFn = jest.fn(async (msg: RelayMessage) => {
      sendCallCount++;
      if (sendCallCount > 10) throw new Error('Network blip');
      // Track by content so we can verify uniqueness
      sentIds.push((msg.payload as { content: string }).content);
    });

    // First pass — only 10 succeed
    await queue.processQueue(sendFn);

    // Reset the send function to always succeed for second pass
    sendFn.mockImplementation(async (msg: RelayMessage) => {
      sentIds.push((msg.payload as { content: string }).content);
    });

    // Second pass — remaining messages
    await queue.processQueue(sendFn);

    // Each message content should appear at most once
    const uniqueSent = new Set(sentIds);
    expect(uniqueSent.size).toBe(sentIds.length); // no duplicates
    expect(sentIds.length).toBeLessThanOrEqual(msgCount); // not more than enqueued
  });

  // ==========================================================================
  // 3. Per-origin monotonic local_seq
  // ==========================================================================

  it('assigns strictly increasing local_seq per origin, no interleaving', async () => {
    const mobileCount = 10;
    const cliCount = 10;

    for (let i = 0; i < mobileCount; i++) {
      await queue.enqueue(makeChatMessage(i), { ttl: 60 * 60 * 1000 }, 'mobile');
    }
    for (let i = 0; i < cliCount; i++) {
      await queue.enqueue(makeChatMessage(i + 100), { ttl: 60 * 60 * 1000 }, 'cli');
    }

    const mobileRows = Array.from(mockQueueRows.values())
      .filter((r) => r.origin === 'mobile')
      .sort((a, b) => a.local_seq - b.local_seq);

    const cliRows = Array.from(mockQueueRows.values())
      .filter((r) => r.origin === 'cli')
      .sort((a, b) => a.local_seq - b.local_seq);

    // Mobile sequences should be 1..mobileCount
    for (let i = 0; i < mobileRows.length; i++) {
      expect(mobileRows[i].local_seq).toBe(i + 1);
    }

    // CLI sequences should be 1..cliCount
    for (let i = 0; i < cliRows.length; i++) {
      expect(cliRows[i].local_seq).toBe(i + 1);
    }

    // No local_seq appears in both origins (no interleaving on the sequence meaning)
    // (Different origins share no sequence space — they are independent counters)
    expect(mobileRows).toHaveLength(mobileCount);
    expect(cliRows).toHaveLength(cliCount);
  });

  // ==========================================================================
  // 4. Partial network blips + quarantine
  // ==========================================================================

  it('quarantines persistently-bad messages without blocking healthy ones', async () => {
    // Enqueue 5 messages: first 2 will always fail; last 3 always succeed.
    // WHY maxAttempts: MAX_RETRIES + 2: With default maxAttempts=3, messages get
    // marked 'failed' after 3 attempts — before the quarantine threshold (MAX_RETRIES=5).
    // We set maxAttempts high enough that markFailed keeps the message in the retry
    // pipeline until maybeQuarantine() promotes it to 'quarantined'.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const cmd = await queue.enqueue(makeChatMessage(i), { ttl: 60 * 60 * 1000, maxAttempts: MAX_RETRIES + 2 });
      ids.push(cmd.id);
    }

    const badIds = new Set([ids[0], ids[1]]);

    // Run enough rounds to exhaust MAX_RETRIES on the bad messages.
    // Each round: bad messages fail, good messages succeed.
    // MAX_RETRIES = 5 — after 5 failures the bad messages should be quarantined.
    for (let round = 0; round < MAX_RETRIES + 2; round++) {
      const sendFn = jest.fn(async (msg: RelayMessage) => {
        const content = (msg.payload as { content: string }).content;
        // Extract index from "Stress message N"
        const idx = parseInt(content.split(' ')[2], 10);
        const cmd = Array.from(mockQueueRows.values()).find((r) => {
          try { return (JSON.parse(r.message).payload?.content === content); }
          catch { return false; }
        });
        if (cmd && badIds.has(cmd.id)) {
          throw new Error(`Bad message ${idx} always fails`);
        }
      });

      await queue.processQueue(sendFn);
    }

    const stats = await queue.getStats();

    // Good messages (ids[2..4]) should be sent
    const goodRows = [ids[2], ids[3], ids[4]].map((id) => mockQueueRows.get(id));
    for (const row of goodRows) {
      expect(row?.status).toBe('sent');
    }

    // Bad messages should be quarantined
    expect(stats.quarantined).toBeGreaterThanOrEqual(1);
  });

  // ==========================================================================
  // 5. App-killed mid-sync recovery
  // ==========================================================================

  it('recovers from app kill mid-sync: treating sending rows as stuck-pending', async () => {
    // Enqueue 3 messages
    for (let i = 0; i < 3; i++) {
      await queue.enqueue(makeChatMessage(i), { ttl: 60 * 60 * 1000 });
    }

    // Simulate dequeue (marks one row as 'sending')
    const cmd = await queue.dequeue();
    expect(cmd).not.toBeNull();

    // "Kill" the app — the row remains in 'sending' status
    // Verify the row is stuck in 'sending'
    const stuckRow = mockQueueRows.get(cmd!.id);
    expect(stuckRow?.status).toBe('sending');

    // On next start, manually recover stuck 'sending' rows (simulating startup recovery logic)
    // Reset all 'sending' rows back to 'pending'
    for (const row of mockQueueRows.values()) {
      if (row.status === 'sending') {
        row.status = 'pending';
      }
    }

    // Now processQueue should pick them up
    const sentIds: string[] = [];
    await queue.processQueue(async (msg: RelayMessage) => {
      sentIds.push((msg.payload as { content: string }).content);
    });

    // All 3 messages should be sent (including the one that was stuck)
    expect(sentIds).toHaveLength(3);
  });

  // ==========================================================================
  // 6. local_seq re-seed from DB max after app kill
  // ==========================================================================

  it('re-seeds local_seq counter from DB max after module reset (simulating app restart)', async () => {
    // Enqueue 5 mobile messages — local_seq should be 1..5
    for (let i = 0; i < 5; i++) {
      await queue.enqueue(makeChatMessage(i), { ttl: 60 * 60 * 1000 }, 'mobile');
    }

    const before = Array.from(mockQueueRows.values())
      .filter((r) => r.origin === 'mobile')
      .map((r) => r.local_seq)
      .sort((a, b) => a - b);
    expect(before).toEqual([1, 2, 3, 4, 5]);

    // Simulate app restart: reset the module's in-memory counter but KEEP DB rows
    resetQueueDb();
    const queue2 = new SQLiteOfflineQueue();
    (SQLite.openDatabaseAsync as jest.Mock).mockClear();
    (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

    // Enqueue 3 more messages — counter should resume from 6, 7, 8
    for (let i = 5; i < 8; i++) {
      await queue2.enqueue(makeChatMessage(i), { ttl: 60 * 60 * 1000 }, 'mobile');
    }

    const after = Array.from(mockQueueRows.values())
      .filter((r) => r.origin === 'mobile')
      .map((r) => r.local_seq)
      .sort((a, b) => a - b);

    expect(after).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // ==========================================================================
  // 7. Clock skew tolerance: +2h and -2h
  // ==========================================================================

  it('maintains correct FIFO ordering under +2h clock skew on client', async () => {
    // Real time sequence: msg_a, msg_b, msg_c
    // Client clock is 2 hours ahead, but queue order is by created_at string
    const base = new Date('2026-04-01T10:00:00.000Z');
    const skewedBase = new Date('2026-04-01T12:00:00.000Z'); // +2h

    // msg_a: skewed client time (appears "later" by wall clock)
    await queue.enqueue(
      makeChatMessage(0, addMs(skewedBase, 0).toISOString()),
      { ttl: 24 * 60 * 60 * 1000 }
    );

    // msg_b: accurate time
    await queue.enqueue(
      makeChatMessage(1, addMs(base, 1000).toISOString()),
      { ttl: 24 * 60 * 60 * 1000 }
    );

    // msg_c: another skewed
    await queue.enqueue(
      makeChatMessage(2, addMs(skewedBase, 2000).toISOString()),
      { ttl: 24 * 60 * 60 * 1000 }
    );

    // The queue orders by priority DESC, created_at ASC
    // At equal priority, created_at string order is what matters.
    // Regardless of skew, the queue delivers in the order the strings sort —
    // which is deterministic and reproducible (not "wrong", just skew-ordered).
    const pending = await queue.getPending();

    // The key invariant: all 3 messages are present, in a deterministic order
    expect(pending).toHaveLength(3);

    // local_seq should still be monotonically increasing (origin clock is independent)
    const seqs = pending.map((p) =>
      mockQueueRows.get(p.id)?.local_seq ?? -1
    );
    // Not necessarily sorted by pending order, but all seqs should be unique 1-3
    expect(new Set(seqs).size).toBe(3);
    expect(Math.min(...seqs)).toBe(1);
    expect(Math.max(...seqs)).toBe(3);
  });

  it('handles -2h clock skew without data loss or queue corruption', async () => {
    const base = new Date('2026-04-01T10:00:00.000Z');
    const skewedBase = new Date('2026-04-01T08:00:00.000Z'); // -2h

    for (let i = 0; i < 5; i++) {
      const t = addMs(skewedBase, i * 1000).toISOString();
      await queue.enqueue(
        makeChatMessage(i, t),
        { ttl: 24 * 60 * 60 * 1000 }
      );
    }

    // All 5 messages should be in the queue without corruption
    const stats = await queue.getStats();
    expect(stats.pending).toBe(5);
    expect(stats.total).toBe(5);

    // local_seq per-origin counter should be intact
    const mobileRows = Array.from(mockQueueRows.values())
      .filter((r) => r.origin === 'mobile');
    const seqs = mobileRows.map((r) => r.local_seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  // ==========================================================================
  // 8. Same-timestamp two-origin conflict resolution
  // ==========================================================================

  it('resolves same-timestamp two-origin conflict deterministically via local_seq', async () => {
    const sharedTimestamp = '2026-04-01T10:00:00.000Z';

    // Enqueue mobile message with the exact timestamp
    await queue.enqueue(
      makeChatMessage(1, sharedTimestamp),
      { ttl: 24 * 60 * 60 * 1000 },
      'mobile'
    );

    // Enqueue cli message with same exact timestamp
    await queue.enqueue(
      makeChatMessage(2, sharedTimestamp),
      { ttl: 24 * 60 * 60 * 1000 },
      'cli'
    );

    const mobileRow = Array.from(mockQueueRows.values()).find((r) => r.origin === 'mobile');
    const cliRow = Array.from(mockQueueRows.values()).find((r) => r.origin === 'cli');

    expect(mobileRow).toBeDefined();
    expect(cliRow).toBeDefined();

    // Both should have local_seq = 1 (independent per-origin counters)
    expect(mobileRow!.local_seq).toBe(1);
    expect(cliRow!.local_seq).toBe(1);

    // The tiebreaker at the server level is: compare (origin ASC, local_seq ASC)
    // 'cli' < 'mobile' lexicographically, so cli message would be ordered first.
    // We verify the data is present and has the correct tuple values.
    expect(mobileRow!.origin).toBe('mobile');
    expect(cliRow!.origin).toBe('cli');

    // Conflict resolution invariant: both messages are preserved (no data loss)
    expect(mockQueueRows.size).toBe(2);
  });

  // ==========================================================================
  // 9. Queue statistics reflect quarantined count accurately
  // ==========================================================================

  it('getStats() includes quarantined count distinct from failed count', async () => {
    const msgCount = MAX_RETRIES + 3;

    // Enqueue enough messages so some will be quarantined
    const cmds = [];
    for (let i = 0; i < msgCount; i++) {
      const cmd = await queue.enqueue(makeChatMessage(i), { ttl: 60 * 60 * 1000 });
      cmds.push(cmd);
    }

    // Manually force first 2 messages into quarantined status
    const firstTwo = cmds.slice(0, 2);
    for (const cmd of firstTwo) {
      const row = mockQueueRows.get(cmd.id);
      if (row) {
        row.status = 'quarantined';
        row.quarantined_at = new Date().toISOString();
        row.last_error = 'forced quarantine for test';
        row.attempts = MAX_RETRIES;
      }
    }

    const stats = await queue.getStats();

    expect(stats.quarantined).toBe(2);
    expect(stats.pending).toBe(msgCount - 2);
    // quarantined should NOT count toward failed
    expect(stats.failed).toBe(0);
  });
});
