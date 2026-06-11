/**
 * Tests for the Droid agent backend factory (Factory-hosted `droid` CLI).
 *
 * Covers:
 * - `createDroidBackend` factory function
 * - `registerDroidAgent` registry integration
 * - `DroidBackend` class: session lifecycle, subprocess management,
 *   stream-json output parsing, Factory API key injection, `droid exec`
 *   invocation form, result/usage handling, error handling, cancellation,
 *   permission response, and disposal.
 *
 * Invocation + the system/error/result event schema are VERIFIED against the
 * real `droid` binary (v0.144.2, `droid exec --help` + a real unauthenticated
 * `droid exec ... -o stream-json` capture, 2026-06-10).
 *
 * assistant/tool (tool_use / tool_result) events are UNVERIFIED — they could
 * not be captured without Factory auth (#30). Those test blocks are
 * `describe.skip`'d with a reason and exercise the best-effort Claude-Code-shaped
 * parser only as documentation of intended behavior, NOT as proof it works.
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

// ---- Droid stream-json event builders (VERIFIED schema) ----

/**
 * `{"type":"system","subtype":"init", model, session_id, tools}`
 * VERIFIED: captured from a real `droid exec ... -o stream-json` run.
 */
function droidInit(model: string, sessionId = 'droid-sess-xyz'): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    cwd: '/project',
    session_id: sessionId,
    tools: ['Read', 'Edit', 'Create'],
    model,
    reasoning_effort: 'high',
  });
}

/**
 * `{"type":"error","source","message","timestamp","session_id"}`
 * VERIFIED: captured from a real run (auth-failure path).
 */
function droidError(message: string, sessionId = 'droid-sess-xyz'): string {
  return JSON.stringify({
    type: 'error',
    source: 'cli',
    message,
    timestamp: 1781148934831,
    session_id: sessionId,
  });
}

/**
 * `{"type":"result","subtype","is_error","result","session_id","usage":{...}}`
 * VERIFIED: usage field names are Claude-Code snake_case
 * (input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens).
 */
function droidResult(opts: {
  result?: string;
  isError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  sessionId?: string;
}): string {
  return JSON.stringify({
    type: 'result',
    subtype: opts.isError ? 'failure' : 'success',
    is_error: opts.isError ?? false,
    duration_ms: 1234,
    num_turns: 1,
    result: opts.result ?? 'Done',
    session_id: opts.sessionId ?? 'droid-sess-xyz',
    usage: {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      cache_read_input_tokens: opts.cacheReadTokens ?? 0,
      cache_creation_input_tokens: opts.cacheCreationTokens ?? 0,
    },
  });
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
    const { backend, model } = createDroidBackend({ ...BASE_OPTIONS, model: 'claude-opus-4-8' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('claude-opus-4-8');
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

  it('accepts autoLevel option', () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, autoLevel: 'medium' });

    expect(backend).toBeDefined();
  });

  it('accepts factoryApiKey option', () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, factoryApiKey: 'fk-test' });

    expect(backend).toBeDefined();
  });

  it('accepts resumeSessionId for session persistence', () => {
    const { backend } = createDroidBackend({
      ...BASE_OPTIONS,
      resumeSessionId: 'existing-session-123',
    });

    expect(backend).toBeDefined();
  });

  it('accepts forkSessionId for session forking', () => {
    const { backend } = createDroidBackend({
      ...BASE_OPTIONS,
      forkSessionId: 'fork-from-456',
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
// DroidBackend — sendPrompt invocation (VERIFIED `droid exec` form)
// ===========================================================================

describe('DroidBackend — sendPrompt invocation', () => {
  it('spawns `droid exec <prompt> --output-format stream-json`', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Review the auth module');
    simulateProcess(currentMockProcess);
    await promptPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'droid',
      expect.arrayContaining([
        'exec',
        'Review the auth module',
        '--output-format',
        'stream-json',
      ]),
      expect.objectContaining({ cwd: '/project' })
    );
  });

  it('uses a POSITIONAL prompt (no --message flag) and no legacy chat subcommand', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('Hello'); // prompt is positional, immediately after `exec`
    expect(args).not.toContain('chat');
    expect(args).not.toContain('--message');
    expect(args).not.toContain('--no-interactive');
    expect(args).not.toContain('--backend');
    expect(args).not.toContain('--format');
  });

  it('passes -m flag when model is specified', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'gpt-5.5' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Analyze deeply');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.5');
  });

  it('passes --auto flag when autoLevel is specified', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, autoLevel: 'high' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Deploy');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--auto');
    expect(args).toContain('high');
  });

  it('does NOT pass --auto when autoLevel is omitted (read-only default)', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Read only');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--auto');
  });

  it('passes -s with resumeSessionId on first prompt', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, resumeSessionId: 'existing-456' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Continue my session');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('-s');
    expect(args).toContain('existing-456');
  });

  it('passes --fork with forkSessionId (taking precedence over resume)', async () => {
    const { backend } = createDroidBackend({
      ...BASE_OPTIONS,
      forkSessionId: 'fork-789',
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Branch off');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--fork');
    expect(args).toContain('fork-789');
    expect(args).not.toContain('-s');
  });

  it('injects FACTORY_API_KEY into the subprocess env (not as a CLI flag)', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, factoryApiKey: 'fk-real-key' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Auth test');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const spawnEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(spawnEnv.FACTORY_API_KEY).toBe('fk-real-key');

    // Droid is Factory-hosted, NOT a multi-provider BYOK proxy: no provider keys.
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('fk-real-key'); // never on the command line
  });

  it('does NOT inject provider keys (Droid is not BYOK/LiteLLM)', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, factoryApiKey: 'fk-x' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'No provider keys');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const spawnEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawnEnv.OPENAI_API_KEY).toBeUndefined();
    expect(spawnEnv.GOOGLE_API_KEY).toBeUndefined();
    expect(spawnEnv.MISTRAL_API_KEY).toBeUndefined();
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
// DroidBackend — stream-json output parsing (VERIFIED events)
// ===========================================================================

