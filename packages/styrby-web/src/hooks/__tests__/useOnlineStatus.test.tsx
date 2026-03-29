/**
 * Tests for useOnlineStatus and useOnlineStatusWithQueue hooks
 *
 * WHY: Offline handling is core Styrby functionality — users need accurate
 * online/offline status so they know when actions are queued vs sent immediately.
 * These tests verify that both hooks correctly reflect navigator.onLine,
 * respond to browser online/offline events, and interact with offlineQueue.
 *
 * @module hooks/__tests__/useOnlineStatus.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOnlineStatus, useOnlineStatusWithQueue } from '../useOnlineStatus';

// ─── Mock offlineQueue ───────────────────────────────────────────────────────

vi.mock('@/lib/offlineQueue', () => ({
  offlineQueue: {
    processQueue: vi.fn(),
    getQueueLength: vi.fn().mockResolvedValue(0),
  },
}));

import { offlineQueue } from '@/lib/offlineQueue';

/** Typed mock references for assertions */
const mockProcessQueue = vi.mocked(offlineQueue.processQueue);
const mockGetQueueLength = vi.mocked(offlineQueue.getQueueLength);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fires a browser online or offline event on the window object.
 *
 * @param type - 'online' or 'offline'
 */
function fireNetworkEvent(type: 'online' | 'offline'): void {
  window.dispatchEvent(new Event(type));
}

/**
 * Sets navigator.onLine to the given value.
 *
 * @param value - The online state to simulate
 */
function setNavigatorOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    writable: true,
    configurable: true,
    value,
  });
}

// ─── useOnlineStatus tests ───────────────────────────────────────────────────

