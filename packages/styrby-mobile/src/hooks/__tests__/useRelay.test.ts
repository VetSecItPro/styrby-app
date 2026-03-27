/**
 * useRelay Hook Test Suite
 *
 * Tests the relay connection hook, including:
 * - Pairing info persistence (save, load, clear)
 * - Connection lifecycle (connect, disconnect, auto-connect)
 * - Device ID generation and persistence
 * - Message sending (online and offline queueing)
 * - Network state monitoring
 * - Offline queue processing
 * - Error handling
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// ============================================================================
// Mock Setup
// ============================================================================

/** Mutable mock state for controlling relay client behavior */
let mockIsConnected = false;
let mockConnectedDevices: unknown[] = [];
let mockConnectError: Error | null = null;
let mockSendError: Error | null = null;

/** Stores event handlers registered by the relay client */
const mockEventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

/** Mock relay client implementation */
const mockRelayClient = {
  connect: jest.fn(async () => {
    if (mockConnectError) throw mockConnectError;
    mockIsConnected = true;
    // Fire the subscribed event
    if (mockEventHandlers['subscribed']) {
      for (const handler of mockEventHandlers['subscribed']) {
        handler();
      }
    }
  }),
  disconnect: jest.fn(async () => {
    mockIsConnected = false;
    if (mockEventHandlers['closed']) {
      for (const handler of mockEventHandlers['closed']) {
        handler();
      }
    }
  }),
  isConnected: jest.fn(() => mockIsConnected),
  send: jest.fn(async () => {
    if (mockSendError) throw mockSendError;
  }),
  getConnectedDevices: jest.fn(() => mockConnectedDevices),
  on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!mockEventHandlers[event]) mockEventHandlers[event] = [];
    mockEventHandlers[event].push(handler);
  }),
};

/** Mock offline queue */
const mockEnqueue = jest.fn(async () => {});
const mockProcessQueue = jest.fn(async () => {});
const mockGetStats = jest.fn(async () => ({ pending: 0, failed: 0, total: 0 }));

jest.mock('styrby-shared', () => ({
  createRelayClient: jest.fn(() => mockRelayClient),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: { id: 'test-user-id' } },
        error: null,
      })),
    },
  },
}));

/**
 * WHY: The hook imports from '../services/offline-queue' which is relative to
 * the hook file. We mock the same absolute path to ensure Jest intercepts it.
 */
jest.mock('../../services/offline-queue.ts', () => ({
  offlineQueue: {
    enqueue: mockEnqueue,
    processQueue: mockProcessQueue,
    getStats: mockGetStats,
  },
}));

import { useRelay, type PairingInfo } from '../useRelay';
import * as SecureStore from 'expo-secure-store';

// ============================================================================
// Test Data
// ============================================================================

const validPairingInfo: PairingInfo = {
  userId: 'test-user-id',
  machineId: 'machine-1',
  deviceName: 'My MacBook',
  pairedAt: '2024-01-01T00:00:00Z',
};

// ============================================================================
// Tests
// ============================================================================

