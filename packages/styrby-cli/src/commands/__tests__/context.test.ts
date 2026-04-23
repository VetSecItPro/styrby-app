/**
 * Context Command Handler Tests (Phase 3.5)
 *
 * Tests for the `styrby context` subcommand arg parsers and the
 * `dbRowToContextMemory` DB mapper.
 *
 * Test strategy:
 *   - parseContextShowArgs: --group required, UUID validation, --json flag
 *   - parseContextSyncArgs: --group required, UUID validation, --budget parsing + clamping
 *   - parseContextExportArgs: --session required, UUID validation, --json flag
 *   - parseContextImportArgs: --session + --from required, UUID validation, --task capture
 *   - dbRowToContextMemory: field mapping, defaults for missing fields
 *   - handleContextCommand: unknown subcommand exits, no subcommand exits
 *
 * WHY mock Supabase + persistence:
 *   Unit tests for arg parsers do not need DB access. The DB interaction code
 *   is covered by integration tests and the focus route tests. Mocking keeps
 *   these tests fast (<100ms) and CI-safe (no Supabase credentials needed).
 *
 * @module commands/__tests__/context.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/persistence', () => ({
  loadPersistedData: vi.fn().mockReturnValue({
    userId: 'user-uuid-001',
    accessToken: 'test-access-token',
    machineId: 'machine-001',
  }),
}));

vi.mock('@/env', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    isDev: true,
    isProd: false,
    env: 'development',
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock @supabase/supabase-js — not needed for arg parsing tests
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
      then: vi.fn().mockResolvedValue({ error: null }),
    }),
  })),
}));

// ============================================================================
// Subject under test
// ============================================================================

import {
  parseContextShowArgs,
  parseContextSyncArgs,
  parseContextExportArgs,
  parseContextImportArgs,
  dbRowToContextMemory,
  handleContextCommand,
} from '../context';
import { TOKEN_BUDGET_DEFAULT, TOKEN_BUDGET_MAX, TOKEN_BUDGET_MIN } from '@styrby/shared/context-sync';

// ============================================================================
// Test data
// ============================================================================

const VALID_GROUP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const VALID_SESSION_ID = 'b1ffcd00-1d1c-4ef9-aa7e-7cc0ce491b22';
const VALID_SESSION_ID_2 = 'c2aade11-2e2d-4ef0-bb8f-8dd1df502c33';
const INVALID_ID = 'not-a-uuid';

// ============================================================================
// parseContextShowArgs
// ============================================================================

describe('parseContextShowArgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns options when --group is a valid UUID', () => {
    const opts = parseContextShowArgs(['--group', VALID_GROUP_ID]);
    expect(opts).not.toBeNull();
    expect(opts!.groupId).toBe(VALID_GROUP_ID);
  });

  it('returns null when --group is missing', () => {
    const opts = parseContextShowArgs([]);
    expect(opts).toBeNull();
  });

  it('returns null when --group has no value', () => {
    const opts = parseContextShowArgs(['--group']);
    expect(opts).toBeNull();
  });

  it('returns null when --group is not a valid UUID', () => {
    const opts = parseContextShowArgs(['--group', INVALID_ID]);
    expect(opts).toBeNull();
  });

  it('sets json: true when --json flag is present', () => {
    const opts = parseContextShowArgs(['--group', VALID_GROUP_ID, '--json']);
    expect(opts).not.toBeNull();
    expect(opts!.json).toBe(true);
  });

  it('defaults json to false when --json is absent', () => {
    const opts = parseContextShowArgs(['--group', VALID_GROUP_ID]);
    expect(opts!.json).toBeFalsy();
  });
});

// ============================================================================
// parseContextSyncArgs
// ============================================================================

describe('parseContextSyncArgs', () => {
  it('returns options when --group is a valid UUID', () => {
    const opts = parseContextSyncArgs(['--group', VALID_GROUP_ID]);
    expect(opts).not.toBeNull();
    expect(opts!.groupId).toBe(VALID_GROUP_ID);
  });

  it('returns null when --group is missing', () => {
    expect(parseContextSyncArgs([])).toBeNull();
  });

  it('returns null when --group is invalid UUID', () => {
    expect(parseContextSyncArgs(['--group', INVALID_ID])).toBeNull();
  });

  it('parses --budget when valid number provided', () => {
    const opts = parseContextSyncArgs(['--group', VALID_GROUP_ID, '--budget', '2000']);
    expect(opts!.tokenBudget).toBe(2000);
  });

  it('clamps --budget below TOKEN_BUDGET_MIN to TOKEN_BUDGET_MIN', () => {
    const opts = parseContextSyncArgs(['--group', VALID_GROUP_ID, '--budget', '10']);
    expect(opts!.tokenBudget).toBe(TOKEN_BUDGET_MIN);
  });

  it('clamps --budget above TOKEN_BUDGET_MAX to TOKEN_BUDGET_MAX', () => {
    const opts = parseContextSyncArgs(['--group', VALID_GROUP_ID, '--budget', '99999']);
    expect(opts!.tokenBudget).toBe(TOKEN_BUDGET_MAX);
  });

  it('leaves tokenBudget undefined when --budget not provided', () => {
    const opts = parseContextSyncArgs(['--group', VALID_GROUP_ID]);
    expect(opts!.tokenBudget).toBeUndefined();
  });

  it('ignores non-numeric --budget', () => {
    const opts = parseContextSyncArgs(['--group', VALID_GROUP_ID, '--budget', 'huge']);
    expect(opts!.tokenBudget).toBeUndefined();
  });
});

// ============================================================================
// parseContextExportArgs
// ============================================================================

describe('parseContextExportArgs', () => {
  it('returns options when --session is a valid UUID', () => {
    const opts = parseContextExportArgs(['--session', VALID_SESSION_ID]);
    expect(opts).not.toBeNull();
    expect(opts!.sessionId).toBe(VALID_SESSION_ID);
  });

  it('returns null when --session is missing', () => {
    expect(parseContextExportArgs([])).toBeNull();
  });

  it('returns null when --session has no value', () => {
    expect(parseContextExportArgs(['--session'])).toBeNull();
  });

  it('returns null when --session is not a valid UUID', () => {
    expect(parseContextExportArgs(['--session', INVALID_ID])).toBeNull();
  });

  it('sets json: true when --json flag is present', () => {
    const opts = parseContextExportArgs(['--session', VALID_SESSION_ID, '--json']);
    expect(opts!.json).toBe(true);
  });

  it('defaults json to false when --json is absent', () => {
    const opts = parseContextExportArgs(['--session', VALID_SESSION_ID]);
    expect(opts!.json).toBeFalsy();
  });
});

// ============================================================================
// parseContextImportArgs
// ============================================================================

describe('parseContextImportArgs', () => {
  it('returns options when both --session and --from are valid UUIDs', () => {
    const opts = parseContextImportArgs([
      '--session', VALID_SESSION_ID,
      '--from', VALID_SESSION_ID_2,
    ]);
    expect(opts).not.toBeNull();
    expect(opts!.sessionId).toBe(VALID_SESSION_ID);
    expect(opts!.fromSessionId).toBe(VALID_SESSION_ID_2);
  });

  it('returns null when --session is missing', () => {
    expect(parseContextImportArgs(['--from', VALID_SESSION_ID_2])).toBeNull();
  });

  it('returns null when --from is missing', () => {
    expect(parseContextImportArgs(['--session', VALID_SESSION_ID])).toBeNull();
  });

  it('returns null when --session is invalid UUID', () => {
    expect(
      parseContextImportArgs(['--session', INVALID_ID, '--from', VALID_SESSION_ID_2])
    ).toBeNull();
  });

  it('returns null when --from is invalid UUID', () => {
    expect(
      parseContextImportArgs(['--session', VALID_SESSION_ID, '--from', INVALID_ID])
    ).toBeNull();
  });

  it('captures --task when provided', () => {
    const opts = parseContextImportArgs([
      '--session', VALID_SESSION_ID,
      '--from', VALID_SESSION_ID_2,
      '--task', 'Refactor the auth system',
    ]);
    expect(opts!.task).toBe('Refactor the auth system');
  });

  it('leaves task undefined when --task not provided', () => {
    const opts = parseContextImportArgs([
      '--session', VALID_SESSION_ID,
      '--from', VALID_SESSION_ID_2,
    ]);
    expect(opts!.task).toBeUndefined();
  });
});

// ============================================================================
// dbRowToContextMemory
// ============================================================================

describe('dbRowToContextMemory', () => {
  it('maps snake_case DB fields to camelCase', () => {
    const row = {
      id: 'mem-001',
      session_group_id: VALID_GROUP_ID,
      summary_markdown: '## Current task\nFix auth',
      file_refs: [{ path: '/Users/alice/auth.ts', lastTouchedAt: '2026-04-22T12:00:00Z', relevance: 0.9 }],
      recent_messages: [{ role: 'user', preview: 'Fix auth' }],
      token_budget: 3000,
      version: 2,
      created_at: '2026-04-22T10:00:00Z',
      updated_at: '2026-04-22T12:00:00Z',
    };

    const mem = dbRowToContextMemory(row);
    expect(mem.id).toBe('mem-001');
    expect(mem.sessionGroupId).toBe(VALID_GROUP_ID);
    expect(mem.summaryMarkdown).toBe('## Current task\nFix auth');
    expect(mem.fileRefs).toHaveLength(1);
    expect(mem.recentMessages).toHaveLength(1);
    expect(mem.tokenBudget).toBe(3000);
    expect(mem.version).toBe(2);
    expect(mem.createdAt).toBe('2026-04-22T10:00:00Z');
    expect(mem.updatedAt).toBe('2026-04-22T12:00:00Z');
  });

  it('uses TOKEN_BUDGET_DEFAULT when token_budget is missing', () => {
    const row = {
      id: 'mem-002',
      session_group_id: VALID_GROUP_ID,
      summary_markdown: '',
      file_refs: null,
      recent_messages: null,
      version: 1,
      created_at: '2026-04-22T10:00:00Z',
      updated_at: '2026-04-22T10:00:00Z',
    };

    const mem = dbRowToContextMemory(row);
    expect(mem.tokenBudget).toBe(TOKEN_BUDGET_DEFAULT);
  });

  it('defaults fileRefs and recentMessages to empty arrays when null', () => {
    const row = {
      id: 'mem-003',
      session_group_id: VALID_GROUP_ID,
      summary_markdown: '',
      file_refs: null,
      recent_messages: null,
      token_budget: 4000,
      version: 1,
      created_at: '2026-04-22T10:00:00Z',
      updated_at: '2026-04-22T10:00:00Z',
    };

    const mem = dbRowToContextMemory(row);
    expect(mem.fileRefs).toEqual([]);
    expect(mem.recentMessages).toEqual([]);
  });
});

// ============================================================================
// handleContextCommand — dispatcher
// ============================================================================

describe('handleContextCommand', () => {
  it('exits non-zero for unknown subcommand', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(handleContextCommand(['unknownsub'])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits non-zero when no subcommand given', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(handleContextCommand([])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits non-zero for "show" with missing --group', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(handleContextCommand(['show'])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits non-zero for "sync" with missing --group', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(handleContextCommand(['sync'])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits non-zero for "export" with missing --session', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(handleContextCommand(['export'])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits non-zero for "import" with missing --from', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(
      handleContextCommand(['import', '--session', VALID_SESSION_ID])
    ).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
