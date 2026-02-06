'use client';

/**
 * Custom hook for managing session replay state.
 *
 * Handles the timing logic for replaying messages based on their original
 * timestamps, supporting variable playback speeds and seeking.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { ReplayMessage, PlaybackSpeed, PlaybackState } from './types';

/**
 * Configuration for the replay state hook.
 */
interface UseReplayStateConfig {
  /** All messages in the session */
  messages: ReplayMessage[];
  /** Initial playback speed */
  initialSpeed?: PlaybackSpeed;
  /** Callback when playback completes */
  onComplete?: () => void;
}

/**
 * Return type for the useReplayState hook.
 */
interface UseReplayStateReturn {
  /** Current playback state */
  playbackState: PlaybackState;
  /** Whether currently playing */
  isPlaying: boolean;
  /** Current playback speed */
  speed: PlaybackSpeed;
  /** Current position in milliseconds from session start */
  currentTimeMs: number;
  /** Total session duration in milliseconds */
  totalDurationMs: number;
  /** Index of the current message (last visible message) */
  currentMessageIndex: number;
  /** Messages that should be visible at current playback position */
  visibleMessages: ReplayMessage[];
  /** Start or resume playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Toggle between play and pause */
  togglePlay: () => void;
  /** Stop playback and reset to beginning */
  stop: () => void;
  /** Change playback speed */
  setSpeed: (speed: PlaybackSpeed) => void;
  /** Seek to a specific time position */
  seekToTime: (timeMs: number) => void;
  /** Jump to a specific message */
  jumpToMessage: (index: number) => void;
}

/**
 * Hook for managing session replay state with timing control.
 *
 * WHY: The replay feature needs precise timing to show messages at their
 * original intervals. This hook encapsulates all the timing logic, including
 * variable speed playback, seeking, and message visibility calculation.
 *
 * @param config - Configuration for the replay
 * @returns Replay state and control functions
 */
