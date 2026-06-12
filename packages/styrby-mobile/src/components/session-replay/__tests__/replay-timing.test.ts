/**
 * Tests for session-replay timing math (Cluster A2 split).
 *
 * These pure helpers drive playback correctness; they were untestable while
 * embedded in useMemo bodies inside SessionReplay.tsx.
 *
 * @module components/session-replay/__tests__/replay-timing
 */

import {
  formatTime,
  toChatMessageData,
  computeTiming,
  computeVisibleIndex,
} from '../replay-timing';
import type { ReplayMessageData } from '../types';

function msg(id: string, secondsFromEpoch: number): ReplayMessageData {
  return {
    id,
    role: 'user',
    content: `m-${id}`,
    createdAt: new Date(secondsFromEpoch * 1000).toISOString(),
  };
}

describe('formatTime', () => {
  it('formats under an hour as M:SS', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(5_000)).toBe('0:05');
    expect(formatTime(65_000)).toBe('1:05');
  });
  it('formats an hour or more as H:MM:SS', () => {
    expect(formatTime(3_661_000)).toBe('1:01:01');
  });
});

describe('toChatMessageData', () => {
  it('wraps content in a single text block and preserves metadata', () => {
    const data = toChatMessageData({
      id: 'x',
      role: 'assistant',
      agentType: 'claude',
      content: 'hello',
      createdAt: '2026-06-12T00:00:00Z',
      costUsd: 0.02,
      durationMs: 1200,
    });
    expect(data).toMatchObject({
      id: 'x',
      role: 'assistant',
      agentType: 'claude',
      content: [{ type: 'text', content: 'hello' }],
      timestamp: '2026-06-12T00:00:00Z',
      costUsd: 0.02,
      durationMs: 1200,
    });
  });
});

describe('computeTiming', () => {
  it('returns zeros for an empty session', () => {
    expect(computeTiming([])).toEqual({ totalDurationMs: 0, messageTimestamps: [] });
  });

  it('computes total span and per-message offsets from the first message', () => {
    const { totalDurationMs, messageTimestamps } = computeTiming([
      msg('a', 100),
      msg('b', 110),
      msg('c', 130),
    ]);
    expect(totalDurationMs).toBe(30_000); // 130s - 100s
    expect(messageTimestamps).toEqual([0, 10_000, 30_000]);
  });
});

describe('computeVisibleIndex', () => {
  const offsets = [0, 10_000, 30_000];

  it('returns -1 before the first message offset', () => {
    expect(computeVisibleIndex(offsets, -1)).toBe(-1);
  });
  it('returns the last reached index at the playhead', () => {
    expect(computeVisibleIndex(offsets, 0)).toBe(0);
    expect(computeVisibleIndex(offsets, 15_000)).toBe(1);
    expect(computeVisibleIndex(offsets, 30_000)).toBe(2);
  });
  it('clamps to the final message past the end', () => {
    expect(computeVisibleIndex(offsets, 999_999)).toBe(2);
  });
  it('returns -1 for an empty session', () => {
    expect(computeVisibleIndex([], 5_000)).toBe(-1);
  });
});
