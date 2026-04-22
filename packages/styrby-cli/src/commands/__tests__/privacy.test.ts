/**
 * Tests for the `styrby privacy` command handlers.
 *
 * Covers:
 *   1. parseExportDataArgs — arg parsing for `styrby export-data`
 *   2. handleExportData    — API call, file write, rate limit, auth check
 *   3. handleDeleteAccount — 2-step confirmation, email match, API call
 *   4. handlePrivacy       — routing to sub-commands and help output
 *
 * WHY: The privacy commands are audit-critical. A silent export failure
 * (e.g., no error on 429) or a broken email-confirmation gate would be a
 * GDPR compliance defect. These tests guard both success paths and all
 * named failure modes.
 *
 * Audit: GDPR Art. 15/20 (export); GDPR Art. 17 (delete); SOC2 CC6.5.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

// ============================================================================
// Mocks
// ============================================================================

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

vi.mock('@/persistence', () => ({
  loadPersistedData: vi.fn().mockReturnValue({
    userId: 'user-uuid-001',
    accessToken: 'test-access-token',
  }),
}));

vi.mock('@/env', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/index', () => ({ VERSION: '1.0.0-test' }));

// Mock readline so we can control stdin prompts
const mockPromptAnswers: string[] = [];
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_q: string, cb: (ans: string) => void) => {
      cb(mockPromptAnswers.shift() ?? '');
    }),
    close: vi.fn(),
  })),
}));

// Mock Supabase client for delete-account (email verification)
const mockGetUser = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ============================================================================
// parseExportDataArgs
// ============================================================================

describe('parseExportDataArgs', () => {
  it('returns null outputPath and pretty:true as defaults', async () => {
    const { parseExportDataArgs } = await import('../privacy');
    const opts = parseExportDataArgs([]);
    expect(opts.outputPath).toBeNull();
    expect(opts.pretty).toBe(true);
  });

  it('parses -o flag', async () => {
    const { parseExportDataArgs } = await import('../privacy');
    const opts = parseExportDataArgs(['-o', 'my-export.json']);
    expect(opts.outputPath).toBe('my-export.json');
  });

  it('parses --output flag', async () => {
    const { parseExportDataArgs } = await import('../privacy');
    const opts = parseExportDataArgs(['--output', '/tmp/data.json']);
    expect(opts.outputPath).toBe('/tmp/data.json');
  });

  it('parses --compact flag', async () => {
    const { parseExportDataArgs } = await import('../privacy');
    const opts = parseExportDataArgs(['--compact']);
    expect(opts.pretty).toBe(false);
  });

  it('handles combined flags', async () => {
    const { parseExportDataArgs } = await import('../privacy');
    const opts = parseExportDataArgs(['-o', 'out.json', '--compact']);
    expect(opts.outputPath).toBe('out.json');
    expect(opts.pretty).toBe(false);
  });
});

// ============================================================================
// handleExportData — API call shape
// ============================================================================

describe('handleExportData', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // WHY: vi.clearAllMocks() resets mockReturnValue set in the vi.mock factory.
    // Re-apply the default authenticated state so each test starts logged-in.
    const { loadPersistedData } = await import('@/persistence');
    vi.mocked(loadPersistedData).mockReturnValue({
      userId: 'user-uuid-001',
      accessToken: 'test-access-token',
    } as never);
    mockFetch.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls POST /api/account/export with Bearer token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ test: true }),
    });

    const { handleExportData } = await import('../privacy');
    await handleExportData([]);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/account/export'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-access-token',
        }),
      }),
    );
  });

  it('writes export JSON to stdout when no --output flag', async () => {
    const exportData = JSON.stringify({ userId: 'user-123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => exportData,
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { handleExportData } = await import('../privacy');
    await handleExportData([]);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('"userId"'));
  });

  it('exits with code 1 on 429 rate limit response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ retryAfter: 3600 }),
    });

    const { handleExportData } = await import('../privacy');

    await expect(handleExportData([])).rejects.toThrow('process.exit(1)');
  });

  it('exits with code 1 on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal server error' }),
    });

    const { handleExportData } = await import('../privacy');

    await expect(handleExportData([])).rejects.toThrow('process.exit(1)');
  });

  it('writes to file when --output flag provided', async () => {
    const exportData = JSON.stringify({ userId: 'user-123' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => exportData,
    });

    const writeFileSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

    const { handleExportData } = await import('../privacy');
    await handleExportData(['-o', '/tmp/my-export.json']);

    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining('my-export.json'),
      expect.any(String),
      'utf-8',
    );
  });

  it('refuses to write to system directory /etc', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{}',
    });

    const { handleExportData } = await import('../privacy');

    await expect(handleExportData(['-o', '/etc/evil'])).rejects.toThrow('process.exit(1)');
  });

  it('exits with code 1 when not authenticated', async () => {
    const { loadPersistedData } = await import('@/persistence');
    vi.mocked(loadPersistedData).mockReturnValueOnce(null as never);

    const { handleExportData } = await import('../privacy');

    await expect(handleExportData([])).rejects.toThrow('process.exit(1)');
  });
});

// ============================================================================
// handleDeleteAccount — 2-step confirmation
// ============================================================================

describe('handleDeleteAccount', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // WHY: vi.clearAllMocks() resets mockReturnValue set in the vi.mock factory.
    // Re-apply the default authenticated state so each test starts logged-in.
    const { loadPersistedData } = await import('@/persistence');
    vi.mocked(loadPersistedData).mockReturnValue({
      userId: 'user-uuid-001',
      accessToken: 'test-access-token',
    } as never);
    mockFetch.mockReset();
    mockPromptAnswers.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cancels when user does not type "yes" at first prompt', async () => {
    mockPromptAnswers.push('no'); // first prompt: "yes" to continue

    const { handleDeleteAccount } = await import('../privacy');
    await handleDeleteAccount([]);

    // Should not call the API
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exits when email does not match registered email', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'real@example.com' } },
      error: null,
    });

    mockPromptAnswers.push('yes'); // first prompt
    mockPromptAnswers.push('wrong@example.com'); // second prompt: email

    const { handleDeleteAccount } = await import('../privacy');

    await expect(handleDeleteAccount([])).rejects.toThrow('process.exit(1)');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls DELETE /api/account/delete with correct body when email matches', async () => {
    const TEST_EMAIL = 'test@example.com';

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: TEST_EMAIL } },
      error: null,
    });

    mockPromptAnswers.push('yes');
    mockPromptAnswers.push(TEST_EMAIL);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Deleted in 30 days' }),
    });

    const { handleDeleteAccount } = await import('../privacy');
    await handleDeleteAccount([]);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/account/delete'),
      expect.objectContaining({
        method: 'DELETE',
        body: expect.stringContaining('DELETE MY ACCOUNT'),
      }),
    );
  });

  it('exits with code 1 on 429 from delete API', async () => {
    const TEST_EMAIL = 'test@example.com';

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: TEST_EMAIL } },
      error: null,
    });

    mockPromptAnswers.push('yes');
    mockPromptAnswers.push(TEST_EMAIL);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Rate limited' }),
    });

    const { handleDeleteAccount } = await import('../privacy');
    await expect(handleDeleteAccount([])).rejects.toThrow('process.exit(1)');
  });

  it('is case-insensitive for email comparison', async () => {
    const TEST_EMAIL = 'Test@Example.COM';

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@example.com' } },
      error: null,
    });

    mockPromptAnswers.push('yes');
    mockPromptAnswers.push(TEST_EMAIL); // mixed case should still match

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Deleted' }),
    });

    const { handleDeleteAccount } = await import('../privacy');
    await handleDeleteAccount([]); // should NOT throw

    expect(mockFetch).toHaveBeenCalled();
  });
});

// ============================================================================
// handlePrivacy — routing
// ============================================================================

describe('handlePrivacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows help text when called with no subcommand', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { handlePrivacy } = await import('../privacy');
    await handlePrivacy([]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Privacy Controls'),
    );
  });
});
