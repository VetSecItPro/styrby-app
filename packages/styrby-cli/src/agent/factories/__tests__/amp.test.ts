/**
 * Tests for the Amp agent backend factory (Sourcegraph).
 *
 * Covers:
 * - `createAmpBackend` factory function
 * - `registerAmpAgent` registry integration
 * - `AmpBackend` class: session lifecycle, subprocess management,
 *   JSONL output parsing, deep mode sub-agent event tracking,
 *   token/cost accumulation across sub-agents, fs-edit detection,
 *   error handling, cancellation, permission response, and disposal.
 *
 * All child_process and logger calls are mocked so no real Amp binary
 * is required.
 *
 * @module factories/__tests__/amp.test.ts
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
import { createAmpBackend, registerAmpAgent, type AmpBackendOptions } from '../amp';
import { agentRegistry } from '../../core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = spawn as unknown as MockInstance;

function collectMessages(backend: ReturnType<typeof createAmpBackend>['backend']) {
  const messages: unknown[] = [];
  backend.onMessage((msg) => messages.push(msg));
  return messages;
}

/**
 * Simulate Amp output: emit lines as stdout data events, then close the process.
 */
function simulateProcess(proc: MockProcess, lines: string[] = [], exitCode = 0) {
  for (const line of lines) {
    (proc.stdout as EventEmitter).emit('data', Buffer.from(line + '\n'));
  }
  proc.emit('close', exitCode);
}

// ---- Amp event builders ----

function ampText(content: string): string {
  return JSON.stringify({ type: 'text', content });
}

function ampToolUse(toolName: string, callId: string, input?: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_use', tool_name: toolName, call_id: callId, tool_input: input });
}

function ampToolResult(
  toolName: string,
  callId: string,
  result: unknown,
  toolInput?: Record<string, unknown>
): string {
  return JSON.stringify({ type: 'tool_result', tool_name: toolName, call_id: callId, tool_result: result, tool_input: toolInput });
}

function ampSubAgentStart(subAgentId: string, description?: string): string {
  return JSON.stringify({ type: 'sub_agent_start', sub_agent_id: subAgentId, sub_agent_description: description });
}

function ampSubAgentComplete(subAgentId: string): string {
  return JSON.stringify({ type: 'sub_agent_complete', sub_agent_id: subAgentId });
}

function ampUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
  sub_agent_id?: string;
}): string {
  return JSON.stringify({ type: 'usage', usage });
}

function ampError(error: string): string {
  return JSON.stringify({ type: 'error', error });
}

function ampDone(): string {
  return JSON.stringify({ type: 'done' });
}

