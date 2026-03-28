/**
 * Tests for the export/import command handlers.
 *
 * These tests cover:
 * - CLI argument parsing for `styrby export` and `styrby import`
 * - Export payload assembly via fetchSessionExport (mocked Supabase)
 * - Import upsert logic via importSession (mocked Supabase)
 * - parseExportFile validation (file I/O mocked via vitest)
 *
 * WHY: Export/import are user-facing data portability features. Bugs here
 * can lead to data loss (silent export failures, partial imports). Full
 * coverage of parsing, assembly, and DB interaction prevents regressions.
 *
 * @module commands/__tests__/export.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionExport } from 'styrby-shared';

// Mock node:fs before importing the module under test so that all fs
// calls in export.ts hit the mock rather than the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
  };
});

// Mock @/persistence so tests don't read ~/.styrby/data.json
vi.mock('@/persistence', () => ({
  loadPersistedData: vi.fn().mockReturnValue({
    userId: 'user-uuid-001',
    accessToken: 'test-access-token',
    machineId: 'machine-001',
  }),
}));

// Mock @/env so tests don't need real Supabase credentials
vi.mock('@/env', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    isDev: true,
    isProd: false,
  },
}));

// Mock @/index to provide VERSION without loading the full CLI
vi.mock('@/index', () => ({ VERSION: '0.1.0-test' }));

// Import after mocks are set up
import {
  parseExportArgs,
  parseImportArgs,
  parseExportFile,
  fetchSessionExport,
  importSession,
} from '../export';

// ============================================================================
// Fixtures
// ============================================================================

/**
 * Minimal valid SessionExport fixture.
 */
const VALID_EXPORT: SessionExport = {
  exportVersion: 1,
  exportedAt: '2026-03-27T10:00:00.000Z',
  generatedBy: 'styrby-cli@0.1.0-test',
  session: {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    title: 'Test Session',
    summary: 'Refactored auth module',
    agentType: 'claude',
    model: 'claude-sonnet-4',
    status: 'stopped',
    projectPath: '/home/user/project',
    gitBranch: 'main',
    gitRemoteUrl: null,
    tags: ['auth', 'refactor'],
    startedAt: '2026-03-27T09:00:00.000Z',
    endedAt: '2026-03-27T09:45:00.000Z',
    messageCount: 10,
    contextWindowUsed: 5000,
    contextWindowLimit: 200000,
  },
  messages: [
    {
      id: 'b1ffcd00-ad1c-4f09-ac7e-7cc0ce491b22',
      sequenceNumber: 1,
      messageType: 'user_prompt',
      contentEncrypted: 'base64-encrypted-content==',
      encryptionNonce: 'base64-nonce==',
      riskLevel: null,
      toolName: null,
      durationMs: null,
      inputTokens: 50,
      outputTokens: 0,
      cacheTokens: 0,
      createdAt: '2026-03-27T09:00:01.000Z',
    },
    {
      id: 'c200de11-be2d-4a10-ad8f-8dd1df502c33',
      sequenceNumber: 2,
      messageType: 'agent_response',
      contentEncrypted: 'base64-response-content==',
      encryptionNonce: 'base64-nonce-2==',
      riskLevel: null,
      toolName: null,
      durationMs: 1200,
      inputTokens: 1500,
      outputTokens: 800,
      cacheTokens: 200,
      createdAt: '2026-03-27T09:00:03.000Z',
    },
  ],
  cost: {
    totalCostUsd: 0.0012,
    totalInputTokens: 1550,
    totalOutputTokens: 800,
    totalCacheTokens: 200,
    model: 'claude-sonnet-4',
    agentType: 'claude',
  },
  contextBreakdown: null,
};

// ============================================================================
// parseExportArgs
// ============================================================================

