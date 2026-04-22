/**
 * Tests for the doctor command.
 *
 * Covers:
 * - Node.js version check (pass when >= 18, fail when < 18)
 * - Config check (pass on valid config, fail on load error)
 * - Auth check (pass when authenticated, fail when not)
 * - Agent detection check (pass with agents, fail with none)
 * - Full runDoctor integration: all-pass and some-fail paths
 * - Per-agent probe integration: probeAllAgents pass, fail, and not-installed
 * - checkAgentProbes: summary messages and failure propagation
 *
 * WHY: The doctor command is the first stop for support tickets; a broken
 * check or incorrect pass/fail logic sends users in the wrong direction.
 *
 * @module commands/__tests__/doctor.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/ui/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/configuration', () => ({
  isAuthenticated: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('@/auth/agent-credentials', () => ({
  getAllAgentStatus: vi.fn(),
}));

/**
 * Mock agentProbe module.
 *
 * WHY: probeAllAgents() spawns real child processes (which/--version).
 * In tests we must use controlled fakes that return deterministic results
 * without touching the filesystem or PATH.
 */
vi.mock('../agentProbe', () => ({
  probeAllAgents: vi.fn(),
  formatAgentProbeReport: vi.fn((results: unknown[]) =>
    results.map((r: unknown) => {
      const result = r as { displayName: string; status: string };
      return `  - [${result.status}] ${result.displayName}`;
    }),
  ),
  getFailedProbes: vi.fn((results: unknown[]) =>
    (results as Array<{ status: string }>).filter((r) => r.status === 'FAIL'),
  ),
}));

import { isAuthenticated, loadConfig } from '@/configuration';
import { getAllAgentStatus } from '@/auth/agent-credentials';
import { logger } from '@/ui/logger';
import { probeAllAgents, formatAgentProbeReport } from '../agentProbe';
import type { AgentProbeResult } from '../agentProbe';
import { runDoctor, checkAgentProbes } from '../doctor';

// ============================================================================
// Fixtures
// ============================================================================

/**
 * A minimal set of 11 probe results — all PASS.
 *
 * WHY: most doctor tests don't care about probe details; they just need a
 * non-empty array so the "Agent installation detail" section is rendered.
 */
const ALL_PASS_PROBES: AgentProbeResult[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'aider',
  'goose',
  'amp',
  'crush',
  'kilo',
  'kiro',
  'droid',
].map((id) => ({
  agentId: id as AgentProbeResult['agentId'],
  displayName: id,
  command: id,
  status: 'PASS' as const,
  version: '1.0.0',
  expectedStreamFormat: { type: 'string' },
  parserFile: `agent/factories/${id}.ts`,
}));

/**
 * A probe result set with one FAIL entry (amp) and 10 NOT_INSTALLED.
 *
 * WHY: Tests the failure propagation path where one agent binary is present
 * but its --version call times out.
 */
const ONE_FAIL_PROBES: AgentProbeResult[] = ALL_PASS_PROBES.map((r) =>
  r.agentId === 'amp'
    ? { ...r, status: 'FAIL' as const, message: '--version timed out' }
    : { ...r, status: 'NOT_INSTALLED' as const, version: undefined },
);

/** A probe set where every agent is NOT_INSTALLED. */
const ALL_NOT_INSTALLED_PROBES: AgentProbeResult[] = ALL_PASS_PROBES.map((r) => ({
  ...r,
  status: 'NOT_INSTALLED' as const,
  version: undefined,
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Override process.version with a fabricated version string.
 *
 * WHY: process.version is read-only in Node; we need to redefine it on the
 * property descriptor to simulate old/new Node versions in tests.
 */
function setNodeVersion(version: string) {
  Object.defineProperty(process, 'version', {
    value: version,
    configurable: true,
  });
}

/**
 * Set up default happy-path mocks for checks we're not specifically testing.
 *
 * WHY: reduces boilerplate in each describe block — only override what's
 * relevant to the test scenario under test.
 */
function setHappyPathDefaults() {
  setNodeVersion('v20.0.0');
  vi.mocked(loadConfig).mockReturnValue({ userId: 'user-001' });
  vi.mocked(isAuthenticated).mockReturnValue(true);
  vi.mocked(getAllAgentStatus).mockResolvedValue({
    claude: {
      agent: 'claude',
      name: 'Claude Code',
      installed: true,
      configured: true,
      command: 'claude',
      version: '1.0.0',
    },
  });
  vi.mocked(probeAllAgents).mockResolvedValue(ALL_PASS_PROBES);
}

// ============================================================================
// runDoctor — all checks pass
// ============================================================================

describe('runDoctor — all checks pass', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setHappyPathDefaults();
    // Restore formatAgentProbeReport after clearAllMocks wipes the implementation
    vi.mocked(formatAgentProbeReport).mockImplementation((results) =>
      results.map((r) => `  - [${r.status}] ${r.displayName}`),
    );
  });

  afterEach(() => {
    setNodeVersion(originalVersion);
  });

  it('logs PASS for Node.js version', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('PASS') && m.includes('Node.js'))).toBe(true);
  });

  it('logs PASS for Configuration', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('PASS') && m.includes('Configuration'))).toBe(true);
  });

  it('logs PASS for Authentication', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('PASS') && m.includes('Authentication'))).toBe(true);
  });

  it('logs PASS for AI Agents when agents are installed', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('PASS') && m.includes('AI Agents'))).toBe(true);
  });

  it('logs PASS for Agent Probes when all probes pass', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('PASS') && m.includes('Agent Probes'))).toBe(true);
  });

  it('logs all checks passed at the end', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => /all checks passed/i.test(m))).toBe(true);
  });

  it('logs the per-agent installation detail section', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('Agent installation detail'))).toBe(true);
  });
});