const BASE_OPTIONS: AmpBackendOptions = {
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
// createAmpBackend — factory function
// ===========================================================================

describe('createAmpBackend', () => {
  it('returns a backend instance and resolved model when model is provided', () => {
    const { backend, model } = createAmpBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('claude-sonnet-4');
  });

  it('returns undefined model when no model is specified', () => {
    const { model } = createAmpBackend(BASE_OPTIONS);

    expect(model).toBeUndefined();
  });

  it('returns a backend implementing the full AgentBackend interface', () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);

    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });

  it('does NOT spawn a process at creation time', () => {
    createAmpBackend(BASE_OPTIONS);

    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// registerAmpAgent
// ===========================================================================

describe('registerAmpAgent', () => {
  it('registers "amp" in the global agent registry', () => {
    registerAmpAgent();

    expect(agentRegistry.has('amp')).toBe(true);
  });

  it('registry can create a backend after registration', () => {
    registerAmpAgent();

    const backend = agentRegistry.create('amp', { cwd: '/project' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
  });
});

// ===========================================================================
// AmpBackend — session lifecycle
// ===========================================================================

describe('AmpBackend — session lifecycle', () => {
  it('startSession returns a sessionId string', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const result = await backend.startSession();

    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('startSession emits "starting" then "idle" when no initial prompt given', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    await backend.startSession();

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses).toContain('starting');
    expect(statuses).toContain('idle');
  });

  it('startSession with initial prompt spawns amp', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    const sessionPromise = backend.startSession('Refactor the payments module');
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
    const { backend } = createAmpBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('Backend has been disposed');
  });

  it('generates a unique sessionId for each backend instance', async () => {
    const { backend: b1 } = createAmpBackend(BASE_OPTIONS);
    const { backend: b2 } = createAmpBackend(BASE_OPTIONS);

    const { sessionId: id1 } = await b1.startSession();
    const { sessionId: id2 } = await b2.startSession();

    expect(id1).not.toBe(id2);
  });

  it('dispose kills an in-flight process', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

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
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const handler = vi.fn();
    backend.onMessage(handler);

    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// AmpBackend — sendPrompt & subprocess arguments
// ===========================================================================

describe('AmpBackend — sendPrompt arguments', () => {
  it('spawns amp with "chat", "--message", and "--format json" flags', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Analyze the auth module');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('amp');
    expect(args).toContain('chat');
    expect(args).toContain('--message');
    expect(args).toContain('Analyze the auth module');
    expect(args).toContain('--format');
    expect(args).toContain('json');
  });

  it('includes --no-interactive flag by default', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--no-interactive');
  });

  it('includes --model flag when model is specified', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, model: 'claude-opus-4' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4');
  });

  it('does NOT include --model when model is omitted', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--model');
  });

  it('includes --deep flag when deepMode is enabled', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, deepMode: true });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--deep');
  });

  it('does NOT include --deep when deepMode is false', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, deepMode: false });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--deep');
  });

  it('includes --max-agents when deepMode is enabled with maxSubAgents', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, deepMode: true, maxSubAgents: 6 });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--max-agents');
    expect(args).toContain('6');
  });

  it('does NOT include --max-agents when deepMode is disabled', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, deepMode: false, maxSubAgents: 6 });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--max-agents');
  });

  it('includes --session flag when resumeSessionId is provided', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, resumeSessionId: 'sess-abc-123' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--session');
    expect(args).toContain('sess-abc-123');
  });

  it('appends extraArgs to the spawn call', async () => {
    const { backend } = createAmpBackend({
      ...BASE_OPTIONS,
      extraArgs: ['--debug', '--timeout', '300'],
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--debug');
    expect(args).toContain('--timeout');
    expect(args).toContain('300');
  });

  it('sets ANTHROPIC_API_KEY and AMP_API_KEY when apiKey is provided', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, apiKey: 'amp-key-456' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, , spawnOptions] = mockSpawn.mock.calls[0];
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBe('amp-key-456');
    expect(spawnOptions.env.AMP_API_KEY).toBe('amp-key-456');
  });

  it('passes cwd to spawn options', async () => {
    const { backend } = createAmpBackend({ cwd: '/monorepo/packages/api' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, , spawnOptions] = mockSpawn.mock.calls[0];
    expect(spawnOptions.cwd).toBe('/monorepo/packages/api');
  });

  it('rejects when called with a mismatched sessionId', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.sendPrompt('invalid-session-id', 'hello')).rejects.toThrow(
      'Invalid session ID',
    );
  });

  it('rejects when called on a disposed backend', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    await backend.dispose();

    await expect(backend.sendPrompt(sessionId, 'hello')).rejects.toThrow(
      'Backend has been disposed',
    );
  });
});

// ===========================================================================
// AmpBackend — JSONL output parsing and event emission
// ===========================================================================

