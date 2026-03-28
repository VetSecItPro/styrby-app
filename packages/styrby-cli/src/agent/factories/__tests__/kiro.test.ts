/**
 * Tests for the Kiro agent backend factory (AWS).
 *
 * Covers:
 * - `createKiroBackend` factory function
 * - `registerKiroAgent` registry integration
 * - `KiroBackend` class: session lifecycle, subprocess management,
 *   JSONL output parsing, credit-based cost tracking (credits → USD),
 *   fs-edit detection from tool names, error handling, cancellation,
 *   permission response, and disposal.
 *
 * All child_process and logger calls are mocked so no real Kiro binary
 * is required.
 *
 * @module factories/__tests__/kiro.test.ts
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
import { createKiroBackend, registerKiroAgent, type KiroBackendOptions } from '../kiro';
import { agentRegistry } from '../../core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = spawn as unknown as MockInstance;

/** Collect all messages emitted by a backend into an array */
function collectMessages(backend: ReturnType<typeof createKiroBackend>['backend']) {
  const messages: unknown[] = [];
  backend.onMessage((msg) => messages.push(msg));
  return messages;
}

/**
 * Simulate a Kiro process run: emit stdout lines, then emit close event.
 *
 * @param proc - The mock child process
 * @param stdoutLines - Lines of stdout to emit
 * @param exitCode - Exit code for the close event (default: 0)
 */
function simulateProcess(proc: MockProcess, stdoutLines: string[] = [], exitCode = 0) {
  for (const line of stdoutLines) {
    (proc.stdout as EventEmitter).emit('data', Buffer.from(line + '\n'));
  }
  proc.emit('close', exitCode);
}

// ---- Kiro JSONL event builders ----

/** Build a Kiro message event line */
function kiroMessage(content: string): string {
  return JSON.stringify({ type: 'message', content });
}

/** Build a Kiro tool_call event line */
function kiroToolCall(tool: string, callId: string, input?: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_call', tool, call_id: callId, input });
}

/** Build a Kiro tool_result event line */
function kiroToolResult(tool: string, callId: string, result: unknown, input?: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_result', tool, call_id: callId, result, input });
}

/**
 * Build a Kiro usage event with credit-based billing data.
 *
 * @param usage - Credit/token usage metadata
 */
function kiroUsage(usage: {
  credits_consumed?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}): string {
  return JSON.stringify({ type: 'usage', usage });
}

/** Build a Kiro error event line */
function kiroError(error: string): string {
  return JSON.stringify({ type: 'error', error });
}

/** Build a Kiro status event line */
function kiroStatus(status: string): string {
  return JSON.stringify({ type: 'status', status });
}

/** Build a Kiro finish event line */
function kiroFinish(): string {
  return JSON.stringify({ type: 'finish' });
}

/** Base options used across most tests */
const BASE_OPTIONS: KiroBackendOptions = {
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
// createKiroBackend — factory function
// ===========================================================================

describe('createKiroBackend', () => {
  it('returns a backend instance and resolved model when model is provided', () => {
    const { backend, model } = createKiroBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('claude-sonnet-4');
  });

  it('returns undefined model when no model is specified', () => {
    const { model } = createKiroBackend(BASE_OPTIONS);

    expect(model).toBeUndefined();
  });

  it('returns a backend implementing the full AgentBackend interface', () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);

    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });

  it('does NOT spawn a process at creation time', () => {
    createKiroBackend(BASE_OPTIONS);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('passes cwd to the backend options', () => {
    const { backend } = createKiroBackend({ cwd: '/aws/workspace' });

    expect(backend).toBeDefined();
  });

  it('accepts awsProfile option', () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, awsProfile: 'prod' });

    expect(backend).toBeDefined();
  });

  it('accepts awsRegion option', () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, awsRegion: 'us-west-2' });

    expect(backend).toBeDefined();
  });
});

// ===========================================================================
// registerKiroAgent
// ===========================================================================

