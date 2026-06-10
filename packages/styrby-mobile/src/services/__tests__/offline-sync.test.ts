/**
 * Offline Sync Service Test Suite (Mobile)
 *
 * Mirrors the web offline-sync test (lib/__tests__/offline-sync.test.ts) and
 * guards the offline-sync parity fixes:
 *  - machine_id uses the command's REAL machine (was userId → FK violation)
 *  - session_id is carried through
 *  - queue_order = Date.parse(created_at) ms-epoch (BIGINT, migration 098)
 *  - upsert on `id` with ignoreDuplicates (idempotent re-sync)
 *  - chat commands are DELIVERED over the relay on reconnect; non-chat aren't
 *  - delivery is best-effort: relay unavailable → commands still persisted
 *
 * Plus the mobile-specific connectivity-listener lifecycle (NetInfo).
 *
 * @module services/__tests__/offline-sync
 */

// ============================================================================
// Types (imported before mocks so generics can reference them)
// ============================================================================

import type { StoredCommand } from '../offline-storage';

// ============================================================================
// Mock offline-storage
// ============================================================================

// WHY explicit return types: tests use mockResolvedValue with concrete
// payloads (StoredCommand[], number); without these generics the impl-inferred
// return narrows to never and rejects mockResolvedValue arguments at typecheck.
const mockGetPendingCommands = jest.fn<Promise<StoredCommand[]>, unknown[]>(async () => []);
const mockMarkSynced = jest.fn<Promise<void>, unknown[]>(async () => {});
const mockClearSynced = jest.fn<Promise<number>, unknown[]>(async () => 0);

jest.mock('../offline-storage', () => ({
  getPendingCommands: (...args: unknown[]) => mockGetPendingCommands(...(args as [])),
  markSynced: (...args: unknown[]) => mockMarkSynced(...(args as [])),
  clearSynced: (...args: unknown[]) => mockClearSynced(...(args as [])),
}));

// ============================================================================
// Mock styrby-shared (relay delivery)
// ============================================================================

let mockRelayThrows = false;
const mockConnect = jest.fn<Promise<void>, unknown[]>(async () => {});
const mockSendChat = jest.fn<Promise<void>, unknown[]>(async () => {});
const mockDisconnect = jest.fn<Promise<void>, unknown[]>(async () => {});

jest.mock('styrby-shared', () => ({
  createRelayClient: () => {
    if (mockRelayThrows) throw new Error('relay unavailable');
    return { connect: mockConnect, sendChat: mockSendChat, disconnect: mockDisconnect };
  },
}));

// ============================================================================
// Mock expo-secure-store (device id lookup for delivery relay)
// ============================================================================

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => 'mobile_test-device'),
  setItemAsync: jest.fn(async () => {}),
}));

// ============================================================================
// Mock Supabase
// ============================================================================

let mockUpsertError: { message: string } | null = null;
let mockAuthUser: { id: string } | null = { id: 'test-user-id' };
let mockAuthError: { message: string } | null = null;