describe('AmpBackend — JSONL output parsing and event emission', () => {
  it('emits model-output message for type=text events', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [ampText('Here is your refactored code.')]);
    await promptPromise;

    const outputs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputs.length).toBeGreaterThan(0);
    const text = outputs.map((m: any) => m.textDelta).join('');
    expect(text).toContain('Here is your refactored code.');
  });

  it('does not emit model-output when text content is absent', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [JSON.stringify({ type: 'text' })]);
    await promptPromise;

    expect(messages.filter((m: any) => m.type === 'model-output').length).toBe(0);
  });

  it('emits tool-call message for type=tool_use events', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampToolUse('search_files', 'call-10', { pattern: '*.ts' }),
    ]);
    await promptPromise;

    const toolCalls = messages.filter((m: any) => m.type === 'tool-call');
    expect(toolCalls.length).toBe(1);
    const call = toolCalls[0] as any;
    expect(call.toolName).toBe('search_files');
    expect(call.callId).toBe('call-10');
    expect(call.args.pattern).toBe('*.ts');
  });

  it('emits tool-result message for type=tool_result events', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampToolResult('read_file', 'call-11', 'const x = 1;', { path: 'src/index.ts' }),
    ]);
    await promptPromise;

    const toolResults = messages.filter((m: any) => m.type === 'tool-result');
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).toolName).toBe('read_file');
    expect((toolResults[0] as any).callId).toBe('call-11');
  });

  it('emits fs-edit message when tool_result uses a write tool', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampToolResult('write_file', 'call-12', 'ok', { path: 'src/payments.ts' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits.length).toBe(1);
    const edit = fsEdits[0] as any;
    expect(edit.path).toBe('src/payments.ts');
    expect(edit.description).toContain('write_file');
    expect(edit.description).toContain('src/payments.ts');
  });

  it('emits fs-edit for edit_file tool with file_path input key', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampToolResult('edit_file', 'call-13', 'ok', { file_path: 'lib/db.ts' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits.length).toBe(1);
    expect((fsEdits[0] as any).path).toBe('lib/db.ts');
  });

  it('does NOT emit fs-edit for non-file-writing tools', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampToolResult('execute_command', 'call-14', 'exit 0'),
    ]);
    await promptPromise;

    expect(messages.filter((m: any) => m.type === 'fs-edit').length).toBe(0);
  });

  it('emits sub-agent-start event message when sub_agent_start is received', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampSubAgentStart('agent-1', 'Analyzing src/auth module'),
    ]);
    await promptPromise;

    const events = messages.filter((m: any) => m.type === 'event' && m.name === 'sub-agent-start');
    expect(events.length).toBe(1);
    const evt = events[0] as any;
    expect(evt.payload.subAgentId).toBe('agent-1');
    expect(evt.payload.description).toBe('Analyzing src/auth module');
    expect(evt.payload.activeCount).toBe(1);
  });

  it('emits sub-agent-complete event and decrements active count', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampSubAgentStart('agent-1', 'Analyzing src/auth'),
      ampSubAgentStart('agent-2', 'Analyzing src/payments'),
      ampSubAgentComplete('agent-1'),
    ]);
    await promptPromise;

    const completeEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'sub-agent-complete'
    );
    expect(completeEvents.length).toBe(1);
    const evt = completeEvents[0] as any;
    expect(evt.payload.subAgentId).toBe('agent-1');
    // One sub-agent remains active
    expect(evt.payload.activeCount).toBe(1);
  });

  it('correctly tracks multiple concurrent sub-agents', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampSubAgentStart('agent-1'),
      ampSubAgentStart('agent-2'),
      ampSubAgentStart('agent-3'),
      ampSubAgentComplete('agent-2'),
      ampSubAgentComplete('agent-3'),
    ]);
    await promptPromise;

    const startEvents = messages.filter((m: any) => m.type === 'event' && m.name === 'sub-agent-start');
    const completeEvents = messages.filter((m: any) => m.type === 'event' && m.name === 'sub-agent-complete');

    expect(startEvents.length).toBe(3);
    expect(completeEvents.length).toBe(2);

    // After 2 completions, 1 agent remains
    const lastComplete = completeEvents.at(-1) as any;
    expect(lastComplete.payload.activeCount).toBe(1);
  });

  it('emits token-count message from usage events', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampUsage({ input_tokens: 500, output_tokens: 200, cache_read_tokens: 50, cost_usd: 0.0075 }),
    ]);
    await promptPromise;

    const tokenMessages = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenMessages.length).toBe(1);
    const tm = tokenMessages[0] as any;
    expect(tm.inputTokens).toBe(500);
    expect(tm.outputTokens).toBe(200);
    expect(tm.cacheReadTokens).toBe(50);
    expect(tm.costUsd).toBeCloseTo(0.0075);
  });

  it('accumulates token usage across multiple usage events (sub-agent deep mode)', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampUsage({ input_tokens: 300, output_tokens: 100, cost_usd: 0.002, sub_agent_id: 'agent-1' }),
      ampUsage({ input_tokens: 250, output_tokens: 80, cost_usd: 0.0015, sub_agent_id: 'agent-2' }),
      ampUsage({ input_tokens: 400, output_tokens: 120, cost_usd: 0.003 }),
    ]);
    await promptPromise;

    const tokenMessages = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenMessages.length).toBe(3);

    const last = tokenMessages.at(-1) as any;
    expect(last.inputTokens).toBe(950);
    expect(last.outputTokens).toBe(300);
    expect(last.costUsd).toBeCloseTo(0.0065);
  });

  it('includes sub_agent_id in token-count message for sub-agent attribution', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampUsage({ input_tokens: 100, output_tokens: 40, cost_usd: 0.001, sub_agent_id: 'agent-3' }),
    ]);
    await promptPromise;

    const tokenMsg = messages.find((m: any) => m.type === 'token-count') as any;
    expect(tokenMsg.subAgentId).toBe('agent-3');
  });

  it('emits error status for type=error events', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [ampError('Anthropic API rate limit exceeded')]);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses.length).toBeGreaterThan(0);
    expect((errorStatuses[0] as any).detail).toContain('rate limit');
  });

  it('emits idle status and clears sub-agents for type=done events', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampSubAgentStart('agent-1'),
      ampDone(),
    ]);
    await promptPromise;

    const idleStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'idle'
    );
    expect(idleStatuses.length).toBeGreaterThan(0);
  });

  it('ignores non-JSON stdout lines without crashing', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      'Initializing Amp...',
      '--- deep mode ---',
      ampText('Done.'),
    ]);

    await expect(promptPromise).resolves.not.toThrow();
  });

  it('handles partial/malformed JSON lines without crashing', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      '{ broken',
      ampText('Recovered.'),
    ]);

    await expect(promptPromise).resolves.not.toThrow();
  });

  it('handles stdout chunks split across multiple data events', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const fullLine = ampText('Chunked response from Amp');
    const half1 = fullLine.slice(0, Math.floor(fullLine.length / 2));
    const half2 = fullLine.slice(Math.floor(fullLine.length / 2)) + '\n';

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half1));
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half2));
    currentMockProcess.emit('close', 0);
    await promptPromise;

    const outputs = messages.filter((m: any) => m.type === 'model-output');
    const text = outputs.map((m: any) => m.textDelta).join('');
    expect(text).toContain('Chunked response from Amp');
  });

  it('emits idle status after process exits cleanly', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
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

  it('extracts session_id from events and stores for persistence', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    // Emit a text message that includes a session_id (Amp provides this for persistence)
    simulateProcess(currentMockProcess, [
      JSON.stringify({ type: 'text', content: 'hello', session_id: 'amp-persist-session-xyz' }),
    ]);
    await promptPromise;

    // Verify the session continues to work (ampSessionId is stored internally)
    const nextProcess = makeMockProcess();
    mockSpawn.mockReturnValue(nextProcess);

    const promptPromise2 = backend.sendPrompt(sessionId, 'follow-up');
    simulateProcess(nextProcess);
    await promptPromise2;

    // The second spawn should include --session with the stored amp session ID
    const secondCall = mockSpawn.mock.calls[1];
    const [, args] = secondCall;
    expect(args).toContain('--session');
    expect(args).toContain('amp-persist-session-xyz');
  });
});

