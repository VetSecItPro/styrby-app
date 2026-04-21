/**
 * Tests for the Goose agent backend factory.
 *
 * Covers:
 * - `createGooseBackend` factory function
 * - `registerGooseAgent` registry integration
 * - `GooseBackend` class: session lifecycle, subprocess management,
 *   JSONL output parsing, cost/token extraction from MCP usage events,
 *   fs-edit detection from tool names, sub-agent event passthrough,
 *   error handling, cancellation, permission response, and disposal.
 *
 * All child_process and logger calls are mocked so no real Goose binary
 * is required.
 *
 * @module factories/__tests__/goose.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mocks — declared before the module under test is imported so Vitest's
// hoisting mechanism replaces the real modules in time.
// ---------------------------------------------------------------------------

/** Minimal mock of a readable/writable stdio stream */
function makeStream() {
  const emitter = new EventEmitter() as EventEmitter & { write?: ReturnType<typeof vi.fn> };
  emitter.write = vi.fn();
  return emitter;
}

/**
 * Factory for building a mock ChildProcess that the spawn mock returns.
 */
function makeMockProcess() {
  const proc = new EventEmitter() as ReturnType<typeof makeMockProcess>;
  proc.stdout = makeStream();
  proc.stderr = makeStream();
  proc.stdin = makeStream();
  proc.killed = false;
  proc.kill = vi.fn((_signal?: string) => {
    proc.killed = true;
    return true;
  });
  return proc;
}

type MockProcess = ReturnType<typeof makeMockProcess>;

// Mutable reference updated by tests that need to control the mock process
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
import { createGooseBackend, registerGooseAgent, type GooseBackendOptions } from '../goose';
import { agentRegistry } from '../../core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = spawn as unknown as MockInstance;

/** Collect all messages emitted by a backend into an array */
function collectMessages(backend: ReturnType<typeof createGooseBackend>['backend']) {
  const messages: unknown[] = [];
  backend.onMessage((msg) => messages.push(msg));
  return messages;
}

/**
 * Simulate a clean Goose process run: emit stdout, then emit close event.
 *
 * @param proc - The mock child process
 * @param stdoutLines - Lines of stdout to emit (each will be emitted as separate data events)
 * @param exitCode - Exit code for the close event (default: 0)
 */
function simulateProcess(proc: MockProcess, stdoutLines: string[] = [], exitCode = 0) {
  for (const line of stdoutLines) {
    (proc.stdout as EventEmitter).emit('data', Buffer.from(line + '\n'));
  }
  proc.emit('close', exitCode);
}

/** Build a valid Goose JSONL message event line */
function gooseMessage(content: string): string {
  return JSON.stringify({ type: 'message', content });
}

/** Build a Goose tool_call event line */
function gooseToolCall(tool: string, callId: string, input?: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_call', tool, call_id: callId, input });
}

/** Build a Goose tool_result event line */
function gooseToolResult(tool: string, callId: string, result: unknown, input?: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_result', tool, call_id: callId, result, input });
}

/** Build a Goose cost event line */
function gooseCost(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}): string {
  return JSON.stringify({ type: 'cost', usage });
}

/** Build a Goose error event line */
function gooseError(error: string): string {
  return JSON.stringify({ type: 'error', error });
}

/** Build a Goose status event line */
function gooseStatus(status: string): string {
  return JSON.stringify({ type: 'status', status });
}

/** Build a Goose finish event line */
function gooseFinish(): string {
  return JSON.stringify({ type: 'finish' });
}

/** Base options used across most tests */
const BASE_OPTIONS: GooseBackendOptions = {
  cwd: '/project',
};

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  currentMockProcess = makeMockProcess();
  mockSpawn.mockReturnValue(currentMockProcess);
  vi.clearAllMocks();
  // Re-apply return value after clearAllMocks
  mockSpawn.mockReturnValue(currentMockProcess);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// createGooseBackend — factory function
// ===========================================================================

/**
 * Tests for the `createGooseBackend` factory function.
 */
describe('createGooseBackend', () => {
  it('returns a backend instance and resolved model when model is provided', () => {
    const { backend, model } = createGooseBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('claude-sonnet-4');
  });

  it('returns undefined model when no model is specified', () => {
    const { model } = createGooseBackend(BASE_OPTIONS);

    expect(model).toBeUndefined();
  });

  it('returns a backend implementing the full AgentBackend interface', () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);

    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });

  it('does NOT spawn a process at creation time', () => {
    createGooseBackend(BASE_OPTIONS);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('passes cwd to the backend options', () => {
    const { backend } = createGooseBackend({ cwd: '/my/workspace' });

    expect(backend).toBeDefined();
    // sendPrompt will later pass cwd to spawn — verified in sendPrompt tests
  });
});

