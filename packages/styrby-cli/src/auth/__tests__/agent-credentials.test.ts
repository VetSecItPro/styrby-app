/**
 * Tests for auth/agent-credentials.ts
 *
 * Covers:
 * - AGENT_CONFIGS: validates shape and required fields for all supported agents
 * - getAgentStatus: installed+configured paths, env var detection,
 *   config-file detection, installed-but-unconfigured (unknown) path
 * - getAllAgentStatus: returns all 4 agents
 * - getInstalledAgents: filters to only installed agents
 * - getDefaultAgent: returns Claude first, then priority order, then null
 * - getAgentSpawnCommand: correct command + agent-specific CLI flags
 *
 * WHY: Agent detection drives the onboarding UX. If we misreport whether
 * Claude is installed, users see an empty state when their tools are present.
 * Testing all detection branches with mocked filesystem and process calls
 * prevents silent regressions when we add new agents or change detection logic.
 *
 * @module auth/__tests__/agent-credentials
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks — declared before imports
// ============================================================================

/**
 * Mock node:child_process so no real shell commands are executed.
 *
 * WHY: agent-credentials.ts uses `spawn(whichCmd, [command], { shell: false,
 * stdio: 'ignore' })` (refactored 2026-05-05 from execAsync template-string
 * shell exec — closes the residual CWE-78 class). The mock returns an
 * EventEmitter-shaped object with `on('exit', cb)` + `on('error', cb)` so
 * the function-under-test's promise-resolve path works.
 */
vi.mock('node:child_process', () => {
  const spawn = vi.fn();
  return { spawn };
});

/**
 * Mock node:fs to control config file existence checks.
 */
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}));

/**
 * Mock the logger to suppress output.
 */
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ============================================================================
// Imports — after vi.mock declarations
// ============================================================================

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import {
  AGENT_CONFIGS,
  getAgentStatus,
  getAllAgentStatus,
  getInstalledAgents,
  getDefaultAgent,
  getAgentSpawnCommand,
  type AgentType,
} from '../agent-credentials';

// ============================================================================
// Helpers
// ============================================================================

/** Cast the spawn mock to a usable vi.fn() type. */
const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;

/**
 * Build a fake spawn child that resolves the function-under-test's promise.
 * isCommandInstalled() listens for `exit` (resolves to code===0) and `error`
 * (resolves to false). We invoke the registered listener synchronously on
 * the next microtask so the assertion queue settles.
 */
function makeChild(exitCode: number | null, error?: Error) {
  return {
    on(event: string, cb: (arg?: unknown) => void) {
      if (error && event === 'error') {
        queueMicrotask(() => cb(error));
      } else if (!error && event === 'exit') {
        queueMicrotask(() => cb(exitCode));
      }
      return this;
    },
  };
}

/** Simulate `which <cmd>` succeeding (exit 0). */
function mockCommandInstalled() {
  mockSpawn.mockImplementation(() => makeChild(0));
}

/** Simulate `which <cmd>` failing (exit 1 — not found). */
function mockCommandNotInstalled() {
  mockSpawn.mockImplementation(() => makeChild(1));
}

// ============================================================================
// AGENT_CONFIGS
// ============================================================================

