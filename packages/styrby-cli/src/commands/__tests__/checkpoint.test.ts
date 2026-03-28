/**
 * Tests for the checkpoint command handlers.
 *
 * These tests cover:
 * - CLI argument parsing for all four subcommands (save, list, restore, delete)
 * - Checkpoint name validation (length, character set, empty)
 * - saveCheckpoint core logic (mocked Supabase)
 * - listCheckpoints core logic (mocked Supabase)
 * - findCheckpoint by UUID and by name (mocked Supabase)
 * - deleteCheckpoint return values (mocked Supabase)
 * - dbRowToCheckpoint field mapping
 * - handleCheckpointCommand dispatcher
 *
 * WHY: Checkpoints are a user-facing data persistence feature. Bugs in arg
 * parsing, name validation, or Supabase interaction can result in silent data
 * loss (checkpoint not saved) or confusing CLI errors. Full coverage of all
 * branches prevents regressions across CLI versions.
 *
 * @module commands/__tests__/checkpoint.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

// Mock @/persistence to avoid reading ~/.styrby/data.json
vi.mock('@/persistence', () => ({
  loadPersistedData: vi.fn().mockReturnValue({
    userId: 'user-uuid-001',
    accessToken: 'test-access-token',
    machineId: 'machine-001',
  }),
  getRecentSessionForProject: vi.fn().mockReturnValue({
    sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    agentType: 'claude',
    projectPath: '/test/project',
    createdAt: '2026-03-27T10:00:00.000Z',
    lastActivityAt: '2026-03-27T12:00:00.000Z',
    status: 'running',
  }),
}));

// Mock @/env to avoid requiring real Supabase credentials
vi.mock('@/env', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    isDev: true,
    isProd: false,
  },
}));

// Mock chalk to avoid ANSI escape codes in test output
vi.mock('chalk', () => ({
  default: {
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    gray: (s: string) => s,
    white: (s: string) => s,
    cyan: (s: string) => s,
  },
}));

// Import after mocks
import {
  parseCheckpointSaveArgs,
  parseCheckpointListArgs,
  parseCheckpointRestoreArgs,
  parseCheckpointDeleteArgs,
  validateCheckpointName,
  saveCheckpoint,
  listCheckpoints,
  findCheckpoint,
  deleteCheckpoint,
  dbRowToCheckpoint,
  handleCheckpointCommand,
} from '../checkpoint';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// Fixtures
// ============================================================================

/** Minimal valid checkpoint row from Supabase */
const CHECKPOINT_ROW = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  session_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  user_id: 'user-uuid-001',
  name: 'before-refactor',
  description: 'Auth endpoint working',
  message_sequence_number: 42,
  context_snapshot: { totalTokens: 12000, fileCount: 8 },
  created_at: '2026-03-27T10:00:00.000Z',
  updated_at: '2026-03-27T10:00:00.000Z',
};

const SESSION_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const USER_ID = 'user-uuid-001';

// ============================================================================
// Arg parsing: save
// ============================================================================

describe('parseCheckpointSaveArgs', () => {
  it('parses name from first positional argument', () => {
    const result = parseCheckpointSaveArgs(['before-refactor']);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('before-refactor');
    expect(result!.description).toBeNull();
    expect(result!.sessionId).toBeNull();
  });

  it('parses --description flag', () => {
    const result = parseCheckpointSaveArgs([
      'before-refactor',
      '--description',
      'Auth working',
    ]);
    expect(result!.description).toBe('Auth working');
  });

  it('parses -d short form for description', () => {
    const result = parseCheckpointSaveArgs([
      'before-refactor',
      '-d',
      'Short note',
    ]);
    expect(result!.description).toBe('Short note');
  });

  it('parses --session flag', () => {
    const result = parseCheckpointSaveArgs([
      'before-refactor',
      '--session',
      SESSION_ID,
    ]);
    expect(result!.sessionId).toBe(SESSION_ID);
  });

  it('returns null when name is missing', () => {
    const result = parseCheckpointSaveArgs([]);
    expect(result).toBeNull();
  });

  it('ignores flags as the name', () => {
    const result = parseCheckpointSaveArgs(['--description', 'note']);
    expect(result).toBeNull(); // No non-flag positional arg
  });
});

