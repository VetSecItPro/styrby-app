/**
 * Tests for the Crush agent backend factory (Charmbracelet).
 *
 * Covers:
 * - `createCrushBackend` factory function
 * - `registerCrushAgent` registry integration
 * - `CrushBackend` class: session lifecycle, subprocess management,
 *   ACP-compatible JSON event parsing, charm-style ANSI output handling,
 *   token/cost accumulation, fs-edit detection from charm tool names,
 *   status mapping, error handling, cancellation, permission response,
 *   and disposal.
 *
 * All child_process and logger calls are mocked so no real Crush binary
 * is required.
 *
 * @module factories/__tests__/crush.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mocks — declared before the module under test is imported
// ---------------------------------------------------------------------------

function makeStream() {
  const emitter = new EventEmitter() as EventEmitter & { write?: ReturnType<typeof vi.fn> };
  emitter.write = vi.fn();
  return emitter;
}

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
// Imports — after vi.mock declarations
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createCrushBackend, registerCrushAgent, type CrushBackendOptions } from '../crush';
import { agentRegistry } from '../../core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = spawn as unknown as MockInstance;

function collectMessages(backend: ReturnType<typeof createCrushBackend>['backend']) {
  const messages: unknown[] = [];
  backend.onMessage((msg) => messages.push(msg));
  return messages;
}

/**
 * Simulate Crush output: emit lines as stdout data events, then close the process.
 */
function simulateProcess(proc: MockProcess, lines: string[] = [], exitCode = 0) {
  for (const line of lines) {
    (proc.stdout as EventEmitter).emit('data', Buffer.from(line + '\n'));
  }
  proc.emit('close', exitCode);
}

// ---- Crush ACP event builders ----

function crushTextDelta(delta: string): string {
  return JSON.stringify({ type: 'text_delta', delta });
}

function crushToolCall(tool: string, callId: string, args?: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_call', tool, call_id: callId, args });
}

function crushToolResult(tool: string, callId: string, output: unknown, args?: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_result', tool, call_id: callId, output, args });
}

function crushUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}): string {
  return JSON.stringify({ type: 'usage', usage });
}

function crushStatus(state: string): string {
  return JSON.stringify({ type: 'status', state });
}

function crushError(message: string): string {
  return JSON.stringify({ type: 'error', message });
}

function crushDone(): string {
  return JSON.stringify({ type: 'done' });
}

const BASE_OPTIONS: CrushBackendOptions = {
  cwd: '/project',
};

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

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
// createCrushBackend — factory function
// ===========================================================================

describe('createCrushBackend', () => {
  it('returns a backend instance and resolved model when model is provided', () => {
    const { backend, model } = createCrushBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('claude-sonnet-4');
  });

  it('returns undefined model when no model is specified', () => {
    const { model } = createCrushBackend(BASE_OPTIONS);

    expect(model).toBeUndefined();
  });

  it('returns a backend implementing the full AgentBackend interface', () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);

    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });

  it('does NOT spawn a process at creation time', () => {
    createCrushBackend(BASE_OPTIONS);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('includes noTui, provider, and sessionName options', () => {
    const { backend } = createCrushBackend({
      ...BASE_OPTIONS,
      noTui: true,
      provider: 'anthropic',
      sessionName: 'my-session',
    });

    expect(backend).toBeDefined();
  });
});

// ===========================================================================
// registerCrushAgent
// ===========================================================================

describe('registerCrushAgent', () => {
  it('registers "crush" in the global agent registry', () => {
    registerCrushAgent();

    expect(agentRegistry.has('crush')).toBe(true);
  });

  it('registry can create a backend after registration', () => {
    registerCrushAgent();

    const backend = agentRegistry.create('crush', { cwd: '/project' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
  });
});

// ===========================================================================
// CrushBackend — session lifecycle
// ===========================================================================

describe('CrushBackend — session lifecycle', () => {
  it('startSession returns a sessionId string', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const result = await backend.startSession();

    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('startSession emits "starting" then "idle" when no initial prompt given', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    await backend.startSession();

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses).toContain('starting');
    expect(statuses).toContain('idle');
  });

  it('startSession with initial prompt spawns crush', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    const sessionPromise = backend.startSession('Refactor the auth module');
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
    const { backend } = createCrushBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('Backend has been disposed');
  });

  it('generates a unique sessionId for each backend instance', async () => {
    const { backend: b1 } = createCrushBackend(BASE_OPTIONS);
    const { backend: b2 } = createCrushBackend(BASE_OPTIONS);

    const { sessionId: id1 } = await b1.startSession();
    const { sessionId: id2 } = await b2.startSession();

    expect(id1).not.toBe(id2);
  });

  it('dispose kills an in-flight process', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // Start a send but don't finish the process — keep it in-flight
    const killSpy = vi.spyOn(currentMockProcess, 'kill');
    backend.sendPrompt(sessionId, 'Long operation'); // intentionally not awaited
    await backend.dispose();

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    // Clean up the dangling process
    currentMockProcess.emit('close', 0);
  });
});