describe('parseExportArgs', () => {
  it('parses a session ID as the first positional argument', () => {
    const opts = parseExportArgs(['abc-123']);
    expect(opts.sessionId).toBe('abc-123');
    expect(opts.all).toBe(false);
    expect(opts.outputPath).toBeNull();
    expect(opts.pretty).toBe(true);
  });

  it('parses --all flag', () => {
    const opts = parseExportArgs(['--all']);
    expect(opts.all).toBe(true);
    expect(opts.sessionId).toBeNull();
  });

  it('parses -a as alias for --all', () => {
    const opts = parseExportArgs(['-a']);
    expect(opts.all).toBe(true);
  });

  it('parses --output path', () => {
    const opts = parseExportArgs(['abc-123', '--output', 'session.json']);
    expect(opts.outputPath).toBe('session.json');
  });

  it('parses -o as alias for --output', () => {
    const opts = parseExportArgs(['abc-123', '-o', 'out.json']);
    expect(opts.outputPath).toBe('out.json');
  });

  it('parses --compact to disable pretty printing', () => {
    const opts = parseExportArgs(['abc-123', '--compact']);
    expect(opts.pretty).toBe(false);
  });

  it('ignores flag-like arguments as sessionId', () => {
    const opts = parseExportArgs(['--all', '-o', 'dir/']);
    expect(opts.sessionId).toBeNull();
    expect(opts.all).toBe(true);
    expect(opts.outputPath).toBe('dir/');
  });

  it('returns defaults when no args are given', () => {
    const opts = parseExportArgs([]);
    expect(opts.sessionId).toBeNull();
    expect(opts.all).toBe(false);
    expect(opts.outputPath).toBeNull();
    expect(opts.pretty).toBe(true);
  });
});

// ============================================================================
// parseImportArgs
// ============================================================================

describe('parseImportArgs', () => {
  it('parses a file path as the first positional argument', () => {
    const opts = parseImportArgs(['session.json']);
    expect(opts).not.toBeNull();
    expect(opts!.filePath).toBe('session.json');
  });

  it('ignores flag arguments when finding the file path', () => {
    const opts = parseImportArgs(['--verbose', 'session.json']);
    expect(opts).not.toBeNull();
    expect(opts!.filePath).toBe('session.json');
  });

  it('returns null when no file path is given', () => {
    expect(parseImportArgs([])).toBeNull();
    expect(parseImportArgs(['--verbose'])).toBeNull();
  });
});

// ============================================================================
// parseExportFile
// ============================================================================

describe('parseExportFile', () => {
  const mockFs = fs as { existsSync: ReturnType<typeof vi.fn>; readFileSync: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a valid SessionExport for well-formed JSON', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(VALID_EXPORT));

    const result = parseExportFile('session.json');
    expect(result.exportVersion).toBe(1);
    expect(result.session.id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(result.messages).toHaveLength(2);
  });

  it('throws if the file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(() => parseExportFile('missing.json')).toThrowError(/File not found/);
  });

  it('throws if the file contains invalid JSON', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('not valid json {{{');
    expect(() => parseExportFile('bad.json')).toThrowError(/Invalid JSON/);
  });

  it('throws if the file is not a JSON object', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('"just a string"');
    expect(() => parseExportFile('bad.json')).toThrowError(/not a JSON object/);
  });

  it('throws on unsupported export version', () => {
    mockFs.existsSync.mockReturnValue(true);
    const future = { ...VALID_EXPORT, exportVersion: 99 };
    mockFs.readFileSync.mockReturnValue(JSON.stringify(future));
    expect(() => parseExportFile('future.json')).toThrowError(/Unsupported export version/);
  });

  it('throws when the session field is missing', () => {
    mockFs.existsSync.mockReturnValue(true);
    const noSession = { exportVersion: 1, exportedAt: '2026-01-01T00:00:00Z' };
    mockFs.readFileSync.mockReturnValue(JSON.stringify(noSession));
    expect(() => parseExportFile('nosess.json')).toThrowError(/missing required "session" field/);
  });
});

// ============================================================================
// fetchSessionExport
// ============================================================================

