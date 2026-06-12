/**
 * Pure timing math for session replay.
 *
 * Extracted from SessionReplay.tsx (Cluster A2 split). The playback engine's
 * correctness lives entirely here - duration, per-message offsets, and which
 * message is current at a given playhead time. These were untestable while
 * embedded in useMemo bodies; as pure functions they can be verified directly.
 *
 * @module components/session-replay/replay-timing
 */

import type { ChatMessageData, ContentBlock } from '../ChatMessage';
import type { ReplayMessageData } from './types';

/**
 * Format milliseconds as MM:SS, or HH:MM:SS once past an hour.
 *
 * @param ms - Duration in milliseconds.
 * @returns Clock-style string.
 */
export function formatTime(ms: number): string {
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
 * Adapt a ReplayMessageData into the ChatMessageData shape ChatMessage renders.
 *
 * @param message - The replay message.
 * @returns Chat-renderable message data.
 */
export function toChatMessageData(message: ReplayMessageData): ChatMessageData {
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

/** Total replay duration plus each message's offset from the start. */
export interface ReplayTiming {
  /** End-to-start span of the session in ms. */
  totalDurationMs: number;
  /** Per-message offset from the first message, in ms. */
  messageTimestamps: number[];
}

/**
 * Compute the total duration and per-message offsets from message timestamps.
 *
 * WHY offsets-from-start (not absolute): the playhead runs from 0, so each
 * message's reveal time is its createdAt minus the first message's createdAt.
 *
 * @param messages - Messages sorted by createdAt.
 * @returns Total duration + offset array (empty for no messages).
 */
export function computeTiming(messages: ReplayMessageData[]): ReplayTiming {
  if (messages.length === 0) {
    return { totalDurationMs: 0, messageTimestamps: [] };
  }

  const startTime = new Date(messages[0].createdAt).getTime();
  const endTime = new Date(messages[messages.length - 1].createdAt).getTime();
  const timestamps = messages.map((msg) => new Date(msg.createdAt).getTime() - startTime);

  return { totalDurationMs: endTime - startTime, messageTimestamps: timestamps };
}

/**
 * Find the index of the latest message whose offset has been reached.
 *
 * WHY linear scan + early break: offsets are monotonically non-decreasing, so
 * the first offset past the playhead means every later one is too.
 *
 * @param messageTimestamps - Per-message offsets from computeTiming.
 * @param currentTimeMs - Current playhead position in ms.
 * @returns Index of the current message, or -1 if none are visible yet.
 */
export function computeVisibleIndex(messageTimestamps: number[], currentTimeMs: number): number {
  let lastVisibleIndex = -1;
  for (let i = 0; i < messageTimestamps.length; i++) {
    if (messageTimestamps[i] <= currentTimeMs) {
      lastVisibleIndex = i;
    } else {
      break;
    }
  }
  return lastVisibleIndex;
}
