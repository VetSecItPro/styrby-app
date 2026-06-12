/**
 * useReplayPlayback — the requestAnimationFrame playback engine for SessionReplay.
 *
 * Extracted verbatim from SessionReplay.tsx (Cluster A2 split). Owns the
 * transport state, the rAF tick loop, the progress-bar animation, auto-scroll,
 * and every control handler. The refs (animation handle, last-tick time,
 * onComplete, scroll target) are preserved exactly as the original to keep the
 * timing behavior identical.
 *
 * @module components/session-replay/useReplayPlayback
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Animated, ScrollView } from 'react-native';
import type { ReplayMessageData, PlaybackState, PlaybackSpeed } from './types';
import { SCREEN_WIDTH } from './constants';
import { computeTiming, computeVisibleIndex } from './replay-timing';

/** Everything the SessionReplay view needs to render + drive playback. */
export interface UseReplayPlayback {
  playbackState: PlaybackState;
  speed: PlaybackSpeed;
  setSpeed: (speed: PlaybackSpeed) => void;
  currentTimeMs: number;
  totalDurationMs: number;
  currentMessageIndex: number;
  progressAnim: Animated.Value;
  scrollRef: React.RefObject<ScrollView | null>;
  togglePlay: () => void;
  jumpToMessage: (index: number) => void;
  handleProgressPress: (event: { nativeEvent: { locationX: number } }) => void;
  handlePrevMessage: () => void;
  handleNextMessage: () => void;
}

/**
 * Drive step-through playback of a recorded session.
 *
 * @param messages - Messages sorted by createdAt.
 * @param onComplete - Optional callback fired when the playhead reaches the end.
 * @returns Playback state + control handlers.
 */
export function useReplayPlayback(
  messages: ReplayMessageData[],
  onComplete?: () => void,
): UseReplayPlayback {
  // Playback state
  const [playbackState, setPlaybackState] = useState<PlaybackState>('stopped');
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);

  // Animation refs
  const animationRef = useRef<number | null>(null);
  const lastTickTimeRef = useRef<number>(0);
  const onCompleteRef = useRef(onComplete);
  const scrollRef = useRef<ScrollView>(null);

  // Progress bar animation
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Keep the onComplete ref current without restarting the tick loop.
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Timing data (total span + per-message offsets).
  const { totalDurationMs, messageTimestamps } = useMemo(() => computeTiming(messages), [messages]);

  // Index of the message at the current playhead position.
  // WHY index-only (the original also computed a sliced visibleMessages array
  // that was never rendered): the UI renders all messages and dims the
  // not-yet-reached ones by index, so the slice was dead weight. Dropping it
  // preserves behavior exactly.
  const currentMessageIndex = useMemo(
    () => computeVisibleIndex(messageTimestamps, currentTimeMs),
    [messageTimestamps, currentTimeMs],
  );

  // Animate the progress bar toward the current fraction.
  useEffect(() => {
    const progress = totalDurationMs > 0 ? currentTimeMs / totalDurationMs : 0;
    Animated.timing(progressAnim, {
      toValue: progress,
      duration: 50,
      useNativeDriver: false,
    }).start();
  }, [currentTimeMs, totalDurationMs, progressAnim]);

  // Animation tick — advances the playhead by elapsed-wall-time * speed.
  const tick = useCallback(() => {
    const now = performance.now();
    const deltaMs = now - lastTickTimeRef.current;
    lastTickTimeRef.current = now;

    setCurrentTimeMs((prev) => {
      const newTime = prev + deltaMs * speed;

      if (newTime >= totalDurationMs) {
        setPlaybackState('stopped');
        onCompleteRef.current?.();
        return totalDurationMs;
      }

      return newTime;
    });

    animationRef.current = requestAnimationFrame(tick);
  }, [speed, totalDurationMs]);

  // Start/stop the rAF loop based on transport state.
  useEffect(() => {
    if (playbackState === 'playing') {
      lastTickTimeRef.current = performance.now();
      animationRef.current = requestAnimationFrame(tick);
    } else if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [playbackState, tick]);

  // Auto-scroll to the current message.
  useEffect(() => {
    if (currentMessageIndex >= 0 && scrollRef.current) {
      // Approximate scroll position: each message is roughly 100-150px tall.
      const estimatedOffset = currentMessageIndex * 120;
      scrollRef.current.scrollTo({ y: estimatedOffset, animated: true });
    }
  }, [currentMessageIndex]);

  // ── Control handlers ──────────────────────────────────────────────────────

  const togglePlay = useCallback(() => {
    if (playbackState === 'playing') {
      setPlaybackState('paused');
    } else {
      // If at the end, restart from zero.
      if (currentTimeMs >= totalDurationMs) {
        setCurrentTimeMs(0);
      }
      setPlaybackState('playing');
    }
  }, [playbackState, currentTimeMs, totalDurationMs]);

  const jumpToMessage = useCallback(
    (index: number) => {
      if (index >= 0 && index < messageTimestamps.length) {
        setCurrentTimeMs(messageTimestamps[index]);
      }
    },
    [messageTimestamps],
  );

  const handleProgressPress = useCallback(
    (event: { nativeEvent: { locationX: number } }) => {
      const { locationX } = event.nativeEvent;
      const progress = locationX / (SCREEN_WIDTH - 32); // Account for padding.
      const newTime = progress * totalDurationMs;
      setCurrentTimeMs(Math.max(0, Math.min(newTime, totalDurationMs)));
    },
    [totalDurationMs],
  );

  const handlePrevMessage = useCallback(() => {
    if (currentMessageIndex > 0) {
      jumpToMessage(currentMessageIndex - 1);
    }
  }, [currentMessageIndex, jumpToMessage]);

  const handleNextMessage = useCallback(() => {
    if (currentMessageIndex < messages.length - 1) {
      jumpToMessage(currentMessageIndex + 1);
    }
  }, [currentMessageIndex, messages.length, jumpToMessage]);

  return {
    playbackState,
    speed,
    setSpeed,
    currentTimeMs,
    totalDurationMs,
    currentMessageIndex,
    progressAnim,
    scrollRef,
    togglePlay,
    jumpToMessage,
    handleProgressPress,
    handlePrevMessage,
    handleNextMessage,
  };
}
