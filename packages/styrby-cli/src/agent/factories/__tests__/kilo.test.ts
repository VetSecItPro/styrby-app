/**
 * Tests for the Kilo agent backend factory.
 *
 * Kilo is an OpenCode fork. Its headless surface (`kilo run <message> --format
 * json`) and event envelope (`{ type, sessionID, part }`) were VERIFIED against
 * the real `kilo` binary (v7.3.41, 2026-06-11) via `kilo --help` /
 * `kilo run --help` and a live `kilo run "say OK" --format json --auto` (which
 * returned a real `error` event envelope). See kilo.ts header for the full
 * confirmed-facts table.
 *
 * SCHEMA UNVERIFIED — needs keyed session (#30): the success-path `text` and
 * `step_finish` `part` payloads could not be captured (no provider credentials
 * locally → 401 PAID_MODEL_AUTH_REQUIRED). Those tests assert the OpenCode-fork
 * shape on the well-founded fork assumption and are tagged for re-verification.
 *
 * Covers:
 * - `createKiloBackend` factory + `registerKiloAgent` registry integration
 * - session lifecycle, real spawn args, provider-scoped key injection
 * - JSON parsing: text → model-output, step_finish → cost-report, error event
 * - error handling, cancellation, permission response, disposal, line buffering
 *
 * All child_process and logger calls are mocked so no real Kilo binary is required.
 *
 * @module factories/__tests__/kilo.test.ts
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
import { createKiloBackend, registerKiloAgent, type KiloBackendOptions } from '../kilo';
import { agentRegistry } from '../../core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = spawn as unknown as MockInstance;

function collectMessages(backend: ReturnType<typeof createKiloBackend>['backend']) {
  const messages: unknown[] = [];
  backend.onMessage((msg) => messages.push(msg));
  return messages;
}

/**
 * Simulate Kilo output: emit lines as stdout data events, then close the process.
 */
function simulateProcess(proc: MockProcess, lines: string[] = [], exitCode = 0) {
  for (const line of lines) {
    (proc.stdout as EventEmitter).emit('data', Buffer.from(line + '\n'));
  }
  proc.emit('close', exitCode);
}

// ---- Real Kilo event builders (`{ type, sessionID, part }` envelope) ----

/** text event: assistant output rides in part.text (OpenCode-fork shape, #30). */
function kiloText(text: string, sessionID = 'ses_test'): string {
  return JSON.stringify({ type: 'text', sessionID, part: { type: 'text', text } });
}

