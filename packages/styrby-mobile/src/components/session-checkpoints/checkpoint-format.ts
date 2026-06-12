/**
 * Pure formatting, mapping, and validation for session checkpoints.
 *
 * Extracted from SessionCheckpoints.tsx (Cluster A2 split). The name validator
 * and the row mapper were untestable while embedded in the component; as pure
 * functions they can be verified directly and the validation rules can't drift
 * out of sync with their tests.
 *
 * @module components/session-checkpoints/checkpoint-format
 */

import type { SessionCheckpoint } from 'styrby-shared';

/** Allowed characters in a checkpoint name. */
const CHECKPOINT_NAME_PATTERN = /^[a-zA-Z0-9 \-_.]+$/;

/** Maximum checkpoint name length. */
export const CHECKPOINT_NAME_MAX = 80;

/**
 * Format a checkpoint timestamp into a short readable string.
 *
 * @param isoTimestamp - ISO 8601 timestamp.
 * @returns Formatted string like "Mar 27, 2:30 PM".
 */
export function formatCheckpointTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Validate a proposed checkpoint name against the same rules the DB enforces.
 *
 * WHY validate client-side first: the DB has a unique constraint + a length
 * cap, but surfacing "name required" / "too long" / "bad chars" before the
 * round-trip gives instant feedback and avoids a doomed insert.
 *
 * @param name - Raw (un-trimmed) name from the input.
 * @returns An error message, or null when the trimmed name is valid.
 */
export function validateCheckpointName(name: string): string | null {
  const trimmed = name.trim();

  if (!trimmed) return 'Name is required';
  if (trimmed.length > CHECKPOINT_NAME_MAX) return 'Name must be 80 characters or fewer';
  if (!CHECKPOINT_NAME_PATTERN.test(trimmed)) {
    return 'Name may only contain letters, numbers, spaces, hyphens, underscores, and dots';
  }
  return null;
}

/**
 * Map a raw `session_checkpoints` row to the typed SessionCheckpoint shape.
 *
 * @param row - Raw database row (snake_case).
 * @returns Typed SessionCheckpoint (camelCase).
 */
export function rowToCheckpoint(row: Record<string, unknown>): SessionCheckpoint {
  const snapshot = (row.context_snapshot ?? {}) as { totalTokens?: number; fileCount?: number };

  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    messageSequenceNumber: (row.message_sequence_number as number) ?? 0,
    contextSnapshot: {
      totalTokens: snapshot.totalTokens ?? 0,
      fileCount: snapshot.fileCount ?? 0,
    },
    createdAt: row.created_at as string,
  };
}
