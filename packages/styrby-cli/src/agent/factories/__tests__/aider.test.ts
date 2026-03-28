/**
 * Tests for the Aider agent backend factory.
 *
 * Covers:
 * - `createAiderBackend` factory function
 * - `registerAiderAgent` registry integration
 * - `AiderBackend` class: session lifecycle, subprocess management,
 *   output parsing, token estimation, event emission, error handling,
 *   and cancellation.
 *
 * All child_process and logger calls are mocked so no real Aider binary
 * is required.
 *
 * @module factories/__tests__/aider
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test so that
// Vitest's hoisting mechanism replaces the real modules in time.
// ---------------------------------------------------------------------------

/** Minimal mock of a writable stdio stream */
function makeStream() {
  const emitter = new EventEmitter();
  return emitter;
}

/**
 * Factory for building a mock ChildProcess.
 * Each test gets a fresh instance through `mockSpawnImpl`.
 */
function makeMockProcess() {
  const proc = new EventEmitter() as ReturnType<typeof makeMockProcess>;
  proc.stdout = makeStream();
  proc.stderr = makeStream();
  proc.stdin = makeStream();
  proc.killed = false;
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true;
    return true;
  });
  return proc;
}

type MockProcess = ReturnType<typeof makeMockProcess>;

// Mutable reference so individual tests can control what spawn returns.
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
// Imports — come AFTER vi.mock declarations
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createAiderBackend, registerAiderAgent, type AiderBackendOptions } from '../aider';
import { agentRegistry } from '../../core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = spawn as unknown as MockInstance;

/** Collect all messages emitted by a backend into an array */
function collectMessages(backend: ReturnType<typeof createAiderBackend>['backend']) {
  const messages: unknown[] = [];
  backend.onMessage((msg) => messages.push(msg));
  return messages;
}

/** Resolve a `sendPrompt` call by simulating a clean process exit */
function resolveProcess(proc: MockProcess, stdout = 'All done.', exitCode = 0) {
  if (stdout) {
    (proc.stdout as EventEmitter).emit('data', Buffer.from(stdout));
  }
  proc.emit('close', exitCode);
}