describe('DroidBackend — stream-json parsing (verified events)', () => {
  it('captures the resolved model from the init system event', async () => {
    // Request one model; Droid's init advertises another. The cost-report must
    // reflect the model Droid actually used (from init), per the result event.
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'gpt-5.5' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'init test');
    simulateProcess(currentMockProcess, [
      droidInit('claude-opus-4-8'),
      droidResult({ inputTokens: 100, outputTokens: 50 }),
    ]);
    await promptPromise;

    const report = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(report.report.model).toBe('claude-opus-4-8');
  });

  it('emits model-output from the result event text', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Generate code');
    simulateProcess(currentMockProcess, [
      droidInit('claude-opus-4-8'),
      droidResult({ result: 'Here is the implementation' }),
    ]);
    await promptPromise;

    const outputMsgs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputMsgs.length).toBeGreaterThanOrEqual(1);
    expect((outputMsgs[outputMsgs.length - 1] as any).textDelta).toBe('Here is the implementation');
  });

  it('emits idle status after a successful result event', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Final task');
    simulateProcess(currentMockProcess, [droidResult({ result: 'ok' })]);
    await promptPromise;

    const idleStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'idle');
    expect(idleStatuses.length).toBeGreaterThan(0);
  });

  it('emits error status for a top-level error event', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Cause error');
    simulateProcess(currentMockProcess, [
      droidError('Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.'),
    ]);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses).toHaveLength(1);
    expect((errorStatuses[0] as any).detail).toContain('Authentication failed');
  });

  it('emits error status for a result event with is_error=true', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Failing run');
    simulateProcess(currentMockProcess, [
      droidResult({ isError: true, result: 'rate limit exceeded' }),
    ]);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses.length).toBeGreaterThan(0);
    expect((errorStatuses[errorStatuses.length - 1] as any).detail).toContain('rate limit');
  });

  it('ignores non-JSON lines without crashing', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      'Droid v0.144.2 initializing...',
      droidResult({ result: 'Response content' }),
      '',
    ]);
    await promptPromise;

    const outputMsgs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputMsgs.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// DroidBackend — usage / cost-report from the result event (VERIFIED schema)
// ===========================================================================

