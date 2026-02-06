/**
 * Session Replay Component
 *
 * Mobile version of the session replay feature that allows users to step
 * through past sessions like a debugger, watching messages appear with
 * original timing.
 *
 * Features:
 * - Vertical timeline
 * - Tap to jump to message
 * - Play/pause with speed control
 * - Auto-scroll to current message
 *
 * @tier Pro+ only - Free users see an upgrade prompt
 */

import {
  View,
  Text,
  ScrollView,
  Pressable,
  Animated,
  Dimensions,
} from 'react-native';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ChatMessage, type ChatMessageData, type ContentBlock } from './ChatMessage';
import type { AgentType } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Message data from the session_messages table.
 */
export interface ReplayMessageData {
  /** Unique message identifier */
  id: string;
  /** Message role */
  role: 'user' | 'assistant' | 'system' | 'error';
  /** Agent type for assistant messages */
  agentType?: AgentType;
  /** Message content (decrypted) */
  content: string;
  /** Message timestamp */
  createdAt: string;
  /** Cost in USD */
  costUsd?: number;
  /** Duration in milliseconds */
  durationMs?: number;
}

/**
 * Props for the SessionReplay component.
 */
interface SessionReplayProps {
  /** All messages in the session, sorted by createdAt */
  messages: ReplayMessageData[];
  /** User's subscription tier */
  userTier: 'free' | 'pro' | 'power';
  /** Callback when replay completes */
  onComplete?: () => void;
  /** Callback when user exits replay */
  onExit?: () => void;
}

/**
 * Playback speed options.
 */
type PlaybackSpeed = 0.5 | 1 | 2 | 4;

/**
 * Playback state.
 */
type PlaybackState = 'playing' | 'paused' | 'stopped';

// ============================================================================
// Constants
// ============================================================================

const SPEED_OPTIONS: PlaybackSpeed[] = [0.5, 1, 2, 4];

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats milliseconds to MM:SS or HH:MM:SS.
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Converts ReplayMessageData to ChatMessageData for rendering.
 */
function toChatMessageData(message: ReplayMessageData): ChatMessageData {
  const contentBlock: ContentBlock = { type: 'text', content: message.content };

  return {
    id: message.id,
    role: message.role,
    agentType: message.agentType,
    content: [contentBlock],
    timestamp: message.createdAt,
    costUsd: message.costUsd,
    durationMs: message.durationMs,
  };
}

// ============================================================================
// Upgrade Prompt Component
// ============================================================================

/**
 * Shown to free users who don't have access to replay.
 */
function UpgradePrompt({ onExit }: { onExit?: () => void }) {
  return (
    <View className="flex-1 bg-background items-center justify-center px-6">
      <View className="w-16 h-16 rounded-2xl bg-orange-500/20 items-center justify-center mb-4">
        <Ionicons name="play-circle" size={32} color="#f97316" />
      </View>
      <Text className="text-white text-xl font-semibold text-center mb-2">
        Session Replay
      </Text>
      <Text className="text-zinc-500 text-center mb-6">
        Step through past sessions like a debugger. Upgrade to Pro to unlock
        this feature.
      </Text>
      <Pressable
        className="bg-brand px-6 py-3 rounded-xl active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel="Upgrade to Pro"
      >
        <Text className="text-white font-semibold">Upgrade to Pro</Text>
      </Pressable>
      {onExit && (
        <Pressable
          onPress={onExit}
          className="mt-4 px-4 py-2"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text className="text-zinc-500">Go Back</Text>
        </Pressable>
      )}
    </View>
  );
}

// ============================================================================
// Speed Selector Component
// ============================================================================

/**
 * Dropdown for selecting playback speed.
 */
