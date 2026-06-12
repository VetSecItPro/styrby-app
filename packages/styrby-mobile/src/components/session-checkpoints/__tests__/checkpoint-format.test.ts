/**
 * Tests for checkpoint formatting, validation, and row mapping (Cluster A2 split).
 *
 * The name validator + row mapper were untestable while embedded in
 * SessionCheckpoints.tsx; extracting them made the rules directly verifiable.
 *
 * @module components/session-checkpoints/__tests__/checkpoint-format
 */

import {
  validateCheckpointName,
  rowToCheckpoint,
  CHECKPOINT_NAME_MAX,
} from '../checkpoint-format';

describe('validateCheckpointName', () => {
  it('rejects an empty / whitespace-only name', () => {
    expect(validateCheckpointName('')).toBe('Name is required');
    expect(validateCheckpointName('   ')).toBe('Name is required');
  });

  it('rejects a name over the length cap', () => {
    const tooLong = 'a'.repeat(CHECKPOINT_NAME_MAX + 1);
    expect(validateCheckpointName(tooLong)).toBe('Name must be 80 characters or fewer');
  });

  it('rejects disallowed characters', () => {
    expect(validateCheckpointName('bad/name')).toMatch(/may only contain/);
    expect(validateCheckpointName('emoji 🚀')).toMatch(/may only contain/);
  });

  it('accepts letters, numbers, spaces, hyphens, underscores, and dots', () => {
    expect(validateCheckpointName('before-refactor_v1.2')).toBeNull();
    expect(validateCheckpointName('  trimmed ok  ')).toBeNull();
  });
});

describe('rowToCheckpoint', () => {
  it('maps snake_case columns to the camelCase shape', () => {
    const cp = rowToCheckpoint({
      id: 'c1',
      session_id: 's1',
      name: 'checkpoint',
      description: 'a note',
      message_sequence_number: 42,
      context_snapshot: { totalTokens: 1234, fileCount: 5 },
      created_at: '2026-06-12T00:00:00Z',
    });
    expect(cp).toEqual({
      id: 'c1',
      sessionId: 's1',
      name: 'checkpoint',
      description: 'a note',
      messageSequenceNumber: 42,
      contextSnapshot: { totalTokens: 1234, fileCount: 5 },
      createdAt: '2026-06-12T00:00:00Z',
    });
  });

  it('defaults a missing snapshot + null description', () => {
    const cp = rowToCheckpoint({
      id: 'c2',
      session_id: 's1',
      name: 'bare',
      description: null,
      message_sequence_number: null,
      created_at: 'now',
    });
    expect(cp.description).toBeUndefined();
    expect(cp.messageSequenceNumber).toBe(0);
    expect(cp.contextSnapshot).toEqual({ totalTokens: 0, fileCount: 0 });
  });
});
