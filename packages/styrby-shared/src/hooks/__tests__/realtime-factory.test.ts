/**
 * Tests for the realtime subscription factory (Phase 0.10).
 *
 * Uses a mock Supabase client so the tests stay offline. The mock records
 * `channel()`, `on()`, `subscribe()`, and `removeChannel()` calls so we can
 * assert lifecycle ordering without standing up a real Realtime server.
 *
 * @module hooks/__tests__/realtime-factory
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createRealtimeSubscription,
  subscribeToSessions,
  subscribeToCostRecords,
} from '../realtime-factory.js';

/**
 * Build a stand-in Supabase client whose `channel()` returns a chainable
 * object recording every call.
 */
function makeMockClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const channelObj: any = {};
  channelObj.on = vi.fn((..._args: unknown[]) => {
    calls.push({ method: 'on', args: _args });
    return channelObj;
  });
  channelObj.subscribe = vi.fn((cb?: (status: string) => void) => {
    calls.push({ method: 'subscribe', args: [] });
    cb?.('SUBSCRIBED');
    return channelObj;
  });
  const client: any = {
    channel: vi.fn((name: string) => {
      calls.push({ method: 'channel', args: [name] });
      return channelObj;
    }),
    removeChannel: vi.fn((ch: unknown) => {
      calls.push({ method: 'removeChannel', args: [ch] });
    }),
  };
  return { client, calls, channelObj };
}

describe('createRealtimeSubscription', () => {
  it('opens a channel with the configured name and registers the events', () => {
    const { client, calls } = makeMockClient();
    createRealtimeSubscription({
      client,
      channelName: 'sessions:user:abc',
      table: 'sessions',
      filter: 'user_id=eq.abc',
      onChange: () => {},
    });
    expect(calls[0]).toEqual({ method: 'channel', args: ['sessions:user:abc'] });
    // INSERT, UPDATE, DELETE → 3 .on() calls
    expect(calls.filter((c) => c.method === 'on').length).toBe(3);
    expect(calls.some((c) => c.method === 'subscribe')).toBe(true);
  });

  it('unsubscribe() releases the channel exactly once (idempotent)', () => {
    const { client, calls } = makeMockClient();
    const sub = createRealtimeSubscription({
      client,
      channelName: 'x',
      table: 'sessions',
      onChange: () => {},
    });
    sub.unsubscribe();
    sub.unsubscribe();
    sub.unsubscribe();
    expect(calls.filter((c) => c.method === 'removeChannel').length).toBe(1);
  });

  it('does not call onChange after unsubscribe', () => {
    const { client, channelObj } = makeMockClient();
    const onChange = vi.fn();
    const sub = createRealtimeSubscription({
      client,
      channelName: 'x',
      table: 'sessions',
      onChange,
    });

    // Grab the registered postgres_changes callback and invoke it.
    const captured = channelObj.on.mock.calls[0][2] as (p: { new: any }) => void;
    captured({ new: { id: 1 } });
    expect(onChange).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    captured({ new: { id: 2 } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('routes onChange errors through onError', () => {
    const { client, channelObj } = makeMockClient();
    const onError = vi.fn();
    createRealtimeSubscription({
      client,
      channelName: 'x',
      table: 'sessions',
      onChange: () => {
        throw new Error('boom');
      },
      onError,
    });
    const captured = channelObj.on.mock.calls[0][2] as (p: { new: any }) => void;
    captured({ new: { id: 1 } });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('subscribeToSessions / subscribeToCostRecords helpers', () => {
  it('subscribeToSessions filters by user_id', () => {
    const { client, calls } = makeMockClient();
    subscribeToSessions(client, 'abc-123', () => {});
    expect(calls[0].args[0]).toBe('sessions:user:abc-123');
  });

  it('subscribeToCostRecords filters by user_id', () => {
    const { client, calls } = makeMockClient();
    subscribeToCostRecords(client, 'abc-123', () => {});
    expect(calls[0].args[0]).toBe('cost_records:user:abc-123');
  });
});
