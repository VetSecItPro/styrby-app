/**
 * Tests for SessionOrphanedBanner component.
 *
 * Covers all 7 required cases from Phase 1 Task 5 spec:
 *  1. Renders nothing when session is fresh (heartbeat within 90s, status active)
 *  2. Renders banner when session is stale (heartbeat > 90s ago AND status active)
 *  3. Renders nothing when session status is 'stopped' or 'expired' (non-active)
 *  4. Dismiss button hides banner via local state
 *  5. End Session button calls Supabase UPDATE with status='stopped' for correct id
 *  6. Loading state during End Session call (button shows loading indicator)
 *  7. Error state if API call fails (banner remains visible with error message)
 *
 * WHY mock supabase at module level:
 *   The real supabase client connects to a live server and uses expo-secure-store.
 *   Mocking at module level isolates the component from all IO, keeping tests
 *   fast and deterministic. Test cases override the mock return values per-test
 *   to simulate success/failure.
 *
 * WHY renderHook / render from @testing-library/react-native:
 *   The component uses React hooks internally. @testing-library/react-native
 *   renders into a simulated React Native host compatible with our Jest config.
 *
 * @module components/sessions/__tests__/SessionOrphanedBanner
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { SessionOrphanedBanner } from '../SessionOrphanedBanner';
import type { SessionOrphanedBannerProps } from '../SessionOrphanedBanner';
import type { SessionStatus } from 'styrby-shared';

// ============================================================================
// Supabase mock
// ============================================================================

/**
 * WHY mockSupabaseUpdateFn prefix:
 *   jest.mock() factories are hoisted above imports. Variables used inside the
 *   factory must be prefixed with "mock" to pass Babel's hoisting safety check.
 */
/**
 * Extended jest.fn type that carries a `__nextResult` field for controlling
 * the return value of the chained `.eq()` call in tests.
 *
 * WHY extend rather than cast at each use-site: The pattern repeats across
 * multiple tests. Centralising the type here avoids repeated `as` casts and
 * keeps each test focused on the assertion rather than the type gymnastics.
 */
interface MockUpdateFn extends jest.Mock {
  __nextResult?: unknown;
}

const mockSupabaseUpdateFn: MockUpdateFn = jest.fn() as MockUpdateFn;
const mockSupabaseEqFn = jest.fn();
const mockSupabaseFromFn = jest.fn();

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      mockSupabaseFromFn(table);
      return {
        update: (data: Record<string, unknown>) => {
          mockSupabaseUpdateFn(data);
          return {
            eq: (col: string, val: string) => {
              mockSupabaseEqFn(col, val);
              return mockSupabaseUpdateFn.__nextResult ?? { error: null };
            },
          };
        },
      };
    },
  },
}));

// ============================================================================
// Test helpers
// ============================================================================

/** ISO timestamp for 'fresh' — 30s ago (well within 90s threshold). */
function freshHeartbeat(): string {
  return new Date(Date.now() - 30_000).toISOString();
}

/** ISO timestamp for 'stale' — 120s ago (beyond 90s threshold). */
function staleHeartbeat(): string {
  return new Date(Date.now() - 120_000).toISOString();
}

