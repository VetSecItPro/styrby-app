/**
 * Tests for `cli/handlers/resume.ts`.
 *
 * Covers:
 * - No-arg path: single live session → auto-select and attach
 * - No-arg path: multiple live sessions → list and exit 0 (user must specify)
 * - No-arg path: no live sessions → error exit
 * - Explicit sessionId: found in local store → attach
 * - Explicit sessionId: not found in local store → error exit
 * - Daemon not running → error exit
 * - IPC attach-relay returns failure → error exit
 *
 * WHY we test the no-args multi-session path specifically: the UX decision
 * to print a picker and exit 0 (rather than auto-selecting) is the key
 * design choice that prevents silently attaching to the wrong session.
 *
 * @module cli/handlers/__tests__/resume
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Test fixtures
// ============================================================================

const SESSION_A = {
  sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  agentType: 'claude' as const,
  projectPath: '/home/user/project-a',
  createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30m ago
  lastActivityAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5m ago
  status: 'running',
};

const SESSION_B = {
  sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  agentType: 'codex' as const,
  projectPath: '/home/user/project-b',
  createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
  lastActivityAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15m ago
  status: 'paused',
};

const SESSION_ENDED = {
  sessionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  agentType: 'gemini' as const,
  projectPath: '/home/user/project-c',
  createdAt: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
  status: 'ended',
};

const PERSISTED_DATA = {
  userId: 'user-uuid-1234',
  accessToken: 'tok_test',
  machineId: 'machine-uuid-5678',
};

// ============================================================================
// Mocks
// ============================================================================

const mockCanConnectToDaemon = vi.fn<[], Promise<boolean>>();
const mockSendDaemonCommand = vi.fn<[unknown], Promise<{ success: boolean; error?: string; data?: unknown }>>();
const mockLoadPersistedData = vi.fn<[], typeof PERSISTED_DATA | null>();
const mockListSessions = vi.fn<[], typeof SESSION_A[]>();
const mockLoadSession = vi.fn<[string], typeof SESSION_A | null>();

vi.mock('@/daemon/controlClient', () => ({
  canConnectToDaemon: mockCanConnectToDaemon,
  sendDaemonCommand: mockSendDaemonCommand,
}));

vi.mock('@/persistence', () => ({
  loadPersistedData: mockLoadPersistedData,
  listSessions: mockListSessions,
  loadSession: mockLoadSession,
}));

// Mock chalk to return plain strings so we can assert on console output
vi.mock('chalk', () => {
  const identity = (s: string) => s;
  const colorProxy = new Proxy(identity, {
    get: (_target, _prop) => colorProxy,
    apply: (_target, _this, args) => args[0],
  });
  return { default: colorProxy };
});

// ============================================================================
// Helpers
// ============================================================================

/** Capture and suppress all console.log output during a test. */
function mockConsole() {
  const calls: string[][] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    calls.push(args.map(String));
  });
  return { calls, spy };
}

// ============================================================================
// Tests
// ============================================================================

