/**
 * useSessionConnectionState — unit tests
 *
 * Covers all four status branches and the 60-second stale fallback:
 *   - 'connected'    — last_seen_at within 60 s
 *   - 'reconnecting' — DB status is 'reconnecting'
 *   - 'offline'      — last_seen_at > 60 s ago
 *   - 'unknown'      — initial state / no DB data
 *   - 60-second stale fallback — presence silent, poll returns stale timestamp
 *
 * Pattern:
 *   - Mock '@/lib/supabase' at module level so supabase.channel().on().subscribe()
 *     is replaceable.  We use a captured mock that emits fake events in tests.
 *   - Advance fake timers to trigger the 30 s poll interval.
 *   - Use renderHook from @testing-library/react-native.
 */

// ── Module-level mocks ────────────────────────────────────────────────────────

/**
 * Mutable mock state controlling the Supabase `.from()` response.
 */
let mockFromData: { last_seen_at?: string | null; status?: string } | null = null;
let mockFromError: { message: string } | null = null;

/**
 * Stored presence event handlers so tests can fire them directly.
 */
const presenceHandlers: Record<string, ((...args: unknown[]) => void)[]> = {
  sync: [],
  join: [],
  leave: [],
};

/**
 * Capture the latest channel created by supabase.channel() so tests can
 * inspect presenceState or trigger subscribe callbacks.
 */
let capturedChannel: {
  presenceState: () => Record<string, unknown[]>;
} | null = null;

/**
 * Mock removeChannel spy to verify cleanup.
 *
 * WHY jest.fn() is placed inside the factory (not hoisted from outer scope):
 * jest.mock() factories are hoisted to the top of the file by babel-jest.
 * Variables declared with `const` outside the factory are initialised AFTER
 * the factory runs, so they are `undefined` when the factory captures them.
 * Placing the spy inside the factory and then re-exporting it via a module
 * property lets us import it after the mock is established.
 */
