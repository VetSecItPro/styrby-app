/**
 * Offline Sync Service Test Suite
 *
 * Tests the connectivity-aware sync service that pushes locally stored
 * commands to the Supabase offline_command_queue table, covering:
 * - syncPendingCommands() with authenticated/unauthenticated users
 * - Single command insertion to Supabase
 * - Partial failure handling (one command fails, others succeed)
 * - Concurrent sync prevention (isSyncing guard)
 * - Connectivity listener lifecycle (start, stop, duplicate prevention)
 * - Network state transitions (offline->online triggers sync)
 * - Cleanup of synced records after successful sync
 */

// ============================================================================
// Types (imported before mocks so generics can reference them)
// ============================================================================

import type { StoredCommand } from '../offline-storage';

// ============================================================================
// Mock offline-storage
// ============================================================================

const mockGetPendingCommands = jest.fn<Promise<StoredCommand[]>, unknown[]>(async () => []);
const mockMarkSynced = jest.fn(async () => {});
const mockClearSynced = jest.fn(async () => 0);

jest.mock('../offline-storage', () => ({
  getPendingCommands: (...args: unknown[]) => mockGetPendingCommands(...(args as [])),
  markSynced: (...args: unknown[]) => mockMarkSynced(...(args as [])),
  clearSynced: (...args: unknown[]) => mockClearSynced(...(args as [])),
}));

// ============================================================================
// Mock Supabase
// ============================================================================

let mockInsertError: { message: string } | null = null;
let mockAuthUser: { id: string } | null = { id: 'test-user-id' };
let mockAuthError: { message: string } | null = null;

jest.mock('../../lib/supabase', () => {
  const createChain = () => {
    const chain: Record<string, jest.Mock | ((resolve: (v: unknown) => void) => Promise<unknown>)> = {
      insert: jest.fn().mockReturnThis(),
    };
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve({ error: mockInsertError }).then(resolve);
    return chain;
  };

  return {
    supabase: {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: mockAuthUser },
          error: mockAuthError,
        })),
      },
      from: jest.fn(() => createChain()),
    },
  };
});

// ============================================================================
// Mock NetInfo
// ============================================================================

import NetInfo from '@react-native-community/netinfo';

// ============================================================================
// Import Supabase mock for assertions
// ============================================================================

import { supabase } from '../../lib/supabase';

// ============================================================================
// Import module under test AFTER mocks
// ============================================================================

// WHY isolateModules: The sync service has module-level state (isSyncing,
// unsubscribeNetInfo). We need fresh imports for tests that check these.
// For most tests we use the direct import and reset state manually.

import {
  syncPendingCommands,
  startConnectivityListener,
  stopConnectivityListener,
} from '../offline-sync';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock StoredCommand for testing.
 */
