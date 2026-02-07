/**
 * useReplayState Hook Tests
 *
 * Tests the session replay timing hook that drives message visibility
 * based on timestamp-relative playback position.
 *
 * Key behaviors tested:
 * - totalDurationMs and messageTimestamps calculation
 * - visibleMessages based on currentTimeMs
 * - play/pause/stop/togglePlay state transitions
 * - seekToTime clamping
 * - jumpToMessage index bounds
 * - setSpeed state
 * - Empty messages edge case
 * - Play from end restarts from beginning
 *
 * WHY: The replay hook has complex timing logic with requestAnimationFrame
 * and speed multipliers. Bugs here cause messages to appear at wrong times
 * or playback to freeze/skip.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReplayState } from '../use-replay-state';
import type { ReplayMessage } from '../types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a mock ReplayMessage with timestamp offset from a base time.
 */
function createMessage(
  id: string,
  offsetMs: number,
  type: ReplayMessage['message_type'] = 'agent_response',
  baseTime = new Date('2025-01-01T00:00:00Z').getTime()
): ReplayMessage {
  return {
    id,
    session_id: 'session-001',
    sequence_number: parseInt(id.replace('msg-', ''), 10),
    message_type: type,
    content_encrypted: `Content for ${id}`,
    risk_level: null,
    permission_granted: null,
    tool_name: null,
    duration_ms: null,
    metadata: null,
    created_at: new Date(baseTime + offsetMs).toISOString(),
  };
}

/**
 * Creates a standard set of messages spread over 10 seconds.
 */