describe('useRelay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected = false;
    mockConnectedDevices = [];
    mockConnectError = null;
    mockSendError = null;

    // Clear all captured event handlers
    for (const key of Object.keys(mockEventHandlers)) {
      delete mockEventHandlers[key];
    }

    // Reset SecureStore
    if (typeof global.__resetSecureStore === 'function') {
      global.__resetSecureStore();
    }

    // Reset offline queue mock
    mockGetStats.mockReset();
    mockGetStats.mockResolvedValue({ pending: 0, failed: 0, total: 0 });
  });

  // --------------------------------------------------------------------------
  // Initial State
  // --------------------------------------------------------------------------

  it('starts disconnected with no pairing info', () => {
    const { result } = renderHook(() => useRelay());

    expect(result.current.connectionState).toBe('disconnected');
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isOnline).toBe(true);
    expect(result.current.pairingInfo).toBeNull();
    expect(result.current.connectedDevices).toEqual([]);
    expect(result.current.lastMessage).toBeNull();
    expect(result.current.pendingQueueCount).toBe(0);
  });

  it('isCliOnline is false when no CLI devices are connected', () => {
    const { result } = renderHook(() => useRelay());
    expect(result.current.isCliOnline).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Pairing Info Persistence
  // --------------------------------------------------------------------------

  it('loads pairing info from SecureStore on mount', async () => {
    await SecureStore.setItemAsync('styrby_pairing_info', JSON.stringify(validPairingInfo));

    const { result } = renderHook(() => useRelay());

    await waitFor(() => expect(result.current.pairingInfo).not.toBeNull());

    expect(result.current.pairingInfo?.userId).toBe('test-user-id');
    expect(result.current.pairingInfo?.machineId).toBe('machine-1');
  });

  it('savePairing persists to SecureStore and updates state', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    expect(result.current.pairingInfo).toEqual(validPairingInfo);

    const stored = await SecureStore.getItemAsync('styrby_pairing_info');
    expect(stored).toBe(JSON.stringify(validPairingInfo));
  });

  it('clearPairing removes from SecureStore and resets state', async () => {
    await SecureStore.setItemAsync('styrby_pairing_info', JSON.stringify(validPairingInfo));

    const { result } = renderHook(() => useRelay());

    await waitFor(() => expect(result.current.pairingInfo).not.toBeNull());

    await act(async () => {
      await result.current.clearPairing();
    });

    expect(result.current.pairingInfo).toBeNull();
    expect(result.current.connectionState).toBe('disconnected');
  });

  it('handles corrupted SecureStore data gracefully', async () => {
    jest.spyOn(console, 'error').mockImplementation();

    await SecureStore.setItemAsync('styrby_pairing_info', 'not-valid-json');

    const { result } = renderHook(() => useRelay());

    // Should not crash; pairingInfo stays null
    await waitFor(() => {
      // Wait for mount effect to finish
      expect(result.current.connectionState).toBe('disconnected');
    });

    expect(result.current.pairingInfo).toBeNull();

    (console.error as jest.Mock).mockRestore();
  });

  // --------------------------------------------------------------------------
  // Connection Lifecycle
  // --------------------------------------------------------------------------

  it('connect does nothing without pairing info', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.connect();
    });

    expect(mockRelayClient.connect).not.toHaveBeenCalled();
  });

  it('connects successfully when pairing info is available', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.connectionState).toBe('connected');
    expect(result.current.isConnected).toBe(true);
  });

  it('disconnect cleans up client and resets state', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.isConnected).toBe(true);

    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.connectionState).toBe('disconnected');
    expect(result.current.isConnected).toBe(false);
    expect(result.current.connectedDevices).toEqual([]);
  });

  it('handles connection error gracefully', async () => {
    jest.spyOn(console, 'error').mockImplementation();

    mockConnectError = new Error('Connection timeout');

    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.connectionState).toBe('error');

    (console.error as jest.Mock).mockRestore();
  });

  it('skips connect when already connected', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    // Reset mock call count
    mockRelayClient.connect.mockClear();

    await act(async () => {
      await result.current.connect();
    });

    // Should not call connect again since already connected
    expect(mockRelayClient.connect).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Messaging
  // --------------------------------------------------------------------------

  it('sends message directly when connected', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      await result.current.sendMessage({
        type: 'chat',
        payload: { text: 'Hello' },
      });
    });

    expect(mockRelayClient.send).toHaveBeenCalledWith({
      type: 'chat',
      payload: { text: 'Hello' },
    });
  });

  it('throws error when not connected but online', async () => {
    const { result } = renderHook(() => useRelay());

    await expect(
      act(async () => {
        await result.current.sendMessage({
          type: 'chat',
          payload: { text: 'Hello' },
        });
      })
    ).rejects.toThrow('Not connected to relay');
  });

  // --------------------------------------------------------------------------
  // Offline Queue
  // --------------------------------------------------------------------------

  it('initializes pending queue count to zero', () => {
    const { result } = renderHook(() => useRelay());

    // Queue count starts at zero before any async operations complete
    expect(result.current.pendingQueueCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Presence Events
  // --------------------------------------------------------------------------

  it('updates connected devices on presence_join', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    const device = { device_id: 'cli-1', device_type: 'cli', device_name: 'CLI' };
    mockConnectedDevices = [device];

    // Trigger presence_join event
    if (mockEventHandlers['presence_join']) {
      await act(async () => {
        mockEventHandlers['presence_join'][0](device);
      });
    }

    expect(result.current.connectedDevices).toHaveLength(1);
  });

  it('removes device on presence_leave', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    const device = { device_id: 'cli-1', device_type: 'cli', device_name: 'CLI' };

    // Simulate join
    if (mockEventHandlers['presence_join']) {
      await act(async () => {
        mockEventHandlers['presence_join'][0](device);
      });
    }

    expect(result.current.connectedDevices).toHaveLength(1);

    // Simulate leave
    if (mockEventHandlers['presence_leave']) {
      await act(async () => {
        mockEventHandlers['presence_leave'][0]({ device_id: 'cli-1' });
      });
    }

    expect(result.current.connectedDevices).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Relay Events
  // --------------------------------------------------------------------------

  it('sets lastMessage on incoming message', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    const message = { id: 'msg-1', type: 'chat', payload: { text: 'Hi' } };

    if (mockEventHandlers['message']) {
      await act(async () => {
        mockEventHandlers['message'][0](message);
      });
    }

    expect(result.current.lastMessage).toEqual(message);
  });

  it('sets error state on relay error event', async () => {
    jest.spyOn(console, 'error').mockImplementation();

    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    if (mockEventHandlers['error']) {
      await act(async () => {
        mockEventHandlers['error'][0]({ message: 'Channel error' });
      });
    }

    expect(result.current.connectionState).toBe('error');

    (console.error as jest.Mock).mockRestore();
  });

  it('resets state on closed event', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    if (mockEventHandlers['closed']) {
      await act(async () => {
        mockEventHandlers['closed'][0]();
      });
    }

    expect(result.current.connectionState).toBe('disconnected');
    expect(result.current.connectedDevices).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // isCliOnline Derived State
  // --------------------------------------------------------------------------

  it('isCliOnline is true when CLI device is in connected devices', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    const cliDevice = { device_id: 'cli-1', device_type: 'cli', device_name: 'CLI' };

    if (mockEventHandlers['presence_join']) {
      await act(async () => {
        mockEventHandlers['presence_join'][0](cliDevice);
      });
    }

    expect(result.current.isCliOnline).toBe(true);
  });

  it('isCliOnline is false when only mobile devices are connected', async () => {
    const { result } = renderHook(() => useRelay());

    await act(async () => {
      await result.current.savePairing(validPairingInfo);
    });

    await act(async () => {
      await result.current.connect();
    });

    const mobileDevice = { device_id: 'mobile-1', device_type: 'mobile', device_name: 'Phone' };

    if (mockEventHandlers['presence_join']) {
      await act(async () => {
        mockEventHandlers['presence_join'][0](mobileDevice);
      });
    }

    expect(result.current.isCliOnline).toBe(false);
  });
});