// ===========================================================================
// registerGooseAgent
// ===========================================================================

/**
 * Tests for `registerGooseAgent` — verifies registry integration.
 */
describe('registerGooseAgent', () => {
  it('registers "goose" in the global agent registry', () => {
    registerGooseAgent();

    expect(agentRegistry.has('goose')).toBe(true);
  });

  it('registry can create a backend after registration', () => {
    registerGooseAgent();

    const backend = agentRegistry.create('goose', { cwd: '/project' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
  });
});

// ===========================================================================
// GooseBackend — session lifecycle
// ===========================================================================

/**
 * Tests for session lifecycle: startSession, sendPrompt, dispose.
 */
describe('GooseBackend — session lifecycle', () => {
  it('startSession returns a sessionId string', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const result = await backend.startSession();

    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('startSession emits "starting" then "idle" when no initial prompt given', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    await backend.startSession();

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses).toContain('starting');
    expect(statuses).toContain('idle');
  });

  it('startSession with initial prompt spawns goose', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    const sessionPromise = backend.startSession('Fix the null reference bug');
    simulateProcess(currentMockProcess);
    await sessionPromise;

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses[0]).toBe('starting');
    expect(statuses[1]).toBe('running');
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('throws when startSession is called on a disposed backend', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('Backend has been disposed');
  });

  it('generates a unique sessionId for each backend instance', async () => {
    const { backend: b1 } = createGooseBackend(BASE_OPTIONS);
    const { backend: b2 } = createGooseBackend(BASE_OPTIONS);

    const { sessionId: id1 } = await b1.startSession();
    const { sessionId: id2 } = await b2.startSession();

    expect(id1).not.toBe(id2);
  });

  it('dispose kills an in-flight process', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // Override kill to also emit close so sendPrompt promise resolves
    currentMockProcess.kill = vi.fn((_signal?: string) => {
      currentMockProcess.killed = true;
      process.nextTick(() => currentMockProcess.emit('close', 1));
      return true;
    });

    const promptPromise = backend.sendPrompt(sessionId, 'hello').catch(() => {});
    await backend.dispose();

    expect(currentMockProcess.kill).toHaveBeenCalled();
    await promptPromise;
  });

  it('dispose clears all message listeners', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const handler = vi.fn();
    backend.onMessage(handler);

    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GooseBackend — sendPrompt & subprocess arguments
// ===========================================================================

/**
 * Tests for sendPrompt — verifies correct CLI arguments are passed to spawn.
 */
describe('GooseBackend — sendPrompt arguments', () => {
  it('spawns goose with "run", "--text", and "--format jsonl" flags', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Refactor auth module');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('goose');
    expect(args).toContain('run');
    expect(args).toContain('--text');
    expect(args).toContain('Refactor auth module');
    expect(args).toContain('--format');
    expect(args).toContain('jsonl');
  });

  it('includes --no-interactive flag by default', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--no-interactive');
  });

  it('omits --no-interactive flag when nonInteractive is explicitly false', async () => {
    const { backend } = createGooseBackend({ ...BASE_OPTIONS, nonInteractive: false });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--no-interactive');
  });

  it('includes --model flag when model option is set', async () => {
    const { backend } = createGooseBackend({ ...BASE_OPTIONS, model: 'claude-opus-4' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4');
  });

  it('does NOT include --model flag when model is omitted', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--model');
  });

  it('includes --provider flag when provider option is set', async () => {
    const { backend } = createGooseBackend({ ...BASE_OPTIONS, provider: 'anthropic' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--provider');
    expect(args).toContain('anthropic');
  });

  it('includes --name flag when sessionName option is set', async () => {
    const { backend } = createGooseBackend({ ...BASE_OPTIONS, sessionName: 'my-session' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--name');
    expect(args).toContain('my-session');
  });

  it('appends extraArgs to the spawn call', async () => {
    const { backend } = createGooseBackend({
      ...BASE_OPTIONS,
      extraArgs: ['--verbose', '--timeout', '60'],
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--verbose');
    expect(args).toContain('--timeout');
    expect(args).toContain('60');
  });

  it('sets ANTHROPIC_API_KEY, OPENAI_API_KEY, and GOOGLE_API_KEY when apiKey is provided', async () => {
    const { backend } = createGooseBackend({ ...BASE_OPTIONS, apiKey: 'sk-test-goose-key' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, , spawnOptions] = mockSpawn.mock.calls[0];
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBe('sk-test-goose-key');
    expect(spawnOptions.env.OPENAI_API_KEY).toBe('sk-test-goose-key');
    expect(spawnOptions.env.GOOGLE_API_KEY).toBe('sk-test-goose-key');
  });

  it('passes cwd to spawn options', async () => {
    const { backend } = createGooseBackend({ cwd: '/workspace/project' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, , spawnOptions] = mockSpawn.mock.calls[0];
    expect(spawnOptions.cwd).toBe('/workspace/project');
  });

  it('rejects when called with a mismatched sessionId', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.sendPrompt('wrong-session-id', 'hello')).rejects.toThrow(
      'Invalid session ID',
    );
  });

  it('rejects when called on a disposed backend', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    await backend.dispose();

    await expect(backend.sendPrompt(sessionId, 'hello')).rejects.toThrow(
      'Backend has been disposed',
    );
  });
});

// ===========================================================================
// GooseBackend — JSONL output parsing and event emission
// ===========================================================================

/**
 * Tests for JSONL parsing: message events, tool calls, tool results, fs-edits,
 * cost tracking, status events, and finish events.
 */
describe('GooseBackend — JSONL output parsing and event emission', () => {
  it('emits model-output message for type=message events', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [gooseMessage('Here is the fix.')]);
    await promptPromise;

    const outputs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputs.length).toBeGreaterThan(0);
    const text = outputs.map((m: any) => m.textDelta).join('');
    expect(text).toContain('Here is the fix.');
  });

  it('does not emit model-output when message content is absent', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [JSON.stringify({ type: 'message' })]);
    await promptPromise;

    const outputs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputs.length).toBe(0);
  });

  it('emits tool-call message for type=tool_call events', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseToolCall('list_files', 'call-1', { directory: '/src' }),
    ]);
    await promptPromise;

    const toolCalls = messages.filter((m: any) => m.type === 'tool-call');
    expect(toolCalls.length).toBe(1);
    const call = toolCalls[0] as any;
    expect(call.toolName).toBe('list_files');
    expect(call.callId).toBe('call-1');
    expect(call.args.directory).toBe('/src');
  });

  it('emits tool-result message for type=tool_result events', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseToolResult('read_file', 'call-2', 'file contents here', { path: 'src/main.ts' }),
    ]);
    await promptPromise;

    const toolResults = messages.filter((m: any) => m.type === 'tool-result');
    expect(toolResults.length).toBe(1);
    const result = toolResults[0] as any;
    expect(result.toolName).toBe('read_file');
    expect(result.callId).toBe('call-2');
  });

  it('emits fs-edit message when tool_result has a file-writing tool name', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseToolResult('write_file', 'call-3', 'ok', { path: 'src/auth.ts' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits.length).toBe(1);
    const edit = fsEdits[0] as any;
    expect(edit.path).toBe('src/auth.ts');
    expect(edit.description).toContain('write_file');
    expect(edit.description).toContain('src/auth.ts');
  });

  it('emits fs-edit for edit_file tool', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseToolResult('edit_file', 'call-4', 'ok', { file_path: 'lib/utils.ts' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits.length).toBe(1);
    expect((fsEdits[0] as any).path).toBe('lib/utils.ts');
  });

  it('does NOT emit fs-edit for non-file-writing tools', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseToolResult('run_bash', 'call-5', 'output', { command: 'ls' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits.length).toBe(0);
  });

  it('emits token-count message with accumulated values from cost events', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseCost({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
        cost_usd: 0.0042,
      }),
    ]);
    await promptPromise;

    const tokenMessages = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenMessages.length).toBe(1);
    const tm = tokenMessages[0] as any;
    expect(tm.inputTokens).toBe(100);
    expect(tm.outputTokens).toBe(50);
    expect(tm.cacheReadTokens).toBe(20);
    expect(tm.cacheWriteTokens).toBe(10);
    expect(tm.costUsd).toBeCloseTo(0.0042);
  });

  it('accumulates token usage across multiple cost events', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseCost({ input_tokens: 100, output_tokens: 50, cost_usd: 0.001 }),
      gooseCost({ input_tokens: 200, output_tokens: 80, cost_usd: 0.002 }),
    ]);
    await promptPromise;

    const tokenMessages = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenMessages.length).toBe(2);
    const last = tokenMessages[tokenMessages.length - 1] as any;
    expect(last.inputTokens).toBe(300);
    expect(last.outputTokens).toBe(130);
    expect(last.costUsd).toBeCloseTo(0.003);
  });

  it('emits error status for type=error events', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [gooseError('MCP server disconnected')]);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses.length).toBeGreaterThan(0);
    expect((errorStatuses[0] as any).detail).toContain('MCP server disconnected');
  });

  it('maps type=status events to corresponding AgentStatus values', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseStatus('running'),
      gooseStatus('complete'),
    ]);
    await promptPromise;

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses).toContain('running');
    expect(statuses).toContain('idle'); // 'complete' maps to 'idle'
  });

  it('emits idle status for type=finish events', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [gooseFinish()]);
    await promptPromise;

    const idleStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'idle'
    );
    expect(idleStatuses.length).toBeGreaterThan(0);
  });

  it('ignores non-JSON stdout lines without crashing', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      'Loading Goose...',
      '   ',
      gooseMessage('Done.'),
    ]);

    await expect(promptPromise).resolves.not.toThrow();
  });

  it('handles partial/malformed JSON lines without crashing', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      '{ incomplete json',
      gooseMessage('Still working.'),
    ]);

    await expect(promptPromise).resolves.not.toThrow();
  });

  it('handles stdout chunks split across lines (partial buffering)', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const fullLine = gooseMessage('Hello from Goose');
    const half1 = fullLine.slice(0, Math.floor(fullLine.length / 2));
    const half2 = fullLine.slice(Math.floor(fullLine.length / 2)) + '\n';

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half1));
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half2));
    currentMockProcess.emit('close', 0);
    await promptPromise;

    const outputs = messages.filter((m: any) => m.type === 'model-output');
    const text = outputs.map((m: any) => m.textDelta).join('');
    expect(text).toContain('Hello from Goose');
  });

  it('emits idle status after process exits cleanly', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [], 0);
    await promptPromise;

    const lastStatus = messages
      .filter((m: any) => m.type === 'status')
      .at(-1) as any;

    expect(lastStatus?.status).toBe('idle');
  });
});