/** step_finish event: usage rides on part.cost + part.tokens (OpenCode-fork shape, #30). */
function kiloStepFinish(
  opts: { cost?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  sessionID = 'ses_test',
): string {
  return JSON.stringify({
    type: 'step_finish',
    sessionID,
    part: {
      type: 'step-finish',
      reason: 'stop',
      cost: opts.cost,
      tokens: {
        input: opts.input,
        output: opts.output,
        cache: { read: opts.cacheRead, write: opts.cacheWrite },
      },
    },
  });
}

/** error event: VERIFIED nested shape error.data.message (captured from real binary). */
function kiloError(message: string, sessionID = 'ses_test'): string {
  return JSON.stringify({
    type: 'error',
    sessionID,
    error: { name: 'APIError', data: { message } },
  });
}

const BASE_OPTIONS: KiloBackendOptions = {
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
// createKiloBackend — factory function
// ===========================================================================

describe('createKiloBackend', () => {
  it('returns a backend instance and resolved model when model is provided', () => {
    const { backend, model } = createKiloBackend({ ...BASE_OPTIONS, model: 'openai/gpt-4o' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('openai/gpt-4o');
  });

  it('returns undefined model when no model is specified', () => {
    const { model } = createKiloBackend(BASE_OPTIONS);

    expect(model).toBeUndefined();
  });

  it('returns a backend implementing the full AgentBackend interface', () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);

    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
    expect(typeof backend.dispose).toBe('function');
  });

  it('does NOT spawn a process at creation time', () => {
    createKiloBackend(BASE_OPTIONS);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('accepts resumeSessionId option', () => {
    const { backend } = createKiloBackend({
      ...BASE_OPTIONS,
      resumeSessionId: 'ses_prev',
    });

    expect(backend).toBeDefined();
  });
});

// ===========================================================================
// registerKiloAgent
// ===========================================================================

describe('registerKiloAgent', () => {
  it('registers "kilo" in the global agent registry', () => {
    registerKiloAgent();

    expect(agentRegistry.has('kilo')).toBe(true);
  });

  it('registry can create a backend after registration', () => {
    registerKiloAgent();

    const backend = agentRegistry.create('kilo', { cwd: '/project' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
  });
});

// ===========================================================================
// KiloBackend — session lifecycle
// ===========================================================================

describe('KiloBackend — session lifecycle', () => {
  it('startSession returns a sessionId string', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const result = await backend.startSession();

    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('startSession emits "starting" then "idle" when no initial prompt given', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    await backend.startSession();

    const statuses = messages
      .filter((m: any) => m.type === 'status')
      .map((m: any) => m.status);

    expect(statuses).toContain('starting');
    expect(statuses).toContain('idle');
  });

  it('startSession with initial prompt spawns kilo', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);

    const sessionPromise = backend.startSession('Add authentication');
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
    const { backend } = createKiloBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('Backend has been disposed');
  });

  it('generates a unique sessionId for each backend instance', async () => {
    const { backend: b1 } = createKiloBackend(BASE_OPTIONS);
    const { backend: b2 } = createKiloBackend(BASE_OPTIONS);

    const { sessionId: id1 } = await b1.startSession();
    const { sessionId: id2 } = await b2.startSession();

    expect(id1).not.toBe(id2);
  });
});

// ===========================================================================
// KiloBackend — sendPrompt (REAL CLI surface)
// ===========================================================================

describe('KiloBackend — sendPrompt', () => {
  it('spawns kilo with the run subcommand, positional prompt, --format json --auto', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Add user auth');
    simulateProcess(currentMockProcess);
    await sendPromise;

    // VERIFIED real surface: `kilo run <message> --format json --auto`.
    // The prompt is POSITIONAL — there is no --prompt flag.
    const args = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    expect(args.slice(0, 5)).toEqual(['run', 'Add user auth', '--format', 'json', '--auto']);
  });

  it('does NOT pass the invented --prompt / --output / --no-interactive / --memory-bank flags', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const args = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    expect(args).not.toContain('--prompt');
    expect(args).not.toContain('--output');
    expect(args).not.toContain('--no-interactive');
    expect(args).not.toContain('--memory-bank');
    expect(args).not.toContain('--no-memory-bank');
    expect(args).not.toContain('--api-base');
    expect(args).not.toContain('--resume');
  });

  it('includes --model flag when model is specified', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, model: 'anthropic/claude-sonnet-4' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      expect.arrayContaining(['--model', 'anthropic/claude-sonnet-4']),
      expect.any(Object)
    );
  });

  it('includes --session flag when resumeSessionId is specified', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, resumeSessionId: 'ses_prev' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      expect.arrayContaining(['--session', 'ses_prev']),
      expect.any(Object)
    );
  });

  it('captures sessionID from events and passes --session on the next prompt', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const send1 = backend.sendPrompt(sessionId, 'first');
    simulateProcess(currentMockProcess, [kiloText('ok', 'ses_captured')]);
    await send1;

    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    const send2 = backend.sendPrompt(sessionId, 'second');
    simulateProcess(currentMockProcess);
    await send2;

    const args = (mockSpawn.mock.calls[1] as any[])[1] as string[];
    expect(args).toContain('--session');
    expect(args).toContain('ses_captured');
  });

  // Provider-scoped API key injection (audit 2026-05-05 HIGH fix).
  // See goose.test.ts for full rationale.

  it('anthropic key: injects ONLY ANTHROPIC_API_KEY', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, apiKey: 'sk-ant-real' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const envArg = (mockSpawn.mock.calls[0] as any[])[2].env;
    expect(envArg.ANTHROPIC_API_KEY).toBe('sk-ant-real');
    expect(envArg.OPENAI_API_KEY).toBeUndefined();
    expect(envArg.KILO_API_KEY).toBeUndefined();
  });

  it('openai key: injects ONLY OPENAI_API_KEY', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, apiKey: 'sk-openai-real' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const envArg = (mockSpawn.mock.calls[0] as any[])[2].env;
    expect(envArg.OPENAI_API_KEY).toBe('sk-openai-real');
    expect(envArg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(envArg.KILO_API_KEY).toBeUndefined();
  });

  it('google key: injects ONLY GOOGLE_API_KEY + GEMINI_API_KEY', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, apiKey: 'AIzaSyKilo' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const envArg = (mockSpawn.mock.calls[0] as any[])[2].env;
    expect(envArg.GOOGLE_API_KEY).toBe('AIzaSyKilo');
    expect(envArg.GEMINI_API_KEY).toBe('AIzaSyKilo');
    expect(envArg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(envArg.OPENAI_API_KEY).toBeUndefined();
  });

  it('throws when sendPrompt is called with wrong sessionId', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.sendPrompt('wrong-id', 'Hello')).rejects.toThrow('Invalid session ID');
  });

  it('throws when sendPrompt is called on a disposed backend', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    await backend.dispose();

    await expect(backend.sendPrompt(sessionId, 'Hello')).rejects.toThrow('Backend has been disposed');
  });

  it('rejects when kilo exits with non-zero code', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [], 1);

    await expect(sendPromise).rejects.toThrow('Kilo exited with code 1');
  });
});

