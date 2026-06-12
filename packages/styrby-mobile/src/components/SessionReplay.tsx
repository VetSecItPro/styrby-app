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
 * Orchestrator only (Cluster A2 split): the rAF playback engine lives in
 * `useReplayPlayback`, timing math in `replay-timing`, and the free-tier gate +
 * speed dropdown in their own sub-components. This file wires them together.
 *
 * @tier Pro+ only - Free users see an upgrade prompt
 */

import { View, Text, ScrollView, Pressable, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ChatMessage } from './ChatMessage';
import { formatTime, toChatMessageData } from './session-replay/replay-timing';
import { useReplayPlayback } from './session-replay/useReplayPlayback';
import { UpgradePrompt } from './session-replay/UpgradePrompt';
import { SpeedSelector } from './session-replay/SpeedSelector';
import type { SessionReplayProps } from './session-replay/types';

export type { ReplayMessageData } from './session-replay/types';

/**
 * Session replay component for mobile.
 *
 * WHY: Session replay lets users review past sessions step-by-step,
 * understanding the flow of conversation and agent actions. The mobile version
 * uses a simplified interface optimized for touch.
 *
 * @param props - SessionReplay configuration.
 */
export function SessionReplay({ messages, userTier, onComplete, onExit }: SessionReplayProps) {
  // Gate access for free users.
  const canAccessReplay = userTier !== 'free';

  const {
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
  } = useReplayPlayback(messages, onComplete);

  // Show upgrade prompt for free users.
  if (!canAccessReplay) {
    return <UpgradePrompt onExit={onExit} />;
  }

  // Empty state.
  if (messages.length === 0) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="chatbubbles-outline" size={48} color="#3f3f46" />
        <Text className="text-zinc-400 text-lg font-semibold mt-4">No Messages to Replay</Text>
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
            <Text className="text-zinc-400 text-xs font-mono">{formatTime(currentTimeMs)}</Text>
            <Text className="text-zinc-600 text-xs mx-1">/</Text>
            <Text className="text-zinc-600 text-xs font-mono">{formatTime(totalDurationMs)}</Text>
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
              className={`p-2 ${currentMessageIndex >= messages.length - 1 ? 'opacity-30' : ''}`}
              accessibilityRole="button"
              accessibilityLabel="Next message"
            >
              <Ionicons name="play-skip-forward" size={20} color="#71717a" />
            </Pressable>
          </View>

          {/* Right side: message count and speed */}
          <View className="flex-row items-center min-w-[80px] justify-end">
            <Text className="text-zinc-500 text-xs mr-3">
              {currentMessageIndex >= 0 ? currentMessageIndex + 1 : 0}/{messages.length}
            </Text>
            <SpeedSelector speed={speed} onSpeedChange={setSpeed} />
          </View>
        </View>
      </View>
    </View>
  );
}
