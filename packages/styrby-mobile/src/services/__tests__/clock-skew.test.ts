/**
 * Clock-Skew Tolerance Test Suite
 *
 * Tests the normalizeOrderingTimestamp() / compareMessageOrder() /
 * isCriticallySkewed() functions that guard offline queue replay ordering
 * against phone clock drift.
 *
 * Scenarios covered:
 * - Server sequence wins over all timestamps
 * - Server timestamp wins over local timestamp
 * - Local timestamp fallback when no server data
 * - +3h skew detected, correct timestamp still used
 * - -3h skew detected, correct timestamp still used
 * - Exact 3h boundary (tolerance boundary)
 * - Sub-1s skew not flagged (noise filter)
 * - isCriticallySkewed threshold
 * - compareMessageOrder sorts batches correctly under skew
 * - buildOrderingKey constructs keys correctly
 *
 * WHY fake timestamps, not Date.now(): These tests must be deterministic
 * across timezones and DST edge changes. We pass explicit epoch values and
 * ISO strings rather than computing from the current wall clock.
 */

import {
  normalizeOrderingTimestamp,
  compareMessageOrder,
  buildOrderingKey,
  isCriticallySkewed,
  CLOCK_SKEW_TOLERANCE_MS,
} from '../clock-skew';
import type { MessageOrderingKey } from '../../types/offline-queue';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Reference epoch values for deterministic tests.
 * WHY 2026-04-21T10:00:00.000Z: A fixed "real time" for all skew scenarios.
 */
const REAL_TIME_MS = Date.parse('2026-04-21T10:00:00.000Z');
const REAL_TIME_ISO = '2026-04-21T10:00:00.000Z';

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_SECOND_MS = 1_000;

/** Local clock showing +3h skew (phone thinks it's 13:00, real time is 10:00) */
const LOCAL_PLUS_3H_ISO = new Date(REAL_TIME_MS + THREE_HOURS_MS).toISOString();
/** Local clock showing -3h skew (phone thinks it's 07:00, real time is 10:00) */
const LOCAL_MINUS_3H_ISO = new Date(REAL_TIME_MS - THREE_HOURS_MS).toISOString();
/** Local clock with tiny noise (<1s) */
const LOCAL_PLUS_500MS_ISO = new Date(REAL_TIME_MS + 500).toISOString();

// ============================================================================
// normalizeOrderingTimestamp()
// ============================================================================