describe('handleResume', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Prevent process.exit from terminating the test runner
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as (code?: number | string | null) => never);

    // Happy-path defaults (overridden per test below)
    mockLoadPersistedData.mockReturnValue(PERSISTED_DATA);
    mockCanConnectToDaemon.mockResolvedValue(true);
    mockSendDaemonCommand.mockResolvedValue({ success: true, data: { attached: true, sessionId: SESSION_A.sessionId } });
    mockListSessions.mockReturnValue([SESSION_A]);
    mockLoadSession.mockReturnValue(SESSION_A);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  // ── Not authenticated ────────────────────────────────────────────────────

  it('exits 1 when user is not authenticated', async () => {
    mockLoadPersistedData.mockReturnValue(null);
    const { handleResume } = await import('../resume.js');
    const con = mockConsole();
    try {
      await handleResume([]);
    } catch {
      // swallow process.exit throw
    } finally {
      con.spy.mockRestore();
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Daemon not running ───────────────────────────────────────────────────

  it('exits 1 with an actionable message when daemon is not running', async () => {
    mockCanConnectToDaemon.mockResolvedValue(false);
    const { handleResume } = await import('../resume.js');
    const con = mockConsole();
    try {
      await handleResume([]);
    } catch {
      // swallow
    } finally {
      con.spy.mockRestore();
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = con.calls.flat().join('\n');
    expect(output).toMatch(/no running daemon/i);
    expect(output).toMatch(/styrby start/i);
  });

  // ── No-arg path: single live session ────────────────────────────────────

  it('auto-selects the single live session and sends attach-relay', async () => {
    mockListSessions.mockReturnValue([SESSION_A]);
    const { handleResume } = await import('../resume.js');
    const con = mockConsole();
    await handleResume([]);
    con.spy.mockRestore();

    expect(mockSendDaemonCommand).toHaveBeenCalledWith({
      type: 'attach-relay',
      sessionId: SESSION_A.sessionId,
    });
    const output = con.calls.flat().join('\n');
    expect(output).toMatch(/session resumed/i);
  });

  // ── No-arg path: multiple live sessions ─────────────────────────────────

  it('lists sessions and exits 0 (without attaching) when multiple live sessions exist', async () => {
    // WHY: Auto-selecting from multiple sessions risks attaching to the wrong
    // agent context. The correct UX is to show a picker and exit cleanly,
    // requiring the user to re-run with an explicit sessionId.
    mockListSessions.mockReturnValue([SESSION_A, SESSION_B]);
    const { handleResume } = await import('../resume.js');
    const con = mockConsole();
    try {
      await handleResume([]);
    } catch {
      // swallow exit throw
    } finally {
      con.spy.mockRestore();
    }

    // Must exit 0 (not an error, just disambiguation)
    expect(exitSpy).toHaveBeenCalledWith(0);
    // Must NOT have sent attach-relay
    expect(mockSendDaemonCommand).not.toHaveBeenCalled();
    // Must display both session IDs in the output
    const output = con.calls.flat().join('\n');
    expect(output).toContain(SESSION_A.sessionId);
    expect(output).toContain(SESSION_B.sessionId);
    expect(output).toMatch(/styrby resume <session-id>/i);
  });

  // ── No-arg path: no live sessions ────────────────────────────────────────

  it('exits 1 when no live sessions exist', async () => {
    mockListSessions.mockReturnValue([SESSION_ENDED]);
    const { handleResume } = await import('../resume.js');
    const con = mockConsole();
    try {
      await handleResume([]);
    } catch {
      // swallow
    } finally {
      con.spy.mockRestore();
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = con.calls.flat().join('\n');
    expect(output).toMatch(/no resumable sessions/i);
  });

  // ── Explicit sessionId: found ─────────────────────────────────────────────

  it('attaches the specified session when sessionId is provided and found', async () => {
    mockLoadSession.mockReturnValue(SESSION_A);
    const { handleResume } = await import('../resume.js');
    const con = mockConsole();
    await handleResume([SESSION_A.sessionId]);
    con.spy.mockRestore();

    expect(mockSendDaemonCommand).toHaveBeenCalledWith({
      type: 'attach-relay',
      sessionId: SESSION_A.sessionId,
    });
    const output = con.calls.flat().join('\n');
    expect(output).toMatch(/session resumed/i);
  });

  // ── Explicit sessionId: not found ────────────────────────────────────────

  it('exits 1 with "session not found" when explicit sessionId is unknown', async () => {
    mockLoadSession.mockReturnValue(null);
    const unknownId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const { handleResume } = await import('../resume.js');
    const con = mockConsole();
    try {
      await handleResume([unknownId]);
    } catch {
      // swallow
    } finally {
      con.spy.mockRestore();
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = con.calls.flat().join('\n');
    expect(output).toMatch(/session not found/i);
  });

  // ── IPC attach-relay failure ─────────────────────────────────────────────

  it('exits 1 when the daemon returns failure for attach-relay', async () => {
    mockSendDaemonCommand.mockResolvedValue({ success: false, error: 'session not recognized by daemon' });
    const { handleResume } = await import('../resume.js');
    const con = mockConsole();
    try {
      await handleResume([SESSION_A.sessionId]);
    } catch {
      // swallow
    } finally {
      con.spy.mockRestore();
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = con.calls.flat().join('\n');
    expect(output).toMatch(/failed to resume session/i);
  });
});