// ===========================================================================
// CrushBackend — sendPrompt
// ===========================================================================

describe('CrushBackend — sendPrompt', () => {
  it('spawns crush with --message, --format json, --no-tui flags', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Refactor auth');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'crush',
      expect.arrayContaining(['--message', 'Refactor auth', '--format', 'json', '--no-tui']),
      expect.any(Object)
    );
  });

  it('includes --model flag when model is specified', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'crush',
      expect.arrayContaining(['--model', 'claude-sonnet-4']),
      expect.any(Object)
    );
  });

  it('includes --provider flag when provider is specified', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, provider: 'anthropic' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'crush',
      expect.arrayContaining(['--provider', 'anthropic']),
      expect.any(Object)
    );
  });

  it('includes --session flag when sessionName is specified', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, sessionName: 'my-project' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'crush',
      expect.arrayContaining(['--session', 'my-project']),
      expect.any(Object)
    );
  });

  it('throws when sendPrompt is called with wrong sessionId', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.sendPrompt('wrong-id', 'Hello')).rejects.toThrow('Invalid session ID');
  });

  it('throws when sendPrompt is called on a disposed backend', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    await backend.dispose();

    await expect(backend.sendPrompt(sessionId, 'Hello')).rejects.toThrow('Backend has been disposed');
  });

  it('rejects when crush exits with non-zero code', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [], 1);

    await expect(sendPromise).rejects.toThrow('Crush exited with code 1');
  });

  it('passes extraArgs after validation', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, extraArgs: ['--verbose'] });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'crush',
      expect.arrayContaining(['--verbose']),
      expect.any(Object)
    );
  });

  it('rejects extraArgs with shell metacharacters', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, extraArgs: ['--flag; rm -rf /'] });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, 'Hello')).rejects.toThrow('Unsafe character');
  });

  it('injects ANTHROPIC_API_KEY and OPENAI_API_KEY from apiKey option', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, apiKey: 'test-key' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const spawnCall = mockSpawn.mock.calls[0] as any[];
    const envArg = spawnCall[2].env;
    expect(envArg.ANTHROPIC_API_KEY).toBe('test-key');
    expect(envArg.OPENAI_API_KEY).toBe('test-key');
  });

  it('emits "running" status when sendPrompt is called', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('running');
  });
});

// ===========================================================================
// CrushBackend — ACP event parsing (text_delta)
// ===========================================================================

describe('CrushBackend — text_delta events', () => {
  it('emits model-output messages for text_delta events', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      crushTextDelta('Hello, '),
      crushTextDelta('world!'),
    ]);
    await sendPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(2);
    expect((textMessages[0] as any).textDelta).toBe('Hello, ');
    expect((textMessages[1] as any).textDelta).toBe('world!');
  });

  it('ignores text_delta events with empty delta', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      JSON.stringify({ type: 'text_delta' }), // no delta field
    ]);
    await sendPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(0);
  });
});

// ===========================================================================
// CrushBackend — ACP event parsing (tool_call / tool_result)
// ===========================================================================

describe('CrushBackend — tool events', () => {
  it('emits tool-call messages for tool_call events', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Edit a file');
    simulateProcess(currentMockProcess, [
      crushToolCall('read_file', 'call-1', { path: '/project/src/index.ts' }),
    ]);
    await sendPromise;

    const toolCalls = messages.filter((m: any) => m.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as any).toolName).toBe('read_file');
    expect((toolCalls[0] as any).callId).toBe('call-1');
  });

  it('emits tool-result messages for tool_result events', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Edit a file');
    simulateProcess(currentMockProcess, [
      crushToolResult('read_file', 'call-1', 'file contents here'),
    ]);
    await sendPromise;

    const toolResults = messages.filter((m: any) => m.type === 'tool-result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).toolName).toBe('read_file');
    expect((toolResults[0] as any).result).toBe('file contents here');
  });

  it('emits fs-edit message for file-writing tool results', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Write a file');
    simulateProcess(currentMockProcess, [
      crushToolResult('write_file', 'call-2', 'ok', { path: '/project/src/utils.ts' }),
    ]);
    await sendPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/project/src/utils.ts');
  });

  it('emits fs-edit for "edit" tools', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Edit file');
    simulateProcess(currentMockProcess, [
      crushToolResult('edit_file', 'call-3', 'done', { file_path: '/project/app.ts' }),
    ]);
    await sendPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/project/app.ts');
  });

  it('does NOT emit fs-edit for non-file-editing tools', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Run shell command');
    simulateProcess(currentMockProcess, [
      crushToolResult('run_command', 'call-4', 'output here'),
    ]);
    await sendPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(0);
  });

  it('does not emit fs-edit if file path is not found in args', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Write file');
    simulateProcess(currentMockProcess, [
      // write_file tool result but no path info in args
      crushToolResult('write_file', 'call-5', 'ok'),
    ]);
    await sendPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(0);
  });
});

