/**
 * Offline Quarantine Service Test Suite
 *
 * Tests the quarantine lifecycle for persistently-failing offline queue messages:
 * - maybeQuarantine(): threshold enforcement, idempotency, sent-exclusion
 * - getQuarantined(): ordering, mapping, empty-state, null-error coercion
 * - getQuarantinedCount(): COUNT query path vs full-row fetch
 * - retryQuarantined(): status reset, attempt reset, throws on missing/wrong-status
 * - discardQuarantined(): DELETE predicate, throws on missing/wrong-status
 * - discardAllQuarantined(): bulk DELETE, count accuracy
 */

import * as SQLite from 'expo-sqlite';
import type { RelayMessage } from 'styrby-shared';

// ============================================================================
// SQLite Mock Setup
// ============================================================================

/**
 * In-memory store simulating the command_queue rows relevant to quarantine.
 */
const mockQueueRows: Map<string, Record<string, unknown>> = new Map();

const mockRunAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  // retryQuarantined UPDATE — MUST be checked before maybeQuarantine because
  // retryQuarantined SQL also contains 'quarantined_at' (in SET ... quarantined_at = NULL).
  // Disambiguator: retryQuarantined sets status = 'pending' AND has WHERE status = 'quarantined';
  // maybeQuarantine sets status = 'quarantined' (not 'pending').
  if (sql.includes("status = 'pending'") && sql.includes("status = 'quarantined'")) {
    const id = params[0] as string;
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

  // maybeQuarantine UPDATE — only matches SET status = 'quarantined' (not 'pending')
  if (sql.includes('quarantined_at') && sql.includes('UPDATE')) {
    const id = params[2] as string;
    const row = mockQueueRows.get(id);
    if (row && row.status !== 'sent') {
      row.status = 'quarantined';
      row.quarantined_at = params[0];
      row.last_error = params[1];
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  // discardQuarantined DELETE (single)
  if (sql.includes('DELETE') && sql.includes("status = 'quarantined'") && params.length > 0) {
    const id = params[0] as string;
    const row = mockQueueRows.get(id);
    if (row && row.status === 'quarantined') {
      mockQueueRows.delete(id);
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  // discardAllQuarantined DELETE (bulk — no params)
  if (sql.includes('DELETE') && sql.includes("status = 'quarantined'") && params.length === 0) {
    let count = 0;
    for (const [id, row] of mockQueueRows) {
      if (row.status === 'quarantined') {
        mockQueueRows.delete(id);
        count++;
      }
    }
    return { changes: count };
  }

  return { changes: 0 };
});

const mockGetFirstAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  // getQuarantinedCount COUNT query
  if (sql.includes('COUNT(*)')) {
    let count = 0;
    for (const row of mockQueueRows.values()) {
      if (row.status === 'quarantined') count++;
    }
    return { count };
  }

  return null;
});

const mockGetAllAsync = jest.fn(async (sql: string) => {
  if (sql.includes("status = 'quarantined'")) {
    const results = Array.from(mockQueueRows.values()).filter(
      (r) => r.status === 'quarantined'
    );
    // ORDER BY quarantined_at ASC
    results.sort((a, b) =>
      (a.quarantined_at as string).localeCompare(b.quarantined_at as string)
    );
    return results;
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

// Override the global expo-sqlite mock
(SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

// ============================================================================
// Import module under test AFTER mocks
// ============================================================================

import {
  MAX_RETRIES,
  maybeQuarantine,
  getQuarantined,
  getQuarantinedCount,
  retryQuarantined,
  discardQuarantined,
  discardAllQuarantined,
  __resetDbForTests,
} from '../offline-quarantine';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a minimal quarantined row for mock DB seeding.
 */
function makeQuarantinedRow(
  id: string,
  quarantinedAt: string,
  lastError: string | null = 'Network timeout'
): Record<string, unknown> {
  const message: RelayMessage = {
    type: 'chat',
    sessionId: 'sess_test',
    payload: { content: `Message ${id}` },
  } as unknown as RelayMessage;

  return {
    id,
    message: JSON.stringify(message),
    status: 'quarantined',
    attempts: MAX_RETRIES,
    max_attempts: 3,
    created_at: '2026-04-01T00:00:00.000Z',
    expires_at: '2026-04-01T01:00:00.000Z',
    quarantined_at: quarantinedAt,
    last_error: lastError,
    priority: 0,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Offline Quarantine Service', () => {
  beforeEach(() => {
    // WHY mockClear() not clearAllMocks(): clearAllMocks() wipes mock
    // implementations back to undefined. mockClear() only resets call counts.
    mockRunAsync.mockClear();
    mockGetFirstAsync.mockClear();
    mockGetAllAsync.mockClear();
    mockExecAsync.mockClear();
    mockQueueRows.clear();
    // Reset module-level _db handle so getDb() runs fresh each test
    __resetDbForTests();
    (SQLite.openDatabaseAsync as jest.Mock).mockClear();
    (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);
  });

  // ==========================================================================
  // Constants
  // ==========================================================================

  describe('MAX_RETRIES', () => {
    it('is 5', () => {
      expect(MAX_RETRIES).toBe(5);
    });
  });

  // ==========================================================================
  // maybeQuarantine()
  // ==========================================================================

  describe('maybeQuarantine()', () => {
    it('returns false when attempts < MAX_RETRIES', async () => {
      const result = await maybeQuarantine('id_1', MAX_RETRIES - 1, 'timeout');
      expect(result).toBe(false);
    });

    it('returns false when attempts is 0', async () => {
      const result = await maybeQuarantine('id_zero', 0, 'timeout');
      expect(result).toBe(false);
    });

    it('returns true and updates row when attempts === MAX_RETRIES', async () => {
      mockQueueRows.set('q_exact', {
        id: 'q_exact', status: 'pending', attempts: MAX_RETRIES,
        message: '{}', created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z', priority: 0,
      });

      const result = await maybeQuarantine('q_exact', MAX_RETRIES, 'final error');

      expect(result).toBe(true);
      expect(mockQueueRows.get('q_exact')!.status).toBe('quarantined');
      expect(mockQueueRows.get('q_exact')!.last_error).toBe('final error');
      expect(mockQueueRows.get('q_exact')!.quarantined_at).toBeDefined();
    });

    it('returns true when attempts > MAX_RETRIES', async () => {
      mockQueueRows.set('q_over', {
        id: 'q_over', status: 'pending', attempts: MAX_RETRIES + 2,
        message: '{}', created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z', priority: 0,
      });

      const result = await maybeQuarantine('q_over', MAX_RETRIES + 2, 'over-retried');
      expect(result).toBe(true);
    });

    it('does not quarantine rows with status = sent (sent exclusion)', async () => {
      mockQueueRows.set('q_sent', {
        id: 'q_sent', status: 'sent', attempts: MAX_RETRIES,
        message: '{}', created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z', priority: 0,
      });

      // The mock respects the AND status != 'sent' predicate
      const result = await maybeQuarantine('q_sent', MAX_RETRIES, 'too late');

      // Row is 'sent' — mock returns changes: 0 — but maybeQuarantine still
      // returns true because attempts threshold is met (it doesn't re-read the row)
      expect(result).toBe(true);
      // The status should remain 'sent' — the SQL predicate blocked the UPDATE
      expect(mockQueueRows.get('q_sent')!.status).toBe('sent');
    });

    it('stores the lastError string in the row', async () => {
      mockQueueRows.set('q_err', {
        id: 'q_err', status: 'pending', attempts: MAX_RETRIES,
        message: '{}', created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z', priority: 0,
      });

      await maybeQuarantine('q_err', MAX_RETRIES, 'Connection refused: ECONNREFUSED');

      expect(mockQueueRows.get('q_err')!.last_error).toBe('Connection refused: ECONNREFUSED');
    });

    it('issues UPDATE with quarantined status, quarantined_at, last_error, and id params', async () => {
      mockQueueRows.set('q_sql', {
        id: 'q_sql', status: 'pending', attempts: MAX_RETRIES,
        message: '{}', created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z', priority: 0,
      });

      await maybeQuarantine('q_sql', MAX_RETRIES, 'err');

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining('quarantined'),
        expect.arrayContaining(['err', 'q_sql'])
      );
    });
  });

  // ==========================================================================
  // getQuarantined()
  // ==========================================================================

  describe('getQuarantined()', () => {
    it('returns empty array when no quarantined messages exist', async () => {
      const result = await getQuarantined();
      expect(result).toEqual([]);
    });

    it('returns quarantined messages ordered oldest-first by quarantined_at', async () => {
      mockQueueRows.set('newer', makeQuarantinedRow('newer', '2026-04-02T00:00:00.000Z'));
      mockQueueRows.set('older', makeQuarantinedRow('older', '2026-04-01T00:00:00.000Z'));

      const result = await getQuarantined();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('older');
      expect(result[1].id).toBe('newer');
    });

    it('maps rows to QuarantinedMessage with correct field types', async () => {
      mockQueueRows.set('msg_1', makeQuarantinedRow('msg_1', '2026-04-01T10:00:00.000Z'));

      const result = await getQuarantined();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('msg_1');
      expect(typeof result[0].message).toBe('object'); // parsed RelayMessage
      expect(result[0].createdAt).toBe('2026-04-01T00:00:00.000Z');
      expect(result[0].quarantinedAt).toBe('2026-04-01T10:00:00.000Z');
      expect(result[0].lastError).toBe('Network timeout');
      expect(result[0].attempts).toBe(MAX_RETRIES);
    });

    it('does not include non-quarantined rows', async () => {
      mockQueueRows.set('pending_row', {
        id: 'pending_row', status: 'pending', attempts: 1,
        message: '{}', created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z', quarantined_at: null,
        last_error: null, priority: 0,
      });
      mockQueueRows.set('q_row', makeQuarantinedRow('q_row', '2026-04-01T00:00:00.000Z'));

      const result = await getQuarantined();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('q_row');
    });

    it('coerces null last_error to undefined', async () => {
      mockQueueRows.set('null_err', makeQuarantinedRow('null_err', '2026-04-01T00:00:00.000Z', null));

      const result = await getQuarantined();

      expect(result[0].lastError).toBeUndefined();
    });
  });

  // ==========================================================================
  // getQuarantinedCount()
  // ==========================================================================

  describe('getQuarantinedCount()', () => {
    it('returns 0 when no quarantined messages exist', async () => {
      const count = await getQuarantinedCount();
      expect(count).toBe(0);
    });

    it('returns the correct count without deserializing message payloads', async () => {
      mockQueueRows.set('q_a', makeQuarantinedRow('q_a', '2026-04-01T00:00:00.000Z'));
      mockQueueRows.set('q_b', makeQuarantinedRow('q_b', '2026-04-01T01:00:00.000Z'));
      mockQueueRows.set('q_c', makeQuarantinedRow('q_c', '2026-04-01T02:00:00.000Z'));

      const count = await getQuarantinedCount();
      expect(count).toBe(3);
    });

    it('uses COUNT(*) query path — not getAllAsync', async () => {
      mockQueueRows.set('q_count', makeQuarantinedRow('q_count', '2026-04-01T00:00:00.000Z'));

      await getQuarantinedCount();

      expect(mockGetFirstAsync).toHaveBeenCalledWith(
        expect.stringContaining('COUNT(*)')
      );
      // getAllAsync should NOT be called (COUNT is more efficient)
      expect(mockGetAllAsync).not.toHaveBeenCalled();
    });

    it('returns 0 when getFirstAsync returns null', async () => {
      mockGetFirstAsync.mockResolvedValueOnce(null);

      const count = await getQuarantinedCount();
      expect(count).toBe(0);
    });
  });

  // ==========================================================================
  // retryQuarantined()
  // ==========================================================================

  describe('retryQuarantined()', () => {
    it('resets status to pending and attempts to 0', async () => {
      mockQueueRows.set('retry_me', makeQuarantinedRow('retry_me', '2026-04-01T00:00:00.000Z'));

      await retryQuarantined('retry_me');

      const row = mockQueueRows.get('retry_me')!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.quarantined_at).toBeNull();
      expect(row.last_error).toBeNull();
      expect(row.last_attempt_at).toBeNull();
    });

    it('throws if no quarantined row matches (not found)', async () => {
      await expect(retryQuarantined('nonexistent')).rejects.toThrow(
        "retryQuarantined: no quarantined message with id 'nonexistent'"
      );
    });

    it('throws if row exists but is not in quarantined status', async () => {
      mockQueueRows.set('pending_row', {
        id: 'pending_row', status: 'pending', attempts: 2,
        message: '{}', created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z', quarantined_at: null,
        last_error: null, priority: 0,
      });

      await expect(retryQuarantined('pending_row')).rejects.toThrow(
        "retryQuarantined: no quarantined message with id 'pending_row'"
      );
    });

    it('issues UPDATE with WHERE id = ? AND status = quarantined predicate', async () => {
      mockQueueRows.set('q_predicate', makeQuarantinedRow('q_predicate', '2026-04-01T00:00:00.000Z'));

      await retryQuarantined('q_predicate');

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining("status = 'quarantined'"),
        expect.arrayContaining(['q_predicate'])
      );
    });
  });

  // ==========================================================================
  // discardQuarantined()
  // ==========================================================================

  describe('discardQuarantined()', () => {
    it('deletes the quarantined row from the database', async () => {
      mockQueueRows.set('discard_me', makeQuarantinedRow('discard_me', '2026-04-01T00:00:00.000Z'));

      await discardQuarantined('discard_me');

      expect(mockQueueRows.has('discard_me')).toBe(false);
    });

    it('throws if no quarantined row matches (not found)', async () => {
      await expect(discardQuarantined('ghost')).rejects.toThrow(
        "discardQuarantined: no quarantined message with id 'ghost'"
      );
    });

    it('throws if row exists but is not in quarantined status', async () => {
      mockQueueRows.set('failed_row', {
        id: 'failed_row', status: 'failed', attempts: 3,
        message: '{}', created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z', quarantined_at: null,
        last_error: 'timeout', priority: 0,
      });

      await expect(discardQuarantined('failed_row')).rejects.toThrow(
        "discardQuarantined: no quarantined message with id 'failed_row'"
      );
    });

    it('issues DELETE with WHERE id = ? AND status = quarantined predicate', async () => {
      mockQueueRows.set('q_del', makeQuarantinedRow('q_del', '2026-04-01T00:00:00.000Z'));

      await discardQuarantined('q_del');

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining("status = 'quarantined'"),
        ['q_del']
      );
    });

    it('does not delete other quarantined rows', async () => {
      mockQueueRows.set('del_target', makeQuarantinedRow('del_target', '2026-04-01T00:00:00.000Z'));
      mockQueueRows.set('keep_me', makeQuarantinedRow('keep_me', '2026-04-01T01:00:00.000Z'));

      await discardQuarantined('del_target');

      expect(mockQueueRows.has('del_target')).toBe(false);
      expect(mockQueueRows.has('keep_me')).toBe(true);
    });
  });

  // ==========================================================================
  // discardAllQuarantined()
  // ==========================================================================

  describe('discardAllQuarantined()', () => {
    it('returns 0 when no quarantined messages exist', async () => {
      const count = await discardAllQuarantined();
      expect(count).toBe(0);
    });

    it('deletes all quarantined rows and returns the count', async () => {
      mockQueueRows.set('qa', makeQuarantinedRow('qa', '2026-04-01T00:00:00.000Z'));
      mockQueueRows.set('qb', makeQuarantinedRow('qb', '2026-04-01T01:00:00.000Z'));
      mockQueueRows.set('qc', makeQuarantinedRow('qc', '2026-04-01T02:00:00.000Z'));

      const count = await discardAllQuarantined();

      expect(count).toBe(3);
      expect(mockQueueRows.size).toBe(0);
    });

    it('does not delete non-quarantined rows', async () => {
      mockQueueRows.set('qa', makeQuarantinedRow('qa', '2026-04-01T00:00:00.000Z'));
      mockQueueRows.set('pending_1', {
        id: 'pending_1', status: 'pending', attempts: 1,
        message: '{}', created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T01:00:00.000Z', quarantined_at: null,
        last_error: null, priority: 0,
      });

      await discardAllQuarantined();

      expect(mockQueueRows.has('qa')).toBe(false);
      expect(mockQueueRows.has('pending_1')).toBe(true);
    });

    it('issues a single DELETE statement (not one per row)', async () => {
      mockQueueRows.set('bulk_1', makeQuarantinedRow('bulk_1', '2026-04-01T00:00:00.000Z'));
      mockQueueRows.set('bulk_2', makeQuarantinedRow('bulk_2', '2026-04-01T01:00:00.000Z'));

      await discardAllQuarantined();

      // Should issue exactly one DELETE call, not one per row
      const deleteCalls = mockRunAsync.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('DELETE')
      );
      expect(deleteCalls).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Database initialization
  // ==========================================================================

  describe('database initialization', () => {
    it('opens the same DB as offline-queue (styrby_offline_queue.db)', async () => {
      await getQuarantinedCount();
      expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('styrby_offline_queue.db');
    });

    it('creates command_queue table and quarantine index on first use', async () => {
      await getQuarantinedCount();
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS command_queue')
      );
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining("idx_queue_quarantined")
      );
    });

    it('does not re-open the database after first call (singleton)', async () => {
      await getQuarantinedCount();
      await getQuarantinedCount();
      // openDatabaseAsync should be called only once per reset cycle
      expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
    });
  });
});
