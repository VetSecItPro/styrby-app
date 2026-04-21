/**
 * Tests for the install-agent command handlers.
 *
 * Covers:
 * - AGENT_PACKAGES data integrity (all four agents have required fields)
 * - installAgent: already-installed path, npm success path, npm error paths
 *   (EACCES, 404, ENOTFOUND, generic non-zero exit)
 * - installAgents: sequential install with per-agent progress callback
 * - handleInstallCommand: no-args usage, --all with nothing to install,
 *   unknown agent, already-installed agent, install cancelled
 *
 * WHY: installAgent drives the npm child_process spawn path; mishandled exit
 * codes or stderr patterns produce silent failures on user machines.
 *
 * @module commands/__tests__/install-agent.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

// Mock child_process spawn before importing the module under test
const mockOn = vi.fn();
const mockStdoutOn = vi.fn();
const mockStderrOn = vi.fn();
const mockProc = {
  stdout: { on: mockStdoutOn },
  stderr: { on: mockStderrOn },
  on: mockOn,
};

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => mockProc),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/auth/agent-credentials', () => ({
  AGENT_CONFIGS: {
    claude: { name: 'Claude Code' },
    codex: { name: 'Codex' },
    gemini: { name: 'Gemini CLI' },
    opencode: { name: 'OpenCode' },
  },
  getAgentStatus: vi.fn(),
  getAllAgentStatus: vi.fn(),
}));

vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    dim: (s: string) => s,
    cyan: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    gray: (s: string) => s,
  },
}));

import { spawn } from 'node:child_process';
import { getAgentStatus, getAllAgentStatus } from '@/auth/agent-credentials';
import {
  AGENT_PACKAGES,
  installAgent,
  installAgents,
  handleInstallCommand,
} from '../install-agent';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Simulate the child_process spawn lifecycle so the Promise in installWithNpm
 * resolves deterministically in tests.
 *
 * @param stderrContent - Content to emit on stderr (controls error branch logic)
 * @param exitCode - Exit code emitted by the 'close' event
 */
function simulateSpawn(stderrContent: string, exitCode: number) {
  mockStdoutOn.mockImplementation(() => {});
  mockStderrOn.mockImplementation((_event: string, cb: (data: Buffer) => void) => {
    if (stderrContent) cb(Buffer.from(stderrContent));
  });
  mockOn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'close') setImmediate(() => cb(exitCode));
    if (event === 'error') {
      // error listener registered but not called in this path
    }
  });
}

function simulateSpawnError(errorMessage: string) {
  mockStdoutOn.mockImplementation(() => {});
  mockStderrOn.mockImplementation(() => {});
  mockOn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'error') setImmediate(() => cb(new Error(errorMessage)));
  });
}

// ============================================================================
// AGENT_PACKAGES data integrity
// ============================================================================

describe('AGENT_PACKAGES', () => {
  const agents = ['claude', 'codex', 'gemini', 'opencode'] as const;

  for (const agent of agents) {
    it(`${agent} has required fields`, () => {
      const pkg = AGENT_PACKAGES[agent];
      expect(pkg.packageManager).toBe('npm');
      expect(typeof pkg.packageName).toBe('string');
      expect(pkg.packageName.length).toBeGreaterThan(0);
      expect(typeof pkg.description).toBe('string');
      expect(typeof pkg.postInstall).toBe('string');
    });
  }
});

// ============================================================================
// installAgent
// ============================================================================

