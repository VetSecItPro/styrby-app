/**
 * Tests for agent/acp/processLifecycle.ts
 *
 * Covers:
 * - spawnAgentProcess: posix spawn path, stdio-pipe validation, env forwarding
 * - attachProcessListeners: stderr data routing, process error emission,
 *   process exit emission (disposed vs. live, clean vs. non-zero exit)
 * - initializeAcpConnection: delegates to connection.initialize with retry
 * - createAcpSession: builds mcpServer list, delegates to connection.newSession
 *
 * WHY: processLifecycle owns subprocess spawn/teardown. Regressions here
 * surface as "spinning" sessions or silent failures on mobile; unit tests
 * that mock child_process + ACP SDK catch them before they hit CI.
 *
 * @module agent/acp/__tests__/processLifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// ---------------------------------------------------------------------------
// Mocks — declared before imports so Vitest hoisting can intercept them.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// WHY: buildSafeEnv strips secrets from the env; mock returns a simple
// passthrough so tests can assert on the env keys without depending on the
// allowlist implementation.
vi.mock('@/utils/safeEnv', () => ({
  buildSafeEnv: vi.fn((extra: Record<string, string>) => ({ ...process.env, ...extra })),
}));

// ---------------------------------------------------------------------------
// Imports AFTER vi.mock declarations
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import {
  spawnAgentProcess,
  attachProcessListeners,
  initializeAcpConnection,
  createAcpSession,
} from '../processLifecycle';
import type { TransportHandler } from '../../transport';
import type { AgentMessage } from '../../core';

const mockSpawn = spawn as unknown as MockInstance;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock ChildProcess with PassThrough stdio streams.
 * PassThrough lets tests push bytes and emit stream events naturally.
 */
