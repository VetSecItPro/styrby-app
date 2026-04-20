/**
 * StreamingAgentBackendBase — shared behavioral contract suite.
 *
 * WHY: This suite runs the same lifecycle contract against EVERY stdout-parsing
 * factory (aider, amp, crush, droid, goose, kilo, kiro, opencode). It protects
 * the invariants that the base class promises:
 *
 *   1. onMessage/emit — every registered handler receives emitted messages.
 *   2. offMessage — removes a specific handler; others continue to receive.
 *   3. dispose — idempotent; clears the internal listener array (SOC2 CC7.2,
 *      so handler closures become GC-eligible); clears any pending cancel
 *      timer (Node.js event-loop hygiene); SIGTERMs the active process.
 *   4. cancel — schedules a tracked SIGKILL-escalation timer via the base
 *      class so it is cleared on dispose and never leaks.
 *   5. Double-dispose — safe no-op the second time.
 *
 * Agent-specific parsing logic is covered by per-factory tests. This file
 * only exercises the shared plumbing.
 *
 * @module agent/__tests__/streamingBackendContract
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mocks — declared before factory imports so Vitest's hoisting can intercept
// child_process.spawn and the logger.
// ---------------------------------------------------------------------------

/**
 * Build a fresh mock ChildProcess with stdin/stdout/stderr streams and a
 * spy-able kill() that records invocation order and sets `killed = true`.
 */
function makeMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write?: (chunk: string) => void };
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter() as typeof proc.stdin;
  proc.stdin.write = vi.fn();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

type MockProcess = ReturnType<typeof makeMockProcess>;

let currentMockProcess: MockProcess;

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

// ---------------------------------------------------------------------------
// Imports AFTER vi.mock declarations
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createAiderBackend } from '../factories/aider';
import { createAmpBackend } from '../factories/amp';
import { createCrushBackend } from '../factories/crush';
import { createDroidBackend } from '../factories/droid';
import { createGooseBackend } from '../factories/goose';
import { createKiloBackend } from '../factories/kilo';
import { createKiroBackend } from '../factories/kiro';
import { createOpenCodeBackend } from '../factories/opencode';
import type { AgentBackend, AgentMessage } from '../core';

const mockSpawn = spawn as unknown as MockInstance;

// ---------------------------------------------------------------------------
// Factory fixture table — every streaming factory registered under test.
// ---------------------------------------------------------------------------

interface FactoryCase {
  name: string;
  create: () => AgentBackend;
}

const FACTORY_CASES: FactoryCase[] = [
  { name: 'aider', create: () => createAiderBackend({ cwd: '/tmp' }).backend },
  { name: 'amp', create: () => createAmpBackend({ cwd: '/tmp' }).backend },
  { name: 'crush', create: () => createCrushBackend({ cwd: '/tmp' }).backend },
  { name: 'droid', create: () => createDroidBackend({ cwd: '/tmp' }).backend },
  { name: 'goose', create: () => createGooseBackend({ cwd: '/tmp' }).backend },
  { name: 'kilo', create: () => createKiloBackend({ cwd: '/tmp' }).backend },
  { name: 'kiro', create: () => createKiroBackend({ cwd: '/tmp' }).backend },
  { name: 'opencode', create: () => createOpenCodeBackend({ cwd: '/tmp' }).backend },
];

// ---------------------------------------------------------------------------
// Suite — runs the same contract against every factory via describe.each
// ---------------------------------------------------------------------------