function createStoredCommand(overrides: Partial<StoredCommand> = {}): StoredCommand {
  return {
    id: overrides.id ?? `cmd_${crypto.randomUUID()}`,
    command_type: overrides.command_type ?? 'chat',
    payload: overrides.payload ?? '{"content":"test"}',
    created_at: overrides.created_at ?? new Date().toISOString(),
    synced: overrides.synced ?? false,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Offline Sync Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mutable mock state
    mockInsertError = null;
    mockAuthUser = { id: 'test-user-id' };
    mockAuthError = null;
    mockGetPendingCommands.mockReset();
    mockGetPendingCommands.mockResolvedValue([]);
    mockMarkSynced.mockReset();
    mockMarkSynced.mockResolvedValue(undefined);
    mockClearSynced.mockReset();
    mockClearSynced.mockResolvedValue(0);

    // Restore supabase.from to use the factory mock (may have been overridden)
    (supabase.from as jest.Mock).mockImplementation(() => {
      const chain: Record<string, unknown> = {
        insert: jest.fn().mockReturnThis(),
      };
      chain.then = (resolve: (v: unknown) => void) =>
        Promise.resolve({ error: mockInsertError }).then(resolve);
      return chain;
    });
    (supabase.auth.getUser as jest.Mock).mockImplementation(async () => ({
      data: { user: mockAuthUser },
      error: mockAuthError,
    }));

    // Ensure connectivity listener is stopped between tests
    stopConnectivityListener();
  });

  // ==========================================================================
  // syncPendingCommands()
  // ==========================================================================

  describe('syncPendingCommands()', () => {
    it('returns 0 when no pending commands exist', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      const result = await syncPendingCommands();

      expect(result).toBe(0);
      expect(mockGetPendingCommands).toHaveBeenCalled();
    });

    it('returns 0 when no authenticated user', async () => {
      mockAuthUser = null;
      mockGetPendingCommands.mockResolvedValue([createStoredCommand()]);

      const result = await syncPendingCommands();

      expect(result).toBe(0);
      expect(supabase.auth.getUser).toHaveBeenCalled();
    });

    it('returns 0 when auth returns an error', async () => {
      mockAuthError = { message: 'Auth session expired' };
      mockGetPendingCommands.mockResolvedValue([createStoredCommand()]);

      const result = await syncPendingCommands();

      expect(result).toBe(0);
    });

    it('syncs a single pending command to Supabase', async () => {
      const command = createStoredCommand({
        id: 'cmd_single',
        command_type: 'chat',
        payload: '{"content":"hello"}',
        created_at: '2026-03-15T10:00:00.000Z',
      });
      mockGetPendingCommands.mockResolvedValue([command]);

      const result = await syncPendingCommands();

      expect(result).toBe(1);
      expect(supabase.from).toHaveBeenCalledWith('offline_command_queue');
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_single');
    });

    it('syncs multiple pending commands', async () => {
      const commands = [
        createStoredCommand({ id: 'cmd_1' }),
        createStoredCommand({ id: 'cmd_2' }),
        createStoredCommand({ id: 'cmd_3' }),
      ];
      mockGetPendingCommands.mockResolvedValue(commands);

      const result = await syncPendingCommands();

      expect(result).toBe(3);
      expect(mockMarkSynced).toHaveBeenCalledTimes(3);
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_1');
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_2');
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_3');
    });

    it('calls clearSynced after successful sync', async () => {
      mockGetPendingCommands.mockResolvedValue([createStoredCommand()]);

      await syncPendingCommands();

      expect(mockClearSynced).toHaveBeenCalled();
    });

    it('does not call clearSynced when no commands were synced', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      await syncPendingCommands();

      expect(mockClearSynced).not.toHaveBeenCalled();
    });

    it('inserts with correct Supabase schema fields', async () => {
      const command = createStoredCommand({
        id: 'cmd_schema',
        payload: '{"action":"test"}',
        created_at: '2026-03-15T12:00:00.000Z',
      });
      mockGetPendingCommands.mockResolvedValue([command]);

      await syncPendingCommands();

      // Verify from() was called with the correct table
      expect(supabase.from).toHaveBeenCalledWith('offline_command_queue');

      // Verify insert was called (via the chain mock)
      const fromMock = supabase.from as jest.Mock;
      const chain = fromMock.mock.results[0].value;
      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'test-user-id',
          machine_id: 'test-user-id',
          command_encrypted: '{"action":"test"}',
          encryption_nonce: 'pending',
          status: 'pending',
          created_at: '2026-03-15T12:00:00.000Z',
        })
      );
    });

    it('uses Date.parse for queue_order field', async () => {
      const timestamp = '2026-03-15T12:00:00.000Z';
      const command = createStoredCommand({ created_at: timestamp });
      mockGetPendingCommands.mockResolvedValue([command]);

      await syncPendingCommands();

      const fromMock = supabase.from as jest.Mock;
      const chain = fromMock.mock.results[0].value;
      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          queue_order: Date.parse(timestamp),
        })
      );
    });

    it('continues syncing remaining commands when one fails', async () => {
      const commands = [
        createStoredCommand({ id: 'cmd_ok_1' }),
        createStoredCommand({ id: 'cmd_fail' }),
        createStoredCommand({ id: 'cmd_ok_2' }),
      ];
      mockGetPendingCommands.mockResolvedValue(commands);

      // Make the second insert fail
      let callCount = 0;
      (supabase.from as jest.Mock).mockImplementation(() => {
        callCount++;
        const chain: Record<string, unknown> = {
          insert: jest.fn().mockReturnThis(),
        };
        if (callCount === 2) {
          chain.then = (resolve: (v: unknown) => void) =>
            Promise.resolve({ error: { message: 'Duplicate key' } }).then(resolve);
        } else {
          chain.then = (resolve: (v: unknown) => void) =>
            Promise.resolve({ error: null }).then(resolve);
        }
        return chain;
      });

      const result = await syncPendingCommands();

      // 2 succeeded, 1 failed
      expect(result).toBe(2);
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_ok_1');
      expect(mockMarkSynced).not.toHaveBeenCalledWith('cmd_fail');
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_ok_2');
    });

    it('handles Supabase insert error by throwing inside syncSingleCommand', async () => {
      mockInsertError = { message: 'Table not found' };
      mockGetPendingCommands.mockResolvedValue([createStoredCommand({ id: 'cmd_err' })]);

      const result = await syncPendingCommands();

      // Should not crash, just skip the failed command
      expect(result).toBe(0);
      expect(mockMarkSynced).not.toHaveBeenCalled();
    });

    it('prevents concurrent sync calls (isSyncing guard)', async () => {
      // WHY: The module-level isSyncing flag prevents double-syncing.
      // We test this by making getPendingCommands slow enough to trigger overlap.
      let resolveFirst: (() => void) | null = null;
      const slowPending = new Promise<StoredCommand[]>((resolve) => {
        resolveFirst = () => resolve([createStoredCommand({ id: 'slow' })]);
      });

      mockGetPendingCommands.mockReturnValueOnce(slowPending as unknown as ReturnType<typeof mockGetPendingCommands>);

      // Start first sync (will block on getPendingCommands)
      const sync1 = syncPendingCommands();

      // Start second sync immediately — should be skipped
      const sync2 = syncPendingCommands();

      // Second call should return 0 immediately because isSyncing is true
      const result2 = await sync2;
      expect(result2).toBe(0);

      // Now resolve the first sync
      resolveFirst!();
      const result1 = await sync1;
      expect(result1).toBe(1);
    });

    it('resets isSyncing flag even when an error occurs', async () => {
      mockGetPendingCommands.mockRejectedValueOnce(new Error('DB error'));

      const result = await syncPendingCommands();
      expect(result).toBe(0);

      // Should be able to sync again (isSyncing was reset)
      mockGetPendingCommands.mockResolvedValue([]);
      const result2 = await syncPendingCommands();
      expect(result2).toBe(0);
      // If isSyncing was still true, the second call would return 0
      // without calling getPendingCommands. Verify it was called.
      expect(mockGetPendingCommands).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // startConnectivityListener()
  // ==========================================================================

  describe('startConnectivityListener()', () => {
    it('registers a NetInfo event listener', () => {
      startConnectivityListener();

      expect(NetInfo.addEventListener).toHaveBeenCalledWith(expect.any(Function));
    });

    it('returns an unsubscribe function', () => {
      const unsub = startConnectivityListener();

      expect(typeof unsub).toBe('function');
    });

    it('triggers an initial sync on start', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      startConnectivityListener();

      // Wait for the async initial sync to complete
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockGetPendingCommands).toHaveBeenCalled();
    });

    it('returns existing unsubscribe and does not register a new listener on duplicate call', () => {
      startConnectivityListener();
      startConnectivityListener();

      // addEventListener should only have been called once (no duplicate listener)
      expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
    });

    it('triggers sync when transitioning from offline to online', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      startConnectivityListener();

      // Get the callback registered with NetInfo
      const addListenerMock = NetInfo.addEventListener as jest.Mock;
      const callback = addListenerMock.mock.calls[0][0];

      // Simulate offline state
      callback({ isConnected: false, isInternetReachable: false });

      // Wait for any async operations
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.clearAllMocks();

      // Simulate coming back online
      callback({ isConnected: true, isInternetReachable: true });

      // Wait for sync to be triggered
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockGetPendingCommands).toHaveBeenCalled();
    });

    it('does not sync when remaining online (no transition)', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      // Capture the callback before starting
      const addListenerMock = NetInfo.addEventListener as jest.Mock;
      startConnectivityListener();
      const callback = addListenerMock.mock.calls[0][0];

      // Wait for initial sync
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.clearAllMocks();

      // Simulate staying online
      callback({ isConnected: true, isInternetReachable: true });

      // Wait for any async ops
      await new Promise<void>((resolve) => setImmediate(resolve));

      // No sync should have been triggered (wasConnected was true)
      expect(mockGetPendingCommands).not.toHaveBeenCalled();
    });

    it('does not sync when going offline', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      // Capture the callback before starting
      const addListenerMock = NetInfo.addEventListener as jest.Mock;
      startConnectivityListener();
      const callback = addListenerMock.mock.calls[0][0];

      // Wait for initial sync
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.clearAllMocks();

      // Go offline
      callback({ isConnected: false, isInternetReachable: false });

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockGetPendingCommands).not.toHaveBeenCalled();
    });

    it('treats isInternetReachable=null as connected (not definitively offline)', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      const addListenerMock = NetInfo.addEventListener as jest.Mock;
      startConnectivityListener();
      const callback = addListenerMock.mock.calls[0][0];

      // Go offline first
      callback({ isConnected: false, isInternetReachable: false });

      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.clearAllMocks();

      // Come back with isInternetReachable = null (common on Android)
      callback({ isConnected: true, isInternetReachable: null });

      await new Promise<void>((resolve) => setImmediate(resolve));

      // Should have triggered sync because isInternetReachable !== false
      expect(mockGetPendingCommands).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // stopConnectivityListener()
  // ==========================================================================

  describe('stopConnectivityListener()', () => {
    it('is safe to call when no listener is active', () => {
      expect(() => stopConnectivityListener()).not.toThrow();
    });

    it('calls the NetInfo unsubscribe function', () => {
      const mockUnsub = jest.fn();
      (NetInfo.addEventListener as jest.Mock).mockReturnValueOnce(mockUnsub);

      startConnectivityListener();
      stopConnectivityListener();

      expect(mockUnsub).toHaveBeenCalled();
    });

    it('allows starting a new listener after stopping', () => {
      const mockUnsub1 = jest.fn();
      const mockUnsub2 = jest.fn();
      (NetInfo.addEventListener as jest.Mock)
        .mockReturnValueOnce(mockUnsub1)
        .mockReturnValueOnce(mockUnsub2);

      startConnectivityListener();
      stopConnectivityListener();

      // Should be able to start a new listener
      startConnectivityListener();

      expect(NetInfo.addEventListener).toHaveBeenCalledTimes(2);
    });

    it('calling the returned unsubscribe from start also stops the listener', () => {
      const mockUnsub = jest.fn();
      (NetInfo.addEventListener as jest.Mock).mockReturnValueOnce(mockUnsub);

      const unsub = startConnectivityListener();
      unsub();

      expect(mockUnsub).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Logger (dev-only)
  // ==========================================================================

  describe('logger behavior', () => {
    it('logs sync activity in __DEV__ mode', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockGetPendingCommands.mockResolvedValue([]);

      await syncPendingCommands();

      // In __DEV__ mode, should log "No pending commands to sync"
      expect(consoleSpy).toHaveBeenCalledWith(
        '[OfflineSync]',
        'No pending commands to sync'
      );

      consoleSpy.mockRestore();
    });

    it('logs warning when no authenticated user', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockAuthUser = null;
      mockGetPendingCommands.mockResolvedValue([createStoredCommand()]);

      await syncPendingCommands();

      expect(warnSpy).toHaveBeenCalledWith(
        '[OfflineSync]',
        'No authenticated user, deferring sync'
      );

      warnSpy.mockRestore();
    });

    it('logs error when sync fails', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockGetPendingCommands.mockRejectedValueOnce(new Error('SQLite error'));

      await syncPendingCommands();

      expect(errorSpy).toHaveBeenCalledWith(
        '[OfflineSync]',
        'Sync failed:',
        expect.any(Error)
      );

      errorSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('handles empty pending array gracefully', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      const result = await syncPendingCommands();

      expect(result).toBe(0);
      expect(supabase.from).not.toHaveBeenCalled();
      expect(mockClearSynced).not.toHaveBeenCalled();
    });

    it('handles all commands failing without crashing', async () => {
      const commands = [
        createStoredCommand({ id: 'fail_1' }),
        createStoredCommand({ id: 'fail_2' }),
      ];
      mockGetPendingCommands.mockResolvedValue(commands);
      mockInsertError = { message: 'All fail' };

      const result = await syncPendingCommands();

      expect(result).toBe(0);
      expect(mockMarkSynced).not.toHaveBeenCalled();
      expect(mockClearSynced).not.toHaveBeenCalled();
    });

    it('uses user_id as machine_id fallback for the insert', async () => {
      const command = createStoredCommand();
      mockGetPendingCommands.mockResolvedValue([command]);

      await syncPendingCommands();

      const fromMock = supabase.from as jest.Mock;
      const chain = fromMock.mock.results[0].value;
      expect(chain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          machine_id: 'test-user-id',
        })
      );
    });
  });

  // ==========================================================================
  // GAP-FILL: additional uncovered branches
  // ==========================================================================

  describe('syncPendingCommands() — clearSynced not called when all inserts fail', () => {
    it('does not call clearSynced when every command fails to insert', async () => {
      mockGetPendingCommands.mockResolvedValueOnce([
        createStoredCommand({ id: 'gap_f1' }),
        createStoredCommand({ id: 'gap_f2' }),
      ]);

      // All Supabase inserts return an error
      let callCount = 0;
      (supabase.from as jest.Mock).mockImplementation(() => {
        callCount++;
        const chain: Record<string, unknown> = {
          insert: jest.fn().mockReturnThis(),
        };
        chain.then = (resolve: (v: unknown) => void) =>
          Promise.resolve({ error: { message: 'Constraint violation' } }).then(resolve);
        return chain;
      });

      const result = await syncPendingCommands();

      expect(result).toBe(0);
      expect(mockClearSynced).not.toHaveBeenCalled();
    });
  });

  describe('syncPendingCommands() — null user with null error defers sync', () => {
    it('returns 0 when auth.getUser returns null user and null error', async () => {
      // WHY: If the session is missing but no error is returned (e.g. anonymous
      // or expired session), we should still defer sync rather than crash.
      mockGetPendingCommands.mockResolvedValueOnce([
        createStoredCommand({ id: 'gap_nouser' }),
      ]);

      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: null,
      });

      const result = await syncPendingCommands();

      expect(result).toBe(0);
      expect(supabase.from).not.toHaveBeenCalled();
    });
  });
});