describe('useOnlineStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore navigator.onLine to its default
    setNavigatorOnline(true);
  });

  describe('initial state', () => {
    it('returns true when navigator.onLine is true', () => {
      setNavigatorOnline(true);
      const { result } = renderHook(() => useOnlineStatus());

      expect(result.current).toBe(true);
    });

    it('returns false when navigator.onLine is false', () => {
      setNavigatorOnline(false);
      const { result } = renderHook(() => useOnlineStatus());

      expect(result.current).toBe(false);
    });

    it('returns a boolean value', () => {
      const { result } = renderHook(() => useOnlineStatus());

      expect(typeof result.current).toBe('boolean');
    });
  });

  describe('online event', () => {
    it('updates to true when the window fires an "online" event', () => {
      setNavigatorOnline(false);
      const { result } = renderHook(() => useOnlineStatus());
      expect(result.current).toBe(false);

      act(() => {
        fireNetworkEvent('online');
      });

      expect(result.current).toBe(true);
    });

    it('calls offlineQueue.processQueue when coming back online', () => {
      setNavigatorOnline(false);
      renderHook(() => useOnlineStatus());

      act(() => {
        fireNetworkEvent('online');
      });

      expect(mockProcessQueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('offline event', () => {
    it('updates to false when the window fires an "offline" event', () => {
      setNavigatorOnline(true);
      const { result } = renderHook(() => useOnlineStatus());
      expect(result.current).toBe(true);

      act(() => {
        fireNetworkEvent('offline');
      });

      expect(result.current).toBe(false);
    });

    it('does not call offlineQueue.processQueue when going offline', () => {
      setNavigatorOnline(true);
      renderHook(() => useOnlineStatus());

      act(() => {
        fireNetworkEvent('offline');
      });

      expect(mockProcessQueue).not.toHaveBeenCalled();
    });
  });

  describe('multiple status changes', () => {
    it('correctly tracks multiple online/offline transitions', () => {
      setNavigatorOnline(true);
      const { result } = renderHook(() => useOnlineStatus());

      act(() => { fireNetworkEvent('offline'); });
      expect(result.current).toBe(false);

      act(() => { fireNetworkEvent('online'); });
      expect(result.current).toBe(true);

      act(() => { fireNetworkEvent('offline'); });
      expect(result.current).toBe(false);
    });
  });

  describe('event listener cleanup', () => {
    it('removes online and offline listeners when unmounted', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = renderHook(() => useOnlineStatus());
      unmount();

      expect(removeSpy).toHaveBeenCalledWith('online', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('offline', expect.any(Function));
    });

    it('does not update state after unmount', () => {
      setNavigatorOnline(true);
      const { result, unmount } = renderHook(() => useOnlineStatus());

      unmount();

      // Should not throw or cause act warnings
      expect(() => {
        act(() => { fireNetworkEvent('offline'); });
      }).not.toThrow();

      // The captured result should still reflect the last known value
      expect(result.current).toBe(true);
    });
  });
});

// ─── useOnlineStatusWithQueue tests ─────────────────────────────────────────

describe('useOnlineStatusWithQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setNavigatorOnline(true);
    mockGetQueueLength.mockResolvedValue(0);
  });

  afterEach(() => {
    // Restore online status so any remaining timers don't set up another interval
    setNavigatorOnline(true);
    // Use clearAllTimers to cancel pending intervals/timeouts rather than firing them,
    // since the offline polling interval is infinite and vi.runAllTimers() would loop.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('returns isOnline=true and pendingCount=0 when online with empty queue', async () => {
      const { result } = renderHook(() => useOnlineStatusWithQueue());

      // Advance past the 0ms initial timeout + the 1s online refresh timer
      await act(async () => {
        vi.advanceTimersByTime(1100);
      });

      expect(result.current.isOnline).toBe(true);
      expect(result.current.pendingCount).toBe(0);
    });

    it('returns the queue length from offlineQueue.getQueueLength', async () => {
      mockGetQueueLength.mockResolvedValue(5);

      const { result } = renderHook(() => useOnlineStatusWithQueue());

      // Advance past the 0ms initial timeout only — no infinite interval
      await act(async () => {
        vi.advanceTimersByTime(10);
      });

      expect(result.current.pendingCount).toBe(5);
    });
  });

  describe('online/offline status', () => {
    it('reflects offline status from useOnlineStatus', async () => {
      setNavigatorOnline(false);
      const { result } = renderHook(() => useOnlineStatusWithQueue());

      // Advance only the initial 0ms timeout — not infinitely
      await act(async () => { vi.advanceTimersByTime(10); });

      expect(result.current.isOnline).toBe(false);
    });

    it('reflects online status change', async () => {
      setNavigatorOnline(false);
      const { result } = renderHook(() => useOnlineStatusWithQueue());

      await act(async () => { vi.advanceTimersByTime(10); });

      act(() => {
        fireNetworkEvent('online');
      });

      expect(result.current.isOnline).toBe(true);
    });
  });

  describe('queue length refresh', () => {
    it('re-fetches the queue length after coming back online (with 1s delay)', async () => {
      setNavigatorOnline(false);
      mockGetQueueLength.mockResolvedValue(3);

      const { result } = renderHook(() => useOnlineStatusWithQueue());

      // Initial fetch (0ms timeout)
      await act(async () => { vi.advanceTimersByTime(10); });
      expect(result.current.pendingCount).toBe(3);

      // Go online — this triggers a 1000ms refresh timer (not an interval)
      mockGetQueueLength.mockResolvedValue(0);
      act(() => { fireNetworkEvent('online'); });

      // Advance past the 1000ms delay used when coming back online
      await act(async () => { vi.advanceTimersByTime(1100); });

      expect(result.current.pendingCount).toBe(0);
    });

    it('polls for queue length every 5 seconds while offline', async () => {
      setNavigatorOnline(false);
      mockGetQueueLength.mockResolvedValue(2);

      renderHook(() => useOnlineStatusWithQueue());

      // Initial fetch at 0ms
      await act(async () => { vi.advanceTimersByTime(10); });
      expect(mockGetQueueLength).toHaveBeenCalledTimes(1);

      // Advance exactly one polling interval (5s)
      await act(async () => { vi.advanceTimersByTime(5000); });
      expect(mockGetQueueLength).toHaveBeenCalledTimes(2);

      // Advance another polling interval
      await act(async () => { vi.advanceTimersByTime(5000); });
      expect(mockGetQueueLength).toHaveBeenCalledTimes(3);
    });

    it('does not poll while online (polling only happens offline)', async () => {
      setNavigatorOnline(true);

      renderHook(() => useOnlineStatusWithQueue());

      // Initial fetch at 0ms
      await act(async () => { vi.advanceTimersByTime(0); });
      const countAfterInit = mockGetQueueLength.mock.calls.length;

      // Advance 10 seconds — no polling should happen while online
      await act(async () => { vi.advanceTimersByTime(10000); });

      // Only the initial fetch + the 1s refresh after going online should fire
      // (the 1s timer fires once, not repeatedly)
      expect(mockGetQueueLength.mock.calls.length).toBeLessThanOrEqual(countAfterInit + 1);
    });
  });

  describe('IndexedDB error handling', () => {
    it('sets pendingCount to 0 when getQueueLength rejects (e.g., private browsing)', async () => {
      mockGetQueueLength.mockRejectedValue(new Error('IndexedDB not available'));

      const { result } = renderHook(() => useOnlineStatusWithQueue());

      await act(async () => { vi.runAllTimers(); });

      // Should not throw — pendingCount defaults to 0
      expect(result.current.pendingCount).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('cancels all timers on unmount without throwing', async () => {
      setNavigatorOnline(false);

      const { unmount } = renderHook(() => useOnlineStatusWithQueue());

      expect(() => {
        unmount();
        vi.runAllTimers();
      }).not.toThrow();
    });
  });
});
