/**
 * Tests for the Crush agent backend factory (Charmbracelet).
 *
 * REALITY CHECK (crush v0.76.0, verified 2026-06-10):
 * - Headless invocation is `crush run [flags] <prompt>` (prompt is a positional
 *   argument). Verified flags: --quiet, --model, --session, --continue, --cwd,
 *   --data-dir, --debug, --verbose, --small-model.
 * - crush has NO JSON/ACP output mode. `crush run` emits the model's reply as
 *   PLAIN TEXT on stdout. There is no --format/--no-tui/--message/--provider
 *   flag and no `{text_delta, usage, tool_call, done}` event schema.
 *
 * Because of that, this suite covers ONLY verified behavior: the real spawn
 * argv, plain-text stdout -> model-output passthrough, exit-code handling,
 * cancellation, dispose, and env-key injection. The previous suite's
 * invented-ACP-event blocks (tool events, usage/cost events, status/done JSON
 * events) are removed/skipped with a reason — they tested a fabricated schema.
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
 * Simulate `crush run` output: emit plain-text chunks as stdout data events,
 * then close the process. (crush emits plain text, NOT line-framed JSON.)
 */
function simulateProcess(proc: MockProcess, chunks: string[] = [], exitCode = 0) {
  for (const chunk of chunks) {
    (proc.stdout as EventEmitter).emit('data', Buffer.from(chunk));
  }
  proc.emit('close', exitCode);
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

  it('reports supportsTools=false (crush has no structured tool events)', () => {
    const { metadata } = createCrushBackend(BASE_OPTIONS);

    expect(metadata?.supportsTools).toBe(false);
    expect(metadata?.supportsStreaming).toBe(true);
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

  it('accepts provider and sessionName options', () => {
    const { backend } = createCrushBackend({
      ...BASE_OPTIONS,
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
// CrushBackend — sendPrompt (VERIFIED `crush run` invocation)
// ===========================================================================

describe('CrushBackend — sendPrompt invocation', () => {
  it('spawns `crush run --quiet <prompt>` with the prompt as a trailing positional', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Refactor auth');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const [bin, args] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    expect(bin).toBe('crush');
    // Subcommand first, prompt last (positional).
    expect(args[0]).toBe('run');
    expect(args).toContain('--quiet');
    expect(args[args.length - 1]).toBe('Refactor auth');
    // The fabricated flags must NOT be present.
    expect(args).not.toContain('--message');
    expect(args).not.toContain('--format');
    expect(args).not.toContain('--no-tui');
    expect(args).not.toContain('--provider');
  });

  it('includes --model flag (before the positional prompt) when model is specified', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, model: 'anthropic/claude-sonnet-4' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const args = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('anthropic/claude-sonnet-4');
    // Prompt stays the trailing positional.
    expect(args[args.length - 1]).toBe('Hello');
  });

  it('includes --session flag when sessionName is specified', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, sessionName: 'sess-123' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const args = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    const sessIdx = args.indexOf('--session');
    expect(sessIdx).toBeGreaterThanOrEqual(0);
    expect(args[sessIdx + 1]).toBe('sess-123');
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

  it('passes extraArgs (validated) before the positional prompt', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, extraArgs: ['--verbose'] });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const args = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    expect(args).toContain('--verbose');
    expect(args.indexOf('--verbose')).toBeLessThan(args.length - 1);
    expect(args[args.length - 1]).toBe('Hello');
  });

  it('rejects extraArgs with shell metacharacters', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, extraArgs: ['--flag; rm -rf /'] });
    const { sessionId } = await backend.startSession();

    await expect(backend.sendPrompt(sessionId, 'Hello')).rejects.toThrow('Unsafe character');
  });

  // Provider-scoped API key injection (audit 2026-05-05 HIGH fix).
  // See goose.test.ts for full rationale on why fan-out was a real bug.

  it('anthropic key: injects ONLY ANTHROPIC_API_KEY (no fan-out to OPENAI)', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, apiKey: 'sk-ant-real' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const envArg = (mockSpawn.mock.calls[0] as any[])[2].env;
    expect(envArg.ANTHROPIC_API_KEY).toBe('sk-ant-real');
    expect(envArg.OPENAI_API_KEY).toBeUndefined();
  });

  it('openai key: injects ONLY OPENAI_API_KEY', async () => {
    const { backend } = createCrushBackend({ ...BASE_OPTIONS, apiKey: 'sk-openai-real' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const envArg = (mockSpawn.mock.calls[0] as any[])[2].env;
    expect(envArg.OPENAI_API_KEY).toBe('sk-openai-real');
    expect(envArg.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('explicit provider option overrides sniffing', async () => {
    const { backend } = createCrushBackend({
      ...BASE_OPTIONS,
      apiKey: 'opaque-token-no-prefix',
      provider: 'openai',
    });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const envArg = (mockSpawn.mock.calls[0] as any[])[2].env;
    expect(envArg.OPENAI_API_KEY).toBe('opaque-token-no-prefix');
    expect(envArg.ANTHROPIC_API_KEY).toBeUndefined();
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
// CrushBackend — plain-text stdout passthrough (VERIFIED behavior)
// ===========================================================================

describe('CrushBackend — plain-text stdout', () => {
  it('emits each stdout chunk verbatim as a model-output delta', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, ['Hello, ', 'world!']);
    await sendPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(2);
    expect((textMessages[0] as any).textDelta).toBe('Hello, ');
    expect((textMessages[1] as any).textDelta).toBe('world!');
  });

  it('passes through plain text that happens to start with "{" (no JSON parsing)', async () => {
    // WHY: the old impl swallowed non-JSON and parsed JSON. The real crush emits
    // plain prose; a line beginning with "{" must still surface verbatim.
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, ['{ "this": "is just text crush printed" }']);
    await sendPromise;

    const textMessages = messages.filter((m: any) => m.type === 'model-output');
    expect(textMessages).toHaveLength(1);
    expect((textMessages[0] as any).textDelta).toContain('is just text crush printed');
  });

  it('emits "idle" status on clean (code 0) exit', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, ['done thinking'], 0);
    await sendPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('idle');
  });

  it('does NOT emit usage/cost/tool/fs-edit events (crush has no schema for them)', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Write a file');
    simulateProcess(currentMockProcess, ['I wrote the file for you.']);
    await sendPromise;

    expect(messages.filter((m: any) => m.type === 'token-count')).toHaveLength(0);
    expect(messages.filter((m: any) => m.type === 'cost-report')).toHaveLength(0);
    expect(messages.filter((m: any) => m.type === 'tool-call')).toHaveLength(0);
    expect(messages.filter((m: any) => m.type === 'tool-result')).toHaveLength(0);
    expect(messages.filter((m: any) => m.type === 'fs-edit')).toHaveLength(0);
  });
});

// ===========================================================================
// SKIPPED — invented ACP event schema (no machine-readable crush output exists)
// ===========================================================================

// SCHEMA UNVERIFIED: crush v0.76.0 has NO JSON/ACP output mode (`crush run`
// emits plain text). These blocks tested a fabricated `{text_delta, tool_call,
// tool_result, usage, status, done}` event stream that the real binary does not
// produce. They stay skipped (not deleted) as a record of what would need a
// keyed crush session to verify before any structured parsing is reintroduced
// (#30 — needs auth + captured real `--verbose`/`--debug` output).
describe.skip('CrushBackend — ACP JSON event parsing (FABRICATED SCHEMA — see #30)', () => {
  it('tool_call / tool_result events', () => {
    // No verified source. Requires keyed session capture (#30).
  });
  it('usage / cost-report events', () => {
    // No verified source. crush exposes no per-turn usage event. (#30)
  });
  it('status / done JSON events', () => {
    // No verified source. Status is implied by exit code, not JSON events. (#30)
  });
});

// ===========================================================================
// CrushBackend — error handling
// ===========================================================================

describe('CrushBackend — error handling', () => {
  it('emits error status on process spawn error', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    currentMockProcess.emit('error', new Error('spawn crush ENOENT'));

    await expect(sendPromise).rejects.toThrow();

    const errorStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'error'
    );
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('emits error status on stderr output containing "Error" (crush ANSI error box)', async () => {
    const { backend } = createCrushBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    // Real crush prints a styled "ERROR" box to stderr; our handler matches
    // case-insensitively on error keywords.
    (currentMockProcess.stderr as EventEmitter).emit(
      'data',
      Buffer.from('  ERROR  Agent processing failed: forbidden\n')
    );
    simulateProcess(currentMockProcess);
    await sendPromise;

    const errorStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'error'
    );
    expect(errorStatuses.length).toBeGreaterThan(0);
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

  // SCHEMA UNVERIFIED: the old test asserted a y\n stdin write. crush's headless
  // `run` mode has no confirmed over-stdin permission protocol (permissions are
  // config/--yolo driven), so we no longer fabricate that write. (#30)
  it.skip('writes "y\\n" to stdin when approved (UNVERIFIED crush permission channel — see #30)', () => {
    // Requires a keyed session to confirm whether crush ever prompts over stdin.
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
});