// ============================================================================
// runDoctor — old Node.js version
// ============================================================================

describe('runDoctor — old Node.js version', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setHappyPathDefaults();
    setNodeVersion('v16.0.0');
    vi.mocked(formatAgentProbeReport).mockImplementation((results) =>
      results.map((r) => `  - [${r.status}] ${r.displayName}`),
    );
  });

  afterEach(() => {
    setNodeVersion(originalVersion);
  });

  it('logs FAIL for Node.js version below 18', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('FAIL') && m.includes('Node.js'))).toBe(true);
  });

  it('logs "some checks failed" when node version fails', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => /some checks failed/i.test(m))).toBe(true);
  });
});

// ============================================================================
// runDoctor — not authenticated
// ============================================================================

describe('runDoctor — not authenticated', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setHappyPathDefaults();
    vi.mocked(isAuthenticated).mockReturnValue(false);
    vi.mocked(formatAgentProbeReport).mockImplementation((results) =>
      results.map((r) => `  - [${r.status}] ${r.displayName}`),
    );
  });

  afterEach(() => {
    setNodeVersion(originalVersion);
  });

  it('logs FAIL for Authentication', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('FAIL') && m.includes('Authentication'))).toBe(true);
  });
});

// ============================================================================
// runDoctor — config load throws
// ============================================================================

describe('runDoctor — config load error', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setHappyPathDefaults();
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('ENOENT: config file not found');
    });
    vi.mocked(formatAgentProbeReport).mockImplementation((results) =>
      results.map((r) => `  - [${r.status}] ${r.displayName}`),
    );
  });

  afterEach(() => {
    setNodeVersion(originalVersion);
  });

  it('logs FAIL for Configuration when loadConfig throws', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('FAIL') && m.includes('Configuration'))).toBe(true);
  });
});

// ============================================================================
// runDoctor — no agents installed (legacy check)
// ============================================================================

describe('runDoctor — no agents installed', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setHappyPathDefaults();
    vi.mocked(getAllAgentStatus).mockResolvedValue({
      claude: {
        agent: 'claude',
        name: 'Claude Code',
        installed: false,
        configured: false,
        command: 'claude',
      },
    });
    vi.mocked(formatAgentProbeReport).mockImplementation((results) =>
      results.map((r) => `  - [${r.status}] ${r.displayName}`),
    );
  });

  afterEach(() => {
    setNodeVersion(originalVersion);
  });

  it('logs FAIL for AI Agents when none are installed', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('FAIL') && m.includes('AI Agents'))).toBe(true);
  });
});

// ============================================================================
// runDoctor — getAllAgentStatus throws
// ============================================================================

describe('runDoctor — getAllAgentStatus throws', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setHappyPathDefaults();
    vi.mocked(getAllAgentStatus).mockRejectedValue(new Error('network error'));
    vi.mocked(formatAgentProbeReport).mockImplementation((results) =>
      results.map((r) => `  - [${r.status}] ${r.displayName}`),
    );
  });

  afterEach(() => {
    setNodeVersion(originalVersion);
  });

  it('logs FAIL for AI Agents check when detection throws', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('FAIL') && m.includes('AI Agents'))).toBe(true);
  });
});

// ============================================================================
// checkAgentProbes — all agents PASS
// ============================================================================

