/**
 * Tests for the Kiro agent backend factory (AWS / Amazon Q Developer CLI rebrand).
 *
 * REALITY CHECK (kiro-cli v2.6.1, verified 2026-06-10):
 * - Binary is `kiro-cli` (NOT `kiro`). Backward-compat aliases `q`/`q chat` exist.
 * - Headless invocation is `kiro-cli chat --no-interactive --trust-all-tools <prompt>`
 *   (the prompt is a trailing positional argument; `--trust-all-tools` is the
 *   default trust posture; optional `--model` / `--effort`). There is NO `run`
 *   subcommand, NO `--prompt`, and NO `--output-format jsonl`.
 * - kiro-cli has NO JSON/stream output mode for chat. It writes the model's reply
 *   to stdout as PLAIN TEXT with ANSI/terminal control codes. The factory strips
 *   ANSI and forwards the text as `model-output`. There is no
 *   `{message, tool_call, tool_result, usage, finish}` event schema.
 * - kiro-cli emits NO token/credit/cost telemetry. The prior credit-billing fiction
 *   (`KIRO_CREDIT_TO_USD`, 1 credit = $0.01) does not exist in the real binary, so
 *   the backend emits NO cost-report / token-count / tool / fs-edit events.
 * - Auth: injects `KIRO_API_KEY` env (from options.apiKey) only.
 *
 * Because of that, this suite covers ONLY verified behavior: the real spawn argv,
 * ANSI-stripped plain-text stdout -> model-output passthrough, exit-code handling,
 * cancellation, dispose, ENOENT install hint, and env-key injection. The previous
 * suite's invented-JSONL-event blocks (message/tool_call/tool_result/usage/finish
 * parsing, credit-cost tracking, fs-edit detection) are DELETED — they tested a
 * fabricated schema the real binary does not produce (#30 — kiro-cli emits no
 * structured output).
 *
 * All child_process and logger calls are mocked so no real kiro-cli binary
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
 * Simulate a kiro-cli run: emit plain-text chunks as stdout data events, then
 * close the process. (kiro-cli emits plain text, NOT line-framed JSON.)
 *
 * @param proc - The mock child process
 * @param chunks - Plain-text chunks to emit on stdout
 * @param exitCode - Exit code for the close event (default: 0)
 */