describe('AGENT_CONFIGS', () => {
  const SUPPORTED_AGENTS: AgentType[] = [
    'claude', 'codex', 'gemini', 'opencode',
    'aider', 'goose', 'amp', 'crush', 'kilo', 'kiro', 'droid',
  ];

  it('has entries for all 11 supported agents', () => {
    const keys = Object.keys(AGENT_CONFIGS) as AgentType[];

    expect(keys).toHaveLength(11);
    for (const agent of SUPPORTED_AGENTS) {
      expect(keys).toContain(agent);
    }
  });

  // WHY (audit 2026-05-05 LOW fix): factories/claude.ts reads
  // ~/.claude/auth.json — detection must include it so the
  // cost-classifier and detector agree.
  it('claude config includes both ~/.claude/auth.json and ~/.claude.json', () => {
    expect(AGENT_CONFIGS.claude.configPaths).toContain('.claude/auth.json');
    expect(AGENT_CONFIGS.claude.configPaths).toContain('.claude.json');
  });

  // Smoke-test that each Tier 2/3 agent has the minimum fields needed
  // for onboarding to display correctly.
  it.each(['aider', 'goose', 'amp', 'crush', 'kilo', 'kiro', 'droid'] as AgentType[])(
    '%s (Tier 2/3) has command, envVars, configPaths, setupUrl, and color',
    (agent) => {
      const c = AGENT_CONFIGS[agent];
      expect(c.command).toBe(agent);
      expect(c.envVars.length).toBeGreaterThan(0);
      expect(c.configPaths.length).toBeGreaterThan(0);
      expect(c.setupUrl).toMatch(/^https?:\/\//);
      expect(c.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    },
  );

  it.each(SUPPORTED_AGENTS)('%s config has required fields', (agent) => {
    const config = AGENT_CONFIGS[agent];

    expect(typeof config.id).toBe('string');
    expect(typeof config.name).toBe('string');
    expect(typeof config.provider).toBe('string');
    expect(typeof config.command).toBe('string');
    expect(Array.isArray(config.envVars)).toBe(true);
    expect(config.envVars.length).toBeGreaterThan(0);
    expect(Array.isArray(config.configPaths)).toBe(true);
    expect(config.configPaths.length).toBeGreaterThan(0);
    expect(typeof config.setupUrl).toBe('string');
    expect(config.setupUrl).toMatch(/^https?:\/\//);
    expect(typeof config.color).toBe('string');
    expect(config.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it.each(SUPPORTED_AGENTS)('%s config id matches its key', (agent) => {
    expect(AGENT_CONFIGS[agent].id).toBe(agent);
  });

  it('claude config points to anthropic', () => {
    expect(AGENT_CONFIGS.claude.provider).toBe('Anthropic');
    expect(AGENT_CONFIGS.claude.command).toBe('claude');
    expect(AGENT_CONFIGS.claude.envVars).toContain('ANTHROPIC_API_KEY');
  });

  it('codex config points to OpenAI', () => {
    expect(AGENT_CONFIGS.codex.provider).toBe('OpenAI');
    expect(AGENT_CONFIGS.codex.command).toBe('codex');
    expect(AGENT_CONFIGS.codex.envVars).toContain('OPENAI_API_KEY');
  });

  it('gemini config points to Google', () => {
    expect(AGENT_CONFIGS.gemini.provider).toBe('Google');
    expect(AGENT_CONFIGS.gemini.command).toBe('gemini');
  });

  it('opencode config has multiple env var options', () => {
    expect(AGENT_CONFIGS.opencode.envVars.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// getAgentStatus
// ============================================================================

describe('getAgentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: not installed, no env vars, no config files
    mockCommandNotInstalled();
    mockExistsSync.mockReturnValue(false);
    // Clear env vars that might be set on the test machine
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct agent and name fields', async () => {
    const status = await getAgentStatus('claude');

    expect(status.agent).toBe('claude');
    expect(status.name).toBe(AGENT_CONFIGS.claude.name);
    expect(status.provider).toBe(AGENT_CONFIGS.claude.provider);
    expect(status.command).toBe(AGENT_CONFIGS.claude.command);
    expect(status.setupUrl).toBe(AGENT_CONFIGS.claude.setupUrl);
    expect(status.color).toBe(AGENT_CONFIGS.claude.color);
  });

  it('returns installed=false and configured=false when command is not found and no env/config', async () => {
    mockCommandNotInstalled();

    const status = await getAgentStatus('claude');

    expect(status.installed).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.configSource).toBeUndefined();
  });

  it('returns installed=true when command is found in PATH', async () => {
    mockCommandInstalled();

    const status = await getAgentStatus('claude');

    expect(status.installed).toBe(true);
  });

  it('returns configured=true and configSource="env" when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

    const status = await getAgentStatus('claude');

    expect(status.configured).toBe(true);
    expect(status.configSource).toBe('env');
    expect(status.configDetail).toBe('ANTHROPIC_API_KEY');

    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns configured=true and configSource="env" when OPENAI_API_KEY is set for codex', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';

    const status = await getAgentStatus('codex');

    expect(status.configured).toBe(true);
    expect(status.configSource).toBe('env');
    expect(status.configDetail).toBe('OPENAI_API_KEY');

    delete process.env.OPENAI_API_KEY;
  });

  it('returns configured=true and configSource="config-file" when a config file exists', async () => {
    mockExistsSync.mockImplementation((filePath: string) => {
      return filePath.includes('.claude.json');
    });

    const status = await getAgentStatus('claude');

    expect(status.configured).toBe(true);
    expect(status.configSource).toBe('config-file');
    expect(status.configDetail).toBe('.claude.json');
  });

  it('env var detection takes precedence over config file', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    mockExistsSync.mockReturnValue(true);

    const status = await getAgentStatus('claude');

    expect(status.configSource).toBe('env');

    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns configSource="unknown" when installed but no env or config file detected', async () => {
    mockCommandInstalled();
    // No env vars, no config files

    const status = await getAgentStatus('claude');

    expect(status.installed).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.configSource).toBe('unknown');
  });

  it('configSource is undefined when not installed and not configured', async () => {
    mockCommandNotInstalled();

    const status = await getAgentStatus('claude');

    expect(status.installed).toBe(false);
    expect(status.configSource).toBeUndefined();
  });

  it('ignores env vars with empty or whitespace-only values', async () => {
    process.env.ANTHROPIC_API_KEY = '   ';

    const status = await getAgentStatus('claude');

    expect(status.configured).toBe(false);

    delete process.env.ANTHROPIC_API_KEY;
  });
});

// ============================================================================
// getAllAgentStatus
// ============================================================================

describe('getAllAgentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCommandNotInstalled();
    mockExistsSync.mockReturnValue(false);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('returns statuses for all 11 agents', async () => {
    const all = await getAllAgentStatus();

    expect(Object.keys(all)).toHaveLength(11);
    for (const a of [
      'claude', 'codex', 'gemini', 'opencode',
      'aider', 'goose', 'amp', 'crush', 'kilo', 'kiro', 'droid',
    ] as AgentType[]) {
      expect(all[a]).toBeDefined();
    }
  });

  it('each status has the correct agent field', async () => {
    const all = await getAllAgentStatus();
    for (const a of Object.keys(all) as AgentType[]) {
      expect(all[a].agent).toBe(a);
    }
  });
});

// ============================================================================
// getInstalledAgents
// ============================================================================

describe('getInstalledAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('returns an empty array when no agents are installed', async () => {
    mockCommandNotInstalled();

    const installed = await getInstalledAgents();

    expect(installed).toHaveLength(0);
  });

  it('returns all agents when all are installed', async () => {
    mockCommandInstalled();

    const installed = await getInstalledAgents();

    expect(installed).toHaveLength(11);
    expect(installed.every((s) => s.installed)).toBe(true);
  });

  it('only includes agents that pass the installed check', async () => {
    // claude installed, others not
    mockSpawn.mockImplementation((_whichCmd: string, args: string[]) =>
      args[0]?.includes('claude') ? makeChild(0) : makeChild(1)
    );

    const installed = await getInstalledAgents();

    expect(installed).toHaveLength(1);
    expect(installed[0].agent).toBe('claude');
  });
});

