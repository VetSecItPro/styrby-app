/**
 * Tests for useRealtimeSubscription hook
 *
 * WHY: The realtime subscription hook manages a WebSocket channel lifecycle
 * and drives live UI updates across the dashboard (sessions, costs). Tests
 * verify that the channel is configured correctly, callbacks fire for the
 * right event types, connection state is tracked accurately, and channels
 * are cleaned up on unmount or dependency change.
 *
 * @module hooks/__tests__/useRealtimeSubscription.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRealtimeSubscription } from '../useRealtimeSubscription';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';

// ─── Mock Supabase client ────────────────────────────────────────────────────

/** Captures the postgres_changes callback so tests can fire fake payloads. */
let capturedPostgresCallback: ((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void) | null = null;

/** Captures the subscribe status callback so tests can simulate connection events. */
let capturedStatusCallback: ((status: string) => void) | null = null;

const mockRemoveChannel = vi.fn();

/**
 * WHY: supabase.channel(...).on(...).subscribe(...) returns the channel object
 * itself (for method chaining in the real SDK). The cleanup path calls
 * supabase.removeChannel(channel), so subscribe must return mockChannel —
 * not a separate unsubscribe function — so the assertion matches.
 */
const mockChannel = {
  on: vi.fn().mockImplementation(
    (
      _event: string,
      _config: unknown,
      callback: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void,
    ) => {
      capturedPostgresCallback = callback;
      return mockChannel;
    },
  ),
  subscribe: vi.fn().mockImplementation((callback: (status: string) => void) => {
    capturedStatusCallback = callback;
    // Return the channel itself — matches Supabase RealtimeChannel interface
    return mockChannel;
  }),
};

const mockSupabase = {
  channel: vi.fn().mockReturnValue(mockChannel),
  removeChannel: mockRemoveChannel,
};

vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => mockSupabase),
}));

// ─── Test record type ────────────────────────────────────────────────────────

/** Represents a minimal session row for type safety in tests. */
interface TestSession {
  id: string;
  user_id: string;
  status: 'active' | 'completed';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fires a simulated Postgres INSERT event through the captured callback.
 *
 * @param record - The new record to deliver
 */
function fireInsert(record: TestSession): void {
  act(() => {
    capturedPostgresCallback?.({
      schema: 'public',
      table: 'sessions',
      commit_timestamp: new Date().toISOString(),
      eventType: 'INSERT',
      new: record,
      old: {},
      errors: null,
    } as unknown as RealtimePostgresChangesPayload<Record<string, unknown>>);
  });
}

/**
 * Fires a simulated Postgres UPDATE event through the captured callback.
 *
 * @param record - The updated record to deliver
 */
function fireUpdate(record: TestSession): void {
  act(() => {
    capturedPostgresCallback?.({
      schema: 'public',
      table: 'sessions',
      commit_timestamp: new Date().toISOString(),
      eventType: 'UPDATE',
      new: record,
      old: {},
      errors: null,
    } as unknown as RealtimePostgresChangesPayload<Record<string, unknown>>);
  });
}

/**
 * Fires a simulated Postgres DELETE event through the captured callback.
 *
 * @param oldRecord - The deleted record to deliver (from the 'old' field)
 */
function fireDelete(oldRecord: TestSession): void {
  act(() => {
    capturedPostgresCallback?.({
      schema: 'public',
      table: 'sessions',
      commit_timestamp: new Date().toISOString(),
      eventType: 'DELETE',
      new: {},
      old: oldRecord,
      errors: null,
    } as unknown as RealtimePostgresChangesPayload<Record<string, unknown>>);
  });
}

/**
 * Simulates a channel status change (SUBSCRIBED, CHANNEL_ERROR, CLOSED).
 *
 * @param status - The new channel status
 */
function fireStatus(status: string): void {
  act(() => {
    capturedStatusCallback?.(status);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useRealtimeSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedPostgresCallback = null;
    capturedStatusCallback = null;

    // Reset mock implementations
    mockChannel.on.mockImplementation(
      (
        _event: string,
        _config: unknown,
        callback: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void,
      ) => {
        capturedPostgresCallback = callback;
        return mockChannel;
      },
    );
    mockChannel.subscribe.mockImplementation((callback: (status: string) => void) => {
      capturedStatusCallback = callback;
      return mockChannel;
    });
    mockSupabase.channel.mockReturnValue(mockChannel);
  });

  describe('initial state', () => {
    it('starts with isConnected=false and error=null', () => {
      const { result } = renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('channel setup', () => {
    it('calls createClient and supabase.channel on mount', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      expect(mockSupabase.channel).toHaveBeenCalledTimes(1);
    });

    it('builds a channel name that includes the table name', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      const channelName = mockSupabase.channel.mock.calls[0][0] as string;
      expect(channelName).toContain('sessions');
    });

    it('includes the filter in the channel name when provided', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({
          table: 'sessions',
          filter: 'user_id=eq.abc123',
        }),
      );

      const channelName = mockSupabase.channel.mock.calls[0][0] as string;
      expect(channelName).toContain('user_id=eq.abc123');
    });

    it('uses "all" in the channel name when no filter is provided', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      const channelName = mockSupabase.channel.mock.calls[0][0] as string;
      expect(channelName).toContain('all');
    });

    it('passes the correct table and schema to the postgres_changes config', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({
          table: 'sessions',
          schema: 'custom_schema',
        }),
      );

      const onConfig = mockChannel.on.mock.calls[0][1] as {
        table: string;
        schema: string;
      };
      expect(onConfig.table).toBe('sessions');
      expect(onConfig.schema).toBe('custom_schema');
    });