// ============================================================================
// Arg parsing: list
// ============================================================================

describe('parseCheckpointListArgs', () => {
  it('returns null sessionId when no args given', () => {
    const result = parseCheckpointListArgs([]);
    expect(result.sessionId).toBeNull();
  });

  it('returns sessionId from first positional arg', () => {
    const result = parseCheckpointListArgs([SESSION_ID]);
    expect(result.sessionId).toBe(SESSION_ID);
  });

  it('ignores flags', () => {
    const result = parseCheckpointListArgs(['--verbose', SESSION_ID]);
    expect(result.sessionId).toBe(SESSION_ID);
  });
});

// ============================================================================
// Arg parsing: restore
// ============================================================================

describe('parseCheckpointRestoreArgs', () => {
  it('parses nameOrId from first positional argument', () => {
    const result = parseCheckpointRestoreArgs(['before-refactor']);
    expect(result!.nameOrId).toBe('before-refactor');
    expect(result!.sessionId).toBeNull();
  });

  it('parses --session flag', () => {
    const result = parseCheckpointRestoreArgs([
      'before-refactor',
      '--session',
      SESSION_ID,
    ]);
    expect(result!.sessionId).toBe(SESSION_ID);
  });

  it('returns null when no nameOrId given', () => {
    const result = parseCheckpointRestoreArgs([]);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Arg parsing: delete
// ============================================================================

describe('parseCheckpointDeleteArgs', () => {
  it('parses nameOrId from first positional argument', () => {
    const result = parseCheckpointDeleteArgs(['before-refactor']);
    expect(result!.nameOrId).toBe('before-refactor');
    expect(result!.force).toBe(false);
    expect(result!.sessionId).toBeNull();
  });

  it('parses --force flag', () => {
    const result = parseCheckpointDeleteArgs(['before-refactor', '--force']);
    expect(result!.force).toBe(true);
  });

  it('parses -f short form for force', () => {
    const result = parseCheckpointDeleteArgs(['before-refactor', '-f']);
    expect(result!.force).toBe(true);
  });

  it('parses --session flag', () => {
    const result = parseCheckpointDeleteArgs([
      'before-refactor',
      '--session',
      SESSION_ID,
    ]);
    expect(result!.sessionId).toBe(SESSION_ID);
  });

  it('returns null when no nameOrId given', () => {
    const result = parseCheckpointDeleteArgs([]);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Name validation
// ============================================================================

describe('validateCheckpointName', () => {
  it('returns null for a valid name', () => {
    expect(validateCheckpointName('before-refactor')).toBeNull();
  });

  it('returns null for a name with spaces', () => {
    expect(validateCheckpointName('before the big refactor')).toBeNull();
  });

  it('returns null for a name with underscores and dots', () => {
    expect(validateCheckpointName('v1.0_stable')).toBeNull();
  });

  it('returns an error for an empty name', () => {
    expect(validateCheckpointName('')).not.toBeNull();
    expect(validateCheckpointName('   ')).not.toBeNull();
  });

  it('returns an error for a name that is too long', () => {
    const longName = 'a'.repeat(81);
    const result = validateCheckpointName(longName);
    expect(result).not.toBeNull();
    expect(result).toContain('80');
  });

  it('returns null for a name exactly at the limit', () => {
    const exactName = 'a'.repeat(80);
    expect(validateCheckpointName(exactName)).toBeNull();
  });

  it('returns an error for names with invalid characters', () => {
    expect(validateCheckpointName('name/with/slashes')).not.toBeNull();
    expect(validateCheckpointName('name<with>brackets')).not.toBeNull();
    expect(validateCheckpointName('name@symbol')).not.toBeNull();
  });

  it('returns an error for a name with semicolons', () => {
    expect(validateCheckpointName('name;drop table')).not.toBeNull();
  });
});

// ============================================================================
// dbRowToCheckpoint mapping
// ============================================================================

describe('dbRowToCheckpoint', () => {
  it('maps all fields correctly from a database row', () => {
    const checkpoint = dbRowToCheckpoint(CHECKPOINT_ROW as Record<string, unknown>);

    expect(checkpoint.id).toBe(CHECKPOINT_ROW.id);
    expect(checkpoint.sessionId).toBe(CHECKPOINT_ROW.session_id);
    expect(checkpoint.name).toBe(CHECKPOINT_ROW.name);
    expect(checkpoint.description).toBe(CHECKPOINT_ROW.description);
    expect(checkpoint.messageSequenceNumber).toBe(CHECKPOINT_ROW.message_sequence_number);
    expect(checkpoint.contextSnapshot.totalTokens).toBe(12000);
    expect(checkpoint.contextSnapshot.fileCount).toBe(8);
    expect(checkpoint.createdAt).toBe(CHECKPOINT_ROW.created_at);
  });

  it('sets description to undefined when null in DB', () => {
    const row = { ...CHECKPOINT_ROW, description: null };
    const checkpoint = dbRowToCheckpoint(row as Record<string, unknown>);
    expect(checkpoint.description).toBeUndefined();
  });

  it('defaults messageSequenceNumber to 0 when missing', () => {
    const row = { ...CHECKPOINT_ROW, message_sequence_number: undefined };
    const checkpoint = dbRowToCheckpoint(row as Record<string, unknown>);
    expect(checkpoint.messageSequenceNumber).toBe(0);
  });

  it('defaults contextSnapshot fields to 0 when context_snapshot is empty', () => {
    const row = { ...CHECKPOINT_ROW, context_snapshot: {} };
    const checkpoint = dbRowToCheckpoint(row as Record<string, unknown>);
    expect(checkpoint.contextSnapshot.totalTokens).toBe(0);
    expect(checkpoint.contextSnapshot.fileCount).toBe(0);
  });

  it('defaults contextSnapshot to empty when context_snapshot is null', () => {
    const row = { ...CHECKPOINT_ROW, context_snapshot: null };
    const checkpoint = dbRowToCheckpoint(row as Record<string, unknown>);
    expect(checkpoint.contextSnapshot.totalTokens).toBe(0);
  });
});

// ============================================================================
// saveCheckpoint
// ============================================================================

describe('saveCheckpoint', () => {
  it('inserts a checkpoint and returns the created record', async () => {
    const mockInserted = { ...CHECKPOINT_ROW };

    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { sequence_number: 42 },
        error: null,
      }),
      single: vi.fn()
        // First call: session fetch
        .mockResolvedValueOnce({
          data: { context_window_used: 12000, user_id: USER_ID },
          error: null,
        })
        // Second call: insert result
        .mockResolvedValueOnce({
          data: mockInserted,
          error: null,
        }),
      insert: vi.fn().mockReturnThis(),
    } as unknown as SupabaseClient;

    const checkpoint = await saveCheckpoint(mockSupabase, USER_ID, SESSION_ID, {
      name: 'before-refactor',
      description: 'Auth working',
      sessionId: null,
    });

    expect(checkpoint.name).toBe('before-refactor');
    expect(checkpoint.messageSequenceNumber).toBe(42);
  });

  it('throws when session is not found', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { sequence_number: 10 },
        error: null,
      }),
      single: vi.fn().mockResolvedValueOnce({
        data: null,
        error: { message: 'Not found', code: 'PGRST116' },
      }),
    } as unknown as SupabaseClient;

    await expect(
      saveCheckpoint(mockSupabase, USER_ID, SESSION_ID, {
        name: 'test',
        description: null,
        sessionId: null,
      })
    ).rejects.toThrow('Session not found');
  });

  it('throws with helpful message on duplicate name (code 23505)', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { sequence_number: 5 },
        error: null,
      }),
      single: vi.fn()
        .mockResolvedValueOnce({
          data: { context_window_used: 5000, user_id: USER_ID },
          error: null,
        })
        .mockResolvedValueOnce({
          data: null,
          error: { message: 'duplicate key', code: '23505' },
        }),
      insert: vi.fn().mockReturnThis(),
    } as unknown as SupabaseClient;

    await expect(
      saveCheckpoint(mockSupabase, USER_ID, SESSION_ID, {
        name: 'duplicate-name',
        description: null,
        sessionId: null,
      })
    ).rejects.toThrow('already exists');
  });

  it('rejects when session belongs to a different user', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { sequence_number: 10 },
        error: null,
      }),
      single: vi.fn().mockResolvedValueOnce({
        data: { context_window_used: 1000, user_id: 'different-user-id' },
        error: null,
      }),
    } as unknown as SupabaseClient;

    await expect(
      saveCheckpoint(mockSupabase, USER_ID, SESSION_ID, {
        name: 'test',
        description: null,
        sessionId: null,
      })
    ).rejects.toThrow('do not have access');
  });
});

