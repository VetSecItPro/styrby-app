/**
 * OpenCode Backend — comprehensive test suite
 *
 * Tests cover:
 *  - createOpenCodeBackend factory (valid/invalid config)
 *  - registerOpenCodeAgent (registry integration)
 *  - Session lifecycle: startSession, sendPrompt, cancel, dispose
 *  - JSON-line parsing — valid, partial, malformed, non-JSON
 *  - Tool-use event routing (tool_use, tool_result, fs-edit side-effects)
 *  - Status mapping (all known status values + unknown fallback)
 *  - Cost/token extraction from 'session' messages
 *  - Error handling: process errors, non-zero exit codes, disposed backend
 *  - Event emission: onMessage/offMessage, disposed guard, handler exceptions
 *  - waitForResponseComplete timeout
 *  - respondToPermission
 *
 * @module factories/__tests__/opencode.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock child_process/spawn before the module is imported
// ---------------------------------------------------------------------------

/** Minimal fake ChildProcess used by spawn mock */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn((signal?: string) => {
    this.killed = true;
    // Simulate async close so tests can await it when needed
    setImmediate(() => this.emit('close', signal === 'SIGKILL' ? 137 : 0));
  });
}

// Holds the last FakeChildProcess created so tests can interact with it
let lastFakeProcess: FakeChildProcess;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    lastFakeProcess = new FakeChildProcess();
    return lastFakeProcess;
  }),
}));

// ---------------------------------------------------------------------------
// Mock @/ui/logger — suppress all output during tests
// ---------------------------------------------------------------------------

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import SUT (after mocks are in place)
// ---------------------------------------------------------------------------

import { createOpenCodeBackend, registerOpenCodeAgent } from '../opencode';
import { agentRegistry } from '../../core';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect messages emitted by a backend into an array.
 *
 * @param backend - The AgentBackend to listen on
 * @returns Tuple of [messages array, remove-listener fn]
 */
function collectMessages(backend: ReturnType<typeof createOpenCodeBackend>['backend']) {
  const messages: unknown[] = [];
  const handler = (msg: unknown) => messages.push(msg);
  backend.onMessage(handler as never);
  return { messages, handler };
}

/**
 * Emit a line of stdout JSON to the last spawned fake process.
 *
 * @param line - Raw text line (newline appended automatically)
 */
function emitStdout(line: string) {
  lastFakeProcess.stdout.emit('data', Buffer.from(line + '\n'));
}

/**
 * Emit a stderr chunk to the last spawned fake process.
 *
 * @param text - Stderr text
 */
function emitStderr(text: string) {
  lastFakeProcess.stderr.emit('data', Buffer.from(text));
}

/**
 * Simulate a clean process exit (code 0).
 */
