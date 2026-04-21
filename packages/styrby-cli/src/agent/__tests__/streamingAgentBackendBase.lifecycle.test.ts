/**
 * Lifecycle unit tests for StreamingAgentBackendBase.
 *
 * Covers methods not deeply exercised by the existing helpers/contract tests:
 * - dispose: idempotent, clears listeners, clears timer, kills process
 * - scheduleForceKill / clearCancelTimer: timer tracking prevents leaks
 * - respondToPermission: emits permission-response event
 * - waitForResponseComplete: resolves when no process active,
 *   resolves when process is killed, rejects on timeout
 * - spawnAgent: uses buildSafeEnv + validateExtraArgs (injection check)
 * - onMessage / offMessage / emit: after-dispose gate, handler isolation
 *
 * WHY: These are the shared primitives that every streaming factory inherits.
 * A regression in any one (e.g., a missing clearCancelTimer on dispose) leaks
 * timers or memory across every agent — a Node.js event-loop hygiene issue
 * that shows as late test hangs and SOC2 CC7.2 reliability failures.
 *
 * @module agent/__tests__/streamingAgentBackendBase.lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  StreamingAgentBackendBase,
  FORCE_KILL_DELAY_MS,
} from '../StreamingAgentBackendBase';
import type { SessionId, StartSessionResult, AgentMessage } from '../core';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/utils/safeEnv', () => ({
  buildSafeEnv: vi.fn((e: Record<string, string>) => ({ ...e })),
  validateExtraArgs: vi.fn((args: string[]) => args),
}));

// ---------------------------------------------------------------------------
// TestBackend concrete subclass
// ---------------------------------------------------------------------------

class TestBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'TestBackend';

  async startSession(): Promise<StartSessionResult> {
    return { sessionId: 'sid' };
  }
  async sendPrompt(_id: SessionId, _p: string): Promise<void> {}
  async cancel(_id: SessionId): Promise<void> {}

  /** Expose internal state for assertions */
  getListeners() { return this.listeners; }
  getProcess() { return this.process; }
  isDisposed() { return this.disposed; }
  getCancelTimer() { return this.cancelTimer; }

  /** Public proxies for protected methods */
  testEmit(msg: AgentMessage) { this.emit(msg); }
  testScheduleForceKill(delayMs?: number) { this.scheduleForceKill(delayMs); }
  testClearCancelTimer() { this.clearCancelTimer(); }
  testSpawnAgent(opts: Parameters<typeof StreamingAgentBackendBase.prototype['spawnAgent']>[0]) {
    return (this as any).spawnAgent(opts);
  }

  /** Inject a fake process for process-kill tests */
  injectProcess(proc: ChildProcess | null) { this.process = proc; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; return true; });
  return proc;
}

import { spawn } from 'node:child_process';
import { validateExtraArgs } from '@/utils/safeEnv';

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockValidateExtraArgs = validateExtraArgs as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  const fakeProc = makeFakeProcess();
  mockSpawn.mockReturnValue(fakeProc);
  mockValidateExtraArgs.mockImplementation((a: string[]) => a);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ===========================================================================
// dispose
// ===========================================================================