jest.mock('../../lib/supabase', () => {
  const createChain = () => {
    const chain: Record<string, unknown> = {
      upsert: jest.fn().mockReturnThis(),
    };
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve({ error: mockUpsertError }).then(resolve);
    return chain;
  };

  return {
    supabase: {
      auth: {
        getUser: jest.fn<unknown, unknown[]>(async () => ({
          data: { user: mockAuthUser },
          error: mockAuthError,
        })),
      },
      from: jest.fn<unknown, unknown[]>(() => createChain()),
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

import {
  syncPendingCommands,
  startConnectivityListener,
  stopConnectivityListener,
} from '../offline-sync';

// ============================================================================
// Test Helpers
// ============================================================================

const CREATED_AT = '2026-06-10T00:00:00.000Z';

/**
 * Creates a mock StoredCommand for testing. Defaults to a deliverable chat
 * command targeting a REAL machine id (not the user id).
 */
function createStoredCommand(overrides: Partial<StoredCommand> = {}): StoredCommand {
  return {
    id: overrides.id ?? `cmd_${crypto.randomUUID()}`,
    command_type: overrides.command_type ?? 'chat',
    payload: overrides.payload ?? JSON.stringify({ content: 'hi there', agent: 'claude' }),
    machine_id: overrides.machine_id ?? 'machine-xyz',
    // WHY a property-presence check (not ??): an explicit `session_id: null`
    // override must survive — `null ?? 'sess-1'` would wrongly coerce to 'sess-1'.
    session_id: 'session_id' in overrides ? (overrides.session_id as string | null) : 'sess-1',
    created_at: overrides.created_at ?? CREATED_AT,
    synced: overrides.synced ?? false,
  };
}

/** Returns the upsert mock fn from the most recent supabase.from() call. */
function lastUpsert(): jest.Mock {
  const fromMock = supabase.from as jest.Mock;
  const chain = fromMock.mock.results[fromMock.mock.results.length - 1].value;
  return chain.upsert as jest.Mock;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Offline Sync Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mutable mock state
    mockUpsertError = null;
    mockAuthUser = { id: 'test-user-id' };
    mockAuthError = null;
    mockRelayThrows = false;
    mockGetPendingCommands.mockReset();
    mockGetPendingCommands.mockResolvedValue([]);
    mockMarkSynced.mockReset();
    mockMarkSynced.mockResolvedValue(undefined);
    mockClearSynced.mockReset();
    mockClearSynced.mockResolvedValue(0);
    mockConnect.mockResolvedValue(undefined);
    mockSendChat.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);

    // Restore supabase.from to use the factory mock (may have been overridden)
    (supabase.from as jest.Mock).mockImplementation(() => {
      const chain: Record<string, unknown> = {
        upsert: jest.fn().mockReturnThis(),
      };
      chain.then = (resolve: (v: unknown) => void) =>
        Promise.resolve({ error: mockUpsertError }).then(resolve);
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
  // syncPendingCommands() — upsert shape (mirrors web)
  // ==========================================================================

  describe('syncPendingCommands() — upsert', () => {
    it('upserts with the REAL machine_id (not userId), session_id, id-dedup, and ms queue_order', async () => {
      mockGetPendingCommands.mockResolvedValue([createStoredCommand({ id: 'c1' })]);

      const count = await syncPendingCommands();

      expect(count).toBe(1);
      expect(supabase.from).toHaveBeenCalledWith('offline_command_queue');
      const upsert = lastUpsert();
      expect(upsert).toHaveBeenCalledTimes(1);
      const [row, opts] = upsert.mock.calls[0];
      expect(row).toMatchObject({
        id: 'c1',
        user_id: 'test-user-id',
        machine_id: 'machine-xyz', // the FK fix — NOT 'test-user-id'
        session_id: 'sess-1',
        command_encrypted: JSON.stringify({ content: 'hi there', agent: 'claude' }),
        encryption_nonce: 'pending',
        queue_order: Date.parse(CREATED_AT), // 1.7e12 — only valid as BIGINT
        status: 'pending',
        created_at: CREATED_AT,
      });
      expect((row as { machine_id: string }).machine_id).not.toBe('test-user-id');
      expect(opts).toEqual({ onConflict: 'id', ignoreDuplicates: true });
      expect(mockMarkSynced).toHaveBeenCalledWith('c1');
      expect(mockClearSynced).toHaveBeenCalled();
    });

    it('carries a null session_id through to the upsert', async () => {
      mockGetPendingCommands.mockResolvedValue([
        createStoredCommand({ id: 'c-null', session_id: null }),
      ]);

      await syncPendingCommands();

      const [row] = lastUpsert().mock.calls[0];
      expect((row as { session_id: string | null }).session_id).toBeNull();
    });
  });

  // ==========================================================================
  // syncPendingCommands() — relay delivery (mirrors web)
  // ==========================================================================

  describe('syncPendingCommands() — delivery', () => {
    it('delivers chat commands over the relay (connect → sendChat → disconnect)', async () => {
      mockGetPendingCommands.mockResolvedValue([createStoredCommand()]);

      await syncPendingCommands();

      expect(mockConnect).toHaveBeenCalled();
      expect(mockSendChat).toHaveBeenCalledWith('hi there', 'claude', 'sess-1');
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('does NOT deliver non-chat commands over the relay (but still persists them)', async () => {
      mockGetPendingCommands.mockResolvedValue([
        createStoredCommand({
          id: 'c2',
          command_type: 'cancel',
          payload: JSON.stringify({ session_id: 'sess-1' }),
        }),
      ]);

      const count = await syncPendingCommands();

      expect(count).toBe(1);
      expect(lastUpsert()).toHaveBeenCalledTimes(1);
      expect(mockSendChat).not.toHaveBeenCalled();
    });

    it('still persists commands when the delivery relay is unavailable (best-effort)', async () => {
      mockRelayThrows = true;
      mockGetPendingCommands.mockResolvedValue([createStoredCommand({ id: 'c1' })]);

      const count = await syncPendingCommands();

      expect(count).toBe(1);
      expect(lastUpsert()).toHaveBeenCalledTimes(1);
      expect(mockSendChat).not.toHaveBeenCalled();
      expect(mockMarkSynced).toHaveBeenCalledWith('c1');
    });
  });

  // ==========================================================================
  // syncPendingCommands() — auth + empty (mirrors web)
  // ==========================================================================

  describe('syncPendingCommands() — guards', () => {
    it('returns 0 and does nothing when there are no pending commands', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      const count = await syncPendingCommands();

      expect(count).toBe(0);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('defers (returns 0) when there is no authenticated user', async () => {
      mockAuthUser = null;
      mockGetPendingCommands.mockResolvedValue([createStoredCommand()]);

      const count = await syncPendingCommands();

      expect(count).toBe(0);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('returns 0 when auth returns an error', async () => {
      mockAuthError = { message: 'Auth session expired' };
      mockGetPendingCommands.mockResolvedValue([createStoredCommand()]);

      const count = await syncPendingCommands();

      expect(count).toBe(0);
    });
  });

  // ==========================================================================
  // syncPendingCommands() — multi-command + partial failure
  // ==========================================================================

  describe('syncPendingCommands() — batch behavior', () => {
    it('syncs multiple pending commands', async () => {
      mockGetPendingCommands.mockResolvedValue([
        createStoredCommand({ id: 'cmd_1' }),
        createStoredCommand({ id: 'cmd_2' }),
        createStoredCommand({ id: 'cmd_3' }),
      ]);

      const result = await syncPendingCommands();

      expect(result).toBe(3);
      expect(mockMarkSynced).toHaveBeenCalledTimes(3);
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_1');
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_2');
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_3');
    });

    it('continues syncing remaining commands when one upsert fails', async () => {
      mockGetPendingCommands.mockResolvedValue([
        createStoredCommand({ id: 'cmd_ok_1' }),
        createStoredCommand({ id: 'cmd_fail' }),
        createStoredCommand({ id: 'cmd_ok_2' }),
      ]);

      // Make the second upsert fail
      let callCount = 0;
      (supabase.from as jest.Mock).mockImplementation(() => {
        callCount++;
        const chain: Record<string, unknown> = {
          upsert: jest.fn().mockReturnThis(),
        };
        const error = callCount === 2 ? { message: 'Duplicate key' } : null;
        chain.then = (resolve: (v: unknown) => void) =>
          Promise.resolve({ error }).then(resolve);
        return chain;
      });

      const result = await syncPendingCommands();

      expect(result).toBe(2);
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_ok_1');
      expect(mockMarkSynced).not.toHaveBeenCalledWith('cmd_fail');
      expect(mockMarkSynced).toHaveBeenCalledWith('cmd_ok_2');
    });

    it('does not call clearSynced when every command fails to upsert', async () => {
      mockGetPendingCommands.mockResolvedValue([
        createStoredCommand({ id: 'f1' }),
        createStoredCommand({ id: 'f2' }),
      ]);
      mockUpsertError = { message: 'Constraint violation' };

      const result = await syncPendingCommands();

      expect(result).toBe(0);
      expect(mockMarkSynced).not.toHaveBeenCalled();
      expect(mockClearSynced).not.toHaveBeenCalled();
    });

    it('disconnects the relay even when upserts fail', async () => {
      mockGetPendingCommands.mockResolvedValue([createStoredCommand({ id: 'f1' })]);
      mockUpsertError = { message: 'boom' };

      await syncPendingCommands();

      expect(mockDisconnect).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // syncPendingCommands() — concurrency + error resilience
  // ==========================================================================

  describe('syncPendingCommands() — resilience', () => {
    it('prevents concurrent sync calls (isSyncing guard)', async () => {
      let resolveFirst: (() => void) | null = null;
      const slowPending = new Promise<StoredCommand[]>((resolve) => {
        resolveFirst = () => resolve([createStoredCommand({ id: 'slow' })]);
      });

      mockGetPendingCommands.mockReturnValueOnce(
        slowPending as unknown as ReturnType<typeof mockGetPendingCommands>
      );

      const sync1 = syncPendingCommands();
      const sync2 = syncPendingCommands();

      const result2 = await sync2;
      expect(result2).toBe(0);

      resolveFirst!();
      const result1 = await sync1;
      expect(result1).toBe(1);
    });

    it('resets isSyncing flag even when an error occurs', async () => {
      mockGetPendingCommands.mockRejectedValueOnce(new Error('DB error'));

      const result = await syncPendingCommands();
      expect(result).toBe(0);

      mockGetPendingCommands.mockResolvedValue([]);
      const result2 = await syncPendingCommands();
      expect(result2).toBe(0);
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

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockGetPendingCommands).toHaveBeenCalled();
    });

    it('returns existing unsubscribe and does not register a new listener on duplicate call', () => {
      startConnectivityListener();
      startConnectivityListener();

      expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
    });

    it('triggers sync when transitioning from offline to online', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      startConnectivityListener();

      const addListenerMock = NetInfo.addEventListener as jest.Mock;
      const callback = addListenerMock.mock.calls[0][0];

      callback({ isConnected: false, isInternetReachable: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.clearAllMocks();

      callback({ isConnected: true, isInternetReachable: true });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockGetPendingCommands).toHaveBeenCalled();
    });

    it('does not sync when remaining online (no transition)', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      const addListenerMock = NetInfo.addEventListener as jest.Mock;
      startConnectivityListener();
      const callback = addListenerMock.mock.calls[0][0];

      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.clearAllMocks();

      callback({ isConnected: true, isInternetReachable: true });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockGetPendingCommands).not.toHaveBeenCalled();
    });

    it('does not sync when going offline', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      const addListenerMock = NetInfo.addEventListener as jest.Mock;
      startConnectivityListener();
      const callback = addListenerMock.mock.calls[0][0];

      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.clearAllMocks();

      callback({ isConnected: false, isInternetReachable: false });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(mockGetPendingCommands).not.toHaveBeenCalled();
    });

    it('treats isInternetReachable=null as connected (not definitively offline)', async () => {
      mockGetPendingCommands.mockResolvedValue([]);

      const addListenerMock = NetInfo.addEventListener as jest.Mock;
      startConnectivityListener();
      const callback = addListenerMock.mock.calls[0][0];

      callback({ isConnected: false, isInternetReachable: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.clearAllMocks();

      callback({ isConnected: true, isInternetReachable: null });
      await new Promise<void>((resolve) => setImmediate(resolve));

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
});