function SpeedSelector({
  speed,
  onSpeedChange,
}: {
  speed: PlaybackSpeed;
  onSpeedChange: (speed: PlaybackSpeed) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <View className="relative">
      <Pressable
        onPress={() => setIsOpen(!isOpen)}
        className="flex-row items-center px-3 py-1.5 rounded-lg bg-zinc-800"
        accessibilityRole="button"
        accessibilityLabel={`Playback speed: ${speed}x`}
      >
        <Text className="text-white text-sm font-medium">{speed}x</Text>
        <Ionicons
          name={isOpen ? 'chevron-up' : 'chevron-down'}
          size={16}
          color="#71717a"
          style={{ marginLeft: 4 }}
        />
      </Pressable>

      {isOpen && (
        <View className="absolute bottom-full mb-1 right-0 bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden z-10">
          {SPEED_OPTIONS.map((option) => (
            <Pressable
              key={option}
              onPress={() => {
                onSpeedChange(option);
                setIsOpen(false);
              }}
              className={`px-4 py-2 ${speed === option ? 'bg-zinc-700' : ''}`}
              accessibilityRole="button"
              accessibilityLabel={`Set speed to ${option}x`}
            >
              <Text
                className={`text-sm ${
                  speed === option ? 'text-orange-500 font-medium' : 'text-white'
                }`}
              >
                {option}x
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Session replay component for mobile.
 *
 * WHY: Session replay allows users to review past sessions step-by-step,
 * understanding the flow of conversation and agent actions. The mobile
 * version uses a simplified interface optimized for touch.
 *
 * @param props - SessionReplay configuration
 */
export function SessionReplay({
  messages,
  userTier,
  onComplete,
  onExit,
}: SessionReplayProps) {
  // Gate access for free users
  const canAccessReplay = userTier !== 'free';

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

  // Update onComplete ref
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Calculate timing data
  const { totalDurationMs, messageTimestamps } = useMemo(() => {
    if (messages.length === 0) {
      return { totalDurationMs: 0, messageTimestamps: [] };
    }

    const startTime = new Date(messages[0].createdAt).getTime();
    const endTime = new Date(messages[messages.length - 1].createdAt).getTime();

    const timestamps = messages.map(
      (msg) => new Date(msg.createdAt).getTime() - startTime
    );

    return {
      totalDurationMs: endTime - startTime,
      messageTimestamps: timestamps,
    };
  }, [messages]);

  // Calculate visible messages
  const { visibleMessages, currentMessageIndex } = useMemo(() => {
    if (messages.length === 0) {
      return { visibleMessages: [], currentMessageIndex: -1 };
    }

    let lastVisibleIndex = -1;
    for (let i = 0; i < messageTimestamps.length; i++) {
      if (messageTimestamps[i] <= currentTimeMs) {
        lastVisibleIndex = i;
      } else {
        break;
      }
    }

    const visible = lastVisibleIndex >= 0 ? messages.slice(0, lastVisibleIndex + 1) : [];

    return {
      visibleMessages: visible,
      currentMessageIndex: lastVisibleIndex,
    };
  }, [messages, messageTimestamps, currentTimeMs]);

  // Update progress bar animation
  useEffect(() => {
    const progress = totalDurationMs > 0 ? currentTimeMs / totalDurationMs : 0;
    Animated.timing(progressAnim, {
      toValue: progress,
      duration: 50,
      useNativeDriver: false,
    }).start();
  }, [currentTimeMs, totalDurationMs, progressAnim]);

  // Animation tick
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

  // Start/stop animation based on playback state
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

  // Auto-scroll to current message
  useEffect(() => {
    if (currentMessageIndex >= 0 && scrollRef.current) {
      // Approximate scroll position based on message index
      // Each message is roughly 100-150px tall
      const estimatedOffset = currentMessageIndex * 120;
      scrollRef.current.scrollTo({ y: estimatedOffset, animated: true });
    }
  }, [currentMessageIndex]);

  // Control handlers
  const togglePlay = useCallback(() => {
    if (playbackState === 'playing') {
      setPlaybackState('paused');
    } else {
      // If at end, restart
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
    [messageTimestamps]
  );

  const handleProgressPress = useCallback(
    (event: { nativeEvent: { locationX: number } }) => {
      const { locationX } = event.nativeEvent;
      const progress = locationX / (SCREEN_WIDTH - 32); // Account for padding
      const newTime = progress * totalDurationMs;
      setCurrentTimeMs(Math.max(0, Math.min(newTime, totalDurationMs)));
    },
    [totalDurationMs]
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

  // Show upgrade prompt for free users
  if (!canAccessReplay) {
    return <UpgradePrompt onExit={onExit} />;
  }

  // Empty state
  if (messages.length === 0) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="chatbubbles-outline" size={48} color="#3f3f46" />
        <Text className="text-zinc-400 text-lg font-semibold mt-4">
          No Messages to Replay
        </Text>
        <Text className="text-zinc-500 text-center mt-2">
          This session has no recorded messages.
        </Text>
        {onExit && (
          <Pressable
            onPress={onExit}
            className="mt-6 px-4 py-2"
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text className="text-orange-500">Go Back</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-zinc-800">
        <View className="flex-row items-center">
          <View className="w-6 h-6 rounded-full bg-orange-500/20 items-center justify-center">
            <Ionicons name="play" size={12} color="#f97316" />
          </View>
          <Text className="text-white font-medium ml-2">Session Replay</Text>
        </View>

        {onExit && (
          <Pressable
            onPress={onExit}
            className="flex-row items-center px-3 py-1.5 rounded-lg"
            accessibilityRole="button"
            accessibilityLabel="Exit replay"
          >
            <Ionicons name="close" size={20} color="#71717a" />
            <Text className="text-zinc-500 text-sm ml-1">Exit</Text>
          </Pressable>
        )}
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerStyle={{ paddingVertical: 8 }}
        showsVerticalScrollIndicator={false}
      >
        {messages.map((message, index) => {
          const isVisible = index <= currentMessageIndex;
          const isCurrent = index === currentMessageIndex;

          return (
            <Pressable
              key={message.id}
              onPress={() => jumpToMessage(index)}
              className={`${!isVisible ? 'opacity-20' : ''}`}
              accessibilityRole="button"
              accessibilityLabel={`Jump to message ${index + 1}`}
            >
              <View
                className={`${
                  isCurrent
                    ? 'border-l-2 border-l-orange-500 ml-0.5'
                    : 'border-l-2 border-l-transparent ml-0.5'
                }`}
              >
                <ChatMessage message={toChatMessageData(message)} />
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Controls */}
      <View className="border-t border-zinc-800 bg-zinc-900/80 px-4 py-3">
        {/* Progress bar */}
        <Pressable
          onPress={handleProgressPress}
          className="h-2 bg-zinc-700 rounded-full mb-3"
          accessibilityRole="adjustable"
          accessibilityLabel="Replay progress"
        >
          <Animated.View
            className="h-full bg-orange-500 rounded-full"
            style={{
              width: progressAnim.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            }}
          />
        </Pressable>

        {/* Control row */}
        <View className="flex-row items-center justify-between">
          {/* Time display */}
          <View className="flex-row items-center min-w-[80px]">
            <Text className="text-zinc-400 text-xs font-mono">
              {formatTime(currentTimeMs)}
            </Text>
            <Text className="text-zinc-600 text-xs mx-1">/</Text>
            <Text className="text-zinc-600 text-xs font-mono">
              {formatTime(totalDurationMs)}
            </Text>
          </View>

          {/* Playback controls */}
          <View className="flex-row items-center">
            {/* Previous message */}
            <Pressable
              onPress={handlePrevMessage}
              disabled={currentMessageIndex <= 0}
              className={`p-2 ${currentMessageIndex <= 0 ? 'opacity-30' : ''}`}
              accessibilityRole="button"
              accessibilityLabel="Previous message"
            >
              <Ionicons name="play-skip-back" size={20} color="#71717a" />
            </Pressable>

            {/* Play/Pause */}
            <Pressable
              onPress={togglePlay}
              className="w-10 h-10 rounded-full bg-orange-500 items-center justify-center mx-2"
              accessibilityRole="button"
              accessibilityLabel={playbackState === 'playing' ? 'Pause' : 'Play'}
            >
              <Ionicons
                name={playbackState === 'playing' ? 'pause' : 'play'}
                size={20}
                color="white"
                style={playbackState !== 'playing' ? { marginLeft: 2 } : undefined}
              />
            </Pressable>

            {/* Next message */}
            <Pressable
              onPress={handleNextMessage}
              disabled={currentMessageIndex >= messages.length - 1}
              className={`p-2 ${
                currentMessageIndex >= messages.length - 1 ? 'opacity-30' : ''
              }`}
              accessibilityRole="button"
              accessibilityLabel="Next message"
            >
              <Ionicons name="play-skip-forward" size={20} color="#71717a" />
            </Pressable>
          </View>

          {/* Right side: message count and speed */}
          <View className="flex-row items-center min-w-[80px] justify-end">
            <Text className="text-zinc-500 text-xs mr-3">
              {currentMessageIndex >= 0 ? currentMessageIndex + 1 : 0}/
              {messages.length}
            </Text>
            <SpeedSelector speed={speed} onSpeedChange={setSpeed} />
          </View>
        </View>
      </View>
    </View>
  );
}
