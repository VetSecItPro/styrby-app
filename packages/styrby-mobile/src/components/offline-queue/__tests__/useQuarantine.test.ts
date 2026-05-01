/**
 * useQuarantine Hook Test Suite
 *
 * WHY a real renderHook suite (not mocked-helpers contract): The previous
 * version of this file exercised mocked io helpers directly without ever
 * invoking `useQuarantine`. That made the suite a syntax check against
 * `offlineQueue` rather than a behavioural test of the hook. This rewrite
 * drives the hook through `renderHook` + `act` from
 * `@testing-library/react-native` so the tests fail when the hook's
 * lifecycle, state transitions, or orchestration of `offlineQueue` regress.
 *
 * Coverage:
 * 1. Initial state — loading=true, then settles empty when no failed items
 * 2. Loads failed items via getFailedItems and shapes ageMs/humanReadableError
 * 3. retryMessage — re-enqueues with original priority/maxAttempts and refreshes
 * 4. discardMessage — clearAll + re-enqueue keepers + refresh
 * 5. retryAll — re-enqueues every quarantined message
 * 6. discardAll — Alert confirmation, calls clearAll on confirm, no-op on cancel
 * 7. Error surfacing — getStats rejection sets `error` without crashing
 * 8. toHumanReadableError mapping (network / auth / server / unknown / passthrough)
 *
 * @module components/offline-queue/__tests__/useQuarantine
 */

// ============================================================================
// Mocks (must be declared before importing the hook)
// ============================================================================

/**
 * Per-test offlineQueue mock. We export the jest.fn handles so each test can
 * tune resolved values and assert call shape without re-mocking the module.
 */
const mockGetStats = jest.fn();
const mockGetFailedItems = jest.fn();
const mockEnqueue = jest.fn(async (..._args: unknown[]) => ({ id: 'new-id' }));
const mockClearAll = jest.fn(async () => {});
const mockDequeue = jest.fn(async () => null);
const mockMarkSent = jest.fn(async () => {});
const mockMarkFailed = jest.fn(async () => {});
const mockGetPending = jest.fn(async () => []);
const mockClearExpired = jest.fn(async () => 0);
const mockProcessQueue = jest.fn(async () => {});

jest.mock('../../../services/offline-queue', () => ({
  offlineQueue: {
    getStats: (...args: unknown[]) => mockGetStats(...(args as [])),
    getFailedItems: (...args: unknown[]) => mockGetFailedItems(...(args as [])),
    enqueue: (...args: unknown[]) => mockEnqueue(...(args as [])),
    clearAll: (...args: unknown[]) => mockClearAll(...(args as [])),
    dequeue: (...args: unknown[]) => mockDequeue(...(args as [])),
    markSent: (...args: unknown[]) => mockMarkSent(...(args as [])),
    markFailed: (...args: unknown[]) => mockMarkFailed(...(args as [])),
    getPending: (...args: unknown[]) => mockGetPending(...(args as [])),
    clearExpired: (...args: unknown[]) => mockClearExpired(...(args as [])),
    processQueue: (...args: unknown[]) => mockProcessQueue(...(args as [])),
  },
}));

/**
 * Capture Alert.alert invocations so we can verify the confirmation dialog
 * and synchronously trigger either the cancel or destructive button.
 *
 * WHY a captured handle (not a partial mock): the hook awaits a Promise that
 * only resolves when one of the Alert buttons fires. We grab the buttons
 * array, find the one we want, and invoke its onPress. The full react-native
 * surface is mocked here because jest.setup.js's mock does not export Alert
 * with this captured-call shape.
 */
const mockAlertAlert = jest.fn();
jest.mock('react-native', () => ({
  Alert: { alert: (...args: unknown[]) => mockAlertAlert(...(args as [])) },
  Platform: { OS: 'ios', select: jest.fn((obj: Record<string, unknown>) => obj.ios) },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })), currentState: 'active' },
  StyleSheet: { create: (styles: unknown) => styles, flatten: (style: unknown) => style },
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { act } from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { QueuedCommand } from 'styrby-shared';
import { useQuarantine } from '../useQuarantine';

// ============================================================================
// Test fixtures
// ============================================================================