// ============================================================================
// getDefaultAgent
// ============================================================================

describe('getDefaultAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('returns null when no agents are installed', async () => {
    mockCommandNotInstalled();

    const def = await getDefaultAgent();

    expect(def).toBeNull();
  });

  it('returns claude when claude is installed (highest priority)', async () => {
    mockCommandInstalled();

    const def = await getDefaultAgent();

    expect(def).not.toBeNull();
    expect(def!.agent).toBe('claude');
  });

  it('falls back to codex when claude is not installed', async () => {
    mockSpawn.mockImplementation((_whichCmd: string, args: string[]) => {
      const cmd = args[0] ?? '';
      return cmd.includes('codex') || cmd.includes('gemini') || cmd.includes('opencode')
        ? makeChild(0)
        : makeChild(1);
    });

    const def = await getDefaultAgent();

    expect(def).not.toBeNull();
    expect(def!.agent).toBe('codex');
  });

  it('falls back to gemini when claude and codex are not installed', async () => {
    mockSpawn.mockImplementation((_whichCmd: string, args: string[]) => {
      const cmd = args[0] ?? '';
      return cmd.includes('gemini') || cmd.includes('opencode') ? makeChild(0) : makeChild(1);
    });

    const def = await getDefaultAgent();

    expect(def).not.toBeNull();
    expect(def!.agent).toBe('gemini');
  });

  it('falls back to opencode when only opencode is installed', async () => {
    mockSpawn.mockImplementation((_whichCmd: string, args: string[]) =>
      args[0]?.includes('opencode') ? makeChild(0) : makeChild(1)
    );

    const def = await getDefaultAgent();

    expect(def).not.toBeNull();
    expect(def!.agent).toBe('opencode');
  });
});

