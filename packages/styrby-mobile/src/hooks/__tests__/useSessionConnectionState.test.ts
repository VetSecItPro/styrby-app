/**
 * Tests for useSessionConnectionState hook.
 *
 * Covers:
 * - Initial state: attempt=0, lastAttemptAt=null
 * - Increment on 'connecting' transition
 * - Increment on 'reconnecting' transition
 * - Reset to 0/null on 'connected' transition
 * - Does NOT increment on 'disconnected' transition
 * - Does NOT increment on 'error' transition
 * - Multiple reconnect cycles accumulate correctly
 *
 * WHY mock useRelay:
 *   useRelay depends on SecureStore, NetInfo, and Supabase — heavy native
 *   modules unavailable in Jest. Mocking at module level lets us test the
 *   state-machine logic in useSessionConnectionState in isolation.
 *
 * WHY renderHook from @testing-library/react-native:
 *   The mobile package uses @testing-library/react-native (not
 *   @testing-library/react-hooks). renderHook from the RN testing library
 *   provides a React host compatible with the native test environment.
 *
 * WHY mockCurrentConnectionState prefix:
 *   Jest's babel plugin requires variables referenced in jest.mock() factory
 *   functions to be prefixed with "mock" (case-insensitive). This ensures
 *   they are not flagged as uninitialized-variable references.
 *
 * @module hooks/__tests__/useSessionConnectionState
 */

import { renderHook, act } from '@testing-library/react-native';
import { useSessionConnectionState } from '../useSessionConnectionState';
import type { ConnectionState } from 'styrby-shared';

// ============================================================================
// Mock state shared between factory and tests
// ============================================================================

/**
 * WHY mockCurrentConnectionState (prefixed with "mock"):
 *   Jest's jest.mock() factory runs in a special scope. Variables not prefixed
 *   with "mock" cannot be referenced from inside the factory. We use this
 *   mutable object to control the connectionState returned by useRelay across
 *   all tests.
 */
const mockCurrentConnectionState: { value: ConnectionState } = {
  value: 'disconnected',
};

// ============================================================================
// Mock useRelay module
// ============================================================================

jest.mock('../useRelay', () => ({
  // WHY inline object instead of buildMockRelay():
  //   jest.mock() factories cannot reference out-of-scope non-mock-prefixed
  //   functions. We inline the stub here. mockCurrentConnectionState IS
  //   accessible because it satisfies the "mock" prefix rule.
  useRelay: () => ({
    connectionState: mockCurrentConnectionState.value,
    isConnected: mockCurrentConnectionState.value === 'connected',
    isOnline: true,
    isCliOnline: false,
    pendingQueueCount: 0,
    pairingInfo: null,
    connectedDevices: [],
    lastMessage: null,
    connect: async () => {},
    disconnect: async () => {},
    sendMessage: async () => {},
    savePairing: async () => {},
    clearPairing: async () => {},
  }),
}));

// ============================================================================
// Tests
// ============================================================================

describe('useSessionConnectionState', () => {
  beforeEach(() => {
    mockCurrentConnectionState.value = 'disconnected';
  });

  it('starts with attempt=0 and lastAttemptAt=null', () => {
    const { result } = renderHook(() => useSessionConnectionState());
    expect(result.current.attempt).toBe(0);
    expect(result.current.lastAttemptAt).toBeNull();
  });

  it('increments attempt and sets lastAttemptAt on connecting transition', () => {
    const { result, rerender } = renderHook(() => useSessionConnectionState());

    act(() => {
      mockCurrentConnectionState.value = 'connecting';
    });
    rerender({});

    expect(result.current.attempt).toBe(1);
    expect(result.current.lastAttemptAt).not.toBeNull();
    expect(typeof result.current.lastAttemptAt).toBe('string');
  });

  it('increments attempt on reconnecting transition', () => {
    const { result, rerender } = renderHook(() => useSessionConnectionState());

    act(() => {
      mockCurrentConnectionState.value = 'reconnecting';
    });
    rerender({});

    expect(result.current.attempt).toBe(1);
    expect(result.current.lastAttemptAt).not.toBeNull();
  });

  it('resets to 0 and null on connected transition', () => {
    const { result, rerender } = renderHook(() => useSessionConnectionState());

    // First: go to reconnecting
    act(() => { mockCurrentConnectionState.value = 'reconnecting'; });
    rerender({});
    expect(result.current.attempt).toBe(1);

    // Then: connected — should reset
    act(() => { mockCurrentConnectionState.value = 'connected'; });
    rerender({});

    expect(result.current.attempt).toBe(0);
    expect(result.current.lastAttemptAt).toBeNull();
  });

  it('does NOT increment on disconnected transition', () => {
    const { result, rerender } = renderHook(() => useSessionConnectionState());

    act(() => { mockCurrentConnectionState.value = 'disconnected'; });
    rerender({});

    // disconnected is the initial state — no transition from prior state, no increment
    expect(result.current.attempt).toBe(0);
    expect(result.current.lastAttemptAt).toBeNull();
  });

  it('does NOT increment on error transition', () => {
    const { result, rerender } = renderHook(() => useSessionConnectionState());

    act(() => { mockCurrentConnectionState.value = 'error'; });
    rerender({});

    expect(result.current.attempt).toBe(0);
    expect(result.current.lastAttemptAt).toBeNull();
  });

  it('accumulates correctly over multiple reconnect cycles', () => {
    const { result, rerender } = renderHook(() => useSessionConnectionState());

    // Cycle 1
    act(() => { mockCurrentConnectionState.value = 'connecting'; });
    rerender({});
    expect(result.current.attempt).toBe(1);

    act(() => { mockCurrentConnectionState.value = 'connected'; });
    rerender({});
    expect(result.current.attempt).toBe(0);

    // Cycle 2
    act(() => { mockCurrentConnectionState.value = 'reconnecting'; });
    rerender({});
    expect(result.current.attempt).toBe(1);

    // Two more reconnects without a connect
    act(() => { mockCurrentConnectionState.value = 'connecting'; });
    rerender({});
    expect(result.current.attempt).toBe(2);

    act(() => { mockCurrentConnectionState.value = 'reconnecting'; });
    rerender({});
    expect(result.current.attempt).toBe(3);
  });

  it('re-exports all useRelay fields unchanged', () => {
    const { result } = renderHook(() => useSessionConnectionState());
    expect(typeof result.current.connect).toBe('function');
    expect(typeof result.current.disconnect).toBe('function');
    expect(typeof result.current.sendMessage).toBe('function');
    expect(typeof result.current.savePairing).toBe('function');
    expect(typeof result.current.clearPairing).toBe('function');
    expect(result.current.isOnline).toBe(true);
  });
});