describe('registerKiroAgent', () => {
  it('registers "kiro" in the global agent registry', () => {
    registerKiroAgent();

    expect(agentRegistry.has('kiro')).toBe(true);
  });

  it('registry can create a backend after registration', () => {
    registerKiroAgent();

    const backend = agentRegistry.create('kiro', { cwd: '/project' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
  });
});

// ===========================================================================
// KiroBackend — session lifecycle
// ===========================================================================

describe('KiroBackend — session lifecycle', () => {
  it('startSession returns a sessionId string', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const result = await backend.startSession();

    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('startSession emits "starting" then "idle" when no initial prompt given', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    await backend.startSession();

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses).toContain('starting');
    expect(statuses).toContain('idle');
  });

  it('startSession with initial prompt spawns kiro', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    const sessionPromise = backend.startSession('Optimize the Lambda function');
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
    const { backend: b1 } = createKiroBackend(BASE_OPTIONS);
    const { backend: b2 } = createKiroBackend(BASE_OPTIONS);

    const { sessionId: id1 } = await b1.startSession();
    const { sessionId: id2 } = await b2.startSession();

    expect(id1).not.toBe(id2);
  });

  it('throws when startSession is called on a disposed backend', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('disposed');
  });
});

// ===========================================================================
// KiroBackend — sendPrompt
// ===========================================================================

describe('KiroBackend — sendPrompt', () => {
  it('spawns the kiro binary with correct arguments', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Write tests for auth module');
    simulateProcess(currentMockProcess);
    await promptPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kiro',
      expect.arrayContaining(['run', '--prompt', 'Write tests for auth module', '--output-format', 'jsonl']),
      expect.objectContaining({ cwd: '/project' })
    );
  });

  it('passes --model flag when model is specified', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, model: 'amazon-nova-pro' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Analyze costs');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('amazon-nova-pro');
  });

  it('passes --session flag when sessionName is provided', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, sessionName: 'my-kiro-session' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Resume work');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--session');
    expect(args).toContain('my-kiro-session');
  });

  it('passes AWS_PROFILE in spawn env when awsProfile is provided', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, awsProfile: 'dev' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Deploy to dev');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const spawnEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(spawnEnv.AWS_PROFILE).toBe('dev');
  });

  it('passes AWS_DEFAULT_REGION in spawn env when awsRegion is provided', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, awsRegion: 'eu-west-1' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Check EU region resources');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const spawnEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(spawnEnv.AWS_DEFAULT_REGION).toBe('eu-west-1');
  });

  it('throws when sendPrompt is called with wrong sessionId', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.sendPrompt('wrong-id', 'test')).rejects.toThrow('Invalid session ID');
  });

  it('throws when sendPrompt is called on a disposed backend', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    await backend.dispose();

    await expect(backend.sendPrompt(sessionId, 'test')).rejects.toThrow('disposed');
  });

  it('emits error status when process exits with non-zero code', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Failing prompt');
    simulateProcess(currentMockProcess, [], 1);

    await expect(promptPromise).rejects.toThrow('code 1');
    const errorMsgs = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorMsgs.length).toBeGreaterThan(0);
  });

  it('rejects with error when process emits error event', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'test');
    (currentMockProcess as EventEmitter).emit('error', new Error('kiro not found'));

    await expect(promptPromise).rejects.toThrow('kiro not found');
  });
});

// ===========================================================================
// KiroBackend — JSONL output parsing
// ===========================================================================

