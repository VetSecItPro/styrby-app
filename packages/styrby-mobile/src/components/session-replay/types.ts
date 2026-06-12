/**
 * Shared types for the session-replay feature.
 *
 * Extracted from SessionReplay.tsx (Cluster A2 split) so the hook, the pure
 * timing helpers, and the sub-components share one set of definitions.
 *
 * @module components/session-replay/types
 */

import type { AgentType } from 'styrby-shared';

/** Message data from the session_messages table. */
export interface ReplayMessageData {
  /** Unique message identifier. */
  id: string;
  /** Message role. */
  role: 'user' | 'assistant' | 'system' | 'error';
  /** Agent type for assistant messages. */
  agentType?: AgentType;
  /** Message content (decrypted). */
  content: string;
  /** Message timestamp. */
  createdAt: string;
  /** Cost in USD. */
  costUsd?: number;
  /** Duration in milliseconds. */
  durationMs?: number;
}

/** Props for the SessionReplay component. */
export interface SessionReplayProps {
  /** All messages in the session, sorted by createdAt. */
  messages: ReplayMessageData[];
  /** User's subscription tier. */
  userTier: 'free' | 'pro' | 'growth';
  /** Callback when replay completes. */
  onComplete?: () => void;
  /** Callback when user exits replay. */
  onExit?: () => void;
}

/** Playback speed options. */
export type PlaybackSpeed = 0.5 | 1 | 2 | 4;

/** Playback transport state. */
export type PlaybackState = 'playing' | 'paused' | 'stopped';