describe('StreamingAgentBackendBase.dispose', () => {
  it('sets disposed = true', async () => {
    const b = new TestBackend();
    await b.dispose();
    expect(b.isDisposed()).toBe(true);
  });

  it('is idempotent — second call is a no-op', async () => {
    const b = new TestBackend();
    await b.dispose();
    await expect(b.dispose()).resolves.toBeUndefined();
  });

  it('clears the listeners array (SOC2 CC7.2 GC hygiene)', async () => {
    const b = new TestBackend();
    b.onMessage(vi.fn());
    b.onMessage(vi.fn());
    expect(b.getListeners().length).toBe(2);

    await b.dispose();
    expect(b.getListeners().length).toBe(0);
  });

  it('kills an active process with SIGTERM', async () => {
    const b = new TestBackend();
    const proc = makeFakeProcess();
    b.injectProcess(proc as unknown as ChildProcess);

    await b.dispose();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('nulls out process reference after dispose', async () => {
    const b = new TestBackend();
    b.injectProcess(makeFakeProcess() as unknown as ChildProcess);

    await b.dispose();
    expect(b.getProcess()).toBeNull();
  });

  it('cancels a pending force-kill timer on dispose', async () => {
    vi.useFakeTimers();
    const b = new TestBackend();
    b.testScheduleForceKill(3000);
    expect(b.getCancelTimer()).toBeDefined();

    await b.dispose();
    expect(b.getCancelTimer()).toBeUndefined();
  });
});

// ===========================================================================
// emit — after-dispose gate
// ===========================================================================

describe('StreamingAgentBackendBase.emit (disposed gate)', () => {
  it('does not call listeners after dispose', async () => {
    const b = new TestBackend();
    const handler = vi.fn();
    b.onMessage(handler);

    await b.dispose();
    // Re-register — disposed flag must block emit
    b.onMessage(handler);
    b.testEmit({ type: 'status', status: 'idle' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('catches and swallows errors thrown by individual handlers', () => {
    const b = new TestBackend();
    const noisy = vi.fn(() => { throw new Error('boom'); });
    const quiet = vi.fn();
    b.onMessage(noisy);
    b.onMessage(quiet);

    b.testEmit({ type: 'status', status: 'idle' });
    expect(quiet).toHaveBeenCalled();
  });
});

// ===========================================================================
// scheduleForceKill / clearCancelTimer
// ===========================================================================

describe('StreamingAgentBackendBase — cancel timer management', () => {
  it('scheduleForceKill stores a timer reference', () => {
    vi.useFakeTimers();
    const b = new TestBackend();
    b.testScheduleForceKill(3000);
    expect(b.getCancelTimer()).toBeDefined();
  });

  it('clearCancelTimer clears the stored timer', () => {
    vi.useFakeTimers();
    const b = new TestBackend();
    b.testScheduleForceKill(3000);
    b.testClearCancelTimer();
    expect(b.getCancelTimer()).toBeUndefined();
  });

  it('clearCancelTimer is safe to call when no timer is scheduled', () => {
    const b = new TestBackend();
    expect(() => b.testClearCancelTimer()).not.toThrow();
  });

  it('scheduleForceKill SIGKILL fires the injected process after delay', () => {
    vi.useFakeTimers();
    const b = new TestBackend();
    const proc = makeFakeProcess();
    b.injectProcess(proc as unknown as ChildProcess);

    b.testScheduleForceKill(1000);
    vi.advanceTimersByTime(1000);

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('SIGKILL does NOT fire when clearCancelTimer is called before delay elapses', () => {
    vi.useFakeTimers();
    const b = new TestBackend();
    const proc = makeFakeProcess();
    b.injectProcess(proc as unknown as ChildProcess);

    b.testScheduleForceKill(3000);
    b.testClearCancelTimer();
    vi.advanceTimersByTime(5000);

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('scheduleForceKill clears a pre-existing timer before setting a new one', () => {
    vi.useFakeTimers();
    const b = new TestBackend();
    const proc = makeFakeProcess();
    b.injectProcess(proc as unknown as ChildProcess);

    b.testScheduleForceKill(5000);
    const firstTimer = b.getCancelTimer();
    b.testScheduleForceKill(5000); // should cancel first, set second
    const secondTimer = b.getCancelTimer();

    expect(firstTimer).not.toBe(secondTimer);
    // Advance: only ONE kill should fire (not two)
    vi.advanceTimersByTime(6000);
    expect(proc.kill.mock.calls.length).toBe(1);
  });
});

// ===========================================================================
// respondToPermission
// ===========================================================================

describe('StreamingAgentBackendBase.respondToPermission', () => {
  it('emits a permission-response message with correct id and approved flag', async () => {
    const b = new TestBackend();
    const msgs: AgentMessage[] = [];
    b.onMessage((m) => msgs.push(m));

    await b.respondToPermission('req-abc', true);

    const permMsg = msgs.find((m) => m.type === 'permission-response') as any;
    expect(permMsg).toBeDefined();
    expect(permMsg.id).toBe('req-abc');
    expect(permMsg.approved).toBe(true);
  });

  it('emits approved=false when denied', async () => {
    const b = new TestBackend();
    const msgs: AgentMessage[] = [];
    b.onMessage((m) => msgs.push(m));

    await b.respondToPermission('req-xyz', false);

    const permMsg = msgs.find((m) => m.type === 'permission-response') as any;
    expect(permMsg.approved).toBe(false);
  });
});

// ===========================================================================
// waitForResponseComplete
// ===========================================================================

describe('StreamingAgentBackendBase.waitForResponseComplete', () => {
  it('resolves immediately when no process is active', async () => {
    const b = new TestBackend();
    await expect(b.waitForResponseComplete(1000)).resolves.toBeUndefined();
  });

  it('resolves once the injected process is marked killed', async () => {
    const b = new TestBackend();
    const proc = makeFakeProcess();
    b.injectProcess(proc as unknown as ChildProcess);

    const waitPromise = b.waitForResponseComplete(2000);
    // Simulate process exit after a tick
    setTimeout(() => { proc.killed = true; }, 50);

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('rejects with a timeout error when process never exits within timeoutMs', async () => {
    const b = new TestBackend();
    const proc = makeFakeProcess();
    b.injectProcess(proc as unknown as ChildProcess);

    await expect(b.waitForResponseComplete(100)).rejects.toThrow(/Timeout waiting for/);
  });

  it('error message strips "Backend" suffix from logTag for readability', async () => {
    const b = new TestBackend();
    const proc = makeFakeProcess();
    b.injectProcess(proc as unknown as ChildProcess);

    await expect(b.waitForResponseComplete(50)).rejects.toThrow(/Timeout waiting for Test response/);
  });
});

// ===========================================================================
// spawnAgent — security + arg handling
// ===========================================================================

describe('StreamingAgentBackendBase.spawnAgent', () => {
  it('calls spawn with the provided command and args', () => {
    const b = new TestBackend();
    b.testSpawnAgent({ command: 'aider', args: ['--no-stream'], cwd: '/project' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'aider',
      ['--no-stream'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('appends validated userExtraArgs to the args vector', () => {
    const b = new TestBackend();
    b.testSpawnAgent({
      command: 'aider',
      args: ['--base'],
      cwd: '/project',
      userExtraArgs: ['--dark-mode'],
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--dark-mode');
    expect(mockValidateExtraArgs).toHaveBeenCalledWith(['--dark-mode']);
  });

  it('stores the spawned process in this.process', () => {
    const b = new TestBackend();
    b.testSpawnAgent({ command: 'agent', args: [], cwd: '/tmp' });
    expect(b.getProcess()).not.toBeNull();
  });

  it('does NOT call validateExtraArgs when userExtraArgs is omitted', () => {
    const b = new TestBackend();
    b.testSpawnAgent({ command: 'agent', args: [], cwd: '/tmp' });
    expect(mockValidateExtraArgs).not.toHaveBeenCalled();
  });
});
