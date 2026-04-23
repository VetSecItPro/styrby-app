/**
 * Tests for `cli/handlers/multi.ts`
 *
 * Covers:
 *   - Argument parsing: missing --agents exits(2)
 *   - Argument parsing: invalid agent name exits(2)
 *   - --dry-run flag: creates group, prints validation message, returns
 *   - Unauthenticated user exits(1)
 *   - Relay connection failure exits(1)
 *   - Orchestrator start failure exits(1)
 *   - Happy path + dry-run validates config successfully
 *
 * WHY we don't test the full session lifecycle in this handler test:
 *   The lifecycle (spawning, streaming, Ctrl+C) is covered by
 *   multiAgentOrchestrator.test.ts. The handler test focuses on
 *   argument parsing, auth gating, and error exits.
 *
 * @module cli/handlers/__tests__/multi
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Logger mock ────────────────────────────────────────────────────────────

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── chalk mock ─────────────────────────────────────────────────────────────

// WHY: chalk.bold is both a callable and an object with sub-properties like
// chalk.bold.green. The mock must handle both usage patterns.
const makeChalkFn = (s?: string) => {
  const fn = (x: string) => x;
  fn.green = (x: string) => x;
  fn.red = (x: string) => x;
  fn.gray = (x: string) => x;
  fn.yellow = (x: string) => x;
  fn.cyan = (x: string) => x;
  return s !== undefined ? s : fn;
};

vi.mock('chalk', () => ({
  default: {
    red: (s: string) => s,
    green: (s: string) => s,
    bold: Object.assign((s: string) => s, { green: (s: string) => s }),
    gray: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
  },
}));

// ── process.exit mock ──────────────────────────────────────────────────────

const mockExit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
  throw new Error(`process.exit(${code})`);
});

// ── persistence mock ───────────────────────────────────────────────────────

const mockLoadPersistedData = vi.fn();
vi.mock('@/persistence', () => ({
  loadPersistedData: () => mockLoadPersistedData(),
}));

// ── env config mock ────────────────────────────────────────────────────────

vi.mock('@/env', () => ({
  config: { supabaseUrl: 'https://test.supabase.co', supabaseAnonKey: 'test-anon-key' },
}));

// ── Supabase client mock ───────────────────────────────────────────────────

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
}));

// ── StyrbyApi mock ─────────────────────────────────────────────────────────

const mockApiConnect = vi.fn(async () => {});
const mockApiDisconnect = vi.fn(async () => {});
const mockApiConfigure = vi.fn();

vi.mock('@/api/api', () => ({
  StyrbyApi: vi.fn().mockImplementation(() => ({
    configure: mockApiConfigure,
    connect: mockApiConnect,
    disconnect: mockApiDisconnect,
  })),
}));

// ── MultiAgentOrchestrator mock ────────────────────────────────────────────

const mockOrchestratorStart = vi.fn();

vi.mock('@/agent/multiAgentOrchestrator', () => ({
  MultiAgentOrchestrator: vi.fn().mockImplementation(() => ({
    start: mockOrchestratorStart,
  })),
}));

// ── os mock ────────────────────────────────────────────────────────────────

vi.mock('os', () => ({ hostname: vi.fn(() => 'test-machine') }));

// ============================================================================
// Tests
// ============================================================================

// Import handler AFTER mocks are defined
import { handleMulti } from '../multi';

describe('handleMulti', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticated
    mockLoadPersistedData.mockReturnValue({
      userId: 'user-123',
      accessToken: 'tok_test',
      machineId: 'machine-abc',
    });
    mockApiConnect.mockResolvedValue(undefined);
    mockApiDisconnect.mockResolvedValue(undefined);
  });

  // ── Argument errors → exit(2) ──────────────────────────────────────────

  it('exits(2) when --agents flag is missing', async () => {
    await expect(handleMulti([])).rejects.toThrow('process.exit(2)');
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('exits(2) when an unknown agent is specified', async () => {
    await expect(handleMulti(['--agents', 'unknownbot'])).rejects.toThrow('process.exit(2)');
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('exits(2) when --agents is empty string', async () => {
    await expect(handleMulti(['--agents', ''])).rejects.toThrow('process.exit(2)');
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  // ── Auth gate → exit(1) ────────────────────────────────────────────────

  it('exits(1) when not authenticated (no persisted data)', async () => {
    mockLoadPersistedData.mockReturnValue(null);
    await expect(handleMulti(['--agents', 'claude,codex'])).rejects.toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits(1) when persisted data has no userId', async () => {
    mockLoadPersistedData.mockReturnValue({ accessToken: 'tok', machineId: 'machine' });
    await expect(handleMulti(['--agents', 'claude'])).rejects.toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  // ── Relay failure → exit(1) ────────────────────────────────────────────

  it('exits(1) when relay connection fails', async () => {
    mockApiConnect.mockRejectedValueOnce(new Error('WebSocket refused'));
    await expect(handleMulti(['--agents', 'claude,codex'])).rejects.toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  // ── Orchestrator failure → exit(1) ────────────────────────────────────

  it('exits(1) when orchestrator.start throws', async () => {
    mockOrchestratorStart.mockRejectedValueOnce(
      new Error('Agent "codex" is not available')
    );
    await expect(handleMulti(['--agents', 'claude,codex'])).rejects.toThrow('process.exit(1)');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  // ── Dry-run happy path ─────────────────────────────────────────────────

  it('dry-run completes without error when config is valid', async () => {
    mockOrchestratorStart.mockResolvedValueOnce({
      groupId: 'dry-run-group',
      agents: [
        { agentId: 'claude', sessionId: 'dry-run-claude-0', color: '\x1b[36m', stop: async () => {} },
        { agentId: 'codex',  sessionId: 'dry-run-codex-1',  color: '\x1b[33m', stop: async () => {} },
      ],
      stop: async () => {},
      focus: async () => {},
    });

    // dry-run returns early without waiting for signals
    await expect(
      handleMulti(['--agents', 'claude,codex', '--dry-run'])
    ).resolves.toBeUndefined();

    // Orchestrator was called with dryRun: true
    expect(mockOrchestratorStart).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, agentIds: ['claude', 'codex'] })
    );
  });

  it('dry-run passes prompt and project path to orchestrator', async () => {
    mockOrchestratorStart.mockResolvedValueOnce({
      groupId: 'dry-run-group',
      agents: [],
      stop: async () => {},
      focus: async () => {},
    });

    await handleMulti([
      '--agents', 'gemini',
      '--prompt', 'refactor the auth module',
      '--project', '/tmp/myproject',
      '--dry-run',
    ]);

    expect(mockOrchestratorStart).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'refactor the auth module',
        projectPath: expect.stringContaining('myproject'),
        dryRun: true,
      })
    );
  });

  it('passes --name to orchestrator as groupName', async () => {
    mockOrchestratorStart.mockResolvedValueOnce({
      groupId: 'dry-run-group',
      agents: [],
      stop: async () => {},
      focus: async () => {},
    });

    await handleMulti([
      '--agents', 'claude',
      '--name', 'Auth refactor PR-42',
      '--dry-run',
    ]);

    expect(mockOrchestratorStart).toHaveBeenCalledWith(
      expect.objectContaining({ groupName: 'Auth refactor PR-42' })
    );
  });
});