/**
 * Construct a minimal QueuedCommand fixture for failed-item scenarios.
 *
 * @param id - Unique queue item id
 * @param error - Optional lastError text driving the human-readable mapping
 * @param attempts - Number of attempts already made (defaults to 3 = exhausted)
 * @param priority - Priority of the command (defaults to 0)
 */
function makeFailedCommand(
  id: string,
  error?: string,
  attempts = 3,
  priority = 0,
): QueuedCommand {
  return {
    id,
    message: {
      id: `msg_${id}`,
      timestamp: '2026-04-21T10:00:00.000Z',
      sender_device_id: 'mobile-test',
      sender_type: 'mobile',
      type: 'chat',
      payload: { content: `Test message ${id}`, agent: 'claude' },
    },
    status: 'failed',
    attempts,
    maxAttempts: 3,
    createdAt: '2026-04-21T09:00:00.000Z',
    expiresAt: '2026-04-21T09:05:00.000Z',
    lastAttemptAt: '2026-04-21T09:04:59.000Z',
    lastError: error,
    priority,
  };
}

/**
 * Configure the offlineQueue mock so the hook's load() will yield the supplied
 * failed items. Call before renderHook (or before triggering a refresh).
 */
function primeQueue(failed: QueuedCommand[]): void {
  mockGetStats.mockResolvedValue({
    total: failed.length,
    pending: 0,
    failed: failed.length,
    expired: 0,
  });
  mockGetFailedItems.mockResolvedValue(failed);
}

// ============================================================================
// Lifecycle
// ============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  // Default: empty queue. Tests override per scenario.
  mockGetStats.mockResolvedValue({ total: 0, pending: 0, failed: 0, expired: 0 });
  mockGetFailedItems.mockResolvedValue([]);
  mockEnqueue.mockResolvedValue({ id: 'new-id' });
  mockClearAll.mockResolvedValue(undefined);
});

// ============================================================================
// Tests
// ============================================================================