// ============================================================================
// listCheckpoints
// ============================================================================

describe('listCheckpoints', () => {
  it('returns mapped checkpoints sorted by created_at descending', async () => {
    const rows = [
      { ...CHECKPOINT_ROW, id: 'cp-2', name: 'second', created_at: '2026-03-27T12:00:00.000Z' },
      { ...CHECKPOINT_ROW, id: 'cp-1', name: 'first', created_at: '2026-03-27T10:00:00.000Z' },
    ];

    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: rows, error: null }),
    } as unknown as SupabaseClient;

    const checkpoints = await listCheckpoints(mockSupabase, SESSION_ID);

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0].name).toBe('second');
    expect(checkpoints[1].name).toBe('first');
  });

  it('returns empty array when no checkpoints exist', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as unknown as SupabaseClient;

    const checkpoints = await listCheckpoints(mockSupabase, SESSION_ID);
    expect(checkpoints).toHaveLength(0);
  });

  it('throws when Supabase returns an error', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'connection timeout' },
      }),
    } as unknown as SupabaseClient;

    await expect(listCheckpoints(mockSupabase, SESSION_ID)).rejects.toThrow('connection timeout');
  });
});

// ============================================================================
// findCheckpoint
// ============================================================================

describe('findCheckpoint', () => {
  it('finds a checkpoint by UUID', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: CHECKPOINT_ROW,
        error: null,
      }),
    } as unknown as SupabaseClient;

    const checkpoint = await findCheckpoint(
      mockSupabase,
      SESSION_ID,
      CHECKPOINT_ROW.id
    );

    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.id).toBe(CHECKPOINT_ROW.id);
  });

  it('falls back to name lookup when nameOrId is not a UUID', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: CHECKPOINT_ROW,
        error: null,
      }),
    } as unknown as SupabaseClient;

    const checkpoint = await findCheckpoint(
      mockSupabase,
      SESSION_ID,
      'before-refactor' // not a UUID
    );

    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.name).toBe('before-refactor');
  });

  it('returns null when checkpoint does not exist', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: null,
        error: null,
      }),
    } as unknown as SupabaseClient;

    const checkpoint = await findCheckpoint(
      mockSupabase,
      SESSION_ID,
      'nonexistent'
    );

    expect(checkpoint).toBeNull();
  });
});

