/**
 * Tests for the Phase 0.3 additions to {@link StreamingAgentBackendBase}:
 *
 * - `formatInstallHint()` returns a per-agent friendly install message.
 * - `streamLines()` yields one callback per line, ignores trailing newlines,
 *   and closes the readline interface when the upstream stream ends.
 * - `attachInstallHintErrorHandler()` distinguishes ENOENT from other errors.
 *
 * These tests do NOT spawn subprocesses; they exercise the helpers against
 * synthetic streams and event emitters.
 *
 * @module agent/__tests__/streamingAgentBackendBase
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  StreamingAgentBackendBase,
  formatInstallHint,
} from '../StreamingAgentBackendBase';
import type { SessionId, StartSessionResult } from '../core';

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Minimal concrete subclass for testing the protected helpers.
 * Exposes the protected methods publicly so tests can drive them directly.
 */
class TestBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'TestBackend';
  async startSession(): Promise<StartSessionResult> {
    return { sessionId: 'test-session' };
  }
  async sendPrompt(_id: SessionId, _p: string): Promise<void> {}
  async cancel(_id: SessionId): Promise<void> {}

  /** Public proxy for tests. */
  public testStreamLines(stream: PassThrough, cb: (line: string) => void) {
    return this.streamLines(stream, cb);
  }
  /** Public proxy for tests. */
  public testAttachError(
    child: ChildProcess,
    cmd: string,
    reject: (e: Error) => void,
  ) {
    this.attachInstallHintErrorHandler(child, cmd, reject);
  }
  /** Public proxy for waitForResponseComplete — tests drive it directly. */
  public testWaitForResponseComplete(timeoutMs?: number): Promise<void> {
    return this.waitForResponseComplete(timeoutMs);
  }
  /**
   * Allow tests to inject a fake ChildProcess reference so we can control
   * when `this.process.killed` becomes true without spawning a real subprocess.
   */
  public setProcess(p: ChildProcess | null): void {
    this.process = p;
  }
  /** Expose emitted messages for assertions. */
  public emitted: unknown[] = [];
  constructor() {
    super();
    this.onMessage((m) => this.emitted.push(m));
  }
}

describe('formatInstallHint', () => {
  it('returns a friendly hint for known agents', () => {
    expect(formatInstallHint('aider')).toContain('Aider');
    expect(formatInstallHint('aider')).toContain('pip install');
    expect(formatInstallHint('amp')).toContain('Amp');
    expect(formatInstallHint('crush')).toContain('Crush');
    expect(formatInstallHint('opencode').toLowerCase()).toContain('opencode');
  });

  it('falls back to a generic hint for unknown agents', () => {
    const msg = formatInstallHint('mystery');
    expect(msg).toContain('Mystery');
    expect(msg).toContain('not installed');
  });

  it('is case-insensitive on lookup but capitalises display', () => {
    expect(formatInstallHint('AIDER').startsWith('AIDER')).toBe(true);
  });
});

describe('streamLines', () => {
  it('emits one callback per line and strips trailing newlines', async () => {
    const backend = new TestBackend();
    const stream = new PassThrough();
    const lines: string[] = [];
    backend.testStreamLines(stream, (l) => lines.push(l));

    stream.write('first line\nsecond line\nthird');
    stream.end();

    // Allow readline to flush.
    await new Promise((r) => setImmediate(r));
    expect(lines).toEqual(['first line', 'second line', 'third']);
  });

  it('closes the readline interface when the upstream stream ends', async () => {
    const backend = new TestBackend();
    const stream = new PassThrough();
    const rl = backend.testStreamLines(stream, () => {});
    const closed = vi.fn();
    rl.on('close', closed);

    stream.end();
    await new Promise((r) => setImmediate(r));
    expect(closed).toHaveBeenCalled();
  });

  it('does not crash when the user callback throws', async () => {
    const backend = new TestBackend();
    const stream = new PassThrough();
    backend.testStreamLines(stream, () => {
      throw new Error('boom');
    });

    stream.write('line\n');
    stream.end();
    await new Promise((r) => setImmediate(r));
    // No assertion needed; test passes if no unhandled rejection.
  });
});