jest.mock('../../lib/supabase', () => {
  const _mockRemoveChannel = jest.fn();

  const buildChannel = (): {
    presenceState: jest.Mock;
    on: jest.Mock;
    subscribe: jest.Mock;
  } => {
    // eslint-disable-next-line prefer-const
    let channelObj: { presenceState: jest.Mock; on: jest.Mock; subscribe: jest.Mock };
    channelObj = {
      presenceState: jest.fn(() => ({})),
      on: jest.fn(
        (
          _type: string,
          opts: { event: string },
          cb: (...args: unknown[]) => void,
        ) => {
          const event = opts.event as 'sync' | 'join' | 'leave';
          if (!presenceHandlers[event]) presenceHandlers[event] = [];
          presenceHandlers[event].push(cb);
          return channelObj;
        },
      ),
      subscribe: jest.fn(() => channelObj),
    };
    capturedChannel = channelObj;
    return channelObj;
  };

  // Allow .from().select().eq().single() chaining
  const mockFrom = jest.fn(() => ({
    select: jest.fn(() => ({
      eq: jest.fn(() => ({
        single: jest.fn(() =>
          Promise.resolve({ data: mockFromData, error: mockFromError }),
        ),
      })),
    })),
  }));

  return {
    supabase: {
      channel: jest.fn(() => buildChannel()),
      removeChannel: _mockRemoveChannel,
      from: mockFrom,
    },
    // Expose the spy so tests can import it post-hoist
    __mockRemoveChannel: _mockRemoveChannel,
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useSessionConnectionState } from '../useSessionConnectionState';

/**
 * Re-import the spy that was defined inside the jest.mock() factory.
 * We cannot use a hoisted `const` for this — see WHY comment on the factory.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockRemoveChannel: jest.Mock = (require('../../lib/supabase') as { __mockRemoveChannel: jest.Mock }).__mockRemoveChannel;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** ISO timestamp N milliseconds in the past */
function msAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFromData = null;
  mockFromError = null;
  // Clear stored handlers between tests
  presenceHandlers.sync = [];
  presenceHandlers.join = [];
  presenceHandlers.leave = [];
  capturedChannel = null;
  mockRemoveChannel.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useSessionConnectionState', () => {
  describe('initial state', () => {
    it('starts as unknown before data arrives', () => {
      // Return no data (simulate pending)
      mockFromData = null;
      mockFromError = { message: 'not found' };

      const { result } = renderHook(() =>
        useSessionConnectionState('session-001'),
      );

      expect(result.current.status).toBe('unknown');
      expect(result.current.lastSeenAt).toBeNull();
    });
  });

  describe('connected branch', () => {
    it('returns connected when last_seen_at is within 60 s', async () => {
      // last seen 10 seconds ago
      mockFromData = { last_seen_at: msAgo(10_000), status: 'running' };
      mockFromError = null;

      const { result } = renderHook(() =>
        useSessionConnectionState('session-002'),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('connected');
      });

      expect(result.current.lastSeenAt).toBeInstanceOf(Date);
    });
  });

  describe('reconnecting branch', () => {
    it('returns reconnecting when DB status is reconnecting', async () => {
      // last seen 5 s ago but status says reconnecting
      mockFromData = { last_seen_at: msAgo(5_000), status: 'reconnecting' };
      mockFromError = null;

      const { result } = renderHook(() =>
        useSessionConnectionState('session-003'),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('reconnecting');
      });
    });

    it('carries attempt number from presence join event', async () => {
      mockFromData = { last_seen_at: msAgo(5_000), status: 'running' };
      mockFromError = null;

      const { result } = renderHook(() =>
        useSessionConnectionState('session-003b'),
      );

      // Fire a presence join with reconnecting status + attempt
      act(() => {
        for (const cb of presenceHandlers.join) {
          cb({ newPresences: [{ status: 'reconnecting', last_seen_at: msAgo(2_000), attempt: 4 }] });
        }
      });

      await waitFor(() => {
        expect(result.current.status).toBe('reconnecting');
        expect(result.current.attempt).toBe(4);
      });
    });
  });

  describe('offline branch — 60-second stale fallback', () => {
    it('returns offline when last_seen_at is older than 60 s', async () => {
      // last seen 90 seconds ago
      mockFromData = { last_seen_at: msAgo(90_000), status: 'running' };
      mockFromError = null;

      const { result } = renderHook(() =>
        useSessionConnectionState('session-004'),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('offline');
      });
    });

    it('immediately marks offline when presence leave fires', async () => {
      mockFromData = { last_seen_at: msAgo(5_000), status: 'running' };
      mockFromError = null;

      const { result } = renderHook(() =>
        useSessionConnectionState('session-005'),
      );

      // First establish connected state
      await waitFor(() => {
        expect(result.current.status).toBe('connected');
      });

      // Trigger presence leave
      act(() => {
        for (const cb of presenceHandlers.leave) {
          cb({});
        }
      });

      expect(result.current.status).toBe('offline');
    });

    it('transitions from connected to offline via 30 s poll when timestamp becomes stale', async () => {
      // Initial call: recent timestamp -> connected
      mockFromData = { last_seen_at: msAgo(5_000), status: 'running' };
      mockFromError = null;

      const { result } = renderHook(() =>
        useSessionConnectionState('session-006'),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('connected');
      });

      // Simulate time advancing: last_seen_at is now 90 s old
      mockFromData = { last_seen_at: msAgo(90_000), status: 'running' };

      // Advance 30 s to trigger the poll interval
      act(() => {
        jest.advanceTimersByTime(30_000);
      });

      await waitFor(() => {
        expect(result.current.status).toBe('offline');
      });
    });
  });

  describe('unknown branch', () => {
    it('stays unknown when DB returns an error', async () => {
      mockFromData = null;
      mockFromError = { message: 'row not found' };

      const { result } = renderHook(() =>
        useSessionConnectionState('session-007'),
      );

      // Give async effects a chance to settle
      await act(async () => {
        jest.advanceTimersByTime(100);
      });

      // Should remain unknown since no valid data arrived
      expect(result.current.status).toBe('unknown');
    });
  });

  describe('presence sync event', () => {
    it('transitions to connected when presence sync carries a recent timestamp', async () => {
      mockFromData = null;
      mockFromError = { message: 'not found' };

      const { result } = renderHook(() =>
        useSessionConnectionState('session-008'),
      );

      // Fire presence sync with a live daemon entry
      act(() => {
        if (capturedChannel) {
          (capturedChannel.presenceState as jest.Mock).mockReturnValue({
            'daemon-key': [{ status: 'connected', last_seen_at: msAgo(2_000) }],
          });
        }
        for (const cb of presenceHandlers.sync) {
          cb({});
        }
      });

      await waitFor(() => {
        expect(result.current.status).toBe('connected');
      });
    });
  });

  describe('cleanup', () => {
    it('removes the Realtime channel on unmount', async () => {
      mockFromData = { last_seen_at: msAgo(5_000), status: 'running' };
      mockFromError = null;

      const { unmount } = renderHook(() =>
        useSessionConnectionState('session-009'),
      );

      await waitFor(() => expect(mockRemoveChannel).not.toHaveBeenCalled());

      unmount();

      expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
    });
  });
});