beforeEach(() => {
  currentMockProcess = makeMockProcess();
  mockSpawn.mockReturnValue(currentMockProcess);
  vi.clearAllMocks();
  mockSpawn.mockReturnValue(currentMockProcess);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(FACTORY_CASES)(
  'StreamingAgentBackendBase contract — $name',
  ({ create }) => {
    it('notifies every registered onMessage handler when emit runs', async () => {
      const backend = create();
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      backend.onMessage(handlerA);
      backend.onMessage(handlerB);

      // startSession emits at least one status message on every backend.
      await backend.startSession();

      expect(handlerA).toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalled();
      // Both handlers see identical messages.
      expect(handlerA.mock.calls.length).toBe(handlerB.mock.calls.length);
    });

    it('offMessage removes only the specified handler', async () => {
      const backend = create();
      const kept = vi.fn();
      const removed = vi.fn();

      backend.onMessage(kept);
      backend.onMessage(removed);
      backend.offMessage?.(removed);

      await backend.startSession();

      expect(kept).toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
    });

    it('dispose is idempotent and clears internal listener references', async () => {
      const backend = create();
      const handler = vi.fn();
      backend.onMessage(handler);

      await backend.startSession();
      const callsBeforeDispose = handler.mock.calls.length;
      expect(callsBeforeDispose).toBeGreaterThan(0);

      await backend.dispose();
      // Second dispose must not throw.
      await expect(backend.dispose()).resolves.toBeUndefined();

      // SOC2 CC7.2 (reliability of processing): after dispose, emit() is
      // gated by the disposed flag. We verify by re-registering the handler,
      // attempting to trigger a sendPrompt, and asserting no new calls.
      handler.mockClear();
      backend.onMessage(handler);
      await backend
        .sendPrompt('fake-session', 'hi')
        .catch(() => undefined); // Expected: rejects because disposed.

      // emit() is a no-op once disposed, so handler must not have fired.
      expect(handler).not.toHaveBeenCalled();
    });

    it('cancel schedules a tracked force-kill timer that dispose can clear', async () => {
      vi.useFakeTimers();
      const backend = create();
      await backend.startSession();

      // Kick off a sendPrompt so the backend spawns a subprocess.
      backend.sendPrompt((await backend.startSession()).sessionId, 'hi').catch(() => undefined);
      // Yield microtasks so spawn() has executed.
      await Promise.resolve();

      if (currentMockProcess.kill.mock.calls.length === 0) {
        // Some factories (e.g. aider) spawn lazily on sendPrompt which is
        // fire-and-forget above; give the promise microtasks a chance.
        await Promise.resolve();
      }

      // Issue cancel; should send SIGTERM and register a force-kill timer.
      const sessionId = 'fake-session';
      await backend.cancel(sessionId).catch(() => undefined);

      // dispose() must clear the timer. If the timer were untracked, the
      // fake-clock advance below would fire SIGKILL; with tracking, it
      // should be cancelled by dispose().
      await backend.dispose();

      const killCountBefore = currentMockProcess.kill.mock.calls.length;
      // Advance past the 3-second SIGKILL deadline.
      vi.advanceTimersByTime(5000);
      const killCountAfter = currentMockProcess.kill.mock.calls.length;

      // No additional kill should have fired after dispose cleared the timer.
      expect(killCountAfter).toBe(killCountBefore);
    });

    it('swallows errors thrown by individual message handlers', async () => {
      const backend = create();
      const noisy = vi.fn(() => {
        throw new Error('handler boom');
      });
      const quiet = vi.fn();

      backend.onMessage(noisy);
      backend.onMessage(quiet);

      // Even though `noisy` throws, `quiet` must still receive every message.
      await expect(backend.startSession()).resolves.toBeDefined();
      expect(quiet).toHaveBeenCalled();
    });
  },
);

// ---------------------------------------------------------------------------
// Cross-factory sanity check — confirms every factory actually extends the
// base class and inherits the public AgentBackend surface.
// ---------------------------------------------------------------------------

describe('StreamingAgentBackendBase — surface coverage', () => {
  it.each(FACTORY_CASES)(
    '$name backend exposes the full AgentBackend interface',
    ({ create }) => {
      const backend = create();
      expect(typeof backend.startSession).toBe('function');
      expect(typeof backend.sendPrompt).toBe('function');
      expect(typeof backend.cancel).toBe('function');
      expect(typeof backend.onMessage).toBe('function');
      expect(typeof backend.offMessage).toBe('function');
      expect(typeof backend.dispose).toBe('function');
      expect(typeof backend.respondToPermission).toBe('function');
      expect(typeof backend.waitForResponseComplete).toBe('function');
    },
  );
});