export function useReplayState({
  messages,
  initialSpeed = 1,
  onComplete,
}: UseReplayStateConfig): UseReplayStateReturn {
  // Playback state
  const [playbackState, setPlaybackState] = useState<PlaybackState>('stopped');
  const [speed, setSpeedState] = useState<PlaybackSpeed>(initialSpeed);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);

  // Refs for animation timing
  const animationFrameRef = useRef<number | null>(null);
  const lastTickTimeRef = useRef<number>(0);
  const onCompleteRef = useRef(onComplete);

  // Keep onComplete ref updated
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Store speed in a ref for the animation loop
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  /**
   * Calculate the session start and end times from messages.
   * Messages are expected to be sorted by created_at.
   */
  const { totalDurationMs, messageTimestamps } = useMemo(() => {
    if (messages.length === 0) {
      return { totalDurationMs: 0, messageTimestamps: [] };
    }

    const startTime = new Date(messages[0].created_at).getTime();
    const endTime = new Date(messages[messages.length - 1].created_at).getTime();
    const duration = endTime - startTime;

    // Pre-calculate relative timestamps for each message
    const timestamps = messages.map((msg) => {
      return new Date(msg.created_at).getTime() - startTime;
    });

    return {
      totalDurationMs: duration,
      messageTimestamps: timestamps,
    };
  }, [messages]);

  // Store totalDurationMs in a ref for the animation loop
  const totalDurationRef = useRef(totalDurationMs);
  useEffect(() => {
    totalDurationRef.current = totalDurationMs;
  }, [totalDurationMs]);

  /**
   * Calculate which messages should be visible at the current time.
   * A message is visible if its timestamp is <= current playback time.
   */
  const { visibleMessages, currentMessageIndex } = useMemo(() => {
    if (messages.length === 0) {
      return { visibleMessages: [], currentMessageIndex: -1 };
    }

    // Find the last message that should be visible
    let lastVisibleIndex = -1;
    for (let i = 0; i < messageTimestamps.length; i++) {
      if (messageTimestamps[i] <= currentTimeMs) {
        lastVisibleIndex = i;
      } else {
        break;
      }
    }

    // Return all messages up to and including the last visible one
    const visible =
      lastVisibleIndex >= 0 ? messages.slice(0, lastVisibleIndex + 1) : [];

    return {
      visibleMessages: visible,
      currentMessageIndex: lastVisibleIndex,
    };
  }, [messages, messageTimestamps, currentTimeMs]);

  // Ref to store the tick function for use in requestAnimationFrame
  // WHY: This avoids the eslint error about accessing `tick` before declaration
  const tickRef = useRef<() => void>(() => {});

  /**
   * Animation loop for playback.
   * Uses requestAnimationFrame for smooth timing.
   * Uses refs instead of state to avoid stale closures.
   */
  useEffect(() => {
    tickRef.current = () => {
      const now = performance.now();
      const deltaMs = now - lastTickTimeRef.current;
      lastTickTimeRef.current = now;

      setCurrentTimeMs((prev) => {
        // Apply speed multiplier to delta time (using ref for current speed)
        const newTime = prev + deltaMs * speedRef.current;

        // Check if we've reached the end (using ref for current duration)
        if (newTime >= totalDurationRef.current) {
          // Stop playback and trigger completion callback
          setPlaybackState('stopped');
          onCompleteRef.current?.();
          return totalDurationRef.current;
        }

        return newTime;
      });

      // Continue the animation loop if still playing
      animationFrameRef.current = requestAnimationFrame(tickRef.current);
    };
  }, []);

  /**
   * Start playback animation loop.
   */
  const startPlayback = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    lastTickTimeRef.current = performance.now();
    animationFrameRef.current = requestAnimationFrame(tickRef.current);
  }, []);

  /**
   * Stop playback animation loop.
   */
  const stopPlayback = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  // Clean up animation frame on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Handle playback state changes
  useEffect(() => {
    if (playbackState === 'playing') {
      startPlayback();
    } else {
      stopPlayback();
    }
  }, [playbackState, startPlayback, stopPlayback]);

  /**
   * Start or resume playback.
   */
  const play = useCallback(() => {
    // If at the end, restart from beginning
    if (currentTimeMs >= totalDurationMs) {
      setCurrentTimeMs(0);
    }
    setPlaybackState('playing');
  }, [currentTimeMs, totalDurationMs]);

  /**
   * Pause playback.
   */
  const pause = useCallback(() => {
    setPlaybackState('paused');
  }, []);

  /**
   * Toggle between play and pause.
   */
  const togglePlay = useCallback(() => {
    if (playbackState === 'playing') {
      pause();
    } else {
      play();
    }
  }, [playbackState, play, pause]);

  /**
   * Stop playback and reset to beginning.
   */
  const stop = useCallback(() => {
    setPlaybackState('stopped');
    setCurrentTimeMs(0);
  }, []);

  /**
   * Change playback speed.
   */
  const setSpeed = useCallback((newSpeed: PlaybackSpeed) => {
    setSpeedState(newSpeed);
  }, []);

  /**
   * Seek to a specific time position.
   */
  const seekToTime = useCallback(
    (timeMs: number) => {
      const clampedTime = Math.max(0, Math.min(timeMs, totalDurationMs));
      setCurrentTimeMs(clampedTime);
    },
    [totalDurationMs]
  );

  /**
   * Jump to a specific message index.
   */
  const jumpToMessage = useCallback(
    (index: number) => {
      if (index < 0 || index >= messageTimestamps.length) return;

      // Set time to the message's timestamp
      const messageTime = messageTimestamps[index];
      setCurrentTimeMs(messageTime);
    },
    [messageTimestamps]
  );

  return {
    playbackState,
    isPlaying: playbackState === 'playing',
    speed,
    currentTimeMs,
    totalDurationMs,
    currentMessageIndex,
    visibleMessages,
    play,
    pause,
    togglePlay,
    stop,
    setSpeed,
    seekToTime,
    jumpToMessage,
  };
}
