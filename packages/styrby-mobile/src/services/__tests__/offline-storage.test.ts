/**
 * Offline Storage Service Test Suite
 *
 * Tests the SQLite-based offline storage adapter, covering:
 * - Saving commands with auto-generated and custom IDs
 * - Retrieving pending (unsynced) commands in chronological order
 * - Marking commands as synced
 * - Clearing synced commands from local storage
 * - Data integrity (saved data matches retrieved data)
 * - Edge cases: empty storage, duplicate IDs, payload serialization
 */

import * as SQLite from 'expo-sqlite';

// ============================================================================
// SQLite Mock Setup
// ============================================================================

/**
 * In-memory store simulating the offline_storage SQLite table.
 * Each key is the command ID, value is the full row.
 */
const mockStorageRows: Map<string, Record<string, unknown>> = new Map();

/** Track SQL calls for assertions */
let sqlCalls: { sql: string; params: unknown[] }[] = [];

const mockRunAsync = jest.fn(async (sql: string, params: unknown[] = []) => {
  sqlCalls.push({ sql, params });

  if (sql.includes('INSERT INTO offline_storage')) {
    mockStorageRows.set(params[0] as string, {
      id: params[0],
      command_type: params[1],
      payload: params[2],
      created_at: params[3],
      synced: params[4],
    });
    return { changes: 1 };
  }

  if (sql.includes('UPDATE offline_storage SET synced = 1')) {
    const id = params[0] as string;
    const row = mockStorageRows.get(id);
    if (row) {
      row.synced = 1;
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  if (sql.includes('DELETE FROM offline_storage WHERE synced = 1')) {
    let deleted = 0;
    for (const [id, row] of mockStorageRows) {
      if (row.synced === 1) {
        mockStorageRows.delete(id);
        deleted++;
      }
    }
    return { changes: deleted };
  }

  return { changes: 0 };
});

const mockGetAllAsync = jest.fn(async (sql: string) => {
  sqlCalls.push({ sql, params: [] });

  if (sql.includes('WHERE synced = 0')) {
    const results: Record<string, unknown>[] = [];
    for (const row of mockStorageRows.values()) {
      if (row.synced === 0) {
        results.push({ ...row });
      }
    }
    // Sort by created_at ASC
    results.sort((a, b) =>
      (a.created_at as string).localeCompare(b.created_at as string)
    );
    return results;
  }

  return [];
});

const mockExecAsync = jest.fn(async () => {});

const mockDb = {
  execAsync: mockExecAsync,
  runAsync: mockRunAsync,
  getFirstAsync: jest.fn(async () => null),
  getAllAsync: mockGetAllAsync,
};

// Override the global expo-sqlite mock with our implementation
(SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

// ============================================================================
// Mock crypto.randomUUID
// ============================================================================

let uuidCounter = 0;
jest.spyOn(crypto, 'randomUUID').mockImplementation(() => {
  uuidCounter++;
  return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`;
});

// ============================================================================
// Import module under test AFTER mocks
// ============================================================================

import {
  saveCommand,
  getPendingCommands,
  markSynced,
  clearSynced,
  type SaveCommandInput,
} from '../offline-storage';

// ============================================================================
// Test Suite
// ============================================================================

describe('Offline Storage Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorageRows.clear();
    sqlCalls = [];
    uuidCounter = 0;
    // Re-apply mock db
    (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);
  });

  // ==========================================================================
  // Database Initialization
  // ==========================================================================

  describe('database initialization', () => {
    it('creates the database and storage table on first operation', async () => {
      await saveCommand({ command_type: 'chat', payload: { content: 'init' } });

      expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('styrby_offline_storage.db');
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS offline_storage')
      );
    });

    it('does not re-initialize on subsequent operations (singleton db)', async () => {
      // WHY: The module-level `db` variable is set after the first init.
      // Subsequent calls skip initDatabase() entirely.
      mockExecAsync.mockClear();

      await saveCommand({ command_type: 'chat', payload: { content: 'no-reinit' } });

      // execAsync should NOT be called again since db is already initialized
      expect(mockExecAsync).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // saveCommand()
  // ==========================================================================

  describe('saveCommand()', () => {
    it('saves a command with auto-generated ID and timestamp', async () => {
      const input: SaveCommandInput = {
        command_type: 'chat',
        payload: { content: 'hello', agent: 'claude' },
      };

      const result = await saveCommand(input);

      expect(result.id).toBeDefined();
      expect(result.command_type).toBe('chat');
      expect(result.payload).toBe(JSON.stringify({ content: 'hello', agent: 'claude' }));
      expect(result.created_at).toBeDefined();
      expect(result.synced).toBe(false);
    });

    it('uses provided custom ID when supplied', async () => {
      const input: SaveCommandInput = {
        id: 'custom-id-123',
        command_type: 'cancel',
        payload: { action: 'cancel' },
      };

      const result = await saveCommand(input);

      expect(result.id).toBe('custom-id-123');
    });

    it('uses provided custom timestamp when supplied', async () => {
      const customTimestamp = '2026-01-15T12:00:00.000Z';
      const input: SaveCommandInput = {
        command_type: 'chat',
        payload: { content: 'with-timestamp' },
        created_at: customTimestamp,
      };

      const result = await saveCommand(input);

      expect(result.created_at).toBe(customTimestamp);
    });

    it('JSON-serializes the payload object', async () => {
      const complexPayload = {
        content: 'test',
        nested: { key: 'value', arr: [1, 2, 3] },
        unicode: 'Hello \u00e9\u00e8\u00ea',
      };

      const result = await saveCommand({
        command_type: 'chat',
        payload: complexPayload,
      });

      expect(result.payload).toBe(JSON.stringify(complexPayload));
    });

    it('stores synced as false (0) in the database', async () => {
      await saveCommand({
        command_type: 'chat',
        payload: { content: 'sync-check' },
      });

      const insertCall = mockRunAsync.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT')
      );
      expect(insertCall).toBeDefined();
      // synced is the 5th param (index 4)
      expect((insertCall![1] as unknown[])[4]).toBe(0);
    });

    it('inserts into the correct table with correct column order', async () => {
      await saveCommand({
        command_type: 'permission_response',
        payload: { request_id: 'req_1', approved: true },
      });

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO offline_storage'),
        expect.arrayContaining([
          expect.any(String), // id
          'permission_response', // command_type
          expect.any(String), // payload (JSON)
          expect.any(String), // created_at
          0, // synced
        ])
      );
    });

    it('returns a proper StoredCommand object', async () => {
      const result = await saveCommand({
        command_type: 'chat',
        payload: { content: 'typed' },
      });

      // Verify all StoredCommand properties exist
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('command_type');
      expect(result).toHaveProperty('payload');
      expect(result).toHaveProperty('created_at');
      expect(result).toHaveProperty('synced');
    });

    it('saves an empty payload object', async () => {
      const result = await saveCommand({
        command_type: 'ping',
        payload: {},
      });

      expect(result.payload).toBe('{}');
    });
  });

  // ==========================================================================
  // getPendingCommands()
  // ==========================================================================

  describe('getPendingCommands()', () => {
    it('returns empty array when no commands exist', async () => {
      const result = await getPendingCommands();
      expect(result).toEqual([]);
    });

    it('returns only unsynced commands', async () => {
      // Add one synced and one unsynced
      mockStorageRows.set('synced_1', {
        id: 'synced_1',
        command_type: 'chat',
        payload: '{"content":"synced"}',
        created_at: '2026-01-01T00:00:00.000Z',
        synced: 1,
      });
      mockStorageRows.set('pending_1', {
        id: 'pending_1',
        command_type: 'chat',
        payload: '{"content":"pending"}',
        created_at: '2026-01-01T00:00:01.000Z',
        synced: 0,
      });

      const result = await getPendingCommands();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('pending_1');
      expect(result[0].synced).toBe(false);
    });

    it('returns commands ordered by created_at ascending (oldest first)', async () => {
      mockStorageRows.set('newer', {
        id: 'newer',
        command_type: 'chat',
        payload: '{"content":"newer"}',
        created_at: '2026-01-02T00:00:00.000Z',
        synced: 0,
      });
      mockStorageRows.set('older', {
        id: 'older',
        command_type: 'chat',
        payload: '{"content":"older"}',
        created_at: '2026-01-01T00:00:00.000Z',
        synced: 0,
      });

      const result = await getPendingCommands();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('older');
      expect(result[1].id).toBe('newer');
    });

    it('converts synced integer to boolean', async () => {
      mockStorageRows.set('bool_check', {
        id: 'bool_check',
        command_type: 'chat',
        payload: '{"content":"check"}',
        created_at: '2026-01-01T00:00:00.000Z',
        synced: 0,
      });

      const result = await getPendingCommands();

      expect(result[0].synced).toBe(false);
      expect(typeof result[0].synced).toBe('boolean');
    });

    it('preserves payload as string (not re-parsed)', async () => {
      const payloadStr = '{"content":"preserve","nested":{"a":1}}';
      mockStorageRows.set('payload_check', {
        id: 'payload_check',
        command_type: 'chat',
        payload: payloadStr,
        created_at: '2026-01-01T00:00:00.000Z',
        synced: 0,
      });

      const result = await getPendingCommands();

      expect(result[0].payload).toBe(payloadStr);
    });

    it('returns multiple pending commands in correct order', async () => {
      for (let i = 0; i < 5; i++) {
        mockStorageRows.set(`cmd_${i}`, {
          id: `cmd_${i}`,
          command_type: 'chat',
          payload: `{"index":${i}}`,
          created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
          synced: 0,
        });
      }

      const result = await getPendingCommands();

      expect(result).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(result[i].id).toBe(`cmd_${i}`);
      }
    });
  });

  // ==========================================================================
  // markSynced()
  // ==========================================================================

  describe('markSynced()', () => {
    it('sets synced = 1 for the specified command', async () => {
      mockStorageRows.set('to_sync', {
        id: 'to_sync',
        command_type: 'chat',
        payload: '{}',
        created_at: '2026-01-01T00:00:00.000Z',
        synced: 0,
      });

      await markSynced('to_sync');

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE offline_storage SET synced = 1'),
        ['to_sync']
      );
      expect(mockStorageRows.get('to_sync')!.synced).toBe(1);
    });

    it('is a no-op for nonexistent IDs (does not throw)', async () => {
      await expect(markSynced('nonexistent')).resolves.toBeUndefined();
    });

    it('only marks the specified command, not others', async () => {
      mockStorageRows.set('mark_a', {
        id: 'mark_a', command_type: 'chat', payload: '{}',
        created_at: '2026-01-01T00:00:00.000Z', synced: 0,
      });
      mockStorageRows.set('mark_b', {
        id: 'mark_b', command_type: 'chat', payload: '{}',
        created_at: '2026-01-01T00:00:01.000Z', synced: 0,
      });

      await markSynced('mark_a');

      expect(mockStorageRows.get('mark_a')!.synced).toBe(1);
      expect(mockStorageRows.get('mark_b')!.synced).toBe(0);
    });
  });

  // ==========================================================================
  // clearSynced()
  // ==========================================================================

  describe('clearSynced()', () => {
    it('returns 0 when no synced commands exist', async () => {
      const result = await clearSynced();
      expect(result).toBe(0);
    });

    it('deletes synced commands and returns the count', async () => {
      mockStorageRows.set('synced_a', {
        id: 'synced_a', command_type: 'chat', payload: '{}',
        created_at: '2026-01-01T00:00:00.000Z', synced: 1,
      });
      mockStorageRows.set('synced_b', {
        id: 'synced_b', command_type: 'chat', payload: '{}',
        created_at: '2026-01-01T00:00:01.000Z', synced: 1,
      });
      mockStorageRows.set('pending_c', {
        id: 'pending_c', command_type: 'chat', payload: '{}',
        created_at: '2026-01-01T00:00:02.000Z', synced: 0,
      });

      const result = await clearSynced();

      expect(result).toBe(2);
      expect(mockStorageRows.has('synced_a')).toBe(false);
      expect(mockStorageRows.has('synced_b')).toBe(false);
      expect(mockStorageRows.has('pending_c')).toBe(true);
    });

    it('leaves pending commands untouched', async () => {
      mockStorageRows.set('only_pending', {
        id: 'only_pending', command_type: 'chat', payload: '{}',
        created_at: '2026-01-01T00:00:00.000Z', synced: 0,
      });

      await clearSynced();

      expect(mockStorageRows.has('only_pending')).toBe(true);
    });

    it('calls DELETE with synced = 1 condition', async () => {
      await clearSynced();

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM offline_storage WHERE synced = 1')
      );
    });
  });

  // ==========================================================================
  // Data Integrity (round-trip tests)
  // ==========================================================================

  describe('data integrity', () => {
    it('saved command can be retrieved via getPendingCommands', async () => {
      const input: SaveCommandInput = {
        id: 'round_trip',
        command_type: 'chat',
        payload: { content: 'round-trip test', nested: { key: 'value' } },
        created_at: '2026-03-15T10:30:00.000Z',
      };

      await saveCommand(input);

      const pending = await getPendingCommands();

      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('round_trip');
      expect(pending[0].command_type).toBe('chat');
      expect(pending[0].payload).toBe(JSON.stringify(input.payload));
      expect(pending[0].created_at).toBe('2026-03-15T10:30:00.000Z');
      expect(pending[0].synced).toBe(false);
    });

    it('marked-synced command no longer appears in pending', async () => {
      mockStorageRows.set('sync_test', {
        id: 'sync_test', command_type: 'chat', payload: '{}',
        created_at: '2026-01-01T00:00:00.000Z', synced: 0,
      });

      await markSynced('sync_test');

      const pending = await getPendingCommands();
      expect(pending).toHaveLength(0);
    });

    it('cleared synced commands are fully removed from storage', async () => {
      mockStorageRows.set('clear_test', {
        id: 'clear_test', command_type: 'chat', payload: '{}',
        created_at: '2026-01-01T00:00:00.000Z', synced: 1,
      });

      const deleted = await clearSynced();

      expect(deleted).toBe(1);
      expect(mockStorageRows.size).toBe(0);
    });

    it('handles multiple save-sync-clear cycles', async () => {
      // Save
      await saveCommand({ id: 'cycle_1', command_type: 'chat', payload: { n: 1 } });
      await saveCommand({ id: 'cycle_2', command_type: 'chat', payload: { n: 2 } });

      // Sync first one
      await markSynced('cycle_1');

      // Clear synced
      await clearSynced();

      // Only cycle_2 should remain
      expect(mockStorageRows.has('cycle_1')).toBe(false);
      expect(mockStorageRows.has('cycle_2')).toBe(true);

      // Pending should return only cycle_2
      const pending = await getPendingCommands();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('cycle_2');
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('handles special characters in payload', async () => {
      const result = await saveCommand({
        command_type: 'chat',
        payload: { content: 'Hello "world" & <test> \'quotes\'' },
      });

      expect(result.payload).toBe(
        JSON.stringify({ content: 'Hello "world" & <test> \'quotes\'' })
      );
    });

    it('handles very long payload strings', async () => {
      const longContent = 'x'.repeat(10000);
      const result = await saveCommand({
        command_type: 'chat',
        payload: { content: longContent },
      });

      const parsed = JSON.parse(result.payload);
      expect(parsed.content).toHaveLength(10000);
    });

    it('handles concurrent save operations without conflict', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        saveCommand({
          id: `concurrent_${i}`,
          command_type: 'chat',
          payload: { index: i },
        })
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      expect(mockStorageRows.size).toBe(10);
    });
  });

  // ==========================================================================
  // GAP-FILL: additional uncovered branches
  // ==========================================================================

  describe('saveCommand() — SQLite write failure', () => {
    it('propagates error when runAsync throws (e.g. SQLITE_FULL)', async () => {
      mockRunAsync.mockRejectedValueOnce(new Error('SQLITE_FULL'));

      await expect(
        saveCommand({ command_type: 'chat', payload: { content: 'fail-write' } })
      ).rejects.toThrow('SQLITE_FULL');
    });
  });

  describe('getPendingCommands() — SQLite read failure', () => {
    it('propagates error when getAllAsync throws (e.g. SQLITE_CORRUPT)', async () => {
      mockGetAllAsync.mockRejectedValueOnce(new Error('SQLITE_CORRUPT'));

      await expect(getPendingCommands()).rejects.toThrow('SQLITE_CORRUPT');
    });
  });
});