// ===========================================================================
// AmpBackend — error handling
// ===========================================================================

describe('AmpBackend — error handling', () => {
  it('rejects sendPrompt when amp exits with non-zero exit code', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [], 1);

    await expect(promptPromise).rejects.toThrow('Amp exited with code 1');
  });

  it('emits error status when amp exits with non-zero code', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello').catch(() => {});
    simulateProcess(currentMockProcess, [], 3);
    await promptPromise;

    const errorStatus = messages
      .filter((m: any) => m.type === 'status' && m.status === 'error')
      .at(-1) as any;

    expect(errorStatus).toBeDefined();
    expect(errorStatus.detail).toContain('code 3');
  });

  it('emits error status when stderr contains "Error"', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stderr as EventEmitter).emit(
      'data',
      Buffer.from('Error: Anthropic API key invalid'),
    );
    simulateProcess(currentMockProcess, [], 0);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('emits error status when stderr contains "failed"', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stderr as EventEmitter).emit(
      'data',
      Buffer.from('Sub-agent failed: context window exceeded'),
    );
    simulateProcess(currentMockProcess, [], 0);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('rejects sendPrompt when the spawned process emits an "error" event', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    currentMockProcess.emit('error', new Error('ENOENT: amp not found'));

    await expect(promptPromise).rejects.toThrow('ENOENT: amp not found');
  });

  it('emits error status when process emits "error" event', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
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
// AmpBackend — cancel
// ===========================================================================

describe('AmpBackend — cancel', () => {
  it('sends SIGTERM to the running process when cancel is called', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'deep mode task').catch(() => {});
    await backend.cancel(sessionId);

    expect(currentMockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('emits "idle" status after cancel', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
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
    const { backend } = createAmpBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.cancel('wrong-id')).rejects.toThrow('Invalid session ID');
  });

  it('does not throw when cancel is called with no active process', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    await expect(backend.cancel(sessionId)).resolves.not.toThrow();
  });
});

