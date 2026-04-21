/**
 * Tests for RelayClient reconnect behavior (relay/client.ts).
 *
 * Covers:
 * - Reconnect continues indefinitely past the old 10-attempt cap
 * - Exponential backoff delay is capped at 60 000 ms
 * - Only 401/403 auth errors stop retrying (emitting AUTH_ERROR)
 * - Non-auth errors (5xx, timeout, network) always retry
 * - `reconnecting` event is emitted with attempt number and delayMs on each retry
 * - `reconnectAttempts` counter keeps incrementing for diagnostics
 *
 * WHY fake timers: the reconnect loop uses setTimeout for backoff delays.
 * Real timers would make these tests take minutes. vi.useFakeTimers() +
 * vi.runAllTimersAsync() advances time synchronously so the full retry
 * sequence resolves in microseconds.
 *
 * @module relay/__tests__/client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayClient } from '../client.js';
import type { RelayClientConfig } from '../client.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a minimal RelayClientConfig with a fake Supabase client.
 *
 * @param subscribeCallback - Controls what status/error the channel.subscribe()
 *   mock passes back to the RelayClient internals. Defaults to always timing out.
 */
function makeConfig(
  subscribeCallback?: (
    cb: (status: string, err?: unknown) => void
  ) => void
): RelayClientConfig {
  // WHY explicit `as` casts: tsc strict mode cannot infer the recursive
  // self-referential mock type at declaration. Typing as `unknown` then
  // asserting satisfies the compiler without losing call-site safety.
  const channelMock = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn((cb: unknown) => {
      // Default: simulate a TIMED_OUT failure on every attempt
      if (subscribeCallback) {
        subscribeCallback(cb as (status: string, err?: unknown) => void);
      } else {
        (cb as (status: string) => void)('TIMED_OUT');
      }
      return channelMock;
    }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue('ok'),
    track: vi.fn().mockResolvedValue(undefined),
    presenceState: vi.fn().mockReturnValue({}),
  };

  const supabaseMock = {
    channel: vi.fn().mockReturnValue(channelMock),
    removeChannel: vi.fn().mockReturnValue(undefined),
  };

  return {
    supabase: supabaseMock as unknown as RelayClientConfig['supabase'],
    userId: 'user-abc',
    deviceId: 'device-xyz',
    deviceType: 'cli',
    debug: false,
  };
}

// ============================================================================
// Helpers — timer advancement
// ============================================================================

/**
 * Advance fake timers by `steps` cycles, each advancing 65 seconds (slightly
 * more than the 60s backoff ceiling). This fires exactly one scheduled
 * reconnect timeout per step without triggering the infinite-loop guard.
 *
 * WHY 65 000 ms per step: The reconnect delay is capped at 60 000 ms.
 * Advancing by 65 000 ms fires the pending timer and lets the connect()
 * call run synchronously (it fails immediately because subscribe fires
 * TIMED_OUT synchronously in tests). The reconnect schedules the NEXT
 * timer, which we advance in the following step — so we get exactly one
 * attempt per step.
 */
async function advanceReconnectCycles(steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await vi.advanceTimersByTimeAsync(65_000);
  }
}

// ============================================================================
// Unbounded reconnect
// ============================================================================