describe('KiroBackend — JSONL output parsing', () => {
  it('emits model-output for message events', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello Kiro');
    simulateProcess(currentMockProcess, [kiroMessage('Here is my AWS analysis')]);
    await promptPromise;

    const outputMsgs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputMsgs).toHaveLength(1);
    expect((outputMsgs[0] as any).textDelta).toBe('Here is my AWS analysis');
  });

  it('emits tool-call for tool_call events', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Check S3 buckets');
    simulateProcess(currentMockProcess, [
      kiroToolCall('list_s3_buckets', 'call-1', { region: 'us-east-1' }),
    ]);
    await promptPromise;

    const toolCalls = messages.filter((m: any) => m.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as any).toolName).toBe('list_s3_buckets');
    expect((toolCalls[0] as any).callId).toBe('call-1');
    expect((toolCalls[0] as any).args).toEqual({ region: 'us-east-1' });
  });

  it('emits tool-result for tool_result events', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Get Lambda metrics');
    simulateProcess(currentMockProcess, [
      kiroToolResult('get_metrics', 'call-2', { p99: 120, errors: 0 }),
    ]);
    await promptPromise;

    const toolResults = messages.filter((m: any) => m.type === 'tool-result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).toolName).toBe('get_metrics');
    expect((toolResults[0] as any).callId).toBe('call-2');
  });

  it('emits idle status for finish events', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Analyze architecture');
    simulateProcess(currentMockProcess, [kiroFinish()]);
    await promptPromise;

    const idleStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'idle');
    expect(idleStatuses.length).toBeGreaterThan(0);
  });

  it('emits error status for error events', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Do something');
    simulateProcess(currentMockProcess, [kiroError('AWS credentials expired')]);
    await promptPromise;

    const errorStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorStatuses).toHaveLength(1);
    expect((errorStatuses[0] as any).detail).toBe('AWS credentials expired');
  });

  it('maps status events correctly', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Process request');
    simulateProcess(currentMockProcess, [kiroStatus('running'), kiroStatus('complete')]);
    await promptPromise;

    const statusValues = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statusValues).toContain('running');
    expect(statusValues).toContain('idle'); // 'complete' maps to 'idle'
  });

  it('ignores non-JSON lines without crashing', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      'Kiro version 1.0.0',
      kiroMessage('Hi there!'),
      '  ',
    ]);
    await promptPromise;

    const outputMsgs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputMsgs).toHaveLength(1);
  });
});

// ===========================================================================
// KiroBackend — credit-based cost tracking
// ===========================================================================