function simulateProcess(proc: MockProcess, chunks: string[] = [], exitCode = 0) {
  for (const chunk of chunks) {
    (proc.stdout as EventEmitter).emit('data', Buffer.from(chunk));
  }
  proc.emit('close', exitCode);
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
    const { backend, model } = createKiroBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4-5' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('claude-sonnet-4-5');
  });

  it('returns undefined model when no model is specified', () => {
    const { model } = createKiroBackend(BASE_OPTIONS);

    expect(model).toBeUndefined();
  });

  it('reports supportsTools=false (kiro-cli emits no structured tool events)', () => {
    const { metadata } = createKiroBackend(BASE_OPTIONS);

    expect(metadata?.supportsTools).toBe(false);
    expect(metadata?.supportsStreaming).toBe(true);
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

  it('accepts effort and trustTools options', () => {
    const { backend } = createKiroBackend({
      ...BASE_OPTIONS,
      effort: 'high',
      trustTools: 'fs_read,fs_write',
    });

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

  it('startSession with initial prompt spawns kiro-cli', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    const sessionPromise = backend.startSession('Optimize the Lambda function');
    simulateProcess(currentMockProcess);
    await sessionPromise;

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses[0]).toBe('starting');
    expect(statuses[1]).toBe('running');
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

  it('dispose kills an in-flight process', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
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
// KiroBackend — sendPrompt (VERIFIED `kiro-cli chat` invocation)
// ===========================================================================

describe('KiroBackend — sendPrompt invocation', () => {
  it('spawns `kiro-cli chat --no-interactive --trust-all-tools <prompt>` with the prompt as a trailing positional', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Write tests for auth module');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [bin, args] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    // Binary is kiro-cli, NOT kiro.
    expect(bin).toBe('kiro-cli');
    // Subcommand + flags first, prompt last (positional).
    expect(args[0]).toBe('chat');
    expect(args).toContain('--no-interactive');
    expect(args).toContain('--trust-all-tools');
    expect(args[args.length - 1]).toBe('Write tests for auth module');
    // The fabricated old-schema flags must NOT be present.
    expect(args).not.toContain('run');
    expect(args).not.toContain('--prompt');
    expect(args).not.toContain('--output-format');
    expect(args).not.toContain('jsonl');
  });

  it('passes cwd to the spawn options', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const opts = (mockSpawn.mock.calls[0] as any[])[2];
    expect(opts.cwd).toBe('/project');
  });

  it('includes --model flag (before the positional prompt) when model is specified', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, model: 'amazon-nova-pro' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Analyze costs');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('amazon-nova-pro');
    // Prompt stays the trailing positional.
    expect(args[args.length - 1]).toBe('Analyze costs');
  });

  it('includes --effort flag when effort is specified', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, effort: 'high' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Deep analysis');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    const effortIdx = args.indexOf('--effort');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(args[effortIdx + 1]).toBe('high');
  });

  it('uses --trust-tools=<list> when trustTools is a comma list', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, trustTools: 'fs_read,fs_write' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Restricted run');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    expect(args).toContain('--trust-tools=fs_read,fs_write');
    expect(args).not.toContain('--trust-all-tools');
  });

  it('injects KIRO_API_KEY into spawn env when apiKey is provided', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, apiKey: 'kiro-secret-key' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Authenticated run');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const spawnEnv = (mockSpawn.mock.calls[0] as any[])[2].env as Record<string, string>;
    expect(spawnEnv.KIRO_API_KEY).toBe('kiro-secret-key');
  });

  it('does NOT inject KIRO_API_KEY when no apiKey is provided', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Anonymous run');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const spawnEnv = (mockSpawn.mock.calls[0] as any[])[2].env as Record<string, string>;
    expect(spawnEnv.KIRO_API_KEY).toBeUndefined();
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

  it('rejects when kiro-cli exits with non-zero code', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Failing prompt');
    simulateProcess(currentMockProcess, [], 1);

    await expect(promptPromise).rejects.toThrow('code 1');
    const errorMsgs = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errorMsgs.length).toBeGreaterThan(0);
  });

  it('rejects with error when process emits a non-ENOENT error event', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'test');
    (currentMockProcess as EventEmitter).emit('error', new Error('boom'));

    await expect(promptPromise).rejects.toThrow('boom');
  });

  it('emits a friendly install hint on ENOENT (binary not on PATH)', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'test').catch(() => {});
    const err = Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' });
    (currentMockProcess as EventEmitter).emit('error', err);
    await promptPromise;

    const errStatuses = messages.filter((m: any) => m.type === 'status' && m.status === 'error');
    expect(errStatuses[0]).toBeDefined();
    expect((errStatuses[0] as any).detail).toMatch(/not installed/i);
  });

  it('passes extraArgs (validated) before the positional prompt', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, extraArgs: ['--verbose'] });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const args = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    expect(args).toContain('--verbose');
    expect(args.indexOf('--verbose')).toBeLessThan(args.length - 1);
    expect(args[args.length - 1]).toBe('Hello');
  });

  it('rejects extraArgs with shell metacharacters', async () => {
    const { backend } = createKiroBackend({ ...BASE_OPTIONS, extraArgs: ['--config=$(malicious)'] });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, 'test')).rejects.toThrow('Unsafe character');
  });

  it('emits "running" status when sendPrompt is called', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('running');
  });
});

// ===========================================================================
// KiroBackend — plain-text stdout passthrough (VERIFIED behavior)
// ===========================================================================