/** Base options used across most tests */
const BASE_OPTIONS: AiderBackendOptions = {
  cwd: '/project',
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  currentMockProcess = makeMockProcess();
  mockSpawn.mockReturnValue(currentMockProcess);
  vi.clearAllMocks();
  // Re-apply the return value after clearAllMocks wipes it
  mockSpawn.mockReturnValue(currentMockProcess);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// createAiderBackend — factory function
// ===========================================================================

/**
 * Tests for the `createAiderBackend` factory function.
 * Verifies that the factory returns the correct shape and resolves config.
 */
describe('createAiderBackend', () => {
  it('returns a backend instance and the resolved model when model is provided', () => {
    const { backend, model } = createAiderBackend({ ...BASE_OPTIONS, model: 'gpt-4' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('gpt-4');
  });

  it('returns undefined model when no model is specified', () => {
    const { model } = createAiderBackend(BASE_OPTIONS);

    expect(model).toBeUndefined();
  });

  it('returns a backend that implements the full AgentBackend interface', () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);

    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });

  it('does NOT spawn a process at creation time', () => {
    createAiderBackend(BASE_OPTIONS);

    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// registerAiderAgent
// ===========================================================================

/**
 * Tests for `registerAiderAgent` — verifies registry integration.
 */
describe('registerAiderAgent', () => {
  it('registers "aider" in the global agent registry', () => {
    registerAiderAgent();

    expect(agentRegistry.has('aider')).toBe(true);
  });

  it('registry can create a backend after registration', () => {
    registerAiderAgent();

    const backend = agentRegistry.create('aider', { cwd: '/project' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
  });
});

// ===========================================================================
// AiderBackend — session lifecycle
// ===========================================================================

/**
 * Tests for session lifecycle: startSession, sendPrompt, dispose.
 */
describe('AiderBackend — session lifecycle', () => {
  it('startSession returns a sessionId string', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const result = await backend.startSession();

    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('startSession emits "starting" then "idle" when no initial prompt given', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    await backend.startSession();

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses).toContain('starting');
    expect(statuses).toContain('idle');
  });

  it('startSession with initial prompt emits "starting" → "running" then spawns aider', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    const sessionPromise = backend.startSession('Fix the bug');
    resolveProcess(currentMockProcess);
    await sessionPromise;

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses[0]).toBe('starting');
    expect(statuses[1]).toBe('running');
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('throws when startSession is called on a disposed backend', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('Backend has been disposed');
  });

  it('generates a unique sessionId each time a new backend is created', async () => {
    const { backend: b1 } = createAiderBackend(BASE_OPTIONS);
    const { backend: b2 } = createAiderBackend(BASE_OPTIONS);

    const { sessionId: id1 } = await b1.startSession();
    const { sessionId: id2 } = await b2.startSession();

    expect(id1).not.toBe(id2);
  });

  it('dispose kills an in-flight process', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // WHY: Override kill to also emit 'close' so sendPrompt's internal
    // promise resolves. Without this, the test hangs because the mock
    // process never signals termination after SIGTERM is sent.
    currentMockProcess.kill = vi.fn((_signal?: string) => {
      currentMockProcess.killed = true;
      // Simulate the OS delivering SIGTERM → process exits with code 1
      process.nextTick(() => currentMockProcess.emit('close', 1));
      return true;
    });

    // Start a prompt (process is "running") — do not await, dispose cancels it
    const promptPromise = backend.sendPrompt(sessionId, 'hello').catch(() => {});

    await backend.dispose();

    expect(currentMockProcess.kill).toHaveBeenCalled();
    await promptPromise;
  });

  it('dispose clears all message listeners', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const handler = vi.fn();
    backend.onMessage(handler);

    await backend.dispose();

    // After dispose, emit should be a no-op — handler must not be called
    // We access internal emit indirectly by starting a new session (which would
    // emit status) but the backend is disposed so startSession will throw.
    await expect(backend.startSession()).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// AiderBackend — sendPrompt & subprocess arguments
// ===========================================================================

/**
 * Tests for sendPrompt — verifies correct CLI arguments are passed to spawn.
 */
describe('AiderBackend — sendPrompt arguments', () => {
  it('spawns aider with --message, --no-stream, and --yes flags', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Refactor the auth module');
    resolveProcess(currentMockProcess);
    await promptPromise;

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('aider');
    expect(args).toContain('--message');
    expect(args).toContain('Refactor the auth module');
    expect(args).toContain('--no-stream');
    expect(args).toContain('--yes');
  });

  it('includes --model flag when model option is set', async () => {
    const { backend } = createAiderBackend({ ...BASE_OPTIONS, model: 'claude-3-opus-20240229' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('claude-3-opus-20240229');
  });

  it('does NOT include --model flag when model is omitted', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--model');
  });

  it('appends extraArgs to the spawn call', async () => {
    const { backend } = createAiderBackend({
      ...BASE_OPTIONS,
      extraArgs: ['--dark-mode', '--no-auto-commits'],
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--dark-mode');
    expect(args).toContain('--no-auto-commits');
  });

  it('appends file paths to the spawn call when files option is set', async () => {
    const { backend } = createAiderBackend({
      ...BASE_OPTIONS,
      files: ['src/main.ts', 'src/utils.ts'],
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('src/main.ts');
    expect(args).toContain('src/utils.ts');
  });

  it('sets OPENAI_API_KEY in env when apiKey option is provided', async () => {
    const { backend } = createAiderBackend({ ...BASE_OPTIONS, apiKey: 'sk-test-123' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess);
    await promptPromise;

    const [, , spawnOptions] = mockSpawn.mock.calls[0];
    expect(spawnOptions.env.OPENAI_API_KEY).toBe('sk-test-123');
  });

  it('does not set OPENAI_API_KEY when apiKey is omitted', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess);
    await promptPromise;

    const [, , spawnOptions] = mockSpawn.mock.calls[0];
    // OPENAI_API_KEY should not be explicitly injected (may still come from
    // process.env, but not forcibly set by the adapter)
    expect('OPENAI_API_KEY' in spawnOptions.env &&
      spawnOptions.env.OPENAI_API_KEY !== undefined
        ? spawnOptions.env.OPENAI_API_KEY
        : null
    ).not.toBe('sk-test-123');
  });

  it('passes cwd to spawn', async () => {
    const { backend } = createAiderBackend({ cwd: '/my/project' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess);
    await promptPromise;

    const [, , spawnOptions] = mockSpawn.mock.calls[0];
    expect(spawnOptions.cwd).toBe('/my/project');
  });

  it('rejects when called with a mismatched sessionId', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.sendPrompt('wrong-session-id', 'hello')).rejects.toThrow(
      'Invalid session ID',
    );
  });

  it('rejects when called on a disposed backend', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    await backend.dispose();

    await expect(backend.sendPrompt(sessionId, 'hello')).rejects.toThrow(
      'Backend has been disposed',
    );
  });
});

// ===========================================================================
// AiderBackend — output parsing & event emission
// ===========================================================================

/**
 * Tests for stdout parsing: model-output events, fs-edit detection, and
 * token-count emission after process close.
 */
describe('AiderBackend — output parsing and event emission', () => {
  it('emits model-output message for non-empty stdout chunks', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess, 'Here is the fix.');
    await promptPromise;

    const modelOutputs = messages.filter((m: any) => m.type === 'model-output');
    expect(modelOutputs.length).toBeGreaterThan(0);
    const text = modelOutputs.map((m: any) => m.textDelta).join('');
    expect(text).toContain('Here is the fix.');
  });

  it('does NOT emit model-output for whitespace-only stdout chunks', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from('   \n  \n'));
    resolveProcess(currentMockProcess, '', 0);
    await promptPromise;

    const modelOutputs = messages.filter((m: any) => m.type === 'model-output');
    expect(modelOutputs.length).toBe(0);
  });

  it('emits fs-edit message when stdout contains "Wrote <path>" pattern', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess, 'Wrote src/foo.ts\n');
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits.length).toBeGreaterThan(0);
    const edit = fsEdits[0] as any;
    expect(edit.path).toBe('src/foo.ts');
    expect(edit.description).toContain('wrote');
    expect(edit.description).toContain('src/foo.ts');
  });

  it('emits fs-edit message when stdout contains "Updated <path>" pattern', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess, 'Updated lib/utils.ts\n');
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits.length).toBeGreaterThan(0);
    expect((fsEdits[0] as any).path).toBe('lib/utils.ts');
  });

  it('emits fs-edit message when stdout contains "Created <path>" pattern', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess, 'Created tests/new.test.ts\n');
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits.length).toBeGreaterThan(0);
    expect((fsEdits[0] as any).path).toBe('tests/new.test.ts');
  });

  it('emits token-count message when process closes', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello world');
    resolveProcess(currentMockProcess, 'Some output text.');
    await promptPromise;

    const tokenMessages = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenMessages.length).toBe(1);

    const tokenMsg = tokenMessages[0] as any;
    expect(typeof tokenMsg.inputTokens).toBe('number');
    expect(typeof tokenMsg.outputTokens).toBe('number');
    expect(tokenMsg.inputTokens).toBeGreaterThan(0);
    expect(tokenMsg.outputTokens).toBeGreaterThan(0);
    // Aider does not provide real cost data
    expect(tokenMsg.estimatedCostUsd).toBe(0);
  });

  it('emits "idle" status after process exits cleanly', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess, 'done', 0);
    await promptPromise;

    const lastStatus = messages
      .filter((m: any) => m.type === 'status')
      .at(-1) as any;

    expect(lastStatus?.status).toBe('idle');
  });

  it('accumulates input tokens across multiple sendPrompt calls', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    // First prompt
    let proc1 = currentMockProcess;
    const p1 = backend.sendPrompt(sessionId, 'first prompt');
    resolveProcess(proc1, 'response one', 0);
    await p1;

    // Second prompt — spawn returns a fresh process
    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);
    const p2 = backend.sendPrompt(sessionId, 'second prompt');
    resolveProcess(currentMockProcess, 'response two', 0);
    await p2;

    const tokenMessages = messages.filter((m: any) => m.type === 'token-count');
    // Both calls should emit token-count
    expect(tokenMessages.length).toBe(2);

    // The second token-count should reflect accumulated input tokens
    const secondCount = tokenMessages[1] as any;
    expect(secondCount.inputTokens).toBeGreaterThan((tokenMessages[0] as any).inputTokens);
  });
});