// ===========================================================================
// GooseBackend — error handling
// ===========================================================================

/**
 * Tests for error conditions: non-zero exit codes, stderr errors, spawn failures.
 */
describe('GooseBackend — error handling', () => {
  it('rejects sendPrompt when goose exits with non-zero exit code', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [], 1);

    await expect(promptPromise).rejects.toThrow('Goose exited with code 1');
  });

  it('emits error status when goose exits with non-zero code', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello').catch(() => {});
    simulateProcess(currentMockProcess, [], 2);
    await promptPromise;

    const errorStatus = messages
      .filter((m: any) => m.type === 'status' && m.status === 'error')
      .at(-1) as any;

    expect(errorStatus).toBeDefined();
    expect(errorStatus.detail).toContain('code 2');
  });

  it('emits error status when stderr contains "Error"', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stderr as EventEmitter).emit(
      'data',
      Buffer.from('Error: MCP provider unreachable'),
    );
    simulateProcess(currentMockProcess, [], 0);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('emits error status when stderr contains "failed"', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stderr as EventEmitter).emit(
      'data',
      Buffer.from('Connection failed: timeout after 30s'),
    );
    simulateProcess(currentMockProcess, [], 0);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('rejects sendPrompt when the spawned process emits an "error" event', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    currentMockProcess.emit('error', new Error('ENOENT: goose not found'));

    await expect(promptPromise).rejects.toThrow('ENOENT: goose not found');
  });

  it('emits error status when process emits "error" event', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
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
// GooseBackend — cancel
// ===========================================================================

/**
 * Tests for the cancel method.
 */
describe('GooseBackend — cancel', () => {
  it('sends SIGTERM to the running process when cancel is called', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'long running task').catch(() => {});
    await backend.cancel(sessionId);

    expect(currentMockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('emits "idle" status after cancel', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
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
    const { backend } = createGooseBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.cancel('invalid-id')).rejects.toThrow('Invalid session ID');
  });

  it('does not throw when cancel is called with no active process', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    await expect(backend.cancel(sessionId)).resolves.not.toThrow();
  });
});

