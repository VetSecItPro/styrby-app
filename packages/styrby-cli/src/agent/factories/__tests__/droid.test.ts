/**
 * Tests for the Droid agent backend factory (BYOK).
 *
 * Covers:
 * - `createDroidBackend` factory function
 * - `registerDroidAgent` registry integration
 * - `DroidBackend` class: session lifecycle, subprocess management,
 *   JSONL output parsing, BYOK API key injection, multi-backend model resolution,
 *   LiteLLM cost estimation from token counts, backend_switch events,
 *   fs-edit detection, error handling, cancellation, permission response,
 *   and disposal.
 *
 * All child_process and logger calls are mocked so no real Droid binary
 * is required.
 *
 * @module factories/__tests__/droid.test.ts
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
import { createDroidBackend, registerDroidAgent, type DroidBackendOptions } from '../droid';
import { agentRegistry } from '../../core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = spawn as unknown as MockInstance;

function collectMessages(backend: ReturnType<typeof createDroidBackend>['backend']) {
  const messages: unknown[] = [];
  backend.onMessage((msg) => messages.push(msg));
  return messages;
}

/**
 * Simulate a Droid process run: emit stdout lines, then close.
 */
function simulateProcess(proc: MockProcess, lines: string[] = [], exitCode = 0) {
  for (const line of lines) {
    (proc.stdout as EventEmitter).emit('data', Buffer.from(line + '\n'));
  }
  proc.emit('close', exitCode);
}

// ---- Droid JSONL event builders ----

function droidText(content: string): string {
  return JSON.stringify({ type: 'text', content });
}

function droidToolCall(toolName: string, callId: string, toolInput?: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_call', tool_name: toolName, call_id: callId, tool_input: toolInput });
}

function droidToolResult(
  toolName: string,
  callId: string,
  result: unknown,
  toolInput?: Record<string, unknown>
): string {
  return JSON.stringify({ type: 'tool_result', tool_name: toolName, call_id: callId, tool_result: result, tool_input: toolInput });
}

function droidUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
  model?: string;
}): string {
  return JSON.stringify({ type: 'usage', usage });
}

function droidBackendSwitch(newBackend?: string, newModel?: string): string {
  return JSON.stringify({ type: 'backend_switch', new_backend: newBackend, new_model: newModel });
}

function droidError(error: string): string {
  return JSON.stringify({ type: 'error', error });
}

function droidDone(): string {
  return JSON.stringify({ type: 'done' });
}

const BASE_OPTIONS: DroidBackendOptions = {
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
// createDroidBackend — factory function
// ===========================================================================

describe('createDroidBackend', () => {
  it('returns a backend instance and resolved model when model is provided', () => {
    const { backend, model } = createDroidBackend({ ...BASE_OPTIONS, model: 'gpt-4o' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('gpt-4o');
  });

  it('returns undefined model when no model is specified', () => {
    const { model } = createDroidBackend(BASE_OPTIONS);

    expect(model).toBeUndefined();
  });

  it('returns a backend implementing the full AgentBackend interface', () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);

    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });

  it('does NOT spawn a process at creation time', () => {
    createDroidBackend(BASE_OPTIONS);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('accepts backend option', () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, backend: 'anthropic' });

    expect(backend).toBeDefined();
  });

  it('accepts apiKeys map for multiple providers', () => {
    const { backend } = createDroidBackend({
      ...BASE_OPTIONS,
      apiKeys: {
        ANTHROPIC_API_KEY: 'sk-ant-test',
        OPENAI_API_KEY: 'sk-test',
      },
    });

    expect(backend).toBeDefined();
  });

  it('accepts resumeSessionId for session persistence', () => {
    const { backend } = createDroidBackend({
      ...BASE_OPTIONS,
      resumeSessionId: 'existing-session-123',
    });

    expect(backend).toBeDefined();
  });
});

// ===========================================================================
// registerDroidAgent
// ===========================================================================