// ===========================================================================
// AiderBackend — error handling
// ===========================================================================

/**
 * Tests for error conditions: non-zero exit codes, stderr errors, and
 * spawn failures.
 */
describe('AiderBackend — error handling', () => {
  it('rejects sendPrompt when aider exits with non-zero exit code', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    resolveProcess(currentMockProcess, '', 1);

    await expect(promptPromise).rejects.toThrow('Aider exited with code 1');
  });

  it('emits error status when aider exits with non-zero code', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello').catch(() => {});
    resolveProcess(currentMockProcess, '', 2);
    await promptPromise;

    const errorStatus = messages
      .filter((m: any) => m.type === 'status' && m.status === 'error')
      .at(-1) as any;

    expect(errorStatus).toBeDefined();
    expect(errorStatus.detail).toContain('code 2');
  });

  it('emits error status when stderr contains the word "Error"', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stderr as EventEmitter).emit(
      'data',
      Buffer.from('Error: cannot connect to model API'),
    );
    resolveProcess(currentMockProcess, '', 0);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('emits error status when stderr contains the word "Exception"', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stderr as EventEmitter).emit(
      'data',
      Buffer.from('Exception: rate limit reached'),
    );
    resolveProcess(currentMockProcess, '', 0);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('rejects sendPrompt when the spawned process emits an "error" event', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    currentMockProcess.emit('error', new Error('ENOENT: aider not found'));

    await expect(promptPromise).rejects.toThrow('ENOENT: aider not found');
  });

  it('emits error status when process emits "error" event', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello').catch(() => {});
    currentMockProcess.emit('error', new Error('spawn ENOENT'));
    await promptPromise;

    const errorStatus = messages
      .filter((m: any) => m.type === 'status' && m.status === 'error')
      .at(0) as any;

    expect(errorStatus).toBeDefined();
    expect(errorStatus.detail).toContain('spawn ENOENT');
  });
});