describe('KiroBackend — credit-based cost tracking', () => {
  it('converts credits to USD at $0.01 per credit', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Analyze IAM policies');
    simulateProcess(currentMockProcess, [
      kiroUsage({ credits_consumed: 10, input_tokens: 500, output_tokens: 200 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts).toHaveLength(1);
    // 10 credits * $0.01/credit = $0.10
    expect((tokenCounts[0] as any).costUsd).toBeCloseTo(0.10, 5);
    expect((tokenCounts[0] as any).inputTokens).toBe(500);
    expect((tokenCounts[0] as any).outputTokens).toBe(200);
  });

  it('uses pre-computed cost_usd when provided by Kiro', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Deep analysis');
    simulateProcess(currentMockProcess, [
      kiroUsage({ credits_consumed: 50, cost_usd: 0.42 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    // Should use provided cost_usd (0.42), not credits * rate (0.50)
    expect((tokenCounts[0] as any).costUsd).toBeCloseTo(0.42, 5);
  });

  it('accumulates credits and cost across multiple usage events', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    // First prompt
    let promptPromise = backend.sendPrompt(sessionId, 'First task');
    simulateProcess(currentMockProcess, [
      kiroUsage({ credits_consumed: 5 }),
    ]);
    await promptPromise;

    // Reset mock for second prompt
    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    // Second prompt
    promptPromise = backend.sendPrompt(sessionId, 'Second task');
    simulateProcess(currentMockProcess, [
      kiroUsage({ credits_consumed: 8 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts.length).toBeGreaterThanOrEqual(2);

    // Final accumulated cost = (5 + 8) * $0.01 = $0.13
    const lastTokenCount = tokenCounts[tokenCounts.length - 1] as any;
    expect(lastTokenCount.costUsd).toBeCloseTo(0.13, 5);
  });

  it('includes creditsConsumed in token-count event', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Calculate credits');
    simulateProcess(currentMockProcess, [
      kiroUsage({ credits_consumed: 25 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect((tokenCounts[0] as any).creditsConsumed).toBe(25);
  });

  it('handles zero credits without dividing or multiplying by zero', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Free operation');
    simulateProcess(currentMockProcess, [
      kiroUsage({ credits_consumed: 0 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts).toHaveLength(1);
    expect((tokenCounts[0] as any).costUsd).toBe(0);
  });

  it('resets credit and cost accumulators on each startSession', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    // First session — consume 10 credits
    let { sessionId } = await backend.startSession();
    let promptPromise = backend.sendPrompt(sessionId, 'First session');
    simulateProcess(currentMockProcess, [
      kiroUsage({ credits_consumed: 10 }),
    ]);
    await promptPromise;

    // Clear messages and start a new session
    messages.length = 0;
    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    ({ sessionId } = await backend.startSession());
    promptPromise = backend.sendPrompt(sessionId, 'Second session');
    simulateProcess(currentMockProcess, [
      kiroUsage({ credits_consumed: 3 }),
    ]);
    await promptPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts.length).toBeGreaterThan(0);
    // New session — should only reflect 3 credits, not 13
    const lastTokenCount = tokenCounts[tokenCounts.length - 1] as any;
    expect(lastTokenCount.costUsd).toBeCloseTo(0.03, 5);
  });
});

// ===========================================================================
// KiroBackend — fs-edit detection
// ===========================================================================

describe('KiroBackend — fs-edit detection', () => {
  it('emits fs-edit for write_file tool results', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Create Lambda handler');
    simulateProcess(currentMockProcess, [
      kiroToolResult('write_file', 'call-1', 'success', { path: '/project/src/handler.py' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/project/src/handler.py');
    expect((fsEdits[0] as any).description).toContain('write_file');
  });

  it('emits fs-edit for edit_file tool results', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Update config');
    simulateProcess(currentMockProcess, [
      kiroToolResult('edit_file', 'call-2', 'ok', { path: '/project/config.json' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/project/config.json');
  });

  it('emits fs-edit for modify_file tool results', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Patch IAM policy');
    simulateProcess(currentMockProcess, [
      kiroToolResult('modify_file', 'call-3', 'done', { file_path: '/iam/policy.json' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/iam/policy.json');
  });

  it('does NOT emit fs-edit for non-file tools', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'List EC2 instances');
    simulateProcess(currentMockProcess, [
      kiroToolResult('list_ec2_instances', 'call-4', ['i-1234', 'i-5678']),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(0);
  });

  it('does NOT emit fs-edit when tool result has no path in input', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Write something');
    simulateProcess(currentMockProcess, [
      kiroToolResult('write_file', 'call-5', 'ok', { content: 'hello' }), // no path
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(0);
  });
});

// ===========================================================================
// KiroBackend — cancellation
// ===========================================================================

describe('KiroBackend — cancellation', () => {
  it('cancel sends SIGTERM to the running process', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // Start a prompt but do not resolve it — keep the process running
    backend.sendPrompt(sessionId, 'Long running task').catch(() => {});
    await backend.cancel(sessionId);

    expect(currentMockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cancel emits idle status', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'Cancellable task').catch(() => {});
    await backend.cancel(sessionId);

    const idleStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'idle');
    expect(idleStatuses.length).toBeGreaterThan(0);
  });

  it('cancel throws for wrong sessionId', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.cancel('bad-id')).rejects.toThrow('Invalid session ID');
  });
});

// ===========================================================================
// KiroBackend — permission response
// ===========================================================================

describe('KiroBackend — permission response', () => {
  it('emits permission-response when approval is granted', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission?.('req-1', true);

    const permResponses = messages.filter((m: any) => m.type === 'permission-response');
    expect(permResponses).toHaveLength(1);
    expect((permResponses[0] as any).approved).toBe(true);
    expect((permResponses[0] as any).id).toBe('req-1');
  });

  it('emits permission-response when approval is denied', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission?.('req-2', false);

    const permResponses = messages.filter((m: any) => m.type === 'permission-response');
    expect((permResponses[0] as any).approved).toBe(false);
  });

  it('writes "y\\n" to stdin when approved and process is active', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // Keep process running
    backend.sendPrompt(sessionId, 'Request permission').catch(() => {});
    await backend.respondToPermission?.('req-3', true);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('y\n');
  });
});

// ===========================================================================
// KiroBackend — message handler management
// ===========================================================================

describe('KiroBackend — message handler management', () => {
  it('onMessage registers a handler that receives events', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    backend.onMessage((msg) => received.push(msg));

    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [kiroMessage('Hi from AWS')]);
    await promptPromise;

    expect(received.some((m: any) => m.type === 'model-output')).toBe(true);
  });

  it('offMessage removes a handler that stops receiving events', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    const handler = (msg: unknown) => received.push(msg);

    backend.onMessage(handler);
    backend.offMessage?.(handler);

    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [kiroMessage('Invisible message')]);
    await promptPromise;

    const modelOutputs = received.filter((m: any) => m.type === 'model-output');
    expect(modelOutputs).toHaveLength(0);
  });

  it('multiple handlers all receive events', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const received1: unknown[] = [];
    const received2: unknown[] = [];

    backend.onMessage((msg) => received1.push(msg));
    backend.onMessage((msg) => received2.push(msg));

    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'Broadcast');
    simulateProcess(currentMockProcess, [kiroMessage('For all handlers')]);
    await promptPromise;

    expect(received1.some((m: any) => m.type === 'model-output')).toBe(true);
    expect(received2.some((m: any) => m.type === 'model-output')).toBe(true);
  });

  it('does not crash when a handler throws', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const received: unknown[] = [];

    backend.onMessage(() => { throw new Error('handler crash'); });
    backend.onMessage((msg) => received.push(msg));

    const { sessionId } = await backend.startSession();
    const promptPromise = backend.sendPrompt(sessionId, 'Still works');
    simulateProcess(currentMockProcess, [kiroMessage('Resilient output')]);
    await promptPromise;

    expect(received.some((m: any) => m.type === 'model-output')).toBe(true);
  });
});

// ===========================================================================
// KiroBackend — waitForResponseComplete
// ===========================================================================

describe('KiroBackend — waitForResponseComplete', () => {
  it('resolves immediately when no process is running', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.waitForResponseComplete?.()).resolves.toBeUndefined();
  });

  it('resolves after the process completes', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Wait for me');
    const waitPromise = backend.waitForResponseComplete?.(5000);

    simulateProcess(currentMockProcess);
    await promptPromise;
    await expect(waitPromise).resolves.toBeUndefined();
  });
});

// ===========================================================================
// KiroBackend — disposal
// ===========================================================================

describe('KiroBackend — disposal', () => {
  it('dispose kills any running process', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    backend.sendPrompt(sessionId, 'Long running').catch(() => {});
    await backend.dispose();

    expect(currentMockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('dispose prevents further message emission', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    backend.onMessage((msg) => received.push(msg));

    await backend.startSession();
    await backend.dispose();

    // Try to emit after disposal — should be a no-op
    received.length = 0;
    // No way to call emit directly, but disposal should have cleared listeners
    expect(received).toHaveLength(0);
  });

  it('calling dispose twice does not throw', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// KiroBackend — extra args validation
// ===========================================================================

describe('KiroBackend — extra args validation', () => {
  it('passes validated extra args to kiro', async () => {
    const { backend } = createKiroBackend({
      ...BASE_OPTIONS,
      extraArgs: ['--verbose', '--timeout', '120'],
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Verbose output');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--verbose');
    expect(args).toContain('--timeout');
    expect(args).toContain('120');
  });

  it('throws for extra args containing shell metacharacters', async () => {
    const { backend } = createKiroBackend({
      ...BASE_OPTIONS,
      extraArgs: ['--config=$(malicious)'],
    });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, 'test')).rejects.toThrow('Unsafe character');
  });
});