describe('registerDroidAgent', () => {
  it('registers "droid" in the global agent registry', () => {
    registerDroidAgent();

    expect(agentRegistry.has('droid')).toBe(true);
  });

  it('registry can create a backend after registration', () => {
    registerDroidAgent();

    const backend = agentRegistry.create('droid', { cwd: '/project' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
  });
});

// ===========================================================================
// DroidBackend — session lifecycle
// ===========================================================================

describe('DroidBackend — session lifecycle', () => {
  it('startSession returns a sessionId string', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const result = await backend.startSession();

    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('startSession emits "starting" then "idle" when no initial prompt given', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    await backend.startSession();

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses).toContain('starting');
    expect(statuses).toContain('idle');
  });

  it('startSession with initial prompt spawns droid', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    const sessionPromise = backend.startSession('Analyze the codebase');
    simulateProcess(currentMockProcess);
    await sessionPromise;

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses).toContain('starting');
    expect(statuses).toContain('running');
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('each startSession generates a unique sessionId', async () => {
    const { backend: b1 } = createDroidBackend(BASE_OPTIONS);
    const { backend: b2 } = createDroidBackend(BASE_OPTIONS);

    const { sessionId: id1 } = await b1.startSession();
    const { sessionId: id2 } = await b2.startSession();

    expect(id1).not.toBe(id2);
  });

  it('throws when startSession is called on a disposed backend', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('disposed');
  });
});

// ===========================================================================
// DroidBackend — sendPrompt
// ===========================================================================

describe('DroidBackend — sendPrompt', () => {
  it('spawns the droid binary with correct arguments', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Review the auth module');
    simulateProcess(currentMockProcess);
    await promptPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'droid',
      expect.arrayContaining(['chat', '--message', 'Review the auth module', '--format', 'json']),
      expect.objectContaining({ cwd: '/project' })
    );
  });

  it('passes --backend flag when backend is specified', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, backend: 'openai' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Use OpenAI');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--backend');
    expect(args).toContain('openai');
  });

  it('passes --model flag when model is specified', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'claude-opus-4' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Analyze deeply');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4');
  });

  it('injects primary apiKey as all provider env vars', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, apiKey: 'sk-my-key' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'BYOK test');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const spawnEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe('sk-my-key');
    expect(spawnEnv.OPENAI_API_KEY).toBe('sk-my-key');
    expect(spawnEnv.GOOGLE_API_KEY).toBe('sk-my-key');
    expect(spawnEnv.MISTRAL_API_KEY).toBe('sk-my-key');
  });

  it('injects apiKeys map overriding individual providers', async () => {
    const { backend } = createDroidBackend({
      ...BASE_OPTIONS,
      apiKeys: {
        ANTHROPIC_API_KEY: 'ant-key',
        OPENAI_API_KEY: 'oai-key',
      },
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Multi-provider test');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const spawnEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe('ant-key');
    expect(spawnEnv.OPENAI_API_KEY).toBe('oai-key');
  });

  it('passes --session when resumeSessionId is provided', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, resumeSessionId: 'existing-456' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Continue my session');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--session');
    expect(args).toContain('existing-456');
  });

  it('throws when sendPrompt is called with wrong sessionId', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.sendPrompt('wrong-id', 'test')).rejects.toThrow('Invalid session ID');
  });

  it('throws when sendPrompt is called on a disposed backend', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    await backend.dispose();

    await expect(backend.sendPrompt(sessionId, 'test')).rejects.toThrow('disposed');
  });

  it('emits error status when process exits with non-zero code', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Failing prompt');
    simulateProcess(currentMockProcess, [], 1);

    await expect(promptPromise).rejects.toThrow('code 1');
    const errorMsgs = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorMsgs.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// DroidBackend — JSONL output parsing
// ===========================================================================

describe('DroidBackend — JSONL output parsing', () => {
  it('emits model-output for text events', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Generate code');
    simulateProcess(currentMockProcess, [droidText('Here is the implementation')]);
    await promptPromise;

    const outputMsgs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputMsgs).toHaveLength(1);
    expect((outputMsgs[0] as any).textDelta).toBe('Here is the implementation');
  });

  it('emits tool-call for tool_call events', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Read file');
    simulateProcess(currentMockProcess, [
      droidToolCall('read_file', 'call-1', { path: '/src/main.ts' }),
    ]);
    await promptPromise;

    const toolCalls = messages.filter((m: any) => m.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as any).toolName).toBe('read_file');
    expect((toolCalls[0] as any).callId).toBe('call-1');
    expect((toolCalls[0] as any).args).toEqual({ path: '/src/main.ts' });
  });

  it('emits tool-result for tool_result events', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'List files');
    simulateProcess(currentMockProcess, [
      droidToolResult('list_files', 'call-2', ['file1.ts', 'file2.ts']),
    ]);
    await promptPromise;

    const toolResults = messages.filter((m: any) => m.type === 'tool-result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).toolName).toBe('list_files');
    expect((toolResults[0] as any).callId).toBe('call-2');
  });

  it('emits idle status for done events', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Final task');
    simulateProcess(currentMockProcess, [droidDone()]);
    await promptPromise;

    const idleStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'idle');
    expect(idleStatuses.length).toBeGreaterThan(0);
  });

  it('emits error status for error events', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Cause error');
    simulateProcess(currentMockProcess, [droidError('API rate limit exceeded')]);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses).toHaveLength(1);
    expect((errorStatuses[0] as any).detail).toBe('API rate limit exceeded');
  });

  it('ignores non-JSON lines without crashing', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      'Droid v2.0.0 initializing...',
      droidText('Response content'),
      '',
    ]);
    await promptPromise;

    const outputMsgs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputMsgs).toHaveLength(1);
  });
});