// ============================================================================
// getAgentSpawnCommand
// ============================================================================

describe('getAgentSpawnCommand', () => {
  it('returns the correct command for each agent', () => {
    const agents: AgentType[] = ['claude', 'codex', 'gemini', 'opencode'];

    for (const agent of agents) {
      const { command } = getAgentSpawnCommand(agent);
      expect(command).toBe(AGENT_CONFIGS[agent].command);
    }
  });

  it('returns empty args when no options are provided', () => {
    const { args } = getAgentSpawnCommand('claude');

    expect(args).toEqual([]);
  });

  it('claude: includes --cwd and --prompt when both options are set', () => {
    const { command, args } = getAgentSpawnCommand('claude', {
      cwd: '/my/project',
      prompt: 'Fix the bug',
    });

    expect(command).toBe('claude');
    expect(args).toContain('--cwd');
    expect(args).toContain('/my/project');
    expect(args).toContain('--prompt');
    expect(args).toContain('Fix the bug');
  });

  it('claude: omits --cwd when cwd is not provided', () => {
    const { args } = getAgentSpawnCommand('claude', { prompt: 'hello' });

    expect(args).not.toContain('--cwd');
  });

  it('codex: includes --working-dir when cwd is provided', () => {
    const { command, args } = getAgentSpawnCommand('codex', { cwd: '/project' });

    expect(command).toBe('codex');
    expect(args).toContain('--working-dir');
    expect(args).toContain('/project');
  });

  it('gemini: includes --project-dir when cwd is provided', () => {
    const { command, args } = getAgentSpawnCommand('gemini', { cwd: '/workspace' });

    expect(command).toBe('gemini');
    expect(args).toContain('--project-dir');
    expect(args).toContain('/workspace');
  });

  it('opencode: includes --message when prompt is provided', () => {
    const { command, args } = getAgentSpawnCommand('opencode', { prompt: 'Refactor auth' });

    expect(command).toBe('opencode');
    expect(args).toContain('--message');
    expect(args).toContain('Refactor auth');
  });

  it('opencode: does not include --cwd flag (uses current directory)', () => {
    const { args } = getAgentSpawnCommand('opencode', { cwd: '/project' });

    expect(args).not.toContain('--cwd');
    expect(args).not.toContain('/project');
  });
});
