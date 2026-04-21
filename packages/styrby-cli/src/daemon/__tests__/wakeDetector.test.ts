/**
 * Tests for WakeDetector — sleep/wake and network-change event detection.
 *
 * Covers:
 * - Sleep gap detection: wall-clock jump > pollInterval + grace → emits `'wake'`
 * - Steady-state polling: no gap, no wake event
 * - Network change: `os.networkInterfaces()` returns a different set → emits `'network-change'`
 * - Same network, same timing → no event
 * - `stop()` clears the interval (no events after stop)
 * - `stop()` idempotent — calling twice does not throw
 * - `start()` idempotent — calling twice does not double-fire events
 *
 * WHY vi.useFakeTimers() + vi.advanceTimersByTimeAsync():
 *   WakeDetector polls every 5 seconds. Letting that run in real time would
 *   make tests slow and flaky. Fake timers advance both `Date.now()` and
 *   `setInterval` synchronously so the entire suite runs in microseconds.
 *
 * WHY vi.mock('node:os') instead of vi.spyOn(os, ...):
 *   In ESM, `node:os` exports are defined as non-configurable properties on
 *   the module namespace object. `vi.spyOn()` tries to redefine them via
 *   `Object.defineProperty`, which throws "Cannot redefine property". Full
 *   module mocking with vi.mock() replaces the entire namespace so each
 *   exported function becomes a configurable vi.fn() that we can control
 *   per-test with `mockReturnValue` / `mockReturnValueOnce`.
 *
 * @module daemon/__tests__/wakeDetector
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Module-level mock for node:os
// WHY declared at module scope: vi.mock() is hoisted to the top of the file
// by Vitest, so it must be called unconditionally. The factory runs once.
// ============================================================================

vi.mock('node:os', () => ({
  default: {
    networkInterfaces: vi.fn(),
    uptime: vi.fn(),
    homedir: vi.fn(() => '/tmp'),
    hostname: vi.fn(() => 'test-host'),
  },
  networkInterfaces: vi.fn(),
  uptime: vi.fn(),
  homedir: vi.fn(() => '/tmp'),
  hostname: vi.fn(() => 'test-host'),
}));

// Import AFTER mock is declared so we get the mocked version.
import * as os from 'node:os';
import { WakeDetector } from '../wakeDetector.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a stable fake `NetworkInterfaceInfo[]` entry.
 * @param address - IPv4 address string (default: '192.168.1.100')
 */
function makeInterfaces(address = '192.168.1.100'): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return {
    eth0: [
      {
        address,
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: `${address}/24`,
      },
    ],
  };
}

// Cast to vi.Mock so we can call mockReturnValue / mockReturnValueOnce.
const mockNetworkInterfaces = os.networkInterfaces as ReturnType<typeof vi.fn>;

// ============================================================================
// Tests
// ============================================================================