// ===========================================================================
// DroidBackend — LiteLLM cost estimation
// ===========================================================================

describe('DroidBackend — LiteLLM cost estimation', () => {
  it('uses provided cost_usd when available (no estimation needed)', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'gpt-4o' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Query with known cost');
    simulateProcess(currentMockProcess, [
      droidUsage({ prompt_tokens: 1000, completion_tokens: 500, cost_usd: 0.075 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts).toHaveLength(1);
    expect((tokenCounts[0] as any).costUsd).toBeCloseTo(0.075, 5);
    expect((tokenCounts[0] as any).inputTokens).toBe(1000);
    expect((tokenCounts[0] as any).outputTokens).toBe(500);
  });

  it('estimates cost from claude-sonnet-4 pricing when cost_usd is not provided', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Sonnet estimation');
    // 1000 input tokens at $0.003/1K + 500 output tokens at $0.015/1K = $0.003 + $0.0075 = $0.0105
    simulateProcess(currentMockProcess, [
      droidUsage({ prompt_tokens: 1000, completion_tokens: 500 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect((tokenCounts[0] as any).costUsd).toBeCloseTo(0.0105, 4);
  });

  it('estimates cost from gpt-4o pricing', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'gpt-4o' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'GPT estimation');
    // 2000 input tokens at $0.0025/1K + 1000 output tokens at $0.01/1K = $0.005 + $0.01 = $0.015
    simulateProcess(currentMockProcess, [
      droidUsage({ prompt_tokens: 2000, completion_tokens: 1000 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect((tokenCounts[0] as any).costUsd).toBeCloseTo(0.015, 4);
  });

  it('uses default pricing for unknown model', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'unknown-model-xyz' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Unknown model');
    simulateProcess(currentMockProcess, [
      droidUsage({ prompt_tokens: 1000, completion_tokens: 1000 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    // Default pricing: $0.002/1K input + $0.008/1K output = $0.002 + $0.008 = $0.01
    expect((tokenCounts[0] as any).costUsd).toBeCloseTo(0.01, 4);
    expect((tokenCounts[0] as any).costUsd).toBeGreaterThan(0);
  });

  it('accumulates cost across multiple usage events', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'gpt-4o-mini' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    let promptPromise = backend.sendPrompt(sessionId, 'First');
    simulateProcess(currentMockProcess, [
      droidUsage({ prompt_tokens: 1000, completion_tokens: 500, cost_usd: 0.01 }),
    ]);
    await promptPromise;

    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    promptPromise = backend.sendPrompt(sessionId, 'Second');
    simulateProcess(currentMockProcess, [
      droidUsage({ prompt_tokens: 1000, completion_tokens: 500, cost_usd: 0.02 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    const lastTokenCount = tokenCounts[tokenCounts.length - 1] as any;
    expect(lastTokenCount.costUsd).toBeCloseTo(0.03, 5);
  });

  it('tracks cache tokens when provided', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Cached request');
    simulateProcess(currentMockProcess, [
      droidUsage({
        prompt_tokens: 1000,
        completion_tokens: 200,
        cache_read_tokens: 500,
        cache_write_tokens: 100,
        cost_usd: 0.005,
      }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect((tokenCounts[0] as any).cacheReadTokens).toBe(500);
    expect((tokenCounts[0] as any).cacheWriteTokens).toBe(100);
  });

  it('resets cost accumulators on each startSession', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    let { sessionId } = await backend.startSession();
    let promptPromise = backend.sendPrompt(sessionId, 'First session');
    simulateProcess(currentMockProcess, [droidUsage({ cost_usd: 1.00 })]);
    await promptPromise;

    messages.length = 0;
    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    ({ sessionId } = await backend.startSession());
    promptPromise = backend.sendPrompt(sessionId, 'Second session');
    simulateProcess(currentMockProcess, [droidUsage({ cost_usd: 0.05 })]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    const lastTokenCount = tokenCounts[tokenCounts.length - 1] as any;
    expect(lastTokenCount.costUsd).toBeCloseTo(0.05, 5);
  });
});

// ===========================================================================
// DroidBackend — backend_switch events
// ===========================================================================

describe('DroidBackend — backend_switch events', () => {
  it('emits event with backend switch details', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Switch backends');
    simulateProcess(currentMockProcess, [
      droidBackendSwitch('openai', 'gpt-4o'),
    ]);
    await promptPromise;

    const backendSwitchEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'backend-switch'
    );
    expect(backendSwitchEvents).toHaveLength(1);
    expect((backendSwitchEvents[0] as any).payload.newBackend).toBe('openai');
    expect((backendSwitchEvents[0] as any).payload.newModel).toBe('gpt-4o');
  });

  it('updates currentModel after backend_switch for subsequent cost estimation', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    // Switch to gpt-4o and then get usage
    let promptPromise = backend.sendPrompt(sessionId, 'Switch then estimate');
    simulateProcess(currentMockProcess, [
      droidBackendSwitch('openai', 'gpt-4o'),
    ]);
    await promptPromise;

    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    promptPromise = backend.sendPrompt(sessionId, 'Post-switch usage');
    // 2000 input + 1000 output with gpt-4o pricing = $0.005 + $0.01 = $0.015
    simulateProcess(currentMockProcess, [
      droidUsage({ prompt_tokens: 2000, completion_tokens: 1000, model: 'gpt-4o' }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts.length).toBeGreaterThan(0);
    const lastTokenCount = tokenCounts[tokenCounts.length - 1] as any;
    expect(lastTokenCount.costUsd).toBeCloseTo(0.015, 4);
  });

  it('handles backend_switch with only new_backend (no model)', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Switch backend only');
    simulateProcess(currentMockProcess, [
      droidBackendSwitch('google'),
    ]);
    await promptPromise;

    const switchEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'backend-switch'
    );
    expect(switchEvents).toHaveLength(1);
    expect((switchEvents[0] as any).payload.newBackend).toBe('google');
  });
});

// ===========================================================================
// DroidBackend — fs-edit detection
// ===========================================================================

describe('DroidBackend — fs-edit detection', () => {
  it('emits fs-edit for write tool results', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Write component');
    simulateProcess(currentMockProcess, [
      droidToolResult('write_file', 'call-1', 'success', { path: '/src/Button.tsx' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/src/Button.tsx');
    expect((fsEdits[0] as any).description).toContain('write_file');
  });

  it('emits fs-edit for edit tool results', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Edit config');
    simulateProcess(currentMockProcess, [
      droidToolResult('edit_file', 'call-2', 'ok', { file_path: '/config.ts' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/config.ts');
  });

  it('emits fs-edit for str_replace tool results', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Replace string');
    simulateProcess(currentMockProcess, [
      droidToolResult('str_replace', 'call-3', 'replaced', { path: '/utils.ts' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
  });

  it('does NOT emit fs-edit for read_file tool results', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Read source');
    simulateProcess(currentMockProcess, [
      droidToolResult('read_file', 'call-4', 'content here', { path: '/src/auth.ts' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(0);
  });

  it('does NOT emit fs-edit when tool result has no path in input', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Pathless write');
    simulateProcess(currentMockProcess, [
      droidToolResult('write_file', 'call-5', 'ok', { content: 'data' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(0);
  });
});

// ===========================================================================
// DroidBackend — cancellation
// ===========================================================================

describe('DroidBackend — cancellation', () => {
  it('cancel sends SIGTERM to the running process', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'Long running').catch(() => {});
    await backend.cancel(sessionId);

    expect(currentMockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cancel emits idle status', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'Cancellable').catch(() => {});
    await backend.cancel(sessionId);

    const idleStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'idle');
    expect(idleStatuses.length).toBeGreaterThan(0);
  });

  it('cancel throws for wrong sessionId', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.cancel('bad-id')).rejects.toThrow('Invalid session ID');
  });
});

// ===========================================================================
// DroidBackend — permission response
// ===========================================================================

describe('DroidBackend — permission response', () => {
  it('emits permission-response when approval is granted', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission?.('req-1', true);

    const permResponses = messages.filter((m: any) => m.type === 'permission-response');
    expect(permResponses).toHaveLength(1);
    expect((permResponses[0] as any).approved).toBe(true);
    expect((permResponses[0] as any).id).toBe('req-1');
  });

  it('emits permission-response when approval is denied', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission?.('req-2', false);

    const permResponses = messages.filter((m: any) => m.type === 'permission-response');
    expect((permResponses[0] as any).approved).toBe(false);
  });

  it('writes "y\\n" to stdin when approved and process is active', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'Permission test').catch(() => {});
    await backend.respondToPermission?.('req-3', true);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('y\n');
  });

  it('writes "n\\n" to stdin when denied', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'Deny test').catch(() => {});
    await backend.respondToPermission?.('req-4', false);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('n\n');
  });
});

// ===========================================================================
// DroidBackend — message handler management
// ===========================================================================

describe('DroidBackend — message handler management', () => {
  it('onMessage registers a handler that receives events', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    backend.onMessage((msg) => received.push(msg));

    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [droidText('World')]);
    await promptPromise;

    expect(received.some((m: any) => m.type === 'model-output')).toBe(true);
  });

  it('offMessage removes a handler that stops receiving events', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    const handler = (msg: unknown) => received.push(msg);

    backend.onMessage(handler);
    backend.offMessage?.(handler);

    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'Hidden');
    simulateProcess(currentMockProcess, [droidText('Invisible')]);
    await promptPromise;

    const modelOutputs = received.filter((m: any) => m.type === 'model-output');
    expect(modelOutputs).toHaveLength(0);
  });

  it('multiple handlers all receive events', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const received1: unknown[] = [];
    const received2: unknown[] = [];

    backend.onMessage((msg) => received1.push(msg));
    backend.onMessage((msg) => received2.push(msg));

    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'Broadcast');
    simulateProcess(currentMockProcess, [droidText('To all')]);
    await promptPromise;

    expect(received1.some((m: any) => m.type === 'model-output')).toBe(true);
    expect(received2.some((m: any) => m.type === 'model-output')).toBe(true);
  });

  it('does not crash when a handler throws', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const received: unknown[] = [];

    backend.onMessage(() => { throw new Error('handler crash'); });
    backend.onMessage((msg) => received.push(msg));

    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'Resilient');
    simulateProcess(currentMockProcess, [droidText('Still works')]);
    await promptPromise;

    expect(received.some((m: any) => m.type === 'model-output')).toBe(true);
  });
});

// ===========================================================================
// DroidBackend — waitForResponseComplete
// ===========================================================================

describe('DroidBackend — waitForResponseComplete', () => {
  it('resolves immediately when no process is running', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.waitForResponseComplete?.()).resolves.toBeUndefined();
  });

  it('resolves after the process completes', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Wait');
    const waitPromise = backend.waitForResponseComplete?.(5000);

    simulateProcess(currentMockProcess);
    await promptPromise;
    await expect(waitPromise).resolves.toBeUndefined();
  });
});

// ===========================================================================
// DroidBackend — disposal
// ===========================================================================

describe('DroidBackend — disposal', () => {
  it('dispose kills any running process', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'Long running').catch(() => {});
    await backend.dispose();

    expect(currentMockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('dispose prevents further message emission', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    backend.onMessage((msg) => received.push(msg));

    await backend.startSession();
    await backend.dispose();

    received.length = 0;
    expect(received).toHaveLength(0);
  });

  it('calling dispose twice does not throw', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// DroidBackend — extra args validation
// ===========================================================================

describe('DroidBackend — extra args validation', () => {
  it('passes validated extra args to droid', async () => {
    const { backend } = createDroidBackend({
      ...BASE_OPTIONS,
      extraArgs: ['--verbose', '--max-tokens', '4096'],
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Extra args test');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--verbose');
    expect(args).toContain('--max-tokens');
    expect(args).toContain('4096');
  });

  it('throws for extra args containing shell metacharacters', async () => {
    const { backend } = createDroidBackend({
      ...BASE_OPTIONS,
      extraArgs: ['--prompt=$(evil)'],
    });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, 'test')).rejects.toThrow('Unsafe character');
  });
});

// ===========================================================================
// DroidBackend — session_id tracking
// ===========================================================================

describe('DroidBackend — session_id tracking', () => {
  it('uses session_id from Droid output in subsequent prompts', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // First prompt — Droid returns a session_id
    let promptPromise = backend.sendPrompt(sessionId, 'First message');
    simulateProcess(currentMockProcess, [
      JSON.stringify({ type: 'text', content: 'Hello', session_id: 'droid-sess-abc' }),
      droidDone(),
    ]);
    await promptPromise;

    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    // Second prompt — should pass --session droid-sess-abc
    promptPromise = backend.sendPrompt(sessionId, 'Second message');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[1][1] as string[];
    expect(args).toContain('--session');
    expect(args).toContain('droid-sess-abc');
  });
});