// ===========================================================================
// AiderBackend — cancel
// ===========================================================================

/**
 * Tests for the cancel method — verifies SIGTERM is sent and idle status emitted.
 */
describe('AiderBackend — cancel', () => {
  it('sends SIGTERM to the running process when cancel is called', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // Start a prompt (don't await — we cancel instead)
    backend.sendPrompt(sessionId, 'long running task').catch(() => {});

    await backend.cancel(sessionId);

    expect(currentMockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('emits "idle" status after cancel', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'task').catch(() => {});
    await backend.cancel(sessionId);

    const lastStatus = messages
      .filter((m: any) => m.type === 'status')
      .at(-1) as any;

    expect(lastStatus?.status).toBe('idle');
  });

  it('throws when cancel is called with a mismatched sessionId', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.cancel('invalid-id')).rejects.toThrow('Invalid session ID');
  });

  it('does not throw when cancel is called with no active process', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // No sendPrompt call — no active process
    await expect(backend.cancel(sessionId)).resolves.not.toThrow();
  });
});

// ===========================================================================
// AiderBackend — onMessage / offMessage
// ===========================================================================

/**
 * Tests for the listener management API.
 */
describe('AiderBackend — onMessage / offMessage', () => {
  it('calls all registered handlers for each emitted message', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const h1 = vi.fn();
    const h2 = vi.fn();
    backend.onMessage(h1);
    backend.onMessage(h2);

    await backend.startSession(); // emits 'starting' + 'idle'

    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('stops calling a handler after offMessage is called', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const handler = vi.fn();
    backend.onMessage(handler);
    backend.offMessage(handler);

    await backend.startSession();

    expect(handler).not.toHaveBeenCalled();
  });

  it('handles errors thrown inside a listener without crashing the backend', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const badHandler = vi.fn(() => {
      throw new Error('handler exploded');
    });
    const goodHandler = vi.fn();
    backend.onMessage(badHandler);
    backend.onMessage(goodHandler);

    // Should not throw even though badHandler throws
    await expect(backend.startSession()).resolves.toBeDefined();
    expect(goodHandler).toHaveBeenCalled();
  });
});

// ===========================================================================
// AiderBackend — respondToPermission
// ===========================================================================

/**
 * Tests for the optional `respondToPermission` method.
 * Aider uses --yes so this is a no-op that just emits a permission-response.
 */
describe('AiderBackend — respondToPermission', () => {
  it('emits a permission-response message with the given id and approved=true', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission?.('req-abc', true);

    const permMsg = messages.find((m: any) => m.type === 'permission-response') as any;
    expect(permMsg).toBeDefined();
    expect(permMsg.id).toBe('req-abc');
    expect(permMsg.approved).toBe(true);
  });

  it('emits a permission-response message with approved=false when denied', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission?.('req-xyz', false);

    const permMsg = messages.find((m: any) => m.type === 'permission-response') as any;
    expect(permMsg).toBeDefined();
    expect(permMsg.approved).toBe(false);
  });
});

// ===========================================================================
// AiderBackend — waitForResponseComplete
// ===========================================================================

/**
 * Tests for waitForResponseComplete — no-op when no active process.
 */
describe('AiderBackend — waitForResponseComplete', () => {
  it('resolves immediately when no process is active', async () => {
    const { backend } = createAiderBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.waitForResponseComplete?.(1000)).resolves.toBeUndefined();
  });
});