// ============================================================================
// deleteCheckpoint
// ============================================================================

describe('deleteCheckpoint', () => {
  it('returns true when checkpoint is deleted', async () => {
    // findCheckpoint will return the checkpoint row
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: CHECKPOINT_ROW,
        error: null,
      }),
      delete: vi.fn().mockReturnThis(),
    } as unknown as SupabaseClient;

    // Mock delete chain's final resolution
    (mockSupabase.delete as ReturnType<typeof vi.fn>).mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const result = await deleteCheckpoint(mockSupabase, SESSION_ID, CHECKPOINT_ROW.id);
    expect(result).toBe(true);
  });

  it('returns false when checkpoint is not found', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: null,
        error: null,
      }),
    } as unknown as SupabaseClient;

    const result = await deleteCheckpoint(mockSupabase, SESSION_ID, 'nonexistent');
    expect(result).toBe(false);
  });
});

// ============================================================================
// handleCheckpointCommand dispatcher
// ============================================================================

describe('handleCheckpointCommand', () => {
  it('prints usage when no subcommand is given', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCheckpointCommand([]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    consoleSpy.mockRestore();
  });

  it('exits with code 1 for unknown subcommand', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(handleCheckpointCommand(['unknowncmd'])).rejects.toThrow('process.exit called');

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