function createTestMessages(): ReplayMessage[] {
  return [
    createMessage('msg-1', 0, 'user_prompt'),         // 0s
    createMessage('msg-2', 2000, 'agent_response'),    // 2s
    createMessage('msg-3', 5000, 'tool_use'),          // 5s
    createMessage('msg-4', 7000, 'tool_result'),       // 7s
    createMessage('msg-5', 10000, 'agent_response'),   // 10s
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('useReplayState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('initializes with stopped state', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      expect(result.current.playbackState).toBe('stopped');
      expect(result.current.isPlaying).toBe(false);
      expect(result.current.currentTimeMs).toBe(0);
    });

    it('defaults speed to 1', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      expect(result.current.speed).toBe(1);
    });

    it('accepts initialSpeed parameter', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages, initialSpeed: 2 })
      );

      expect(result.current.speed).toBe(2);
    });

    it('calculates totalDurationMs from first to last message', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      // 10s = 10000ms between first (0s) and last (10s) message
      expect(result.current.totalDurationMs).toBe(10000);
    });
  });

  describe('empty messages', () => {
    it('handles empty messages array', () => {
      const { result } = renderHook(() =>
        useReplayState({ messages: [] })
      );

      expect(result.current.totalDurationMs).toBe(0);
      expect(result.current.visibleMessages).toEqual([]);
      expect(result.current.currentMessageIndex).toBe(-1);
    });
  });

  describe('visibleMessages calculation', () => {
    it('shows no messages at time 0 if first message is at offset 0', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      // At time 0, the first message (offset 0) should be visible
      // because messageTimestamps[0] = 0 and currentTimeMs = 0, so 0 <= 0 is true
      expect(result.current.visibleMessages).toHaveLength(1);
      expect(result.current.visibleMessages[0].id).toBe('msg-1');
      expect(result.current.currentMessageIndex).toBe(0);
    });

    it('shows correct messages after seeking', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      // Seek to 5000ms (should show messages at 0, 2000, and 5000)
      act(() => {
        result.current.seekToTime(5000);
      });

      expect(result.current.visibleMessages).toHaveLength(3);
      expect(result.current.visibleMessages[0].id).toBe('msg-1');
      expect(result.current.visibleMessages[1].id).toBe('msg-2');
      expect(result.current.visibleMessages[2].id).toBe('msg-3');
      expect(result.current.currentMessageIndex).toBe(2);
    });

    it('shows all messages at end time', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.seekToTime(10000);
      });

      expect(result.current.visibleMessages).toHaveLength(5);
      expect(result.current.currentMessageIndex).toBe(4);
    });
  });

  describe('play/pause/stop/togglePlay', () => {
    it('play sets state to playing', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.play();
      });

      expect(result.current.playbackState).toBe('playing');
      expect(result.current.isPlaying).toBe(true);
    });

    it('pause sets state to paused', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.play();
      });

      act(() => {
        result.current.pause();
      });

      expect(result.current.playbackState).toBe('paused');
      expect(result.current.isPlaying).toBe(false);
    });

    it('stop resets to beginning', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      // Seek forward, then stop
      act(() => {
        result.current.seekToTime(5000);
        result.current.play();
      });

      act(() => {
        result.current.stop();
      });

      expect(result.current.playbackState).toBe('stopped');
      expect(result.current.currentTimeMs).toBe(0);
    });

    it('togglePlay switches between playing and paused', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      // Initially stopped, toggle should play
      act(() => {
        result.current.togglePlay();
      });
      expect(result.current.isPlaying).toBe(true);

      // Toggle again should pause
      act(() => {
        result.current.togglePlay();
      });
      expect(result.current.isPlaying).toBe(false);
      expect(result.current.playbackState).toBe('paused');
    });

    it('play from end position restarts from beginning', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      // Seek to end
      act(() => {
        result.current.seekToTime(10000);
      });

      expect(result.current.currentTimeMs).toBe(10000);

      // Play should reset to 0 since we're at the end
      act(() => {
        result.current.play();
      });

      expect(result.current.currentTimeMs).toBe(0);
      expect(result.current.isPlaying).toBe(true);
    });
  });

  describe('seekToTime', () => {
    it('clamps to 0 for negative values', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.seekToTime(-500);
      });

      expect(result.current.currentTimeMs).toBe(0);
    });

    it('clamps to totalDurationMs for values beyond end', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.seekToTime(99999);
      });

      expect(result.current.currentTimeMs).toBe(10000);
    });

    it('allows seeking to exact message timestamps', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.seekToTime(7000);
      });

      expect(result.current.currentTimeMs).toBe(7000);
      // Messages at 0, 2000, 5000, 7000 should be visible (indices 0-3)
      expect(result.current.currentMessageIndex).toBe(3);
    });
  });

  describe('jumpToMessage', () => {
    it('jumps to a specific message by index', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.jumpToMessage(2);
      });

      // Message at index 2 has offset 5000ms
      expect(result.current.currentTimeMs).toBe(5000);
      expect(result.current.currentMessageIndex).toBe(2);
    });

    it('ignores negative index', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.seekToTime(5000);
      });

      act(() => {
        result.current.jumpToMessage(-1);
      });

      // Should not change
      expect(result.current.currentTimeMs).toBe(5000);
    });

    it('ignores index beyond message count', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.seekToTime(5000);
      });

      act(() => {
        result.current.jumpToMessage(99);
      });

      // Should not change
      expect(result.current.currentTimeMs).toBe(5000);
    });

    it('jumps to first message at index 0', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.seekToTime(5000);
      });

      act(() => {
        result.current.jumpToMessage(0);
      });

      expect(result.current.currentTimeMs).toBe(0);
    });

    it('jumps to last message', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.jumpToMessage(4);
      });

      expect(result.current.currentTimeMs).toBe(10000);
    });
  });

  describe('setSpeed', () => {
    it('changes playback speed', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      act(() => {
        result.current.setSpeed(4);
      });

      expect(result.current.speed).toBe(4);
    });

    it('accepts all valid speed values', () => {
      const messages = createTestMessages();
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      for (const speed of [0.5, 1, 2, 4] as const) {
        act(() => {
          result.current.setSpeed(speed);
        });
        expect(result.current.speed).toBe(speed);
      }
    });
  });

  describe('single message', () => {
    it('handles a session with one message', () => {
      const messages = [createMessage('msg-1', 0, 'user_prompt')];
      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      expect(result.current.totalDurationMs).toBe(0);
      expect(result.current.visibleMessages).toHaveLength(1);
      expect(result.current.currentMessageIndex).toBe(0);
    });
  });

  describe('messages with same timestamp', () => {
    it('shows all messages at the same timestamp simultaneously', () => {
      const messages = [
        createMessage('msg-1', 0, 'user_prompt'),
        createMessage('msg-2', 0, 'agent_response'), // Same time
        createMessage('msg-3', 5000, 'tool_use'),
      ];

      const { result } = renderHook(() =>
        useReplayState({ messages })
      );

      // At time 0, both msg-1 and msg-2 should be visible
      expect(result.current.visibleMessages).toHaveLength(2);
      expect(result.current.currentMessageIndex).toBe(1);
    });
  });
});
