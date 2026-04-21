/**
 * Tests for the doctor command.
 *
 * Covers:
 * - Node.js version check (pass when >= 18, fail when < 18)
 * - Config check (pass on valid config, fail on load error)
 * - Auth check (pass when authenticated, fail when not)
 * - Agent detection check (pass with agents, fail with none)
 * - Full runDoctor integration: all-pass and some-fail paths
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

import { isAuthenticated, loadConfig } from '@/configuration';
import { getAllAgentStatus } from '@/auth/agent-credentials';
import { logger } from '@/ui/logger';
import { runDoctor } from '../doctor';

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

// ============================================================================
// runDoctor — all checks pass
// ============================================================================

describe('runDoctor — all checks pass', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('logs all checks passed at the end', async () => {
    await runDoctor();
    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    expect(calls.some((m) => /all checks passed/i.test(m))).toBe(true);
  });
});

// ============================================================================
// runDoctor — Node.js version too old
// ============================================================================

describe('runDoctor — old Node.js version', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setNodeVersion('v16.0.0');
    vi.mocked(loadConfig).mockReturnValue({ userId: 'user-001' });
    vi.mocked(isAuthenticated).mockReturnValue(true);
    vi.mocked(getAllAgentStatus).mockResolvedValue({
      claude: {
        agent: 'claude',
        name: 'Claude Code',
        installed: true,
        configured: true,
        command: 'claude',
      },
    });
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
    setNodeVersion('v20.0.0');
    vi.mocked(loadConfig).mockReturnValue({ userId: 'user-001' });
    vi.mocked(isAuthenticated).mockReturnValue(false);
    vi.mocked(getAllAgentStatus).mockResolvedValue({});
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
    setNodeVersion('v20.0.0');
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('ENOENT: config file not found');
    });
    vi.mocked(isAuthenticated).mockReturnValue(false);
    vi.mocked(getAllAgentStatus).mockResolvedValue({});
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
// runDoctor — no agents installed
// ============================================================================

describe('runDoctor — no agents installed', () => {
  const originalVersion = process.version;

  beforeEach(() => {
    vi.clearAllMocks();
    setNodeVersion('v20.0.0');
    vi.mocked(loadConfig).mockReturnValue({ userId: 'user-001' });
    vi.mocked(isAuthenticated).mockReturnValue(true);
    vi.mocked(getAllAgentStatus).mockResolvedValue({
      claude: {
        agent: 'claude',
        name: 'Claude Code',
        installed: false,
        configured: false,
        command: 'claude',
      },
    });
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
    setNodeVersion('v20.0.0');
    vi.mocked(loadConfig).mockReturnValue({ userId: 'user-001' });
    vi.mocked(isAuthenticated).mockReturnValue(true);
    vi.mocked(getAllAgentStatus).mockRejectedValue(new Error('network error'));
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