describe('checkAgentProbes — all agents PASS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeAllAgents).mockResolvedValue(ALL_PASS_PROBES);
  });

  it('returns passed:true when no probes failed', async () => {
    const { checkResult } = await checkAgentProbes();
    expect(checkResult.passed).toBe(true);
  });

  it('includes installed count in the summary message', async () => {
    const { checkResult } = await checkAgentProbes();
    expect(checkResult.message).toMatch(/11 of 11/);
  });

  it('returns all 11 probe results', async () => {
    const { probeResults } = await checkAgentProbes();
    expect(probeResults).toHaveLength(11);
  });

  it('check name is "Agent Probes (all 11)"', async () => {
    const { checkResult } = await checkAgentProbes();
    expect(checkResult.name).toBe('Agent Probes (all 11)');
  });
});

// ============================================================================
// checkAgentProbes — one agent FAILS
// ============================================================================

describe('checkAgentProbes — one agent FAIL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeAllAgents).mockResolvedValue(ONE_FAIL_PROBES);
  });

  it('returns passed:false when any probe is FAIL', async () => {
    const { checkResult } = await checkAgentProbes();
    expect(checkResult.passed).toBe(false);
  });

  it('message mentions the failed agent count', async () => {
    const { checkResult } = await checkAgentProbes();
    expect(checkResult.message).toMatch(/1 agent\(s\) failed/);
  });

  it('returns all 11 probe results even when some fail', async () => {
    const { probeResults } = await checkAgentProbes();
    expect(probeResults).toHaveLength(11);
  });

  it('the FAIL result has the expected diagnostic message', async () => {
    const { probeResults } = await checkAgentProbes();
    const amp = probeResults.find((r) => r.agentId === 'amp');
    expect(amp?.status).toBe('FAIL');
    expect(amp?.message).toBe('--version timed out');
  });
});

// ============================================================================
// checkAgentProbes — all NOT_INSTALLED (none on PATH)
// ============================================================================

describe('checkAgentProbes — all agents NOT_INSTALLED', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeAllAgents).mockResolvedValue(ALL_NOT_INSTALLED_PROBES);
  });

  it('returns passed:true (NOT_INSTALLED is not a failure)', async () => {
    const { checkResult } = await checkAgentProbes();
    expect(checkResult.passed).toBe(true);
  });

  it('message mentions no agents installed', async () => {
    const { checkResult } = await checkAgentProbes();
    expect(checkResult.message).toMatch(/no agents installed/i);
  });
});

// ============================================================================
// checkAgentProbes — probeAllAgents throws
// ============================================================================

describe('checkAgentProbes — probeAllAgents throws', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeAllAgents).mockRejectedValue(new Error('EACCES: permission denied'));
  });

  it('returns passed:false when probe run itself throws', async () => {
    const { checkResult } = await checkAgentProbes();
    expect(checkResult.passed).toBe(false);
  });

  it('message includes the thrown error text', async () => {
    const { checkResult } = await checkAgentProbes();
    expect(checkResult.message).toContain('EACCES: permission denied');
  });

  it('returns empty probeResults array on error', async () => {
    const { probeResults } = await checkAgentProbes();
    expect(probeResults).toHaveLength(0);
  });
});

// ============================================================================
// runDoctor — agent probe FAIL triggers overall failure
// ============================================================================

describe('runDoctor — one agent probe FAIL', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setHappyPathDefaults();
    vi.mocked(probeAllAgents).mockResolvedValue(ONE_FAIL_PROBES);
    vi.mocked(formatAgentProbeReport).mockImplementation((results) =>
      results.map((r) => `  - [${r.status}] ${r.displayName}`),
    );
  });

  afterEach(() => {
    setNodeVersion(originalVersion);
  });

  it('logs FAIL for Agent Probes when one agent fails', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('FAIL') && m.includes('Agent Probes'))).toBe(true);
  });

  it('logs "some checks failed" when an agent probe fails', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => /some checks failed/i.test(m))).toBe(true);
  });

  it('still renders the per-agent detail section even when probes fail', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('Agent installation detail'))).toBe(true);
  });
});

// ============================================================================
// runDoctor — probe section not rendered when probeResults is empty
// ============================================================================

describe('runDoctor — probeAllAgents throws (empty probeResults)', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setHappyPathDefaults();
    vi.mocked(probeAllAgents).mockRejectedValue(new Error('spawn failed'));
    vi.mocked(formatAgentProbeReport).mockImplementation((results) =>
      results.map((r) => `  - [${r.status}] ${r.displayName}`),
    );
  });

  afterEach(() => {
    setNodeVersion(originalVersion);
  });

  it('does not log the agent detail section when probe results are empty', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    // The "Agent installation detail" header should NOT appear because probeResults is []
    expect(calls.some((m) => m.includes('Agent installation detail'))).toBe(false);
  });

  it('still logs FAIL for Agent Probes', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => m.includes('FAIL') && m.includes('Agent Probes'))).toBe(true);
  });
});