// ===========================================================================
// GooseBackend — onMessage / offMessage
// ===========================================================================

/**
 * Tests for the listener management API.
 */
describe('GooseBackend — onMessage / offMessage', () => {
  it('calls all registered handlers for each emitted message', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const h1 = vi.fn();
    const h2 = vi.fn();
    backend.onMessage(h1);
    backend.onMessage(h2);

    await backend.startSession(); // emits 'starting' + 'idle'

    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('stops calling a handler after offMessage is called', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const handler = vi.fn();
    backend.onMessage(handler);
    backend.offMessage(handler);

    await backend.startSession();

    expect(handler).not.toHaveBeenCalled();
  });

  it('handles errors thrown inside a listener without crashing the backend', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const badHandler = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const goodHandler = vi.fn();
    backend.onMessage(badHandler);
    backend.onMessage(goodHandler);

    await expect(backend.startSession()).resolves.toBeDefined();
    expect(goodHandler).toHaveBeenCalled();
  });
});

// ===========================================================================
// GooseBackend — respondToPermission
// ===========================================================================

/**
 * Tests for the `respondToPermission` method.
 */
describe('GooseBackend — respondToPermission', () => {
  it('emits a permission-response message with approved=true', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission('req-001', true);

    const permMsg = messages.find((m: any) => m.type === 'permission-response') as any;
    expect(permMsg).toBeDefined();
    expect(permMsg.id).toBe('req-001');
    expect(permMsg.approved).toBe(true);
  });

  it('emits a permission-response message with approved=false when denied', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission('req-002', false);

    const permMsg = messages.find((m: any) => m.type === 'permission-response') as any;
    expect(permMsg).toBeDefined();
    expect(permMsg.approved).toBe(false);
  });

  it('writes "y\\n" to stdin when approved=true and process is running', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // Start a prompt to get a running process
    backend.sendPrompt(sessionId, 'task').catch(() => {});

    await backend.respondToPermission('req-003', true);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('y\n');
  });

  it('writes "n\\n" to stdin when approved=false and process is running', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'task').catch(() => {});

    await backend.respondToPermission('req-004', false);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('n\n');
  });
});