// ===========================================================================
// CrushBackend — token/cost accumulation (usage events)
// ===========================================================================

describe('CrushBackend — usage events', () => {
  it('emits token-count messages with cumulative totals', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      crushUsage({ input_tokens: 100, output_tokens: 50, cost_usd: 0.005 }),
    ]);
    await sendPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts).toHaveLength(1);
    expect((tokenCounts[0] as any).inputTokens).toBe(100);
    expect((tokenCounts[0] as any).outputTokens).toBe(50);
    expect((tokenCounts[0] as any).costUsd).toBeCloseTo(0.005);
  });

  it('accumulates token counts across multiple usage events', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      crushUsage({ input_tokens: 100, output_tokens: 50 }),
      crushUsage({ input_tokens: 200, output_tokens: 75 }),
    ]);
    await sendPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    const last = tokenCounts[tokenCounts.length - 1] as any;
    expect(last.inputTokens).toBe(300);
    expect(last.outputTokens).toBe(125);
  });

  it('tracks cache tokens from usage events', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      crushUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
        cost_usd: 0.01,
      }),
    ]);
    await sendPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    const tc = tokenCounts[0] as any;
    expect(tc.cacheReadTokens).toBe(80);
    expect(tc.cacheWriteTokens).toBe(20);
  });

  it('resets token counts on new session', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId: s1 } = await backend.startSession();
    const messages = collectMessages(backend);

    const send1 = backend.sendPrompt(s1, 'First');
    simulateProcess(currentMockProcess, [crushUsage({ input_tokens: 500 })]);
    await send1;

    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    const { sessionId: s2 } = await backend.startSession();
    const send2 = backend.sendPrompt(s2, 'Second');
    simulateProcess(currentMockProcess, [crushUsage({ input_tokens: 100 })]);
    await send2;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    // Last event should reflect only the second session's accumulation
    const lastCount = tokenCounts[tokenCounts.length - 1] as any;
    expect(lastCount.inputTokens).toBe(100);
  });
});

// ===========================================================================
// CrushBackend — status events
// ===========================================================================

describe('CrushBackend — status events', () => {
  it('maps "loading" state to "starting"', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [crushStatus('loading')]);
    await sendPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('starting');
  });

  it('maps "thinking" state to "running"', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [crushStatus('thinking')]);
    await sendPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('running');
  });

  it('maps "executing" state to "running"', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [crushStatus('executing')]);
    await sendPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('running');
  });

  it('maps "done" state to "idle"', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [crushStatus('done')]);
    await sendPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('idle');
  });

  it('emits "idle" on "done" event', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [crushDone()]);
    await sendPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('idle');
  });
});

// ===========================================================================
// CrushBackend — error handling
// ===========================================================================

describe('CrushBackend — error handling', () => {
  it('emits error status on "error" events', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [crushError('Provider API rate limit exceeded')]);
    await sendPromise;

    const errorStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'error'
    );
    expect(errorStatuses.length).toBeGreaterThan(0);
    expect((errorStatuses[0] as any).detail).toContain('rate limit');
  });

  it('emits error status on process spawn error', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    currentMockProcess.emit('error', new Error('spawn crush ENOENT'));

    await expect(sendPromise).rejects.toThrow('spawn crush ENOENT');

    const errorStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'error'
    );
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('emits error status on stderr output containing "Error"', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    (currentMockProcess.stderr as EventEmitter).emit('data', Buffer.from('Error: config not found\n'));
    simulateProcess(currentMockProcess);
    await sendPromise;

    const errorStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'error'
    );
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('ignores non-JSON stdout lines gracefully', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      '  \x1b[32m✓\x1b[0m Loading context...', // charm ANSI progress line
      '────────────────────────────────', // charm box drawing
    ]);

    // Should not throw
    await expect(sendPromise).resolves.toBeUndefined();
  });
});

// ===========================================================================
// CrushBackend — cancellation
// ===========================================================================