describe('fetchSessionExport', () => {
  /**
   * Build a minimal Supabase client mock that returns controllable data.
   *
   * @param sessionRow - The session row to return from `sessions` table query
   * @param messageRows - The message rows to return from `session_messages`
   */
  function buildMockSupabase(
    sessionRow: Record<string, unknown> | null,
    sessionError: { code?: string; message: string } | null,
    messageRows: Record<string, unknown>[],
  ) {
    const messagesQuery = {
      data: messageRows,
      error: null,
      select: () => messagesQuery,
      eq: () => messagesQuery,
      order: () => messagesQuery,
      limit: () => messagesQuery,
    };

    const sessionQuery = {
      data: sessionRow,
      error: sessionError,
      select: () => sessionQuery,
      eq: () => sessionQuery,
      single: () => ({ data: sessionRow, error: sessionError }),
    };

    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'sessions') return sessionQuery;
        if (table === 'session_messages') return messagesQuery;
        return sessionQuery;
      }),
    };
  }

  it('returns null when session is not found (PGRST116)', async () => {
    const supabase = buildMockSupabase(null, { code: 'PGRST116', message: 'not found' }, []);
    const result = await fetchSessionExport(supabase as never, 'missing-id');
    expect(result).toBeNull();
  });

  it('throws on generic Supabase session fetch error', async () => {
    const supabase = buildMockSupabase(null, { message: 'internal error' }, []);
    await expect(fetchSessionExport(supabase as never, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).rejects.toThrow(
      'Failed to fetch session'
    );
  });

  it('assembles a valid SessionExport from session and message rows', async () => {
    const sessionRow = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      title: 'Test',
      summary: null,
      agent_type: 'claude',
      model: 'claude-sonnet-4',
      status: 'stopped',
      project_path: '/home/user/app',
      git_branch: 'main',
      git_remote_url: null,
      tags: ['test'],
      started_at: '2026-03-27T09:00:00Z',
      created_at: '2026-03-27T09:00:00Z',
      ended_at: '2026-03-27T09:30:00Z',
      message_count: 1,
      context_window_used: null,
      context_window_limit: null,
      total_cost_usd: 0.0005,
      total_input_tokens: 500,
      total_output_tokens: 300,
      total_cache_tokens: 0,
    };

    const messageRows = [
      {
        id: 'msg-001',
        sequence_number: 1,
        message_type: 'user_prompt',
        content_encrypted: 'enc==',
        encryption_nonce: 'nonce==',
        risk_level: null,
        tool_name: null,
        duration_ms: null,
        input_tokens: 50,
        output_tokens: 0,
        cache_tokens: 0,
        metadata: {},
        created_at: '2026-03-27T09:00:01Z',
      },
    ];

    const supabase = buildMockSupabase(sessionRow, null, messageRows);
    const result = await fetchSessionExport(supabase as never, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

    expect(result).not.toBeNull();
    expect(result!.exportVersion).toBe(1);
    expect(result!.generatedBy).toContain('styrby-cli');
    expect(result!.session.id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(result!.session.agentType).toBe('claude');
    expect(result!.messages).toHaveLength(1);
    expect(result!.messages[0].sequenceNumber).toBe(1);
    expect(result!.messages[0].contentEncrypted).toBe('enc==');
    expect(result!.cost.totalCostUsd).toBe(0.0005);
    expect(result!.contextBreakdown).toBeNull();
  });

  it('falls back to created_at when started_at is missing', async () => {
    const sessionRow = {
      id: 'd300ef22-cf3e-4b21-ae9a-9ee2ea613d44',
      title: null,
      summary: null,
      agent_type: 'codex',
      model: null,
      status: 'stopped',
      project_path: null,
      git_branch: null,
      git_remote_url: null,
      tags: [],
      started_at: undefined,
      created_at: '2026-01-15T12:00:00Z',
      ended_at: null,
      message_count: 0,
      context_window_used: null,
      context_window_limit: null,
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_tokens: 0,
    };

    const supabase = buildMockSupabase(sessionRow, null, []);
    const result = await fetchSessionExport(supabase as never, 'd300ef22-cf3e-4b21-ae9a-9ee2ea613d44');

    expect(result!.session.startedAt).toBe('2026-01-15T12:00:00Z');
    expect(result!.messages).toHaveLength(0);
  });
});

// ============================================================================
// importSession
// ============================================================================

