/**
 * WakeDetector
 *
 * Polls `os.uptime()` and `os.networkInterfaces()` at a fixed interval to
 * detect two conditions that should trigger an immediate relay reconnect:
 *
 *   1. Sleep/wake: if the elapsed wall-clock time between two polls is
 *      significantly larger than the poll interval, the system was suspended
 *      (macOS sleep, Linux suspend, VM pause).
 *   2. Network change: if the set of active network interfaces (name + family
 *      + address) changes between polls, a link came up or went down.
 *
 * WHY uptime-delta heuristic instead of NSWorkspace / pm-utils:
 *   Native OS sleep notifications require either a macOS-only Objective-C
 *   native addon (`NSWorkspace`) or a Linux D-Bus dependency. Both are heavy,
 *   brittle to cross-platform builds, and unnecessary: when a machine wakes
 *   from sleep `os.uptime()` keeps ticking but real time jumps. If the gap
 *   between two consecutive polls is larger than `pollIntervalMs + SLEEP_GRACE_MS`
 *   we can reliably infer a suspend/resume cycle. This approach works on
 *   macOS, Linux, and Windows with no native bindings, and handles both
 *   hardware sleep and VM suspension (Docker containers never truly sleep,
 *   so the heuristic fires only when there is an actual gap).
 *
 * WHY 10s grace:
 *   A slow event-loop tick under heavy CPU load can delay a poll by a few
 *   seconds. 10 seconds is wide enough to absorb the worst-case Node.js
 *   event-loop jitter while still catching the shortest practical sleep
 *   cycle (~15–20s on modern macOS).
 *
 * @module daemon/wakeDetector
 */

import { EventEmitter } from 'node:events';
import * as os from 'node:os';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default poll interval in milliseconds.
 * WHY 5 seconds: `os.uptime()` and `os.networkInterfaces()` are cheap syscalls
 * (< 1 ms each). Polling every 5 seconds keeps the reconnect latency under 10s
 * (poll fires within 5s of wake, then reconnect is immediate) without
 * measurable CPU impact even on constrained devices.
 */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Grace period added to the expected poll interval when checking for a sleep gap.
 * WHY 10 seconds: Node.js timers can be delayed by event-loop saturation,
 * GC pauses, or OS scheduling. 10s absorbs worst-case jitter while still
 * reliably detecting any real suspend cycle.
 */
const SLEEP_GRACE_MS = 10_000;

// ============================================================================
// Types
// ============================================================================

/** Events emitted by WakeDetector. */
interface WakeDetectorEvents {
  /** Fired when an OS sleep/resume cycle is detected. */
  wake: void;
  /** Fired when the active network interfaces change (link up/down, DHCP renew). */
  'network-change': void;
}

// ============================================================================
// WakeDetector
// ============================================================================

/**
 * Detects system sleep/wake and network topology changes via lightweight polling.
 *
 * Emits `'wake'` when a sleep gap is detected and `'network-change'` when
 * the active network interfaces change. Both events should trigger an immediate
 * relay reconnect in the caller.
 *
 * @example
 * ```typescript
 * const detector = new WakeDetector();
 * detector.on('wake', () => relay.scheduleReconnect(0, 'sleep-wake'));
 * detector.on('network-change', () => relay.scheduleReconnect(0, 'network-change'));
 * detector.start();
 * // later…
 * detector.stop();
 * ```
 */
export class WakeDetector extends EventEmitter {
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Wall-clock timestamp (Date.now()) of the most recent poll. */
  private lastPollAt: number = 0;

  /** Fingerprint of the network interfaces seen on the most recent poll. */
  private lastNetworkHash: string = '';

  /**
   * Create a WakeDetector instance.
   *
   * @param pollIntervalMs - How often to poll in ms (default 5000).
   *   Override in tests via vi.useFakeTimers() + vi.advanceTimersByTimeAsync().
   */
  constructor(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS) {
    super();
    this.pollIntervalMs = pollIntervalMs;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Begin polling. Safe to call multiple times — a second `start()` is a no-op
   * if already running.
   */
  start(): void {
    if (this.timer !== null) return;

    this.lastPollAt = Date.now();
    this.lastNetworkHash = hashNetworkInterfaces();

    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop polling and clear the interval. Safe to call when already stopped.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  /**
   * Execute one poll cycle: check for sleep gap and network change.
   * Called internally by the setInterval timer.
   */
  private poll(): void {
    const now = Date.now();
    const elapsed = now - this.lastPollAt;

    // --- Sleep/wake detection ---
    // WHY: If the wall-clock gap between polls exceeds the expected interval by
    // more than SLEEP_GRACE_MS we can infer the system was suspended. When the
    // machine wakes, this poll fires with `elapsed` equal to the full sleep
    // duration (potentially hours), which far exceeds the grace threshold.
    if (elapsed > this.pollIntervalMs + SLEEP_GRACE_MS) {
      this.emit('wake');
    }

    // --- Network change detection ---
    const currentHash = hashNetworkInterfaces();
    if (currentHash !== this.lastNetworkHash) {
      this.lastNetworkHash = currentHash;
      this.emit('network-change');
    }

    this.lastPollAt = now;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Produce a stable string fingerprint of the currently active network
 * interfaces. The fingerprint covers interface name, address family, and
 * IPv4/IPv6 address (CIDR). Order-independent: entries are sorted before
 * joining so a reorder does not trigger a spurious event.
 *
 * WHY we ignore loopback and internal interfaces: loopback (`lo`, `lo0`) is
 * always present and never changes. Including it would add noise without
 * adding signal about real connectivity changes.
 *
 * @returns A deterministic string that changes iff the set of active
 *   non-loopback interfaces changes.
 */
function hashNetworkInterfaces(): string {
  const ifaces = os.networkInterfaces();
  const entries: string[] = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue; // skip loopback
      entries.push(`${name}|${addr.family}|${addr.address}`);
    }
  }

  return entries.sort().join(';');
}