// ===========================================================================
// KiloBackend — text events (part.text → model-output)
//
// SCHEMA UNVERIFIED — needs keyed session (#30): the part.text success-path
// shape mirrors OpenCode's verified schema on the fork assumption; re-verify
// against a real keyed Kilo session.
// ===========================================================================

describe('KiloBackend — text events', () => {
  it('emits model-output (fullText) from part.text on text events', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      kiloText('I will help you with that. '),
      kiloText('Let me read the codebase.'),
    ]);
    await sendPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(2);
    expect((textMessages[0] as any).fullText).toBe('I will help you with that. ');
    expect((textMessages[1] as any).fullText).toBe('Let me read the codebase.');
  });

  it('ignores text events without part.text', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      JSON.stringify({ type: 'text', sessionID: 'ses_test', part: { type: 'text' } }),
    ]);
    await sendPromise;

    expect(messages.filter((m: any) => m.type === 'model-output')).toHaveLength(0);
  });
});

// ===========================================================================
// KiloBackend — step_finish events (cost-report)
//
// SCHEMA UNVERIFIED — needs keyed session (#30): part.cost + part.tokens shape
// mirrors OpenCode's verified schema on the fork assumption.
// ===========================================================================

describe('KiloBackend — step_finish / cost-report', () => {
  it('emits token-count and cost-report from a step_finish event', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, model: 'anthropic/claude-sonnet-4' });
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      kiloStepFinish({ cost: 0.0123, input: 600, output: 250, cacheRead: 40, cacheWrite: 0 }),
    ]);
    await sendPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts).toHaveLength(1);
    expect((tokenCounts[0] as any).inputTokens).toBe(600);
    expect((tokenCounts[0] as any).outputTokens).toBe(250);

    const reports = messages.filter((m: any) => m.type === 'cost-report');
    expect(reports).toHaveLength(1);
    const r = (reports[0] as any).report;
    expect(r.agentType).toBe('kilo');
    expect(r.source).toBe('agent-reported');
    expect(r.billingModel).toBe('api-key');
    expect(r.costUsd).toBe(0.0123);
    expect(r.inputTokens).toBe(600);
    expect(r.outputTokens).toBe(250);
    expect(r.cacheReadTokens).toBe(40);
    expect(r.cacheWriteTokens).toBe(0);
  });

  it('cost-report timestamp is a valid ISO 8601 string', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [kiloStepFinish({ cost: 0.001, input: 10, output: 5 })]);
    await sendPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r).toBeDefined();
    expect(new Date(r.report.timestamp).toISOString()).toBe(r.report.timestamp);
  });
});

// ===========================================================================
// KiloBackend — error events (VERIFIED nested error.data.message shape)
// ===========================================================================

describe('KiloBackend — error events', () => {
  it('emits error status with the nested error.data.message detail', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [kiloError('Model API timeout')]);
    await sendPromise;

    const errorStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'error'
    );
    expect(errorStatuses.length).toBeGreaterThan(0);
    expect((errorStatuses[0] as any).detail).toBe('Model API timeout');
  });

  it('falls back to error.name when error.data.message is absent', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      JSON.stringify({ type: 'error', sessionID: 'ses_test', error: { name: 'APIError' } }),
    ]);
    await sendPromise;

    const errorStatus = messages.find(
      (m: any) => m.type === 'status' && m.status === 'error'
    ) as any;
    expect(errorStatus.detail).toBe('APIError');
  });

  it('emits error status on process spawn error (ENOENT install hint)', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello').catch(() => {});
    const err = Object.assign(new Error('spawn kilo ENOENT'), { code: 'ENOENT' });
    currentMockProcess.emit('error', err);
    await sendPromise;

    const errorStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'error'
    );
    expect(errorStatuses.length).toBeGreaterThan(0);
    expect((errorStatuses[0] as any).detail).toMatch(/not installed/i);
  });

  it('ignores non-JSON stdout lines without crashing', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      'Kilo v7.3.41 starting...',
      'Loading config...',
    ]);

    await expect(sendPromise).resolves.toBeUndefined();
  });
});