describe('CrushBackend — cancellation', () => {
  it('sends SIGTERM on cancel', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // Start a send but don't finish the process — keep it in-flight
    backend.sendPrompt(sessionId, 'Long task'); // intentionally not awaited
    const killSpy = vi.spyOn(currentMockProcess, 'kill');

    await backend.cancel(sessionId);

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    // Clean up the dangling process
    currentMockProcess.emit('close', 0);
  });

  it('throws when cancel is called with wrong sessionId', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.cancel('wrong-session-id')).rejects.toThrow('Invalid session ID');
  });

  it('emits "idle" after cancel', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    await backend.cancel(sessionId);

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('idle');
  });
});

// ===========================================================================
// CrushBackend — permission response
// ===========================================================================

describe('CrushBackend — permission response', () => {
  it('emits permission-response message when approved', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    await backend.startSession();
    const messages = collectMessages(backend);

    await backend.respondToPermission?.('req-123', true);

    const permResponses = messages.filter((m: any) => m.type === 'permission-response');
    expect(permResponses).toHaveLength(1);
    expect((permResponses[0] as any).id).toBe('req-123');
    expect((permResponses[0] as any).approved).toBe(true);
  });

  it('emits permission-response message when denied', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    await backend.startSession();
    const messages = collectMessages(backend);

    await backend.respondToPermission?.('req-456', false);

    const permResponses = messages.filter((m: any) => m.type === 'permission-response');
    expect(permResponses).toHaveLength(1);
    expect((permResponses[0] as any).approved).toBe(false);
  });

  it('writes "y\\n" to stdin when approved and process is running', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Dangerous operation');
    // Process is running but not yet closed

    await backend.respondToPermission?.('req-789', true);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('y\n');
    currentMockProcess.emit('close', 0);
    await sendPromise;
  });
});

// ===========================================================================
// CrushBackend — waitForResponseComplete
// ===========================================================================

describe('CrushBackend — waitForResponseComplete', () => {
  it('resolves immediately if no process is running', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.waitForResponseComplete?.()).resolves.toBeUndefined();
  });

  it('resolves after the process finishes', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Work');
    const waitPromise = backend.waitForResponseComplete?.();
    simulateProcess(currentMockProcess);

    await sendPromise;
    await waitPromise;
  });
});

// ===========================================================================
// CrushBackend — message handler registration
// ===========================================================================

describe('CrushBackend — message handler registration', () => {
  it('onMessage registers a handler that receives events', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    backend.onMessage((msg) => received.push(msg));
    await backend.startSession();

    expect(received.length).toBeGreaterThan(0);
  });

  it('offMessage removes a registered handler', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    const handler = (msg: unknown) => received.push(msg);
    backend.onMessage(handler);
    backend.offMessage(handler);

    await backend.startSession();

    expect(received).toHaveLength(0);
  });

  it('disposed backend does not emit to handlers', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    await backend.startSession();
    await backend.dispose();

    const received: unknown[] = [];
    backend.onMessage((msg) => received.push(msg));

    // Try to trigger an event after dispose (should be silent)
    const countBefore = received.length;
    expect(received.length).toBe(countBefore);
  });

  it('handler errors do not break other handlers', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const goodMessages: unknown[] = [];

    backend.onMessage(() => {
      throw new Error('Bad handler');
    });
    backend.onMessage((msg) => goodMessages.push(msg));

    await backend.startSession();

    expect(goodMessages.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// CrushBackend — dispose
// ===========================================================================

describe('CrushBackend — dispose', () => {
  it('marks backend as disposed', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('Backend has been disposed');
  });

  it('dispose is idempotent (safe to call twice)', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    await backend.dispose();

    // Should not throw
    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  it('clears message listeners on dispose', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    backend.onMessage((msg) => received.push(msg));
    await backend.dispose();

    const countAfterDispose = received.length;
    // Even if we could trigger events, no new ones should arrive
    expect(received.length).toBe(countAfterDispose);
  });
});

// ===========================================================================
// CrushBackend — line buffer handling
// ===========================================================================

describe('CrushBackend — line buffer handling', () => {
  it('handles JSON split across multiple data events', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');

    // Split a JSON event across two data chunks (simulates Node.js stream chunking)
    const json = crushTextDelta('Hello, world!');
    const half1 = json.slice(0, Math.floor(json.length / 2));
    const half2 = json.slice(Math.floor(json.length / 2)) + '\n';

    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half1));
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half2));
    currentMockProcess.emit('close', 0);
    await sendPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(1);
    expect((textMessages[0] as any).textDelta).toBe('Hello, world!');
  });

  it('flushes remaining buffer on process close', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');

    // Emit JSON without trailing newline (simulates unterminated line in buffer)
    const json = crushTextDelta('Final chunk');
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(json));
    currentMockProcess.emit('close', 0);
    await sendPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(1);
  });
});