// ===========================================================================
// GooseBackend — waitForResponseComplete
// ===========================================================================

/**
 * Tests for waitForResponseComplete.
 */
describe('GooseBackend — waitForResponseComplete', () => {
  it('resolves immediately when no process is active', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.waitForResponseComplete?.(1000)).resolves.toBeUndefined();
  });
});

// ===========================================================================
// GooseBackend — cost-report emission
// ===========================================================================

/**
 * Tests for the unified CostReport event added to Goose cost events.
 *
 * WHY: migration 022 columns require billing_model / source / raw_agent_payload.
 * When Goose provides cost_usd the source is 'agent-reported' with rawAgentPayload.
 * When cost_usd is absent, source falls back to 'styrby-estimate' and rawAgentPayload is null.
 */
describe('GooseBackend — cost-report emission', () => {
  it('emits cost-report with source=agent-reported when cost event has cost_usd', async () => {
    const { backend } = createGooseBackend({ ...BASE_OPTIONS, model: 'claude-opus-4' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseCost({
        input_tokens: 500,
        output_tokens: 200,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
        cost_usd: 0.0088,
      }),
    ]);
    await promptPromise;

    const reports = messages.filter((m: any) => m.type === 'cost-report');
    expect(reports.length).toBeGreaterThanOrEqual(1);
    const r = reports[0] as any;
    expect(r.report.billingModel).toBe('api-key');
    expect(r.report.source).toBe('agent-reported');
    expect(r.report.agentType).toBe('goose');
    expect(r.report.inputTokens).toBe(500);
    expect(r.report.outputTokens).toBe(200);
    expect(r.report.cacheReadTokens).toBe(30);
    expect(r.report.cacheWriteTokens).toBe(10);
    expect(r.report.rawAgentPayload).not.toBeNull();
  });

  it('emits cost-report with source=styrby-estimate and rawAgentPayload=null when cost_usd is absent', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      gooseCost({ input_tokens: 100, output_tokens: 40 }),
    ]);
    await promptPromise;

    const reports = messages.filter((m: any) => m.type === 'cost-report');
    expect(reports.length).toBeGreaterThanOrEqual(1);
    const r = reports[0] as any;
    expect(r.report.source).toBe('styrby-estimate');
    expect(r.report.rawAgentPayload).toBeNull();
  });

  it('cost-report billingModel is always api-key for Goose', async () => {
    const { backend } = createGooseBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [gooseCost({ cost_usd: 0.005 })]);
    await promptPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r.report.billingModel).toBe('api-key');
  });
});