/** Build default props for easy overriding. */
function buildProps(overrides: Partial<SessionOrphanedBannerProps> = {}): SessionOrphanedBannerProps {
  return {
    sessionId: 'session-abc-123',
    status: 'running',
    lastHeartbeatAt: staleHeartbeat(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SessionOrphanedBanner', () => {
  beforeEach(() => {
    // Reset supabase mock state before each test
    mockSupabaseFromFn.mockClear();
    mockSupabaseUpdateFn.mockClear();
    mockSupabaseEqFn.mockClear();
    // Default: successful update
    mockSupabaseUpdateFn.__nextResult = { error: null };
  });

  // --------------------------------------------------------------------------
  // Case 1: Fresh session — renders nothing
  // --------------------------------------------------------------------------

  it('renders nothing when heartbeat is within 90s and status is active', () => {
    const { queryByTestId, queryByText } = render(
      <SessionOrphanedBanner {...buildProps({ lastHeartbeatAt: freshHeartbeat(), status: 'running' })} />,
    );

    expect(queryByTestId('orphaned-banner')).toBeNull();
    expect(queryByText(/session's CLI/i)).toBeNull();
  });

  it('renders nothing when heartbeat is exactly at 90s boundary (not yet stale)', () => {
    // 89s ago — should NOT trigger the banner
    const justUnderThreshold = new Date(Date.now() - 89_000).toISOString();
    const { queryByTestId } = render(
      <SessionOrphanedBanner {...buildProps({ lastHeartbeatAt: justUnderThreshold, status: 'running' })} />,
    );

    expect(queryByTestId('orphaned-banner')).toBeNull();
  });

  it('timeProvider: deterministically shows banner at 90001ms and hides it at 89999ms', () => {
    /**
     * WHY: Without timeProvider injection, 89s/90s boundary tests rely on
     * real-clock offsets that can drift on slow CI runners. By pinning both
     * "now" (via timeProvider) and lastHeartbeatAt to fixed epoch values we
     * make the threshold check 100% deterministic regardless of runner speed.
     */
    const fixedNow = 1_700_000_000_000; // arbitrary fixed epoch

    // 90001ms delta — just over threshold, banner MUST appear
    const staleFixed = new Date(fixedNow - 90_001).toISOString();
    const { queryByTestId: queryStale } = render(
      <SessionOrphanedBanner
        {...buildProps({ lastHeartbeatAt: staleFixed, status: 'running' })}
        timeProvider={() => fixedNow}
      />,
    );
    expect(queryStale('orphaned-banner')).toBeTruthy();

    // 89999ms delta — just under threshold, banner MUST NOT appear
    const freshFixed = new Date(fixedNow - 89_999).toISOString();
    const { queryByTestId: queryFresh } = render(
      <SessionOrphanedBanner
        {...buildProps({ lastHeartbeatAt: freshFixed, status: 'running' })}
        timeProvider={() => fixedNow}
      />,
    );
    expect(queryFresh('orphaned-banner')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Case 2: Stale heartbeat + active status — renders banner
  // --------------------------------------------------------------------------

  it('renders banner when heartbeat > 90s ago and status is active', () => {
    const { getByTestId, getByText } = render(
      <SessionOrphanedBanner {...buildProps({ lastHeartbeatAt: staleHeartbeat(), status: 'running' })} />,
    );

    expect(getByTestId('orphaned-banner')).toBeTruthy();
    expect(getByText(/This session's CLI was logged out/i)).toBeTruthy();
  });

  it('renders banner for all active statuses (starting, running, idle)', () => {
    // WHY 'paused' removed: SessionStatus = 'starting' | 'running' | 'idle' |
    // 'stopped' | 'error'. 'paused' is not in the union; it was dead code.
    const activeStatuses = ['starting', 'running', 'idle'] as const;

    for (const status of activeStatuses) {
      const { getByTestId, unmount } = render(
        <SessionOrphanedBanner {...buildProps({ lastHeartbeatAt: staleHeartbeat(), status })} />,
      );
      expect(getByTestId('orphaned-banner')).toBeTruthy();
      unmount();
    }
  });

  // --------------------------------------------------------------------------
  // Case 3: Non-active status — renders nothing even if heartbeat is stale
  // --------------------------------------------------------------------------

  it('renders nothing when status is stopped (even with stale heartbeat)', () => {
    const { queryByTestId } = render(
      <SessionOrphanedBanner {...buildProps({ lastHeartbeatAt: staleHeartbeat(), status: 'stopped' })} />,
    );

    expect(queryByTestId('orphaned-banner')).toBeNull();
  });

  it('renders nothing when status is not a recognised active status (e.g. a legacy value)', () => {
    // WHY cast through unknown to SessionStatus: 'expired' is not in the
    // SessionStatus union. The cast simulates a value arriving from an older
    // Supabase row before a migration cleaned up legacy status strings. The
    // component must safely return null in this case.
    const { queryByTestId } = render(
      <SessionOrphanedBanner
        {...buildProps({
          lastHeartbeatAt: staleHeartbeat(),
          status: 'expired' as unknown as SessionStatus,
        })}
      />,
    );

    expect(queryByTestId('orphaned-banner')).toBeNull();
  });

  it('renders nothing when status is error', () => {
    const { queryByTestId } = render(
      <SessionOrphanedBanner {...buildProps({ lastHeartbeatAt: staleHeartbeat(), status: 'error' })} />,
    );

    expect(queryByTestId('orphaned-banner')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Case 4: Dismiss button hides banner via local state
  // --------------------------------------------------------------------------

  it('dismiss button hides the banner without calling any API', async () => {
    const { getByTestId, queryByTestId } = render(
      <SessionOrphanedBanner {...buildProps()} />,
    );

    expect(getByTestId('orphaned-banner')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('dismiss-button'));
    });

    // Banner should be gone from the tree
    expect(queryByTestId('orphaned-banner')).toBeNull();

    // Supabase must NOT have been called
    expect(mockSupabaseFromFn).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Case 5: End Session calls Supabase update with correct sessionId
  // --------------------------------------------------------------------------

  it('End Session calls supabase.from("sessions").update({status:"stopped"}).eq("id", sessionId)', async () => {
    const sessionId = 'test-session-xyz-789';
    const { getByTestId } = render(
      <SessionOrphanedBanner {...buildProps({ sessionId })} />,
    );

    await act(async () => {
      fireEvent.press(getByTestId('end-session-button'));
    });

    await waitFor(() => {
      expect(mockSupabaseFromFn).toHaveBeenCalledWith('sessions');
      expect(mockSupabaseUpdateFn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'stopped' }),
      );
      expect(mockSupabaseEqFn).toHaveBeenCalledWith('id', sessionId);
    });
  });

  // --------------------------------------------------------------------------
  // Case 6: Loading state during End Session call
  // --------------------------------------------------------------------------

  it('shows loading state and disables End Session button while API call is in flight', async () => {
    // Make the supabase call hang indefinitely via a promise that never resolves
    let resolveUpdate: ((val: unknown) => void) | undefined;
    mockSupabaseUpdateFn.__nextResult =
      new Promise((resolve) => { resolveUpdate = resolve; });

    const { getByTestId } = render(
      <SessionOrphanedBanner {...buildProps()} />,
    );

    await act(async () => {
      fireEvent.press(getByTestId('end-session-button'));
    });

    // While pending: loading indicator should be present and button should be disabled
    expect(getByTestId('end-session-loading')).toBeTruthy();
    const btn = getByTestId('end-session-button');
    // Pressable accessibilityState.disabled should be true during loading
    expect(btn.props.accessibilityState?.disabled).toBe(true);

    // Resolve to prevent open handles
    await act(async () => {
      resolveUpdate?.({ error: null });
    });
  });

  // --------------------------------------------------------------------------
  // Case 7: Error state if API call fails — banner remains, error message shown
  // --------------------------------------------------------------------------

  it('shows error message when End Session API call fails and keeps banner visible', async () => {
    mockSupabaseUpdateFn.__nextResult = {
      error: { message: 'Network error' },
    };

    const { getByTestId, getByText, queryByTestId } = render(
      <SessionOrphanedBanner {...buildProps()} />,
    );

    await act(async () => {
      fireEvent.press(getByTestId('end-session-button'));
    });

    await waitFor(() => {
      // Banner must still be visible
      expect(queryByTestId('orphaned-banner')).toBeTruthy();
      // Error message should be displayed
      expect(getByText(/failed to end session/i)).toBeTruthy();
    });
  });

  it('clears error state and hides banner on successful retry after previous failure', async () => {
    // First call: fail
    mockSupabaseUpdateFn.__nextResult = {
      error: { message: 'timeout' },
    };

    const { getByTestId, queryByText, queryByTestId } = render(
      <SessionOrphanedBanner {...buildProps()} />,
    );

    await act(async () => {
      fireEvent.press(getByTestId('end-session-button'));
    });

    await waitFor(() => {
      expect(queryByText(/failed to end session/i)).toBeTruthy();
    });

    // Second call: succeed
    mockSupabaseUpdateFn.__nextResult = { error: null };

    await act(async () => {
      fireEvent.press(getByTestId('end-session-button'));
    });

    await waitFor(() => {
      expect(queryByTestId('orphaned-banner')).toBeNull();
    });
  });
});