// ===========================================================================
// KiloBackend — cancellation
// ===========================================================================

describe('KiloBackend — cancellation', () => {
  it('sends SIGTERM on cancel', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Long task');
    const killSpy = vi.spyOn(currentMockProcess, 'kill');
    await backend.cancel(sessionId);

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    currentMockProcess.emit('close', 0);
    await sendPromise.catch(() => {});
  });

  it('throws when cancel is called with wrong sessionId', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.cancel('wrong-id')).rejects.toThrow('Invalid session ID');
  });

  it('emits "idle" after cancel', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    await backend.cancel(sessionId);

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('idle');
  });
});

// ===========================================================================
// KiloBackend — permission response (inherited emit-only behavior)
//
// Kilo runs headless with `--auto`, so there is no interactive y/n stdin
// protocol. The base class default just emits a permission-response message.
// ===========================================================================

describe('KiloBackend — permission response', () => {
  it('emits permission-response message when approved', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    await backend.startSession();
    const messages = collectMessages(backend);

    await backend.respondToPermission?.('req-123', true);

    const permResponses = messages.filter((m: any) => m.type === 'permission-response');
    expect(permResponses).toHaveLength(1);
    expect((permResponses[0] as any).id).toBe('req-123');
    expect((permResponses[0] as any).approved).toBe(true);
  });

  it('emits permission-response with approved=false', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    await backend.startSession();
    const messages = collectMessages(backend);

    await backend.respondToPermission?.('req-456', false);

    const permResponses = messages.filter((m: any) => m.type === 'permission-response');
    expect((permResponses[0] as any).approved).toBe(false);
  });
});

// ===========================================================================
// KiloBackend — dispose
// ===========================================================================

describe('KiloBackend — dispose', () => {
  it('marks backend as disposed', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('Backend has been disposed');
  });

  it('dispose is idempotent (safe to call twice)', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    await backend.dispose();

    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  it('clears message listeners on dispose', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    backend.onMessage((msg) => received.push(msg));
    await backend.dispose();

    const countAfterDispose = received.length;
    expect(received.length).toBe(countAfterDispose);
  });
});

// ===========================================================================
// KiloBackend — message handler registration
// ===========================================================================

describe('KiloBackend — message handler registration', () => {
  it('onMessage registers a handler that receives events', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    backend.onMessage((msg) => received.push(msg));
    await backend.startSession();

    expect(received.length).toBeGreaterThan(0);
  });

  it('offMessage removes a registered handler', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const received: unknown[] = [];
    const handler = (msg: unknown) => received.push(msg);
    backend.onMessage(handler);
    backend.offMessage(handler);

    await backend.startSession();

    expect(received).toHaveLength(0);
  });

  it('handler errors do not break other handlers', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
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
// KiloBackend — waitForResponseComplete
// ===========================================================================

describe('KiloBackend — waitForResponseComplete', () => {
  it('resolves immediately if no process is running', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    await backend.startSession();

    await expect(backend.waitForResponseComplete?.()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// KiloBackend — line buffer / chunked output handling
// ===========================================================================

describe('KiloBackend — line buffer handling', () => {
  it('handles JSON split across multiple data events', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');

    const json = kiloText('Split JSON content');
    const half1 = json.slice(0, Math.floor(json.length / 2));
    const half2 = json.slice(Math.floor(json.length / 2)) + '\n';

    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half1));
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half2));
    currentMockProcess.emit('close', 0);
    await sendPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(1);
    expect((textMessages[0] as any).fullText).toBe('Split JSON content');
  });

  it('processes a buffered incomplete line on process close', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    // Emit without trailing newline so it stays in the line buffer until close.
    (currentMockProcess.stdout as EventEmitter).emit(
      'data',
      Buffer.from(kiloText('buffered')),
    );
    currentMockProcess.emit('close', 0);
    await sendPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(1);
    expect((textMessages[0] as any).fullText).toBe('buffered');
  });
});