describe('RelayClient — unbounded reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues retrying past the old 10-attempt cap', async () => {
    const client = new RelayClient(makeConfig());
    const reconnectingEvents: Array<{ attempt: number; delayMs: number }> = [];
    const errorEvents: Array<{ message: string; code?: string }> = [];

    client.on('reconnecting', (e) => reconnectingEvents.push(e));
    client.on('error', (e) => errorEvents.push(e));

    // Start connecting (will fail immediately with TIMED_OUT)
    await client.connect();

    // Drive reconnect loop past 15 attempts to prove no cap
    await advanceReconnectCycles(15);

    // Should have attempted many reconnects — well past the old limit of 10
    expect(reconnectingEvents.length).toBeGreaterThan(10);

    // No AUTH_ERROR should have been emitted
    const authErrors = errorEvents.filter((e) => e.code === 'AUTH_ERROR');
    expect(authErrors).toHaveLength(0);
  });

  it('emits reconnecting event with incrementing attempt numbers', async () => {
    const client = new RelayClient(makeConfig());
    const attempts: number[] = [];

    client.on('reconnecting', (e) => attempts.push(e.attempt));

    await client.connect();

    // Advance through 5 retry cycles
    await advanceReconnectCycles(5);

    // Attempts must be strictly ascending (1, 2, 3, ...)
    for (let i = 1; i < attempts.length; i++) {
      expect(attempts[i]).toBeGreaterThan(attempts[i - 1]);
    }
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Backoff cap
// ============================================================================

describe('RelayClient — backoff delay capped at 60 000 ms', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps delay at 60 000 ms even after many attempts', async () => {
    const client = new RelayClient(makeConfig());
    const delays: number[] = [];

    client.on('reconnecting', (e) => delays.push(e.delayMs));

    await client.connect();

    // Advance enough cycles for the exponential to overflow the cap
    // Backoff sequence: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped), 60s, ...
    await advanceReconnectCycles(10);

    // Every delay must be <= 60 000 ms
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(60_000);
    }

    // At least one delay should hit the ceiling (attempt >= 7 saturates it)
    const atCeiling = delays.filter((d) => d === 60_000);
    expect(atCeiling.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Auth-error stops retry
// ============================================================================

describe('RelayClient — auth error stops retrying', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops retrying and emits AUTH_ERROR when subscribe receives a 401 error', async () => {
    // WHY: Supabase Realtime delivers 401 as a CHANNEL_ERROR with an error
    // object whose stringified form contains "401". We simulate that here.
    const config = makeConfig((cb) => {
      cb('CHANNEL_ERROR', new Error('JWT expired: 401 Unauthorized'));
    });

    const client = new RelayClient(config);
    const reconnectingEvents: Array<{ attempt: number }> = [];
    const errorEvents: Array<{ message: string; code?: string }> = [];

    client.on('reconnecting', (e) => reconnectingEvents.push(e));
    client.on('error', (e) => errorEvents.push(e));

    await client.connect();

    // Advance timers — no additional retries should fire
    await vi.advanceTimersByTimeAsync(130_000);

    // Must not have scheduled any reconnect attempts
    expect(reconnectingEvents).toHaveLength(0);

    // Must have emitted exactly one AUTH_ERROR
    const authErrors = errorEvents.filter((e) => e.code === 'AUTH_ERROR');
    expect(authErrors).toHaveLength(1);
    expect(authErrors[0].message).toMatch(/401|403|re-authenticate/i);
  });

  it('stops retrying and emits AUTH_ERROR when subscribe receives a 403 error', async () => {
    const config = makeConfig((cb) => {
      cb('CHANNEL_ERROR', 'HTTP 403 Forbidden');
    });

    const client = new RelayClient(config);
    const errorEvents: Array<{ message: string; code?: string }> = [];
    const reconnectingEvents: Array<{ attempt: number }> = [];

    client.on('error', (e) => errorEvents.push(e));
    client.on('reconnecting', (e) => reconnectingEvents.push(e));

    await client.connect();
    await vi.advanceTimersByTimeAsync(130_000);

    expect(reconnectingEvents).toHaveLength(0);
    const authErrors = errorEvents.filter((e) => e.code === 'AUTH_ERROR');
    expect(authErrors).toHaveLength(1);
  });

  it('continues retrying on a 500 server error (not an auth error)', async () => {
    // WHY: A Supabase 5xx is transient — the relay should keep retrying.
    // This verifies the auth-error check doesn't accidentally catch 5xx codes.
    const config = makeConfig((cb) => {
      cb('CHANNEL_ERROR', new Error('Internal server error: 500'));
    });

    const client = new RelayClient(config);
    const reconnectingEvents: Array<{ attempt: number }> = [];
    const errorEvents: Array<{ message: string; code?: string }> = [];

    client.on('reconnecting', (e) => reconnectingEvents.push(e));
    client.on('error', (e) => errorEvents.push(e));

    await client.connect();
    await advanceReconnectCycles(5);

    // Must have retried (no auth stop)
    expect(reconnectingEvents.length).toBeGreaterThan(0);

    // Must NOT have emitted AUTH_ERROR
    const authErrors = errorEvents.filter((e) => e.code === 'AUTH_ERROR');
    expect(authErrors).toHaveLength(0);
  });

  it('continues retrying on a connection timeout (not an auth error)', async () => {
    // Default config simulates TIMED_OUT — should retry indefinitely
    const client = new RelayClient(makeConfig());
    const reconnectingEvents: Array<{ attempt: number }> = [];

    client.on('reconnecting', (e) => reconnectingEvents.push(e));

    await client.connect();
    await advanceReconnectCycles(3);

    expect(reconnectingEvents.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Attempt counter persists across retries
// ============================================================================

describe('RelayClient — reconnectAttempts diagnostic counter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attempt number in reconnecting events is always the total lifetime count', async () => {
    const client = new RelayClient(makeConfig());
    const attempts: number[] = [];

    client.on('reconnecting', (e) => attempts.push(e.attempt));

    await client.connect();
    await advanceReconnectCycles(4);

    // Attempts must start at 1 and increment by 1 each time
    expect(attempts[0]).toBe(1);
    for (let i = 1; i < attempts.length; i++) {
      expect(attempts[i]).toBe(attempts[i - 1] + 1);
    }
  });
});
