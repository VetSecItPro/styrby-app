/**
 * Shared types for the session-checkpoints feature.
 *
 * Extracted from SessionCheckpoints.tsx (Cluster A2 split).
 *
 * @module components/session-checkpoints/types
 */

import type { SessionCheckpoint } from 'styrby-shared';

/** Props for the SessionCheckpoints component. */
export interface SessionCheckpointsProps {
  /** Session ID whose checkpoints to display. */
  sessionId: string;
  /** Current message count for a new checkpoint's position. */
  currentMessageCount?: number;
  /** Whether the session is currently active. */
  isSessionActive?: boolean;
  /**
   * Called when the user taps "Restore" on a checkpoint.
   * The parent screen uses this to filter/scroll messages.
   */
  onRestore?: (checkpoint: SessionCheckpoint) => void;
}