describe('KiroBackend — plain-text stdout', () => {
  it('emits each stdout chunk as a model-output delta', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, ['Here is my ', 'AWS analysis']);
    await promptPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(2);
    expect((textMessages[0] as any).textDelta).toBe('Here is my ');
    expect((textMessages[1] as any).textDelta).toBe('AWS analysis');
  });

  it('strips ANSI/terminal control codes from model-output', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    // Real kiro-cli styles its markdown reply with CSI color codes + cursor
    // show/hide. We strip them so only the model text reaches the app.
    const ESC = String.fromCharCode(27);
    const styled = ESC + "[?25l" + ESC + "[1;36mHello" + ESC + "[0m, world!" + ESC + "[?25h";
    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [styled]);
    await promptPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(1);
    expect((textMessages[0] as any).textDelta).toBe('Hello, world!');
    // No raw escape bytes should remain.
    // eslint-disable-next-line no-control-regex
    expect((textMessages[0] as any).textDelta).not.toMatch(new RegExp(String.fromCharCode(27)));
  });

  it('passes through plain text that happens to start with "{" (no JSON parsing)', async () => {
    // WHY: the old impl parsed a fabricated JSONL schema. The real kiro-cli emits
    // plain prose; a line beginning with "{" must still surface verbatim.
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, ['{ "this": "is just text kiro printed" }']);
    await promptPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(1);
    expect((textMessages[0] as any).textDelta).toContain('is just text kiro printed');
  });

  it('emits "idle" status on clean (code 0) exit', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, ['done thinking'], 0);
    await promptPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('idle');
  });

  it('does NOT emit usage/cost/tool/fs-edit events (kiro-cli has no schema for them)', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Write a file');
    simulateProcess(currentMockProcess, ['I wrote the file for you.']);
    await promptPromise;

    expect(messages.filter((m: any) => m.type === 'token-count')).toHaveLength(0);
    expect(messages.filter((m: any) => m.type === 'cost-report')).toHaveLength(0);
    expect(messages.filter((m: any) => m.type === 'tool-call')).toHaveLength(0);
    expect(messages.filter((m: any) => m.type === 'tool-result')).toHaveLength(0);
    expect(messages.filter((m: any) => m.type === 'fs-edit')).toHaveLength(0);
  });
});

// ===========================================================================
// DELETED — invented JSONL event schema + credit-cost tracking
// ===========================================================================
//
// SCHEMA UNVERIFIED / NONEXISTENT (#30 — kiro-cli emits no structured output):
// kiro-cli v2.6.1 has NO JSON/stream output mode for chat. The prior suite's
// `KiroBackend — JSONL output parsing`, `credit-based cost tracking`, `fs-edit
// detection`, and `cost-report emission` blocks asserted a fabricated
// `{message, tool_call, tool_result, usage:{credits_consumed}, finish}` schema
// and a `KIRO_CREDIT_TO_USD` (1 credit = $0.01) billing model that the real
// binary does not produce. They were DELETED rather than skipped because there
// is nothing real to replace them with — kiro-cli writes plain text to stdout
// and emits no usage/cost/tool telemetry. The plain-text passthrough block above
// is the complete verified behavior.

// ===========================================================================
// KiroBackend — cancellation
// ===========================================================================

describe('KiroBackend — cancellation', () => {
  it('cancel sends SIGTERM to the running process', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    // Start a prompt but do not resolve it — keep the process running
    backend.sendPrompt(sessionId, 'Long running task').catch(() => {});
    const killSpy = vi.spyOn(currentMockProcess, 'kill');

    await backend.cancel(sessionId);

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    // Clean up the dangling process
    currentMockProcess.emit('close', 0);
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

  // SCHEMA UNVERIFIED: the old test asserted a "y\n" stdin write. kiro-cli's
  // headless mode emits NO structured permission events and pre-authorizes tool
  // use at spawn via --trust-all-tools / --trust-tools, so there is no verified
  // over-stdin y/n channel. We no longer fabricate that write. (#30)
  it.skip('writes "y\\n" to stdin when approved (UNVERIFIED kiro permission channel — see #30)', () => {
    // Requires a keyed session to confirm whether kiro-cli ever prompts over stdin.
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
    simulateProcess(currentMockProcess, ['Hi from AWS']);
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
    simulateProcess(currentMockProcess, ['Invisible message']);
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
    simulateProcess(currentMockProcess, ['For all handlers']);
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
    simulateProcess(currentMockProcess, ['Resilient output']);
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

  it('marks backend as disposed', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('disposed');
  });

  it('calling dispose twice does not throw', async () => {
    const { backend } = createKiroBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});