describe('importSession', () => {
  /**
   * Build a Supabase mock that records upsert calls.
   */
  function buildImportMock(
    sessionUpsertError: null | { message: string },
    messageUpsertError: null | { message: string },
    messageCount = 2,
  ) {
    const sessionUpsert = {
      error: sessionUpsertError,
      upsert: vi.fn().mockReturnThis(),
    };

    const messageUpsert = {
      error: messageUpsertError,
      count: messageCount,
      select: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockReturnThis(),
    };

    const fromSpy = vi.fn().mockImplementation((table: string) => {
      if (table === 'sessions') return sessionUpsert;
      if (table === 'session_messages') return messageUpsert;
      return sessionUpsert;
    });

    return { from: fromSpy, _sessionUpsert: sessionUpsert, _messageUpsert: messageUpsert };
  }

  it('upserts the session row with the importing user ID', async () => {
    const mock = buildImportMock(null, null, 2);
    const result = await importSession(mock as never, 'importer-uid', VALID_EXPORT);

    expect(result.sessionId).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(mock._sessionUpsert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        user_id: 'importer-uid', // Must use importer's user ID, not export's
        agent_type: 'claude',
        title: 'Test Session',
      }),
      expect.objectContaining({ onConflict: 'id' })
    );
  });

  it('throws when session upsert fails', async () => {
    const mock = buildImportMock({ message: 'RLS violation' }, null);
    await expect(importSession(mock as never, 'uid', VALID_EXPORT)).rejects.toThrow(
      'Failed to import session'
    );
  });

  it('throws when message upsert fails', async () => {
    const mock = buildImportMock(null, { message: 'FK violation' });
    await expect(importSession(mock as never, 'uid', VALID_EXPORT)).rejects.toThrow(
      'Failed to import messages'
    );
  });

  it('handles a session with zero messages without calling messages table', async () => {
    const mock = buildImportMock(null, null, 0);
    const emptyExport: SessionExport = { ...VALID_EXPORT, messages: [] };

    const result = await importSession(mock as never, 'uid', emptyExport);
    expect(result.messagesImported).toBe(0);

    // session_messages table should NOT be called when there are no messages
    const messageTableCalls = (mock.from as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([t]: [string]) => t === 'session_messages'
    );
    expect(messageTableCalls).toHaveLength(0);
  });

  it('returns the session ID and message count on success', async () => {
    const mock = buildImportMock(null, null, 2);
    const result = await importSession(mock as never, 'uid', VALID_EXPORT);

    expect(result.sessionId).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(result.messagesImported).toBe(2);
  });

  it('overrides the user_id with the importing user regardless of export source', async () => {
    // WHY: A malicious export file could set user_id to another user's UUID.
    // importSession must always use the authenticated importer's ID.
    const mock = buildImportMock(null, null, 0);
    await importSession(mock as never, 'legit-user-id', { ...VALID_EXPORT, messages: [] });

    expect(mock._sessionUpsert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'legit-user-id' }),
      expect.anything()
    );
  });
});

// ============================================================================
// Round-trip: parseExportFile → importSession shape compatibility
// ============================================================================

describe('round-trip: file parse → import compatibility', () => {
  it('data parsed from a file can be passed directly to importSession', async () => {
    const mockFs = fs as { existsSync: ReturnType<typeof vi.fn>; readFileSync: ReturnType<typeof vi.fn> };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(VALID_EXPORT));

    const parsed = parseExportFile('session.json');

    // Verify the parsed shape matches what importSession expects
    expect(parsed.session.id).toBe(VALID_EXPORT.session.id);
    expect(parsed.messages).toHaveLength(VALID_EXPORT.messages.length);
    expect(parsed.cost.totalCostUsd).toBe(VALID_EXPORT.cost.totalCostUsd);

    // Verify importSession accepts it without type errors
    const supabaseMock = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        error: null,
        count: 2,
      }),
    };

    const result = await importSession(supabaseMock as never, 'test-user', parsed);
    expect(result.sessionId).toBe(VALID_EXPORT.session.id);
  });
});