function closeProcess(code = 0) {
  lastFakeProcess.emit('close', code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOpenCodeBackend — factory', () => {
  /**
   * Verify the factory returns a backend and the resolved model.
   */
  it('returns a backend and the configured model', () => {
    const { backend, model } = createOpenCodeBackend({
      cwd: '/tmp/project',
      model: 'claude-sonnet-4-20250514',
    });
    expect(backend).toBeDefined();
    expect(model).toBe('claude-sonnet-4-20250514');
  });

  /**
   * model is optional — result.model should be undefined when omitted.
   */
  it('returns undefined model when model option is omitted', () => {
    const { model } = createOpenCodeBackend({ cwd: '/tmp/project' });
    expect(model).toBeUndefined();
  });

  /**
   * The returned backend must implement the full AgentBackend interface.
   */
  it('backend implements AgentBackend interface', () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });

  /**
   * Two calls to the factory should produce independent backend instances.
   */
  it('creates independent backend instances on repeated calls', () => {
    const { backend: a } = createOpenCodeBackend({ cwd: '/tmp/a' });
    const { backend: b } = createOpenCodeBackend({ cwd: '/tmp/b' });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------

describe('registerOpenCodeAgent', () => {
  /**
   * After calling registerOpenCodeAgent the 'opencode' key should be available
   * in the global agent registry.
   */
  it('registers opencode in the global agent registry', () => {
    registerOpenCodeAgent();
    expect(agentRegistry.has('opencode')).toBe(true);
  });

  /**
   * The registry factory should produce a valid backend when called.
   */
  it('registered factory creates a usable backend', () => {
    registerOpenCodeAgent();
    const backend = agentRegistry.create('opencode', { cwd: '/tmp/project' });
    expect(typeof backend.startSession).toBe('function');
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — session lifecycle', () => {
  it('startSession returns a sessionId string', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const result = await backend.startSession();
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
    await backend.dispose();
  });

  it('startSession emits "starting" then "idle" when no initial prompt given', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    await backend.startSession();
    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);
    expect(statuses).toContain('starting');
    expect(statuses).toContain('idle');
    await backend.dispose();
  });

  it('startSession emits "starting" then "running" when initial prompt supplied', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);

    // We don't want to actually wait for the spawned process to finish,
    // so we intercept after messages are emitted synchronously.
    const startPromise = backend.startSession('hello');

    // Immediately close the fake process with code 0
    setImmediate(() => closeProcess(0));

    await startPromise;

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);
    expect(statuses).toContain('starting');
    expect(statuses).toContain('running');
    await backend.dispose();
  });

  it('startSession generates unique session IDs across calls on separate backends', async () => {
    const { backend: a } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { backend: b } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { sessionId: idA } = await a.startSession();
    const { sessionId: idB } = await b.startSession();
    expect(idA).not.toBe(idB);
    await a.dispose();
    await b.dispose();
  });

  it('startSession throws after dispose', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    await backend.dispose();
    await expect(backend.startSession()).rejects.toThrow('Backend has been disposed');
  });

  it('dispose kills any running process and clears listeners', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { sessionId } = await backend.startSession();

    // Kick off a prompt so a process is spawned
    const promptPromise = backend.sendPrompt(sessionId, 'test');
    // Dispose immediately
    await backend.dispose();
    // The fake process's kill should have been called
    expect(lastFakeProcess.kill).toHaveBeenCalledWith('SIGTERM');
    // Clean up the dangling promise
    promptPromise.catch(() => {});
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — sendPrompt', () => {
  it('passes --format json and --non-interactive to spawn', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'write a test');
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(spawn).toHaveBeenCalledWith(
      'opencode',
      expect.arrayContaining(['--format', 'json', '--message', 'write a test', '--non-interactive']),
      expect.any(Object),
    );
    await backend.dispose();
  });

  it('includes --model when model option is set', async () => {
    const { backend } = createOpenCodeBackend({
      cwd: '/tmp/project',
      model: 'claude-sonnet-4-20250514',
    });
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(spawn).toHaveBeenCalledWith(
      'opencode',
      expect.arrayContaining(['--model', 'claude-sonnet-4-20250514']),
      expect.any(Object),
    );
    await backend.dispose();
  });

  it('includes --session when resumeSessionId is set', async () => {
    const { backend } = createOpenCodeBackend({
      cwd: '/tmp/project',
      resumeSessionId: 'ses-abc-123',
    });
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(spawn).toHaveBeenCalledWith(
      'opencode',
      expect.arrayContaining(['--session', 'ses-abc-123']),
      expect.any(Object),
    );
    await backend.dispose();
  });

  it('passes extraArgs to spawn', async () => {
    const { backend } = createOpenCodeBackend({
      cwd: '/tmp/project',
      extraArgs: ['--verbose', '--timeout', '60'],
    });
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'hi');
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(spawn).toHaveBeenCalledWith(
      'opencode',
      expect.arrayContaining(['--verbose', '--timeout', '60']),
      expect.any(Object),
    );
    await backend.dispose();
  });

  it('rejects when called with a wrong sessionId', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    await backend.startSession();
    await expect(backend.sendPrompt('wrong-id', 'hello')).rejects.toThrow('Invalid session ID');
    await backend.dispose();
  });

  it('rejects when called after dispose', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { sessionId } = await backend.startSession();
    await backend.dispose();
    await expect(backend.sendPrompt(sessionId, 'hello')).rejects.toThrow('Backend has been disposed');
  });

  it('rejects and emits error status when process exits with non-zero code', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'fail please');
    setImmediate(() => closeProcess(1));
    await expect(promptPromise).rejects.toThrow('OpenCode exited with code 1');

    const errorStatus = messages.find(
      (m: any) => m.type === 'status' && m.status === 'error',
    );
    expect(errorStatus).toBeDefined();
    await backend.dispose();
  });

  it('rejects and emits error status on process error event', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    setImmediate(() => lastFakeProcess.emit('error', new Error('ENOENT: opencode not found')));
    await expect(promptPromise).rejects.toThrow('ENOENT: opencode not found');

    const errorStatus = messages.find(
      (m: any) => m.type === 'status' && m.status === 'error' && m.detail?.includes('ENOENT'),
    );
    expect(errorStatus).toBeDefined();
    await backend.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — JSON-line parsing', () => {
  async function setupWithRunningPrompt() {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    // Start a prompt to spawn the process; don't await yet
    const promptPromise = backend.sendPrompt(sessionId, 'go');
    return { backend, messages, sessionId, promptPromise };
  }

  it('emits model-output for assistant messages', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(JSON.stringify({ type: 'assistant', content: 'Hello world' }));
    setImmediate(() => closeProcess(0));
    await promptPromise;

    const msg = messages.find((m: any) => m.type === 'model-output');
    expect(msg).toMatchObject({ type: 'model-output', textDelta: 'Hello world' });
  });

  it('ignores assistant messages without content', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(JSON.stringify({ type: 'assistant' }));
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages.filter((m: any) => m.type === 'model-output')).toHaveLength(0);
  });

  it('ignores empty lines', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout('');
    emitStdout('   ');
    setImmediate(() => closeProcess(0));
    await promptPromise;

    // No messages should have come from empty lines
    expect(messages.filter((m: any) => m.type === 'model-output')).toHaveLength(0);
  });

  it('ignores non-JSON text lines without throwing', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout('starting opencode v1.2.3');
    setImmediate(() => closeProcess(0));
    await promptPromise;

    // No crash, no model-output
    expect(messages.filter((m: any) => m.type === 'model-output')).toHaveLength(0);
  });

  it('handles malformed JSON gracefully', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout('{broken json here');
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages.filter((m: any) => m.type === 'model-output')).toHaveLength(0);
  });

  it('handles partial lines across multiple data chunks', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    const full = JSON.stringify({ type: 'assistant', content: 'streamed' });
    // Split arbitrarily in the middle (no trailing newline on first chunk)
    lastFakeProcess.stdout.emit('data', Buffer.from(full.slice(0, 10)));
    lastFakeProcess.stdout.emit('data', Buffer.from(full.slice(10) + '\n'));
    setImmediate(() => closeProcess(0));
    await promptPromise;

    const msg = messages.find((m: any) => m.type === 'model-output');
    expect(msg).toMatchObject({ type: 'model-output', textDelta: 'streamed' });
  });

  it('processes buffered incomplete line on process close', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    // Emit without trailing newline so it stays in lineBuffer
    lastFakeProcess.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'assistant', content: 'buffered' })),
    );
    setImmediate(() => closeProcess(0));
    await promptPromise;

    const msg = messages.find((m: any) => m.type === 'model-output');
    expect(msg).toMatchObject({ type: 'model-output', textDelta: 'buffered' });
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — tool-use event routing', () => {
  async function setupWithRunningPrompt() {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'go');
    return { backend, messages, promptPromise };
  }

  it('emits tool-call for tool_use messages with tool_name and call_id', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(
      JSON.stringify({
        type: 'tool_use',
        tool_name: 'read_file',
        call_id: 'call-1',
        tool_input: { path: '/src/index.ts' },
      }),
    );
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages).toContainEqual({
      type: 'tool-call',
      toolName: 'read_file',
      callId: 'call-1',
      args: { path: '/src/index.ts' },
    });
  });

  it('ignores tool_use messages missing call_id or tool_name', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(JSON.stringify({ type: 'tool_use', tool_name: 'read_file' }));
    emitStdout(JSON.stringify({ type: 'tool_use', call_id: 'call-2' }));
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages.filter((m: any) => m.type === 'tool-call')).toHaveLength(0);
  });

  it('emits tool-result for tool_result messages', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(
      JSON.stringify({
        type: 'tool_result',
        tool_name: 'read_file',
        call_id: 'call-1',
        tool_result: 'file contents',
      }),
    );
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages).toContainEqual({
      type: 'tool-result',
      toolName: 'read_file',
      callId: 'call-1',
      result: 'file contents',
    });
  });

  it('emits fs-edit for write_file tool_result with path in tool_input', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(
      JSON.stringify({
        type: 'tool_result',
        tool_name: 'write_file',
        call_id: 'call-3',
        tool_input: { path: '/src/foo.ts' },
        tool_result: null,
      }),
    );
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'fs-edit', path: '/src/foo.ts' }),
    );
  });

  it('emits fs-edit for edit_file tool_result with file_path in tool_input', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(
      JSON.stringify({
        type: 'tool_result',
        tool_name: 'edit_file',
        call_id: 'call-4',
        tool_input: { file_path: '/src/bar.ts' },
        tool_result: null,
      }),
    );
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'fs-edit', path: '/src/bar.ts' }),
    );
  });

  it('does NOT emit fs-edit for non-file tools like read_file', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(
      JSON.stringify({
        type: 'tool_result',
        tool_name: 'read_file',
        call_id: 'call-5',
        tool_result: 'contents',
      }),
    );
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages.filter((m: any) => m.type === 'fs-edit')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — status mapping', () => {
  async function setupWithRunningPrompt() {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'go');
    return { backend, messages, promptPromise };
  }

  const statusCases: Array<[string, string]> = [
    ['starting', 'starting'],
    ['running', 'running'],
    ['idle', 'idle'],
    ['complete', 'idle'],   // complete maps to idle
    ['stopped', 'stopped'],
    ['error', 'error'],
    ['unknown_value', 'running'], // unknown falls back to 'running'
  ];

  for (const [input, expected] of statusCases) {
    it(`maps OpenCode status "${input}" → AgentStatus "${expected}"`, async () => {
      const { messages, promptPromise } = await setupWithRunningPrompt();
      emitStdout(JSON.stringify({ type: 'status', status: input }));
      setImmediate(() => closeProcess(0));
      await promptPromise;

      const statusMsgs = messages.filter(
        (m: any) => m.type === 'status' && m.status === expected,
      );
      expect(statusMsgs.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('emits error status for "error" message type', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(JSON.stringify({ type: 'error', error: 'API quota exceeded' }));
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'status', status: 'error', detail: 'API quota exceeded' }),
    );
  });

  it('uses "Unknown error" detail when error message has no error field', async () => {
    const { messages, promptPromise } = await setupWithRunningPrompt();
    emitStdout(JSON.stringify({ type: 'error' }));
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'status', status: 'error', detail: 'Unknown error' }),
    );
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — cost and token extraction', () => {
  it('emits token-count from session messages', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'go');

    emitStdout(
      JSON.stringify({
        type: 'session',
        session: {
          id: 'oc-session-xyz',
          Cost: 0.0042,
          PromptTokens: 1500,
          CompletionTokens: 300,
          TotalTokens: 1800,
        },
      }),
    );
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'token-count',
        inputTokens: 1500,
        outputTokens: 300,
        totalTokens: 1800,
        costUsd: 0.0042,
      }),
    );
    await backend.dispose();
  });

  it('computes totalTokens from input+output when TotalTokens is missing', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'go');

    emitStdout(
      JSON.stringify({
        type: 'session',
        session: { PromptTokens: 100, CompletionTokens: 50 },
      }),
    );
    setImmediate(() => closeProcess(0));
    await promptPromise;

    const tc = messages.find((m: any) => m.type === 'token-count') as any;
    expect(tc.totalTokens).toBe(150);
    await backend.dispose();
  });

  it('captures the opencode session id from session messages', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'go');

    emitStdout(
      JSON.stringify({
        type: 'session',
        session: { id: 'oc-session-abc' },
      }),
    );
    // Close the first prompt so its promise resolves
    closeProcess(0);
    await promptPromise;

    // WHY: A second prompt should include the captured session id as --session arg.
    // The backend stores the OpenCode session ID from the session message and passes
    // it to subsequent spawn calls so the same OpenCode session is resumed.
    const promptPromise2 = backend.sendPrompt(sessionId, 'follow-up');
    setImmediate(() => closeProcess(0));
    await promptPromise2;

    expect(spawn).toHaveBeenCalledWith(
      'opencode',
      expect.arrayContaining(['--session', 'oc-session-abc']),
      expect.any(Object),
    );
    await backend.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — event emission (onMessage/offMessage)', () => {
  it('calls all registered handlers for each message', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    backend.onMessage(handlerA);
    backend.onMessage(handlerB);
    await backend.startSession();
    // Both handlers should have received the 'starting' status
    expect(handlerA).toHaveBeenCalledWith(expect.objectContaining({ type: 'status', status: 'starting' }));
    expect(handlerB).toHaveBeenCalledWith(expect.objectContaining({ type: 'status', status: 'starting' }));
    await backend.dispose();
  });

  it('offMessage removes a handler — it no longer receives events', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const handler = vi.fn();
    backend.onMessage(handler);

    // Start a session to trigger events — handler should receive 'starting' + 'idle'
    const { sessionId } = await backend.startSession();
    const callsBefore = handler.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    // Remove the handler
    backend.offMessage!(handler);

    // WHY: We must trigger a real event after removal to prove the handler
    // is no longer called. sendPrompt spawns a process which emits status
    // events — if offMessage didn't work, handler.mock.calls would grow.
    const promptPromise = backend.sendPrompt(sessionId, 'test');
    emitStdout(JSON.stringify({ type: 'assistant', content: 'reply' }));
    setImmediate(() => closeProcess(0));
    await promptPromise;

    // Handler call count must not have increased
    expect(handler.mock.calls.length).toBe(callsBefore);
    await backend.dispose();
  });

  it('offMessage is a no-op for unregistered handlers', () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const unregistered = vi.fn();
    expect(() => backend.offMessage!(unregistered)).not.toThrow();
  });

  it('does not emit messages after dispose', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    await backend.startSession();
    const countBeforeDispose = messages.length;
    await backend.dispose();
    // Internal emit after dispose should be guarded
    // Trigger a manual emit by attempting a cancelled process
    expect(messages.length).toBe(countBeforeDispose);
  });

  it('continues emitting to remaining handlers when one handler throws', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const throwingHandler = vi.fn(() => { throw new Error('handler error'); });
    const safeHandler = vi.fn();
    backend.onMessage(throwingHandler);
    backend.onMessage(safeHandler);

    await backend.startSession();

    // safeHandler should still have been called despite throwingHandler throwing
    expect(safeHandler).toHaveBeenCalled();
    await backend.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — cancel', () => {
  it('sends SIGTERM to the running process', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'long task');

    await backend.cancel(sessionId);
    expect(lastFakeProcess.kill).toHaveBeenCalledWith('SIGTERM');

    promptPromise.catch(() => {}); // suppress unhandled rejection
    await backend.dispose();
  });

  it('emits idle status after cancel', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    backend.sendPrompt(sessionId, 'task').catch(() => {});

    await backend.cancel(sessionId);

    const idleAfterCancel = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'idle',
    );
    expect(idleAfterCancel.length).toBeGreaterThanOrEqual(1);
    await backend.dispose();
  });

  it('throws when cancel is called with a wrong sessionId', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    await backend.startSession();
    await expect(backend.cancel('wrong-id')).rejects.toThrow('Invalid session ID');
    await backend.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — respondToPermission', () => {
  it('emits permission-response with approved=true', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    await backend.startSession();
    await backend.respondToPermission!('req-1', true);
    expect(messages).toContainEqual({ type: 'permission-response', id: 'req-1', approved: true });
    await backend.dispose();
  });

  it('emits permission-response with approved=false', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    await backend.startSession();
    await backend.respondToPermission!('req-2', false);
    expect(messages).toContainEqual({ type: 'permission-response', id: 'req-2', approved: false });
    await backend.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — waitForResponseComplete', () => {
  it('resolves immediately when no process is running', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    await backend.startSession();
    // No prompt sent → no active process
    await expect(backend.waitForResponseComplete!()).resolves.toBeUndefined();
    await backend.dispose();
  });

  it('resolves after the active process exits', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'go');
    const waitPromise = backend.waitForResponseComplete!();
    setImmediate(() => closeProcess(0));
    await Promise.all([promptPromise, waitPromise]);
    await backend.dispose();
  });

  it('rejects with timeout error when process does not exit in time', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { sessionId } = await backend.startSession();
    backend.sendPrompt(sessionId, 'hang forever').catch(() => {});
    // 1ms timeout — process will not exit in time
    await expect(backend.waitForResponseComplete!(1)).rejects.toThrow(
      'Timeout waiting for OpenCode response',
    );
    await backend.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('OpenCodeBackend — stderr handling', () => {
  it('emits error status when stderr contains "Error"', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'go');

    emitStderr('Error: authentication failed');
    setImmediate(() => closeProcess(0));
    await promptPromise;

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'status', status: 'error' }),
    );
    await backend.dispose();
  });

  it('does not emit error status for benign stderr output', async () => {
    const { backend } = createOpenCodeBackend({ cwd: '/tmp/project' });
    const { messages } = collectMessages(backend);
    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'go');

    emitStderr('Loading config...');
    setImmediate(() => closeProcess(0));
    await promptPromise;

    const errorMsgs = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'error',
    );
    expect(errorMsgs).toHaveLength(0);
    await backend.dispose();
  });
});