describe('DroidBackend — usage + cost-report', () => {
  it('reads VERIFIED snake_case usage fields from the result event', async () => {
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'claude-opus-4-8' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Usage test');
    simulateProcess(currentMockProcess, [
      droidInit('claude-opus-4-8'),
      droidResult({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreationTokens: 100,
      }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts).toHaveLength(1);
    expect((tokenCounts[0] as any).inputTokens).toBe(1000);
    expect((tokenCounts[0] as any).outputTokens).toBe(500);
    expect((tokenCounts[0] as any).cacheReadTokens).toBe(200);
    expect((tokenCounts[0] as any).cacheWriteTokens).toBe(100);
  });

  it('emits a cost-report with source=styrby-estimate (Droid never reports cost)', async () => {
    // WHY: Droid's verified result.usage block has NO cost field. Cost is
    // derived downstream, so every Droid cost-report is a styrby-estimate.
    const { backend } = createDroidBackend({ ...BASE_OPTIONS, model: 'claude-opus-4-8' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Cost test');
    simulateProcess(currentMockProcess, [
      droidInit('claude-opus-4-8'),
      droidResult({ inputTokens: 800, outputTokens: 300 }),
    ]);
    await promptPromise;

    const report = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(report).toBeDefined();
    expect(report.report.agentType).toBe('droid');
    expect(report.report.billingModel).toBe('api-key');
    expect(report.report.source).toBe('styrby-estimate');
    expect(report.report.inputTokens).toBe(800);
    expect(report.report.outputTokens).toBe(300);
    // rawAgentPayload carries the real usage block for downstream pricing.
    expect(report.report.rawAgentPayload).not.toBeNull();
    expect((report.report.rawAgentPayload as any).input_tokens).toBe(800);
  });

  it('resets token accumulators on each startSession', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    let { sessionId } = await backend.startSession();
    let promptPromise = backend.sendPrompt(sessionId, 'First session');
    simulateProcess(currentMockProcess, [droidResult({ inputTokens: 5000, outputTokens: 5000 })]);
    await promptPromise;

    messages.length = 0;
    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    ({ sessionId } = await backend.startSession());
    promptPromise = backend.sendPrompt(sessionId, 'Second session');
    simulateProcess(currentMockProcess, [droidResult({ inputTokens: 10, outputTokens: 20 })]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    const last = tokenCounts[tokenCounts.length - 1] as any;
    expect(last.inputTokens).toBe(10);
    expect(last.outputTokens).toBe(20);
  });
});

// ===========================================================================
// DroidBackend — assistant/tool events (UNVERIFIED — schema needs keyed session)
// ===========================================================================

/**
 * These events (assistant text deltas, tool_use, tool_result) could NOT be
 * captured because the test machine has no Factory auth (#30). The parser
 * branches are written best-effort against the Claude-Code stream-json schema
 * that Droid's init event advertises, but until a real keyed session confirms
 * the exact envelope, we do NOT claim these work — hence `.skip`.
 *
 * To unskip: capture a real `droid exec "..." -o stream-json` run with a valid
 * FACTORY_API_KEY, paste the actual assistant/tool_use/tool_result lines as the
 * builders below, and verify the assertions hold.
 */
describe.skip('DroidBackend — assistant/tool events (UNVERIFIED, needs keyed session #30)', () => {
  function droidAssistantText(text: string): string {
    return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  }
  function droidAssistantToolUse(name: string, id: string, input: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, id, input }] },
    });
  }
  function droidUserToolResult(name: string, toolUseId: string, content: unknown, input?: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', name, tool_use_id: toolUseId, content, input }] },
    });
  }

  it('emits model-output from assistant text blocks', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'stream');
    simulateProcess(currentMockProcess, [droidAssistantText('partial answer'), droidResult({})]);
    await promptPromise;

    const outputs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputs.some((m: any) => m.textDelta === 'partial answer')).toBe(true);
  });

  it('emits tool-call from assistant tool_use blocks', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'use a tool');
    simulateProcess(currentMockProcess, [
      droidAssistantToolUse('Read', 'tu-1', { path: '/src/main.ts' }),
      droidResult({}),
    ]);
    await promptPromise;

    const calls = messages.filter((m: any) => m.type === 'tool-call');
    expect(calls).toHaveLength(1);
    expect((calls[0] as any).toolName).toBe('Read');
  });

  it('emits fs-edit for write tool_result blocks', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'write a file');
    simulateProcess(currentMockProcess, [
      droidUserToolResult('Edit', 'tu-2', 'ok', { path: '/src/Button.tsx' }),
      droidResult({}),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/src/Button.tsx');
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
    simulateProcess(currentMockProcess, [droidResult({ result: 'World' })]);
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
    simulateProcess(currentMockProcess, [droidResult({ result: 'Invisible' })]);
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
    simulateProcess(currentMockProcess, [droidResult({ result: 'To all' })]);
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
    simulateProcess(currentMockProcess, [droidResult({ result: 'Still works' })]);
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
      extraArgs: ['--reasoning-effort', 'high'],
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Extra args test');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--reasoning-effort');
    expect(args).toContain('high');
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
// DroidBackend — session_id tracking across prompts
// ===========================================================================

describe('DroidBackend — session_id tracking', () => {
  it('uses the session_id from Droid output to resume on subsequent prompts', async () => {
    const { backend } = createDroidBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // First prompt — Droid emits init + result carrying a session_id
    let promptPromise = backend.sendPrompt(sessionId, 'First message');
    simulateProcess(currentMockProcess, [
      droidInit('claude-opus-4-8', 'droid-sess-abc'),
      droidResult({ result: 'Hello', sessionId: 'droid-sess-abc' }),
    ]);
    await promptPromise;

    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    // Second prompt — should pass `-s droid-sess-abc`
    promptPromise = backend.sendPrompt(sessionId, 'Second message');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[1][1] as string[];
    expect(args).toContain('-s');
    expect(args).toContain('droid-sess-abc');
  });
});