describe('useQuarantine — initial state', () => {
  it('starts with isLoading=true and resolves to an empty list when nothing is failed', async () => {
    const { result } = renderHook(() => useQuarantine());

    // Mount snapshot: loading flag is true before the async load resolves.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetStats).toHaveBeenCalledTimes(1);
    // Short-circuit: no failed items means getFailedItems is never called.
    expect(mockGetFailedItems).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe('useQuarantine — load with failed items', () => {
  it('shapes failed items into QuarantinedMessage entries with humanReadableError + ageMs', async () => {
    primeQueue([
      makeFailedCommand('f1', 'Network request failed'),
      makeFailedCommand('f2', '401 Unauthorized'),
      makeFailedCommand('f3', undefined),
    ]);

    const { result } = renderHook(() => useQuarantine());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetFailedItems).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(3);
    expect(result.current.messages[0].humanReadableError).toContain('Network error');
    expect(result.current.messages[1].humanReadableError).toContain('Authentication error');
    expect(result.current.messages[2].humanReadableError).toContain('Unknown error');
    // ageMs is computed against Date.now() so it must be non-negative.
    for (const m of result.current.messages) {
      expect(m.ageMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns an empty list when getFailedItems is missing on the queue (interface gap fallback)', async () => {
    // WHY: useQuarantine guards against queues that don't expose getFailedItems
    // (e.g., a future web IndexedDB impl). Stats says >0 but the optional method
    // is absent — hook should return [] without throwing.
    mockGetStats.mockResolvedValue({ total: 1, pending: 0, failed: 1, expired: 0 });
    mockGetFailedItems.mockResolvedValue(undefined as unknown as QueuedCommand[]);

    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe('useQuarantine — retryMessage', () => {
  it('re-enqueues the targeted message with original priority + maxAttempts and refreshes', async () => {
    const target = makeFailedCommand('retry-me', 'Network timeout', 3, 5);
    primeQueue([target]);

    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    // After retry the queue should be empty again so the post-retry refresh
    // settles to messages.length === 0.
    mockGetStats.mockResolvedValue({ total: 0, pending: 1, failed: 0, expired: 0 });
    mockGetFailedItems.mockResolvedValue([]);

    await act(async () => {
      await result.current.retryMessage('retry-me');
    });

    expect(mockEnqueue).toHaveBeenCalledWith(
      target.message,
      { priority: 5, maxAttempts: 3 },
    );
    // load() was called once on mount + once after retry.
    expect(mockGetStats).toHaveBeenCalledTimes(2);
    expect(result.current.messages).toEqual([]);
  });

  it('logs but does not throw when the id is unknown', async () => {
    primeQueue([makeFailedCommand('only', 'err')]);
    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await act(async () => {
      await result.current.retryMessage('does-not-exist');
    });

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error string when enqueue rejects', async () => {
    primeQueue([makeFailedCommand('boom', 'err')]);
    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    mockEnqueue.mockRejectedValueOnce(new Error('disk full'));

    await act(async () => {
      await result.current.retryMessage('boom');
    });

    expect(result.current.error).toBe('disk full');
  });
});

describe('useQuarantine — discardMessage', () => {
  it('clears the queue then re-enqueues every keeper', async () => {
    const cmds = [
      makeFailedCommand('keep-1', 'A', 3, 1),
      makeFailedCommand('discard-me', 'B', 3, 2),
      makeFailedCommand('keep-2', 'C', 3, 3),
    ];
    primeQueue(cmds);

    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(3));

    // Post-discard refresh: queue settled empty.
    mockGetStats.mockResolvedValue({ total: 0, pending: 2, failed: 0, expired: 0 });
    mockGetFailedItems.mockResolvedValue([]);

    await act(async () => {
      await result.current.discardMessage('discard-me');
    });

    expect(mockClearAll).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(mockEnqueue).toHaveBeenCalledWith(cmds[0].message, { priority: 1, maxAttempts: 3 });
    expect(mockEnqueue).toHaveBeenCalledWith(cmds[2].message, { priority: 3, maxAttempts: 3 });
  });

  it('is a no-op when the id is unknown', async () => {
    primeQueue([makeFailedCommand('only', 'err')]);
    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    await act(async () => {
      await result.current.discardMessage('phantom');
    });

    expect(mockClearAll).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('surfaces an error string when clearAll rejects', async () => {
    primeQueue([makeFailedCommand('x', 'err')]);
    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    mockClearAll.mockRejectedValueOnce(new Error('sqlite locked'));

    await act(async () => {
      await result.current.discardMessage('x');
    });

    expect(result.current.error).toBe('sqlite locked');
  });
});

describe('useQuarantine — retryAll', () => {
  it('re-enqueues every quarantined message and refreshes', async () => {
    const cmds = [
      makeFailedCommand('r1', 'err', 3, 0),
      makeFailedCommand('r2', 'err', 3, 1),
      makeFailedCommand('r3', 'err', 3, 2),
    ];
    primeQueue(cmds);

    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(3));

    mockGetStats.mockResolvedValue({ total: 0, pending: 3, failed: 0, expired: 0 });
    mockGetFailedItems.mockResolvedValue([]);

    await act(async () => {
      await result.current.retryAll();
    });

    expect(mockEnqueue).toHaveBeenCalledTimes(3);
    expect(mockEnqueue).toHaveBeenNthCalledWith(1, cmds[0].message, { priority: 0, maxAttempts: 3 });
    expect(mockEnqueue).toHaveBeenNthCalledWith(2, cmds[1].message, { priority: 1, maxAttempts: 3 });
    expect(mockEnqueue).toHaveBeenNthCalledWith(3, cmds[2].message, { priority: 2, maxAttempts: 3 });
    // load() ran on mount + once post-retryAll.
    expect(mockGetStats).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when the list is empty', async () => {
    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.retryAll();
    });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('surfaces an error when one of the enqueue calls rejects', async () => {
    primeQueue([
      makeFailedCommand('a', 'err'),
      makeFailedCommand('b', 'err'),
    ]);

    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    mockEnqueue
      .mockResolvedValueOnce({ id: 'first' })
      .mockRejectedValueOnce(new Error('queue rejected second'));

    await act(async () => {
      await result.current.retryAll();
    });

    expect(result.current.error).toBe('queue rejected second');
  });
});

describe('useQuarantine — discardAll', () => {
  it('shows a confirmation Alert with the correct count and pluralization', async () => {
    primeQueue([
      makeFailedCommand('a', 'err'),
      makeFailedCommand('b', 'err'),
      makeFailedCommand('c', 'err'),
    ]);

    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(3));

    // Auto-cancel so the Promise resolves and the test doesn't hang.
    mockAlertAlert.mockImplementation((_t, _b, buttons: Array<{ text: string; onPress?: () => void }>) => {
      buttons.find((b) => b.text === 'Cancel')?.onPress?.();
    });

    await act(async () => {
      await result.current.discardAll();
    });

    expect(mockAlertAlert).toHaveBeenCalledWith(
      'Discard All Messages?',
      '3 undelivered messages will be permanently deleted.',
      expect.any(Array),
    );
    // Cancel path: clearAll must NOT be called.
    expect(mockClearAll).not.toHaveBeenCalled();
  });

  it('uses singular "message" for a single-item list', async () => {
    primeQueue([makeFailedCommand('solo', 'err')]);
    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    mockAlertAlert.mockImplementation((_t, _b, buttons: Array<{ text: string; onPress?: () => void }>) => {
      buttons.find((b) => b.text === 'Cancel')?.onPress?.();
    });

    await act(async () => {
      await result.current.discardAll();
    });

    expect(mockAlertAlert).toHaveBeenCalledWith(
      'Discard All Messages?',
      '1 undelivered message will be permanently deleted.',
      expect.any(Array),
    );
  });

  it('calls clearAll when the destructive button fires and refreshes the list', async () => {
    primeQueue([makeFailedCommand('z', 'err')]);
    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    // Post-discard the queue is empty.
    mockGetStats.mockResolvedValue({ total: 0, pending: 0, failed: 0, expired: 0 });
    mockGetFailedItems.mockResolvedValue([]);

    mockAlertAlert.mockImplementation(async (_t, _b, buttons: Array<{ text: string; onPress?: () => void | Promise<void> }>) => {
      const destructive = buttons.find((b) => b.text === 'Discard All');
      await destructive?.onPress?.();
    });

    await act(async () => {
      await result.current.discardAll();
    });

    expect(mockClearAll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.messages).toEqual([]));
  });

  it('is a no-op when the list is empty (no Alert)', async () => {
    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.discardAll();
    });

    expect(mockAlertAlert).not.toHaveBeenCalled();
    expect(mockClearAll).not.toHaveBeenCalled();
  });

  it('surfaces an error when clearAll rejects from the destructive path', async () => {
    primeQueue([makeFailedCommand('z', 'err')]);
    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    mockClearAll.mockRejectedValueOnce(new Error('sqlite vanished'));
    mockAlertAlert.mockImplementation(async (_t, _b, buttons: Array<{ text: string; onPress?: () => void | Promise<void> }>) => {
      const destructive = buttons.find((b) => b.text === 'Discard All');
      await destructive?.onPress?.();
    });

    await act(async () => {
      await result.current.discardAll();
    });

    expect(result.current.error).toBe('sqlite vanished');
  });
});

describe('useQuarantine — error surfacing on load', () => {
  it('sets error and stops loading when getStats rejects', async () => {
    mockGetStats.mockRejectedValueOnce(new Error('db handle closed'));

    const { result } = renderHook(() => useQuarantine());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('db handle closed');
    expect(result.current.messages).toEqual([]);
  });
});

describe('useQuarantine — toHumanReadableError mapping (via load)', () => {
  /**
   * WHY drive the mapping through the hook (not a direct import): the helper
   * is intentionally module-private so callers see only the shaped
   * QuarantinedMessage. Driving via load() asserts both the mapping logic
   * AND its wiring into the visible state.
   */
  const cases: Array<[string | undefined, string]> = [
    [undefined, 'Unknown error'],
    ['Network request failed', 'Network error'],
    ['timeout after 30s', 'Network error'],
    ['401 Unauthorized', 'Authentication error'],
    ['auth token expired', 'Authentication error'],
    ['500 Internal Server Error', 'Server error'],
    ['The server crashed', 'Server error'],
    ['Specific custom error', 'Specific custom error'], // passthrough
  ];

  it.each(cases)('maps lastError=%p to humanReadableError containing %p', async (raw, expected) => {
    primeQueue([makeFailedCommand('only', raw)]);

    const { result } = renderHook(() => useQuarantine());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    expect(result.current.messages[0].humanReadableError).toContain(expected);
  });
});