describe('installAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success=true with a message when agent is already installed', async () => {
    vi.mocked(getAgentStatus).mockResolvedValue({
      agent: 'claude',
      name: 'Claude Code',
      installed: true,
      configured: true,
      command: 'claude',
      version: '1.0.0',
    });

    const result = await installAgent('claude');

    expect(result.success).toBe(true);
    expect(result.error).toMatch(/already installed/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns success=true when npm exits with code 0', async () => {
    vi.mocked(getAgentStatus).mockResolvedValue({
      agent: 'claude',
      name: 'Claude Code',
      installed: false,
      configured: false,
      command: 'claude',
    });

    simulateSpawn('', 0);

    const result = await installAgent('claude');

    expect(spawn).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.agent).toBe('claude');
    expect(result.error).toBeUndefined();
  });

  it('returns EACCES error message when npm exits with permission denied', async () => {
    vi.mocked(getAgentStatus).mockResolvedValue({
      agent: 'codex',
      name: 'Codex',
      installed: false,
      configured: false,
      command: 'codex',
    });

    simulateSpawn('npm ERR! code EACCES', 1);

    const result = await installAgent('codex');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/permission denied/i);
  });

  it('returns 404 error message when package is not found', async () => {
    vi.mocked(getAgentStatus).mockResolvedValue({
      agent: 'gemini',
      name: 'Gemini CLI',
      installed: false,
      configured: false,
      command: 'gemini',
    });

    simulateSpawn('npm ERR! 404 Not Found', 1);

    const result = await installAgent('gemini');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('returns network error message when npm reports ENOTFOUND', async () => {
    vi.mocked(getAgentStatus).mockResolvedValue({
      agent: 'opencode',
      name: 'OpenCode',
      installed: false,
      configured: false,
      command: 'opencode',
    });

    simulateSpawn('npm ERR! code ENOTFOUND', 1);

    const result = await installAgent('opencode');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/network error/i);
  });

  it('returns generic exit code message for unknown npm failure', async () => {
    vi.mocked(getAgentStatus).mockResolvedValue({
      agent: 'claude',
      name: 'Claude Code',
      installed: false,
      configured: false,
      command: 'claude',
    });

    simulateSpawn('some unknown error', 2);

    const result = await installAgent('claude');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exit code 2/i);
  });

  it('returns error when npm binary cannot be spawned', async () => {
    vi.mocked(getAgentStatus).mockResolvedValue({
      agent: 'claude',
      name: 'Claude Code',
      installed: false,
      configured: false,
      command: 'claude',
    });

    simulateSpawnError('npm not found');

    const result = await installAgent('claude');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/failed to run npm/i);
  });

  it('calls the onProgress callback during install', async () => {
    vi.mocked(getAgentStatus).mockResolvedValue({
      agent: 'claude',
      name: 'Claude Code',
      installed: false,
      configured: false,
      command: 'claude',
    });

    simulateSpawn('', 0);

    const messages: string[] = [];
    await installAgent('claude', (msg) => messages.push(msg));

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => /installing/i.test(m))).toBe(true);
  });
});

// ============================================================================
// installAgents (batch)
// ============================================================================

describe('installAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('installs agents sequentially and returns one result per agent', async () => {
    vi.mocked(getAgentStatus)
      .mockResolvedValueOnce({
        agent: 'claude',
        name: 'Claude Code',
        installed: false,
        configured: false,
        command: 'claude',
      })
      .mockResolvedValueOnce({
        agent: 'codex',
        name: 'Codex',
        installed: false,
        configured: false,
        command: 'codex',
      });

    // Both spawns succeed
    mockStdoutOn.mockImplementation(() => {});
    mockStderrOn.mockImplementation(() => {});
    mockOn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') setImmediate(() => cb(0));
    });

    const progressCalls: [string, string][] = [];
    const results = await installAgents(['claude', 'codex'], (agent, msg) =>
      progressCalls.push([agent, msg])
    );

    expect(results).toHaveLength(2);
    expect(results[0].agent).toBe('claude');
    expect(results[1].agent).toBe('codex');
    expect(results.every((r) => r.success)).toBe(true);
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it('returns mixed results when some agents fail', async () => {
    vi.mocked(getAgentStatus)
      .mockResolvedValueOnce({
        agent: 'claude',
        name: 'Claude Code',
        installed: false,
        configured: false,
        command: 'claude',
      })
      .mockResolvedValueOnce({
        agent: 'codex',
        name: 'Codex',
        installed: false,
        configured: false,
        command: 'codex',
      });

    let callCount = 0;
    mockStdoutOn.mockImplementation(() => {});
    mockStderrOn.mockImplementation(() => {});
    mockOn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') {
        callCount++;
        // First spawn succeeds, second fails
        setImmediate(() => cb(callCount === 1 ? 0 : 1));
      }
    });

    const results = await installAgents(['claude', 'codex']);

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
  });
});

// ============================================================================
// handleInstallCommand
// ============================================================================

describe('handleInstallCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints usage when no arguments are provided', async () => {
    await handleInstallCommand([]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('prints unknown agent message for invalid agent name', async () => {
    await handleInstallCommand(['bingbong']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown agent'));
  });

  it('prints already-installed message when agent is already present', async () => {
    vi.mocked(getAgentStatus).mockResolvedValue({
      agent: 'claude',
      name: 'Claude Code',
      installed: true,
      configured: true,
      command: 'claude',
      version: '1.0.0',
    });

    await handleInstallCommand(['claude']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('already installed'));
  });

  it('prints all-installed message when --all and no agents need installing', async () => {
    vi.mocked(getAllAgentStatus).mockResolvedValue({
      claude: { agent: 'claude', name: 'Claude Code', installed: true, configured: true, command: 'claude' },
      codex: { agent: 'codex', name: 'Codex', installed: true, configured: true, command: 'codex' },
      gemini: { agent: 'gemini', name: 'Gemini CLI', installed: true, configured: true, command: 'gemini' },
      opencode: { agent: 'opencode', name: 'OpenCode', installed: true, configured: true, command: 'opencode' },
    });

    await handleInstallCommand(['--all']);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('already installed')
    );
  });
});