function makeMockProcess() {
  const proc = new EventEmitter() as ReturnType<typeof makeMockProcess>;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

/**
 * Build a minimal TransportHandler double used across processLifecycle tests.
 * Only the methods exercised by processLifecycle are implemented.
 *
 * @param overrides - Partial override of method implementations.
 */
function makeTransport(
  overrides: Partial<TransportHandler> = {}
): TransportHandler {
  return {
    agentName: 'test-agent',
    getInitTimeout: () => 5_000,
    filterStdoutLine: (line: string) => line,
    handleStderr: (_text, _ctx) => ({ message: null }),
    getToolPatterns: () => [],
    isInvestigationTool: () => false,
    getToolCallTimeout: () => 30_000,
    extractToolNameFromId: () => null,
    determineToolName: (name) => name,
    ...overrides,
  };
}

let currentMockProcess: ReturnType<typeof makeMockProcess>;

beforeEach(() => {
  currentMockProcess = makeMockProcess();
  mockSpawn.mockReturnValue(currentMockProcess);
  vi.clearAllMocks();
  mockSpawn.mockReturnValue(currentMockProcess);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// spawnAgentProcess
// ===========================================================================

describe('spawnAgentProcess', () => {
  it('calls spawn with the supplied command and args on non-Windows', () => {
    // WHY: The platform branch is covered by the non-Windows path in test
    // environments. Windows-specific cmd.exe routing is not exercised here
    // because we cannot override process.platform in vitest without a heavier
    // setup — but the logic branch is straightforward.
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    spawnAgentProcess({ command: 'my-agent', args: ['--flag'], cwd: '/project' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'my-agent',
      ['--flag'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('uses empty args array when args is omitted', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    spawnAgentProcess({ command: 'agent', cwd: '/cwd' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual([]);
  });

  it('returns the spawned ChildProcess', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    const result = spawnAgentProcess({ command: 'agent', cwd: '/cwd' });

    expect(result).toBe(currentMockProcess);
  });

  it('throws when the mock process lacks stdio pipes', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    const brokenProcess = new EventEmitter() as ReturnType<typeof makeMockProcess>;
    // Intentionally leave stdin/stdout/stderr undefined
    mockSpawn.mockReturnValue(brokenProcess);

    expect(() => spawnAgentProcess({ command: 'agent', cwd: '/cwd' })).toThrow(
      'Failed to create stdio pipes',
    );
  });

  it('merges caller env into the spawned process env via buildSafeEnv', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    spawnAgentProcess({ command: 'agent', cwd: '/cwd', env: { MY_KEY: 'value123' } });

    const [, , opts] = mockSpawn.mock.calls[0];
    expect(opts.env).toMatchObject({ MY_KEY: 'value123' });
  });
});

// ===========================================================================
// attachProcessListeners
// ===========================================================================

describe('attachProcessListeners', () => {
  it('calls transport.handleStderr and emits the resulting message on stderr data', () => {
    const emitted: AgentMessage[] = [];
    const transport = makeTransport({
      handleStderr: (_text, _ctx) => ({
        message: { type: 'status', status: 'error', detail: 'oops' },
      }),
    });

    attachProcessListeners(currentMockProcess as any, {
      transport,
      getActiveToolCalls: () => new Set(),
      isDisposed: () => false,
      emit: (msg) => emitted.push(msg),
    });

    currentMockProcess.stderr.emit('data', Buffer.from('some error text'));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'status', status: 'error', detail: 'oops' });
  });

  it('does NOT emit when handleStderr returns null message', () => {
    const emitted: AgentMessage[] = [];
    attachProcessListeners(currentMockProcess as any, {
      transport: makeTransport(),
      getActiveToolCalls: () => new Set(),
      isDisposed: () => false,
      emit: (msg) => emitted.push(msg),
    });

    currentMockProcess.stderr.emit('data', Buffer.from('just noise\n'));
    expect(emitted).toHaveLength(0);
  });

  it('does NOT emit for whitespace-only stderr chunks', () => {
    const emitted: AgentMessage[] = [];
    const stderrSpy = vi.fn();
    attachProcessListeners(currentMockProcess as any, {
      transport: makeTransport({ handleStderr: stderrSpy }),
      getActiveToolCalls: () => new Set(),
      isDisposed: () => false,
      emit: (msg) => emitted.push(msg),
    });

    currentMockProcess.stderr.emit('data', Buffer.from('   \n'));
    // handleStderr should NOT be called for whitespace-only data
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('emits status error on process error event', () => {
    const emitted: AgentMessage[] = [];
    attachProcessListeners(currentMockProcess as any, {
      transport: makeTransport(),
      getActiveToolCalls: () => new Set(),
      isDisposed: () => false,
      emit: (msg) => emitted.push(msg),
    });

    currentMockProcess.emit('error', new Error('spawn failed'));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'status', status: 'error', detail: 'spawn failed' });
  });

  it('emits stopped status on non-zero exit when backend is NOT disposed', () => {
    const emitted: AgentMessage[] = [];
    attachProcessListeners(currentMockProcess as any, {
      transport: makeTransport(),
      getActiveToolCalls: () => new Set(),
      isDisposed: () => false,
      emit: (msg) => emitted.push(msg),
    });

    currentMockProcess.emit('exit', 1, null);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'status', status: 'stopped' });
  });

  it('does NOT emit on non-zero exit when backend is disposed', () => {
    const emitted: AgentMessage[] = [];
    attachProcessListeners(currentMockProcess as any, {
      transport: makeTransport(),
      getActiveToolCalls: () => new Set(),
      isDisposed: () => true,
      emit: (msg) => emitted.push(msg),
    });

    currentMockProcess.emit('exit', 1, null);
    expect(emitted).toHaveLength(0);
  });

  it('does NOT emit on exit code 0 (clean exit)', () => {
    const emitted: AgentMessage[] = [];
    attachProcessListeners(currentMockProcess as any, {
      transport: makeTransport(),
      getActiveToolCalls: () => new Set(),
      isDisposed: () => false,
      emit: (msg) => emitted.push(msg),
    });

    currentMockProcess.emit('exit', 0, null);
    expect(emitted).toHaveLength(0);
  });

  it('calls isInvestigationTool when transport supports it', () => {
    const emitted: AgentMessage[] = [];
    const isInvestigationTool = vi.fn(() => true);
    const transport = makeTransport({
      isInvestigationTool,
      handleStderr: (_text, _ctx) => ({ message: null }),
    });

    attachProcessListeners(currentMockProcess as any, {
      transport,
      getActiveToolCalls: () => new Set(['tool-001']),
      isDisposed: () => false,
      emit: (msg) => emitted.push(msg),
    });

    currentMockProcess.stderr.emit('data', Buffer.from('some debug text'));
    // isInvestigationTool is invoked via the active tool call check
    expect(isInvestigationTool).toHaveBeenCalled();
  });
});

// ===========================================================================
// initializeAcpConnection
// ===========================================================================

describe('initializeAcpConnection', () => {
  it('calls connection.initialize with the ACP protocol version and clientInfo', async () => {
    const initFn = vi.fn().mockResolvedValue({ protocolVersion: 1 });
    const connection = { initialize: initFn, newSession: vi.fn() } as any;
    const transport = makeTransport();

    await initializeAcpConnection(connection, transport);

    expect(initFn).toHaveBeenCalledOnce();
    const [req] = initFn.mock.calls[0];
    expect(req.protocolVersion).toBe(1);
    expect(req.clientInfo.name).toBeDefined();
  });

  it('rejects when connection.initialize throws (and exhausts retries)', async () => {
    const initFn = vi.fn().mockRejectedValue(new Error('connection refused'));
    const connection = { initialize: initFn, newSession: vi.fn() } as any;
    // WHY: Short timeout so the test doesn't wait the full retry budget.
    const transport = makeTransport({ getInitTimeout: () => 50 });

    await expect(initializeAcpConnection(connection, transport)).rejects.toThrow();
    // withRetry retries; at least 1 call must have been made.
    expect(initFn).toHaveBeenCalled();
  }, 15_000);
});

// ===========================================================================
// createAcpSession
// ===========================================================================

describe('createAcpSession', () => {
  it('calls connection.newSession with cwd and returns the session ID', async () => {
    const newSessionFn = vi.fn().mockResolvedValue({ sessionId: 'session-abc' });
    const connection = { initialize: vi.fn(), newSession: newSessionFn } as any;
    const transport = makeTransport();

    const id = await createAcpSession(connection, transport, '/my/project');

    expect(newSessionFn).toHaveBeenCalledOnce();
    const [req] = newSessionFn.mock.calls[0];
    expect(req.cwd).toBe('/my/project');
    expect(id).toBe('session-abc');
  });

  it('passes an empty mcpServers list when no mcpServers option supplied', async () => {
    const newSessionFn = vi.fn().mockResolvedValue({ sessionId: 's1' });
    const connection = { initialize: vi.fn(), newSession: newSessionFn } as any;

    await createAcpSession(connection, makeTransport(), '/cwd');

    const [req] = newSessionFn.mock.calls[0];
    expect(Array.isArray(req.mcpServers)).toBe(true);
    expect(req.mcpServers).toHaveLength(0);
  });

  it('maps mcpServers Record to the ACP list format', async () => {
    const newSessionFn = vi.fn().mockResolvedValue({ sessionId: 's2' });
    const connection = { initialize: vi.fn(), newSession: newSessionFn } as any;

    await createAcpSession(connection, makeTransport(), '/cwd', {
      myServer: { command: 'python', args: ['-m', 'myserver'], env: { DEBUG: '1' } },
    });

    const [req] = newSessionFn.mock.calls[0];
    expect(req.mcpServers).toHaveLength(1);
    expect(req.mcpServers[0].name).toBe('myServer');
    expect(req.mcpServers[0].command).toBe('python');
    expect(req.mcpServers[0].args).toEqual(['-m', 'myserver']);
    expect(req.mcpServers[0].env).toEqual([{ name: 'DEBUG', value: '1' }]);
  });

  it('rejects when connection.newSession throws (and exhausts retries)', async () => {
    const newSessionFn = vi.fn().mockRejectedValue(new Error('timeout'));
    const connection = { initialize: vi.fn(), newSession: newSessionFn } as any;
    const transport = makeTransport({ getInitTimeout: () => 50 });

    await expect(createAcpSession(connection, transport, '/cwd')).rejects.toThrow();
    expect(newSessionFn).toHaveBeenCalled();
  }, 15_000);
});