describe('normalizeOrderingTimestamp()', () => {
  // --------------------------------------------------------------------------
  // Source: serverSequence (highest priority)
  // --------------------------------------------------------------------------

  describe('when serverSequence is provided', () => {
    it('uses serverSequence as the ordering source regardless of other fields', () => {
      const key: MessageOrderingKey = {
        serverSequence: 42,
        serverTimestamp: REAL_TIME_ISO,
        localTimestamp: LOCAL_PLUS_3H_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.source).toBe('serverSequence');
      expect(result.timestamp).toBe(new Date(42).toISOString());
    });

    it('reports no skew detected when serverSequence is used', () => {
      const key: MessageOrderingKey = {
        serverSequence: 1000,
        localTimestamp: LOCAL_PLUS_3H_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.skewDetected).toBe(false);
      expect(result.skewMs).toBe(0);
    });

    it('handles serverSequence = 0 (valid monotonic start)', () => {
      const key: MessageOrderingKey = {
        serverSequence: 0,
        localTimestamp: REAL_TIME_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.source).toBe('serverSequence');
      expect(result.timestamp).toBe(new Date(0).toISOString());
    });

    it('produces monotonically ordered ISO timestamps for ascending sequences', () => {
      const sequences = [100, 200, 300, 400, 500];
      const timestamps = sequences.map((seq) =>
        normalizeOrderingTimestamp({ serverSequence: seq, localTimestamp: REAL_TIME_ISO }).timestamp
      );

      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i] > timestamps[i - 1]).toBe(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Source: serverTimestamp (second priority)
  // --------------------------------------------------------------------------

  describe('when serverTimestamp is provided (no serverSequence)', () => {
    it('uses serverTimestamp as the ordering source', () => {
      const key: MessageOrderingKey = {
        serverTimestamp: REAL_TIME_ISO,
        localTimestamp: LOCAL_PLUS_3H_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.source).toBe('serverTimestamp');
      expect(result.timestamp).toBe(REAL_TIME_ISO);
    });

    it('detects +3h skew (local ahead of server)', () => {
      const key: MessageOrderingKey = {
        serverTimestamp: REAL_TIME_ISO,
        localTimestamp: LOCAL_PLUS_3H_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.skewDetected).toBe(true);
      expect(result.skewMs).toBeCloseTo(THREE_HOURS_MS, -2); // within 100ms
    });

    it('detects -3h skew (local behind server)', () => {
      const key: MessageOrderingKey = {
        serverTimestamp: REAL_TIME_ISO,
        localTimestamp: LOCAL_MINUS_3H_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.skewDetected).toBe(true);
      expect(result.skewMs).toBeCloseTo(THREE_HOURS_MS, -2);
    });

    it('still uses serverTimestamp for ordering even when skew is detected', () => {
      /**
       * WHY: The point of skew detection is telemetry, not to fall back to
       * the skewed local clock. We always prefer the server timestamp.
       */
      const key: MessageOrderingKey = {
        serverTimestamp: REAL_TIME_ISO,
        localTimestamp: LOCAL_PLUS_3H_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.timestamp).toBe(REAL_TIME_ISO);
    });

    it('does not flag sub-1s difference as skew (noise filter)', () => {
      const key: MessageOrderingKey = {
        serverTimestamp: REAL_TIME_ISO,
        localTimestamp: LOCAL_PLUS_500MS_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.skewDetected).toBe(false);
      expect(result.skewMs).toBe(500);
    });

    it('handles exactly 1h skew — detected but within tolerance', () => {
      const localOneHourAhead = new Date(REAL_TIME_MS + ONE_HOUR_MS).toISOString();
      const key: MessageOrderingKey = {
        serverTimestamp: REAL_TIME_ISO,
        localTimestamp: localOneHourAhead,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.skewDetected).toBe(true);
      expect(result.skewMs).toBeCloseTo(ONE_HOUR_MS, -2);
      // Still use server timestamp
      expect(result.timestamp).toBe(REAL_TIME_ISO);
    });

    it('handles exactly 3h boundary — edge case for CLOCK_SKEW_TOLERANCE_MS', () => {
      /**
       * A skew of exactly CLOCK_SKEW_TOLERANCE_MS is still detected as skew
       * (the tolerance is for isCriticallySkewed, not for detection here).
       * skewDetected reflects |skew| > 1s — 3h > 1s → true.
       */
      const key: MessageOrderingKey = {
        serverTimestamp: REAL_TIME_ISO,
        localTimestamp: LOCAL_PLUS_3H_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.skewDetected).toBe(true);
      expect(result.skewMs).toBeGreaterThanOrEqual(THREE_HOURS_MS - 1000);
    });
  });

  // --------------------------------------------------------------------------
  // Source: local (fallback)
  // --------------------------------------------------------------------------

  describe('when only localTimestamp is provided', () => {
    it('uses local timestamp as fallback', () => {
      const key: MessageOrderingKey = {
        localTimestamp: REAL_TIME_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.source).toBe('local');
      expect(result.timestamp).toBe(REAL_TIME_ISO);
    });

    it('reports no skew (no server data to compare against)', () => {
      const key: MessageOrderingKey = {
        localTimestamp: REAL_TIME_ISO,
      };

      const result = normalizeOrderingTimestamp(key);

      expect(result.skewDetected).toBe(false);
      expect(result.skewMs).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // nowMs injection
  // --------------------------------------------------------------------------

  describe('nowMs injection for deterministic testing', () => {
    it('accepts a custom nowMs parameter without using it for timestamp selection', () => {
      // nowMs is provided but only used internally for future extensions
      // (currently unused in selection logic — this test verifies the API
      //  signature accepts it without throwing)
      const key: MessageOrderingKey = {
        serverTimestamp: REAL_TIME_ISO,
        localTimestamp: LOCAL_PLUS_3H_ISO,
      };

      expect(() => normalizeOrderingTimestamp(key, REAL_TIME_MS)).not.toThrow();
    });
  });
});

// ============================================================================
// compareMessageOrder()
// ============================================================================

describe('compareMessageOrder()', () => {
  it('sorts messages by server timestamp correctly under +3h local skew', () => {
    /**
     * Scenario: 3 messages queued at real times 10:00, 10:01, 10:02.
     * Local clock is +3h skewed, so local timestamps are 13:00, 13:01, 13:02.
     * Server timestamps correct this.
     * Expected sort order: msg1 < msg2 < msg3 (chronological).
     */
    const makeKey = (realMinuteOffset: number): MessageOrderingKey => ({
      serverTimestamp: new Date(REAL_TIME_MS + realMinuteOffset * 60_000).toISOString(),
      localTimestamp: new Date(REAL_TIME_MS + realMinuteOffset * 60_000 + THREE_HOURS_MS).toISOString(),
    });

    const keyA = makeKey(0);  // 10:00 real, 13:00 local
    const keyB = makeKey(2);  // 10:02 real, 13:02 local
    const keyC = makeKey(1);  // 10:01 real, 13:01 local

    const sorted = [keyA, keyB, keyC].sort(compareMessageOrder);

    expect(new Date(sorted[0].serverTimestamp!).getMinutes()).toBe(0);
    expect(new Date(sorted[1].serverTimestamp!).getMinutes()).toBe(1);
    expect(new Date(sorted[2].serverTimestamp!).getMinutes()).toBe(2);
  });

  it('sorts messages by local timestamp when no server data (local fallback)', () => {
    const keyEarlier: MessageOrderingKey = { localTimestamp: '2026-04-21T10:00:00.000Z' };
    const keyLater: MessageOrderingKey = { localTimestamp: '2026-04-21T11:00:00.000Z' };
    const keyMiddle: MessageOrderingKey = { localTimestamp: '2026-04-21T10:30:00.000Z' };

    const sorted = [keyLater, keyEarlier, keyMiddle].sort(compareMessageOrder);

    expect(sorted[0]).toEqual(keyEarlier);
    expect(sorted[1]).toEqual(keyMiddle);
    expect(sorted[2]).toEqual(keyLater);
  });

  it('serverSequence ordering is monotonic regardless of timestamp values', () => {
    const keySeq1: MessageOrderingKey = { serverSequence: 1, localTimestamp: '2026-04-21T15:00:00.000Z' };
    const keySeq3: MessageOrderingKey = { serverSequence: 3, localTimestamp: '2026-04-21T10:00:00.000Z' };
    const keySeq2: MessageOrderingKey = { serverSequence: 2, localTimestamp: '2026-04-21T20:00:00.000Z' };

    const sorted = [keySeq3, keySeq1, keySeq2].sort(compareMessageOrder);

    expect(sorted[0].serverSequence).toBe(1);
    expect(sorted[1].serverSequence).toBe(2);
    expect(sorted[2].serverSequence).toBe(3);
  });

  it('returns 0 for identical ordering timestamps', () => {
    const key: MessageOrderingKey = { localTimestamp: REAL_TIME_ISO };
    const result = compareMessageOrder(key, key);
    expect(result).toBe(0);
  });

  it('sorts a batch of 50 messages with mixed server/local timestamps correctly', () => {
    const BATCH_SIZE = 50;
    // Half with server timestamps (even indices), half local-only (odd indices)
    const keys: MessageOrderingKey[] = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const realMs = REAL_TIME_MS + i * 60_000; // 1 minute apart
      if (i % 2 === 0) {
        keys.push({
          serverTimestamp: new Date(realMs).toISOString(),
          // Skewed local clock: ±1h randomly
          localTimestamp: new Date(realMs + (i % 4 === 0 ? ONE_HOUR_MS : -ONE_HOUR_MS)).toISOString(),
        });
      } else {
        keys.push({ localTimestamp: new Date(realMs).toISOString() });
      }
    }

    // Shuffle to make sort non-trivial
    const shuffled = [...keys].sort(() => Math.random() - 0.5);
    const sorted = shuffled.sort(compareMessageOrder);

    // Verify monotonic order: each timestamp >= previous
    for (let i = 1; i < sorted.length; i++) {
      const prev = normalizeOrderingTimestamp(sorted[i - 1]).timestamp;
      const curr = normalizeOrderingTimestamp(sorted[i]).timestamp;
      expect(curr >= prev).toBe(true);
    }
  });
});

// ============================================================================
// buildOrderingKey()
// ============================================================================

describe('buildOrderingKey()', () => {
  it('builds a key with only localTimestamp when no server data provided', () => {
    const key = buildOrderingKey(REAL_TIME_ISO);

    expect(key.localTimestamp).toBe(REAL_TIME_ISO);
    expect(key.serverTimestamp).toBeUndefined();
    expect(key.serverSequence).toBeUndefined();
  });

  it('includes serverTimestamp when provided', () => {
    const key = buildOrderingKey(LOCAL_PLUS_3H_ISO, REAL_TIME_ISO);

    expect(key.localTimestamp).toBe(LOCAL_PLUS_3H_ISO);
    expect(key.serverTimestamp).toBe(REAL_TIME_ISO);
    expect(key.serverSequence).toBeUndefined();
  });

  it('includes serverSequence when provided', () => {
    const key = buildOrderingKey(REAL_TIME_ISO, undefined, 42);

    expect(key.localTimestamp).toBe(REAL_TIME_ISO);
    expect(key.serverTimestamp).toBeUndefined();
    expect(key.serverSequence).toBe(42);
  });

  it('includes all three fields when all provided', () => {
    const key = buildOrderingKey(LOCAL_PLUS_3H_ISO, REAL_TIME_ISO, 99);

    expect(key.localTimestamp).toBe(LOCAL_PLUS_3H_ISO);
    expect(key.serverTimestamp).toBe(REAL_TIME_ISO);
    expect(key.serverSequence).toBe(99);
  });

  it('serverSequence = 0 is preserved (not treated as falsy)', () => {
    const key = buildOrderingKey(REAL_TIME_ISO, undefined, 0);

    expect(key.serverSequence).toBe(0);
  });
});

// ============================================================================
// isCriticallySkewed()
// ============================================================================

describe('isCriticallySkewed()', () => {
  it('returns false when local is within 3h of server', () => {
    const serverTs = REAL_TIME_ISO;
    const localMs = REAL_TIME_MS + ONE_HOUR_MS; // 1h ahead — within tolerance

    expect(isCriticallySkewed(localMs, serverTs)).toBe(false);
  });

  it('returns false when local is exactly 3h ahead (boundary — not strictly greater)', () => {
    /**
     * CLOCK_SKEW_TOLERANCE_MS is 3h. A skew of exactly 3h is NOT critical
     * because the condition is `|skew| > tolerance`, not `>= tolerance`.
     */
    const serverTs = REAL_TIME_ISO;
    const localMs = REAL_TIME_MS + THREE_HOURS_MS;

    expect(isCriticallySkewed(localMs, serverTs)).toBe(false);
  });

  it('returns true when local is more than 3h ahead of server', () => {
    const serverTs = REAL_TIME_ISO;
    const localMs = REAL_TIME_MS + THREE_HOURS_MS + ONE_SECOND_MS; // 3h + 1s

    expect(isCriticallySkewed(localMs, serverTs)).toBe(true);
  });

  it('returns true when local is more than 3h behind server', () => {
    const serverTs = REAL_TIME_ISO;
    const localMs = REAL_TIME_MS - THREE_HOURS_MS - ONE_SECOND_MS;

    expect(isCriticallySkewed(localMs, serverTs)).toBe(true);
  });

  it('uses the same constant as CLOCK_SKEW_TOLERANCE_MS', () => {
    // Verify the exported constant matches the behavior
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(3 * 60 * 60 * 1000);

    const serverTs = REAL_TIME_ISO;
    // Just over the boundary
    const justOverMs = REAL_TIME_MS + CLOCK_SKEW_TOLERANCE_MS + 1;
    expect(isCriticallySkewed(justOverMs, serverTs)).toBe(true);
  });

  it('handles negative (behind) skews symmetrically', () => {
    const serverTs = REAL_TIME_ISO;
    const behind1h = REAL_TIME_MS - ONE_HOUR_MS;
    const behind4h = REAL_TIME_MS - 4 * ONE_HOUR_MS;

    expect(isCriticallySkewed(behind1h, serverTs)).toBe(false);
    expect(isCriticallySkewed(behind4h, serverTs)).toBe(true);
  });
});

// ============================================================================
// Integration: real-world DST and timezone-change scenarios
// ============================================================================

describe('real-world clock-skew scenarios', () => {
  /**
   * Scenario: User flies from New York (UTC-5) to London (UTC+0) while offline.
   * Their phone still shows Eastern time. When they reconnect, the phone clock
   * is 5 hours behind the server. All messages queued during the flight have
   * timestamps 5h behind real time.
   *
   * Expected: Server timestamps are used for ordering, so the 5h discrepancy
   * does not corrupt replay order.
   */
  it('handles 5h timezone change (US to UK) — messages stay in order', () => {
    const US_OFFSET_MS = 5 * ONE_HOUR_MS; // UTC-5 vs UTC+0
    const makeMessage = (minuteOffset: number) => ({
      serverTimestamp: new Date(REAL_TIME_MS + minuteOffset * 60_000).toISOString(),
      localTimestamp: new Date(REAL_TIME_MS + minuteOffset * 60_000 - US_OFFSET_MS).toISOString(),
    });

    const messages = [makeMessage(0), makeMessage(2), makeMessage(1), makeMessage(3)];
    const sorted = messages.sort(compareMessageOrder);

    // Verify chronological order by server timestamps
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].serverTimestamp! > sorted[i - 1].serverTimestamp!).toBe(true);
    }
  });

  /**
   * Scenario: DST spring-forward. At 2:00 AM, clocks jump to 3:00 AM.
   * A message queued at "1:59 AM" gets stamped 1:59, but a message queued
   * at "3:01 AM" (real) might be stamped 2:01 on an un-updated device.
   * The server clock is NTP-correct and sees 3:01.
   *
   * Expected: Server timestamps resolve the 1h DST ambiguity.
   */
  it('handles DST spring-forward (1h ambiguity window)', () => {
    const DST_JUMP_MS = ONE_HOUR_MS;
    // Message queued at real 3:01 AM, but local shows 2:01 AM (device not updated)
    const afterDst: MessageOrderingKey = {
      serverTimestamp: new Date(REAL_TIME_MS + 3 * 60_000).toISOString(),  // 3:01 AM server
      localTimestamp: new Date(REAL_TIME_MS + 3 * 60_000 - DST_JUMP_MS).toISOString(), // 2:01 AM local
    };
    // Message queued at real 1:59 AM (before spring-forward)
    const beforeDst: MessageOrderingKey = {
      serverTimestamp: new Date(REAL_TIME_MS - 1 * 60_000).toISOString(),  // 1:59 AM server
      localTimestamp: new Date(REAL_TIME_MS - 1 * 60_000).toISOString(),   // 1:59 AM local (correct pre-DST)
    };

    const sorted = [afterDst, beforeDst].sort(compareMessageOrder);

    // beforeDst should come first (earlier server timestamp)
    expect(sorted[0]).toEqual(beforeDst);
    expect(sorted[1]).toEqual(afterDst);
  });

  /**
   * Scenario: Device has no NTP (airplane mode, no server data).
   * All messages use local timestamp fallback.
   * Expected: FIFO order is preserved via local timestamps.
   */
  it('preserves FIFO order using local timestamps when server data unavailable', () => {
    const keys: MessageOrderingKey[] = [
      { localTimestamp: '2026-04-21T08:00:00.000Z' },
      { localTimestamp: '2026-04-21T08:01:00.000Z' },
      { localTimestamp: '2026-04-21T08:02:00.000Z' },
      { localTimestamp: '2026-04-21T08:03:00.000Z' },
    ];

    const shuffled = [keys[2], keys[0], keys[3], keys[1]];
    const sorted = shuffled.sort(compareMessageOrder);

    expect(sorted[0].localTimestamp).toBe('2026-04-21T08:00:00.000Z');
    expect(sorted[3].localTimestamp).toBe('2026-04-21T08:03:00.000Z');
  });
});