// ===========================================================================
// AmpBackend — onMessage / offMessage
// ===========================================================================

describe('AmpBackend — onMessage / offMessage', () => {
  it('calls all registered handlers for each emitted message', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const h1 = vi.fn();
    const h2 = vi.fn();
    backend.onMessage(h1);
    backend.onMessage(h2);

    await backend.startSession();

    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('stops calling a handler after offMessage is called', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const handler = vi.fn();
    backend.onMessage(handler);
    backend.offMessage(handler);

    await backend.startSession();

    expect(handler).not.toHaveBeenCalled();
  });

  it('handles errors thrown inside a listener without crashing the backend', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const badHandler = vi.fn(() => {
      throw new Error('handler crashed');
    });
    const goodHandler = vi.fn();
    backend.onMessage(badHandler);
    backend.onMessage(goodHandler);

    await expect(backend.startSession()).resolves.toBeDefined();
    expect(goodHandler).toHaveBeenCalled();
  });
});

// ===========================================================================
// AmpBackend — respondToPermission
// ===========================================================================

describe('AmpBackend — respondToPermission', () => {
  it('emits a permission-response message with approved=true', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission('req-amp-1', true);

    const permMsg = messages.find((m: any) => m.type === 'permission-response') as any;
    expect(permMsg).toBeDefined();
    expect(permMsg.id).toBe('req-amp-1');
    expect(permMsg.approved).toBe(true);
  });

  it('emits a permission-response message with approved=false when denied', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission('req-amp-2', false);

    const permMsg = messages.find((m: any) => m.type === 'permission-response') as any;
    expect(permMsg).toBeDefined();
    expect(permMsg.approved).toBe(false);
  });

  it('writes "y\\n" to stdin when approved=true and process is running', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'task').catch(() => {});
    await backend.respondToPermission('req-amp-3', true);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('y\n');
  });

  it('writes "n\\n" to stdin when approved=false and process is running', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'task').catch(() => {});
    await backend.respondToPermission('req-amp-4', false);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('n\n');
  });
});

// ===========================================================================
// AmpBackend — waitForResponseComplete
// ===========================================================================

describe('AmpBackend — waitForResponseComplete', () => {
  it('resolves immediately when no process is active', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.waitForResponseComplete?.(1000)).resolves.toBeUndefined();
  });
});

// ===========================================================================
// AmpBackend — cost-report emission
// ===========================================================================

/**
 * Tests for the unified CostReport event added to Amp usage events.
 *
 * WHY: migration 022 persists billing_model / source / raw_agent_payload.
 * Amp always emits agent-reported with billingModel=api-key. When sub_agent_id
 * is present it must appear in rawAgentPayload for sub-agent cost attribution.
 */
describe('AmpBackend — cost-report emission', () => {
  it('emits cost-report with billingModel=api-key and source=agent-reported on usage event', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampUsage({ input_tokens: 800, output_tokens: 300, cache_read_tokens: 50, cost_usd: 0.012 }),
    ]);
    await promptPromise;

    const reports = messages.filter((m: any) => m.type === 'cost-report');
    expect(reports.length).toBeGreaterThanOrEqual(1);
    const r = reports[0] as any;
    expect(r.report.billingModel).toBe('api-key');
    expect(r.report.source).toBe('agent-reported');
    expect(r.report.agentType).toBe('amp');
    expect(r.report.inputTokens).toBe(800);
    expect(r.report.outputTokens).toBe(300);
    expect(r.report.cacheReadTokens).toBe(50);
    expect(r.report.rawAgentPayload).not.toBeNull();
  });

  it('includes sub_agent_id in rawAgentPayload when usage event has sub_agent_id', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'deep task');
    simulateProcess(currentMockProcess, [
      ampUsage({ input_tokens: 300, output_tokens: 100, cost_usd: 0.005, sub_agent_id: 'sub-xyz' }),
    ]);
    await promptPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r.report.rawAgentPayload?.sub_agent_id).toBe('sub-xyz');
  });

  it('cost-report has messageId=null (Amp does not expose per-message IDs)', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [ampUsage({ cost_usd: 0.003 })]);
    await promptPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r.report.messageId).toBeNull();
  });
});
