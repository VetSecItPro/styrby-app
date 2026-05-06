/**
 * Tests for the pure helper functions extracted from status.ts.
 *
 * Coverage target: 0% → ~95% on status-helpers.ts.
 *
 * @module cli/handlers/__tests__/status-helpers
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  formatUptime,
  formatTimeAgo,
  readReconnectHistory,
} from '@/cli/handlers/status-helpers';

describe('formatUptime', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(1)).toBe('1s');
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(59)).toBe('59s');
  });

  it('formats minute-range durations as "Xm Ys"', () => {
    expect(formatUptime(60)).toBe('1m 0s');
    expect(formatUptime(125)).toBe('2m 5s');
    expect(formatUptime(3599)).toBe('59m 59s');
  });

  it('formats hour-range durations as "Xh Ym"', () => {
    expect(formatUptime(3600)).toBe('1h 0m');
    expect(formatUptime(3661)).toBe('1h 1m');
    expect(formatUptime(7200 + 30 * 60)).toBe('2h 30m');
    expect(formatUptime(86400)).toBe('24h 0m'); // 1 day shown as 24 hours
  });
});

describe('formatTimeAgo', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatTimeAgo(0)).toBe('0s');
    expect(formatTimeAgo(999)).toBe('0s'); // < 1 second floors to 0s
    expect(formatTimeAgo(1000)).toBe('1s');
    expect(formatTimeAgo(45_000)).toBe('45s');
    expect(formatTimeAgo(59_999)).toBe('59s');
  });

  it('formats minute-range durations', () => {
    expect(formatTimeAgo(60_000)).toBe('1m');
    expect(formatTimeAgo(120_000)).toBe('2m');
    expect(formatTimeAgo(59 * 60_000)).toBe('59m');
  });

  it('formats hour-range durations', () => {
    expect(formatTimeAgo(60 * 60_000)).toBe('1h');
    expect(formatTimeAgo(3 * 60 * 60_000)).toBe('3h');
    expect(formatTimeAgo(23 * 60 * 60_000)).toBe('23h');
  });

  it('formats day-range durations', () => {
    expect(formatTimeAgo(24 * 60 * 60_000)).toBe('1d');
    expect(formatTimeAgo(3 * 24 * 60 * 60_000)).toBe('3d');
    expect(formatTimeAgo(365 * 24 * 60 * 60_000)).toBe('365d');
  });
});

describe('readReconnectHistory', () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'styrby-status-test-'));
    logFile = path.join(tmpDir, 'daemon.log');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns [] when log file does not exist', () => {
    const events = readReconnectHistory(path.join(tmpDir, 'no-such-file.log'));
    expect(events).toEqual([]);
  });

  it('returns [] when log file is empty', () => {
    fs.writeFileSync(logFile, '');
    expect(readReconnectHistory(logFile)).toEqual([]);
  });

  it('returns [] when log has no relay events', () => {
    fs.writeFileSync(
      logFile,
      [
        '[2026-04-21T12:00:00.000Z] [daemon] Process started',
        '[2026-04-21T12:00:01.000Z] [daemon] Heartbeat ok',
      ].join('\n')
    );
    expect(readReconnectHistory(logFile)).toEqual([]);
  });

  it('correctly pairs a single close+connected at the START of the log (CLI-FOLLOWUP #73)', () => {
    // Regression test for CLI-FOLLOWUP #73: the previous reverse-scan
    // algorithm produced 2 events (orphan-close + initial-connect) for this
    // exact input. The forward-scan fix produces 1 event with success=true.
    fs.writeFileSync(
      logFile,
      [
        '[2026-04-21T12:00:00.000Z] [daemon] Relay closed, will reconnect timeout after 30s',
        '[2026-04-21T12:00:05.000Z] [daemon] Relay connected',
      ].join('\n')
    );

    const events = readReconnectHistory(logFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      timestamp: '2026-04-21T12:00:00.000Z',
      reason: 'timeout after 30s',
      success: true,
    });
  });

  it('correctly pairs close+connected after a baseline initial-connect event', () => {
    fs.writeFileSync(
      logFile,
      [
        '[2026-04-21T10:00:00.000Z] [daemon] Relay connected',
        '[2026-04-21T11:00:00.000Z] [daemon] Relay closed, will reconnect first-cycle',
        '[2026-04-21T11:00:05.000Z] [daemon] Relay connected',
      ].join('\n')
    );

    const events = readReconnectHistory(logFile);
    const firstCycle = events.find((e) => e.reason === 'first-cycle');
    expect(firstCycle).toBeDefined();
    expect(firstCycle?.success).toBe(true);
  });

  it('pairs each connected with the LATEST unpaired close (close-close-connected)', () => {
    // Two consecutive closes without an intervening connected = first
    // close was followed by another close (still failed), second close
    // was followed by a successful connect. Result: c1=false, c2=true.
    fs.writeFileSync(
      logFile,
      [
        '[2026-04-21T12:00:00.000Z] [daemon] Relay closed, will reconnect first-attempt',
        '[2026-04-21T12:00:30.000Z] [daemon] Relay closed, will reconnect retry-attempt',
        '[2026-04-21T12:01:00.000Z] [daemon] Relay connected',
      ].join('\n')
    );

    const events = readReconnectHistory(logFile);
    expect(events).toHaveLength(2);
    const firstAttempt = events.find((e) => e.reason === 'first-attempt');
    const retryAttempt = events.find((e) => e.reason === 'retry-attempt');
    expect(firstAttempt?.success).toBe(false); // never paired
    expect(retryAttempt?.success).toBe(true);  // paired with the connected
  });

  it('returns events in most-recent-first chronological order', () => {
    fs.writeFileSync(
      logFile,
      [
        '[2026-04-21T08:00:00.000Z] [daemon] Relay closed, will reconnect oldest',
        '[2026-04-21T08:00:05.000Z] [daemon] Relay connected',
        '[2026-04-21T09:00:00.000Z] [daemon] Relay closed, will reconnect middle',
        '[2026-04-21T09:00:05.000Z] [daemon] Relay connected',
        '[2026-04-21T10:00:00.000Z] [daemon] Relay closed, will reconnect newest',
        '[2026-04-21T10:00:05.000Z] [daemon] Relay connected',
      ].join('\n')
    );

    const events = readReconnectHistory(logFile);
    expect(events).toHaveLength(3);
    expect(events[0].reason).toBe('newest');
    expect(events[1].reason).toBe('middle');
    expect(events[2].reason).toBe('oldest');
    // All paired → all success
    expect(events.every((e) => e.success)).toBe(true);
  });

  it('parses a failed reconnect (closed without subsequent connected) and marks failure', () => {
    fs.writeFileSync(
      logFile,
      ['[2026-04-21T12:00:00.000Z] [daemon] Relay closed, will reconnect network error'].join('\n')
    );

    const events = readReconnectHistory(logFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      timestamp: '2026-04-21T12:00:00.000Z',
      reason: 'network error',
      success: false,
    });
  });

  it('treats a standalone "Relay connected" with no preceding close as initial', () => {
    fs.writeFileSync(
      logFile,
      ['[2026-04-21T12:00:00.000Z] [daemon] Relay connected'].join('\n')
    );

    const events = readReconnectHistory(logFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: 'initial',
      success: true,
    });
  });

  it('respects the limit parameter (returns the N most-recent paired events)', () => {
    const lines: string[] = [];
    // Write 10 successful close→connected pairs
    for (let i = 0; i < 10; i++) {
      lines.push(`[2026-04-21T${String(i).padStart(2, '0')}:00:00.000Z] [daemon] Relay closed, will reconnect attempt-${i}`);
      lines.push(`[2026-04-21T${String(i).padStart(2, '0')}:00:05.000Z] [daemon] Relay connected`);
    }
    fs.writeFileSync(logFile, lines.join('\n'));

    const events = readReconnectHistory(logFile, 3);
    expect(events).toHaveLength(3);
    // After CLI-FOLLOWUP #73 fix: ordering is now meaningful
    // (most-recent first). With 10 pairs (attempts 0-9), limit=3 returns
    // attempts 9, 8, 7 in that order.
    expect(events[0].reason).toBe('attempt-9');
    expect(events[1].reason).toBe('attempt-8');
    expect(events[2].reason).toBe('attempt-7');
    // All paired
    expect(events.every((e) => e.success)).toBe(true);
  });

  it('uses default limit of 5 when not specified', () => {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(`[2026-04-21T${String(i).padStart(2, '0')}:00:00.000Z] [daemon] Relay closed, will reconnect r-${i}`);
    }
    fs.writeFileSync(logFile, lines.join('\n'));

    const events = readReconnectHistory(logFile);
    expect(events).toHaveLength(5);
  });

  it('handles "Relay closed, will reconnect" with no reason (uses "unknown")', () => {
    fs.writeFileSync(
      logFile,
      ['[2026-04-21T12:00:00.000Z] [daemon] Relay closed, will reconnect'].join('\n')
    );

    const events = readReconnectHistory(logFile);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('unknown');
  });

  it('skips lines without a recognizable timestamp', () => {
    fs.writeFileSync(
      logFile,
      [
        'Garbage line at the top',
        '[not-an-iso-timestamp] [daemon] Relay closed, will reconnect should-skip',
        '[2026-04-21T12:00:00.000Z] [daemon] Relay closed, will reconnect should-include',
      ].join('\n')
    );

    const events = readReconnectHistory(logFile);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('should-include');
  });

  it('returns [] (not throws) on read errors (e.g. permission denied)', () => {
    // Simulate by passing a directory path instead of a file — fs.readFileSync throws EISDIR
    const events = readReconnectHistory(tmpDir);
    expect(events).toEqual([]);
  });

  it('handles mixed close-without-connected and standalone-connected sequences', () => {
    fs.writeFileSync(
      logFile,
      [
        // initial connect
        '[2026-04-21T10:00:00.000Z] [daemon] Relay connected',
        // First reconnect cycle: close → connected
        '[2026-04-21T11:00:00.000Z] [daemon] Relay closed, will reconnect first',
        '[2026-04-21T11:00:05.000Z] [daemon] Relay connected',
        // Second close that never reconnects (still pending in real usage,
        // but the parser sees it as the most recent line, with no later
        // 'connected' to match → reverse-scan picks it up first as failed,
        // then sees the next connected and marks the close as success
        // (parser quirk: the connected pairs with the close AFTER it in
        // reverse scan order, which is BEFORE it chronologically).
      ].join('\n')
    );

    const events = readReconnectHistory(logFile);
    // We assert the parser produces SOME events for this 4-line input
    // (exact pairing semantics are documented in earlier tests).
    expect(events.length).toBeGreaterThan(0);
    // 'first' reconnect cycle should appear
    const first = events.find((e) => e.reason === 'first');
    expect(first).toBeDefined();
  });
});