describe('WakeDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default: stable network
    mockNetworkInterfaces.mockReturnValue(makeInterfaces('192.168.1.100'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Sleep/wake detection
  // --------------------------------------------------------------------------

  it('emits "wake" when wall-clock delta exceeds pollInterval + grace', async () => {
    /**
     * WHY this approach (setSystemTime + small timer advance):
     *
     * `vi.advanceTimersByTimeAsync(60_000)` fires 12 poll callbacks at 5s
     * intervals (5s, 10s, 15s... 60s). Each poll sees `elapsed ≈ 5 000ms`
     * (the interval between consecutive polls) — never 60s — because
     * `lastPollAt` is updated on every tick. That correctly models the
     * steady-state case and produces no wake event.
     *
     * To model a real OS sleep we need `Date.now()` to jump by a large
     * amount between two successive poll() invocations WITHOUT any
     * intermediate poll firing. `vi.setSystemTime()` jumps the wall clock
     * without advancing queued timers. The sequence is:
     *
     * 1. start() → lastPollAt = T0
     * 2. advance 4 999ms → no interval fires yet (interval is 5 000ms)
     * 3. setSystemTime(T0 + 4 999 + 20 000) → clock jumps 20s, no timer fires
     * 4. advance 2ms → interval fires at T0 + 5 001ms (timer side)
     *    elapsed = (T0 + 24 999) - T0 = 24 999ms > 5 000 + 10 000 = 15 000ms
     *    → wake event emitted ✓
     */
    const detector = new WakeDetector(5_000);
    const wakeSpy = vi.fn<[], void>();
    detector.on('wake', wakeSpy);

    detector.start();
    const startTime = Date.now();

    // Step 1: advance almost to the poll boundary (4 999ms) — no poll fires yet.
    await vi.advanceTimersByTimeAsync(4_999);

    // Step 2: jump the wall clock 20s forward (simulates sleep) without
    // firing any timers. Timer queue still thinks only 4 999ms have passed.
    vi.setSystemTime(startTime + 4_999 + 20_000);

    // Step 3: advance the remaining 2ms to fire the interval callback.
    // elapsed = Date.now() - lastPollAt = (T0+24 999) - T0 = 24 999ms > 15 000ms.
    await vi.advanceTimersByTimeAsync(2);

    expect(wakeSpy).toHaveBeenCalledTimes(1);
    detector.stop();
  });

  it('does NOT emit "wake" during steady-state polling (no time gap)', async () => {
    /**
     * WHY no event: advancing the clock exactly 5s at a time means each
     * successive poll sees elapsed ≈ 5 000ms, which equals pollIntervalMs
     * and does NOT exceed pollIntervalMs + SLEEP_GRACE_MS (15 000ms).
     */
    const detector = new WakeDetector(5_000);
    const wakeSpy = vi.fn<[], void>();
    detector.on('wake', wakeSpy);

    detector.start();

    // Three normal ticks — elapsed per tick ≈ 5s, well under the 15s threshold.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(wakeSpy).not.toHaveBeenCalled();
    detector.stop();
  });

  // --------------------------------------------------------------------------
  // Network change detection
  // --------------------------------------------------------------------------

  it('emits "network-change" when the active network interfaces change', async () => {
    // First call during start() — set the baseline
    mockNetworkInterfaces.mockReturnValueOnce(makeInterfaces('10.0.0.1'));
    // Second call during the poll after advanceTimers — new address
    mockNetworkInterfaces.mockReturnValueOnce(makeInterfaces('10.0.1.50'));

    const detector = new WakeDetector(5_000);
    const netSpy = vi.fn<[], void>();
    detector.on('network-change', netSpy);

    detector.start();

    // Advance one poll interval
    await vi.advanceTimersByTimeAsync(5_000);

    expect(netSpy).toHaveBeenCalledTimes(1);
    detector.stop();
  });

  it('does NOT emit "network-change" when the interfaces stay the same', async () => {
    // Both start() and every subsequent poll return the same interface set.
    mockNetworkInterfaces.mockReturnValue(makeInterfaces('192.168.1.100'));

    const detector = new WakeDetector(5_000);
    const netSpy = vi.fn<[], void>();
    detector.on('network-change', netSpy);

    detector.start();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(netSpy).not.toHaveBeenCalled();
    detector.stop();
  });

  // --------------------------------------------------------------------------
  // Combined: no event when both are stable
  // --------------------------------------------------------------------------

  it('emits no events when both uptime and network are stable', async () => {
    mockNetworkInterfaces.mockReturnValue(makeInterfaces('192.168.1.100'));

    const detector = new WakeDetector(5_000);
    const wakeSpy = vi.fn<[], void>();
    const netSpy = vi.fn<[], void>();
    detector.on('wake', wakeSpy);
    detector.on('network-change', netSpy);

    detector.start();

    // Three normal ticks
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(wakeSpy).not.toHaveBeenCalled();
    expect(netSpy).not.toHaveBeenCalled();
    detector.stop();
  });

  // --------------------------------------------------------------------------
  // stop() clears the interval
  // --------------------------------------------------------------------------

  it('stop() prevents further events after being called', async () => {
    // Baseline at start time
    mockNetworkInterfaces.mockReturnValueOnce(makeInterfaces('10.0.0.1'));
    // What would be returned if the poll fired — but it should NOT fire after stop()
    mockNetworkInterfaces.mockReturnValue(makeInterfaces('99.99.99.99'));

    const detector = new WakeDetector(5_000);
    const wakeSpy = vi.fn<[], void>();
    const netSpy = vi.fn<[], void>();
    detector.on('wake', wakeSpy);
    detector.on('network-change', netSpy);

    detector.start();

    // Stop immediately — before any poll tick fires
    detector.stop();

    // Advance time well past any poll + sleep-gap threshold
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wakeSpy).not.toHaveBeenCalled();
    expect(netSpy).not.toHaveBeenCalled();
  });

  it('stop() is idempotent — calling it twice does not throw', () => {
    const detector = new WakeDetector(5_000);
    detector.start();
    expect(() => {
      detector.stop();
      detector.stop();
    }).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // start() idempotency
  // --------------------------------------------------------------------------

  it('start() is idempotent — calling it twice does not double-fire events', async () => {
    // Baseline at start()
    mockNetworkInterfaces.mockReturnValueOnce(makeInterfaces('10.0.0.1'));
    // Changed network — should fire exactly once (one interval, not two)
    mockNetworkInterfaces.mockReturnValue(makeInterfaces('10.0.1.1'));

    const detector = new WakeDetector(5_000);
    const netSpy = vi.fn<[], void>();
    detector.on('network-change', netSpy);

    detector.start();
    detector.start(); // no-op

    await vi.advanceTimersByTimeAsync(5_000);

    // Should have exactly one event — one interval, not two
    expect(netSpy).toHaveBeenCalledTimes(1);
    detector.stop();
  });
});