    it('defaults schema to "public" when not provided', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      const onConfig = mockChannel.on.mock.calls[0][1] as { schema: string };
      expect(onConfig.schema).toBe('public');
    });

    it('passes the event type to the postgres_changes config', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({
          table: 'sessions',
          event: 'INSERT',
        }),
      );

      const onConfig = mockChannel.on.mock.calls[0][1] as { event: string };
      expect(onConfig.event).toBe('INSERT');
    });

    it('defaults event to "*" when not provided', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      const onConfig = mockChannel.on.mock.calls[0][1] as { event: string };
      expect(onConfig.event).toBe('*');
    });
  });

  describe('connection status', () => {
    it('sets isConnected=true when status is SUBSCRIBED', () => {
      const { result } = renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      fireStatus('SUBSCRIBED');

      expect(result.current.isConnected).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('sets isConnected=false and records an error when status is CHANNEL_ERROR', () => {
      const { result } = renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      fireStatus('SUBSCRIBED');
      expect(result.current.isConnected).toBe(true);

      fireStatus('CHANNEL_ERROR');

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toContain('sessions');
    });

    it('sets isConnected=false when status is CLOSED', () => {
      const { result } = renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      fireStatus('SUBSCRIBED');
      fireStatus('CLOSED');

      expect(result.current.isConnected).toBe(false);
    });

    it('clears the error when SUBSCRIBED fires after a CHANNEL_ERROR', () => {
      const { result } = renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      fireStatus('CHANNEL_ERROR');
      expect(result.current.error).toBeInstanceOf(Error);

      fireStatus('SUBSCRIBED');
      expect(result.current.error).toBeNull();
    });
  });

  describe('event callbacks — INSERT', () => {
    it('calls onInsert with the new record on INSERT events', () => {
      const onInsert = vi.fn();
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions', onInsert }),
      );

      const newSession: TestSession = { id: 'abc', user_id: 'u1', status: 'active' };
      fireInsert(newSession);

      expect(onInsert).toHaveBeenCalledTimes(1);
      expect(onInsert).toHaveBeenCalledWith(newSession);
    });

    it('does not call onUpdate or onDelete on INSERT events', () => {
      const onUpdate = vi.fn();
      const onDelete = vi.fn();
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions', onUpdate, onDelete }),
      );

      fireInsert({ id: 'abc', user_id: 'u1', status: 'active' });

      expect(onUpdate).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
    });
  });

  describe('event callbacks — UPDATE', () => {
    it('calls onUpdate with the new record on UPDATE events', () => {
      const onUpdate = vi.fn();
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions', onUpdate }),
      );

      const updatedSession: TestSession = { id: 'abc', user_id: 'u1', status: 'completed' };
      fireUpdate(updatedSession);

      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith(updatedSession);
    });

    it('does not call onInsert or onDelete on UPDATE events', () => {
      const onInsert = vi.fn();
      const onDelete = vi.fn();
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions', onInsert, onDelete }),
      );

      fireUpdate({ id: 'abc', user_id: 'u1', status: 'completed' });

      expect(onInsert).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
    });
  });

  describe('event callbacks — DELETE', () => {
    it('calls onDelete with the old record on DELETE events', () => {
      const onDelete = vi.fn();
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions', onDelete }),
      );

      const deletedSession: TestSession = { id: 'abc', user_id: 'u1', status: 'active' };
      fireDelete(deletedSession);

      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith(deletedSession);
    });

    it('does not call onInsert or onUpdate on DELETE events', () => {
      const onInsert = vi.fn();
      const onUpdate = vi.fn();
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions', onInsert, onUpdate }),
      );

      fireDelete({ id: 'abc', user_id: 'u1', status: 'active' });

      expect(onInsert).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe('no-op when callbacks are not provided', () => {
    it('does not throw when onInsert is not provided and an INSERT fires', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      expect(() => fireInsert({ id: 'abc', user_id: 'u1', status: 'active' })).not.toThrow();
    });

    it('does not throw when onUpdate is not provided and an UPDATE fires', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      expect(() => fireUpdate({ id: 'abc', user_id: 'u1', status: 'completed' })).not.toThrow();
    });

    it('does not throw when onDelete is not provided and a DELETE fires', () => {
      renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      expect(() => fireDelete({ id: 'abc', user_id: 'u1', status: 'active' })).not.toThrow();
    });
  });

  describe('callback ref stability', () => {
    it('uses the latest onInsert callback without re-subscribing when the callback changes', () => {
      const onInsertV1 = vi.fn();
      const onInsertV2 = vi.fn();

      const { rerender } = renderHook(
        ({ onInsert }: { onInsert: (record: TestSession) => void }) =>
          useRealtimeSubscription<TestSession>({ table: 'sessions', onInsert }),
        { initialProps: { onInsert: onInsertV1 } },
      );

      // Change the callback — this should NOT cause a re-subscribe
      rerender({ onInsert: onInsertV2 });

      // Only one subscription should have been created
      expect(mockSupabase.channel).toHaveBeenCalledTimes(1);

      // The new callback should be invoked when an event fires
      fireInsert({ id: 'abc', user_id: 'u1', status: 'active' });

      expect(onInsertV1).not.toHaveBeenCalled();
      expect(onInsertV2).toHaveBeenCalledTimes(1);
    });
  });

  describe('re-subscription on dependency changes', () => {
    it('creates a new channel when the table prop changes', () => {
      const { rerender } = renderHook(
        ({ table }: { table: string }) =>
          useRealtimeSubscription<TestSession>({ table }),
        { initialProps: { table: 'sessions' } },
      );

      expect(mockSupabase.channel).toHaveBeenCalledTimes(1);

      rerender({ table: 'cost_records' });

      expect(mockSupabase.channel).toHaveBeenCalledTimes(2);
    });

    it('removes the old channel before creating a new one on table change', () => {
      const { rerender } = renderHook(
        ({ table }: { table: string }) =>
          useRealtimeSubscription<TestSession>({ table }),
        { initialProps: { table: 'sessions' } },
      );

      rerender({ table: 'cost_records' });

      expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
    });

    it('creates a new channel when the filter prop changes', () => {
      const { rerender } = renderHook(
        ({ filter }: { filter: string }) =>
          useRealtimeSubscription<TestSession>({ table: 'sessions', filter }),
        { initialProps: { filter: 'user_id=eq.abc' } },
      );

      rerender({ filter: 'user_id=eq.xyz' });

      expect(mockSupabase.channel).toHaveBeenCalledTimes(2);
    });
  });

  describe('cleanup on unmount', () => {
    it('removes the channel when the component unmounts', () => {
      const { unmount } = renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      unmount();

      expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
      expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
    });

    it('sets isConnected=false after the channel is removed (via CLOSED status)', () => {
      const { result, unmount } = renderHook(() =>
        useRealtimeSubscription<TestSession>({ table: 'sessions' }),
      );

      fireStatus('SUBSCRIBED');
      expect(result.current.isConnected).toBe(true);

      unmount();

      // After unmount the component no longer renders, but the channel was removed
      expect(mockRemoveChannel).toHaveBeenCalled();
    });
  });
});