describe('attachInstallHintErrorHandler', () => {
  it('rejects with the install hint when err.code === ENOENT', async () => {
    const backend = new TestBackend();
    const child = new EventEmitter() as ChildProcess;
    let rejected: Error | undefined;
    backend.testAttachError(child, 'aider', (e) => {
      rejected = e;
    });

    const err = new Error('spawn aider ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    child.emit('error', err);

    expect(rejected?.message).toMatch(/Aider is not installed/);
    const status = backend.emitted.find(
      (m: any) => m.type === 'status' && m.status === 'error',
    ) as any;
    expect(status.detail).toMatch(/pip install/);
  });

  it('forwards non-ENOENT errors verbatim', async () => {
    const backend = new TestBackend();
    const child = new EventEmitter() as ChildProcess;
    let rejected: Error | undefined;
    backend.testAttachError(child, 'aider', (e) => {
      rejected = e;
    });

    child.emit('error', new Error('EPERM: denied'));

    expect(rejected?.message).toBe('EPERM: denied');
  });
});

// ============================================================================
// Audit C-2: polling timer leak — poll loop must stop after outer timeout fires
// ============================================================================

describe('waitForResponseComplete — C-2: polling loop stops after outer timeout', () => {
  /**
   * WHY THIS TEST EXISTS
   * --------------------
   * Before the C-2 fix, `waitForResponseComplete` used `setTimeout(poll, 100)`
   * recursively without storing the handle. When the outer timeout fired and
   * called `reject()`, the already-scheduled poll tick would fire 100 ms later,
   * find `this.process` still alive, and schedule yet another poll tick —
   * indefinitely. Each iteration held a closure over the ChildProcess reference,
   * preventing GC and keeping the event loop alive.
   *
   * The fix introduces a `cancelled` boolean that is set to `true` inside the
   * outer timeout callback. The poll loop checks this flag on entry and exits
   * immediately if it is set.
   *
   * These tests verify:
   *   1. The promise rejects with the expected timeout message.
   *   2. setTimeout is called exactly once for the poll re-schedule BEFORE the
   *      timeout fires, and NOT called again after the timeout fires.
   *   3. The polling resolves immediately when `this.process.killed` is true.
   *
   * We use fake timers (vi.useFakeTimers) to control when the outer timeout and
   * poll ticks fire, and spy on `setTimeout` to count re-schedule calls.
   */
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects with the timeout message when the process does not die within timeoutMs', async () => {
    const backend = new TestBackend();

    // Inject a fake process that is never killed
    const fakeProcess = new EventEmitter() as ChildProcess;
    (fakeProcess as unknown as Record<string, unknown>).killed = false;
    backend.setProcess(fakeProcess);

    const promise = backend.testWaitForResponseComplete(500);

    // Advance past the outer timeout
    vi.advanceTimersByTime(600);

    // WHY 'Test' not 'TestBackend': StreamingAgentBackendBase strips the
    // "Backend" suffix from logTag to produce the user-facing agent label
    // (see line ~416 in the parent class).
    await expect(promise).rejects.toThrow('Timeout waiting for Test response');
  });

  it('stops scheduling new poll ticks after the outer timeout fires', async () => {
    const backend = new TestBackend();

    const fakeProcess = new EventEmitter() as ChildProcess;
    (fakeProcess as unknown as Record<string, unknown>).killed = false;
    backend.setProcess(fakeProcess);

    // Spy on setTimeout AFTER fake timers are installed so we count only our calls
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const promise = backend.testWaitForResponseComplete(150);

    // Advance time: the outer timeout fires at 150 ms.
    // In between, poll() should have fired at t=0, t=100, and re-scheduled at each
    // tick. Once the outer timeout fires at 150 ms, the next poll() at t=200 should
    // see `cancelled = true` and return without calling setTimeout again.
    vi.advanceTimersByTime(500);

    // Consume the rejection so the promise does not cause an unhandled rejection
    await promise.catch(() => undefined);

    // Count how many times setTimeout was called with poll (100 ms interval).
    // With cancelled=true guarding the loop, there should be NO poll re-schedule
    // calls after the outer timeout fired at 150 ms. That means the last
    // re-schedule call happens at either t=0 or t=100, and the call at t=200
    // exits immediately without calling setTimeout.
    const pollCalls = setTimeoutSpy.mock.calls.filter(
      // The outer timeout has delay=150, poll re-schedules have delay=100
      (args) => (args[1] as number) === 100,
    );
    // There should be at most 2 poll re-schedule calls (at t=0 → schedule t=100,
    // at t=100 → schedule t=200). The call at t=200 exits early; no further
    // re-schedules occur.
    expect(pollCalls.length).toBeLessThanOrEqual(2);
  });

  it('resolves immediately when the process is already killed at poll time', async () => {
    const backend = new TestBackend();

    const fakeProcess = new EventEmitter() as ChildProcess;
    (fakeProcess as unknown as Record<string, unknown>).killed = true;
    backend.setProcess(fakeProcess);

    const promise = backend.testWaitForResponseComplete(5000);

    // The first poll() tick runs synchronously at call time; advance just enough
    // for the initial setImmediate/microtask queue to flush.
    vi.advanceTimersByTime(0);

    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves if the process becomes killed between two poll ticks', async () => {
    const backend = new TestBackend();

    const fakeProcess = new EventEmitter() as ChildProcess;
    (fakeProcess as unknown as Record<string, unknown>).killed = false;
    backend.setProcess(fakeProcess);

    const promise = backend.testWaitForResponseComplete(5000);

    // Let the first poll tick run (process still alive → schedules next poll)
    vi.advanceTimersByTime(50);

    // Now mark the process as killed
    (fakeProcess as unknown as Record<string, unknown>).killed = true;

    // Advance past the next poll tick (100 ms interval)
    vi.advanceTimersByTime(100);

    await expect(promise).resolves.toBeUndefined();
  });
});
