/**
 * Tests for the Amp agent backend factory (ampcode.com).
 *
 * Covers:
 * - `createAmpBackend` factory function
 * - `registerAmpAgent` registry integration
 * - `AmpBackend` class: session lifecycle, subprocess management, the REAL
 *   `amp -x "<prompt>" --stream-json` invocation (verified against
 *   `amp --help`), Claude Code-compatible stream-json parsing, AMP_API_KEY-only
 *   auth injection, error handling, cancellation, and disposal.
 *
 * Stream-json schema source: `amp --help` documents `--stream-json` as
 * "Claude Code-compatible stream JSON format", so the event shape is the same
 * newline-delimited `{type:'assistant',message:{content:[...],usage:{...}}}` /
 * `{type:'result'}` schema the `claude` factory parses. The exact bytes could
 * NOT be captured live (running `amp -x ... --stream-json` triggers `amp login`
 * with no AMP_API_KEY available) — see #30. Tests therefore assert the
 * claude-compatible shape; any assertion needing real keyed output is skipped
 * with a reason.
 *
 * All child_process and logger calls are mocked so no real Amp binary
 * is required.
 *
 * @module factories/__tests__/amp.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// ---------------------------------------------------------------------------
// Mocks — declared before the module under test is imported
// ---------------------------------------------------------------------------

// WHY PassThrough (not a bare EventEmitter): the rewritten AmpBackend consumes
// stdout via the base class's node:readline `streamLines()`, which requires a
// real Readable (`resume`/`pause`/`read`). PassThrough exposes the full Readable
// API while still letting tests push bytes via `.write()` / `.emit('data', buf)`.
function makeStream(): PassThrough {
  return new PassThrough();
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
 * Simulate Amp stream-json output: write newline-delimited lines to the stdout
 * PassThrough (so the backend's readline emits 'line' events), end the streams,
 * then fire the process 'close' on the next tick.
 *
 * WHY nextTick (mirrors aider.test): 'close' must fire AFTER readline has flushed
 * the buffered lines, otherwise the close handler resolves before any line is
 * parsed and the emitted-message assertions race.
 */
function simulateProcess(proc: MockProcess, lines: string[] = [], exitCode = 0) {
  for (const line of lines) {
    (proc.stdout as PassThrough).write(line + '\n');
  }
  (proc.stdout as PassThrough).end();
  (proc.stderr as PassThrough).end();
  process.nextTick(() => proc.emit('close', exitCode));
}

// ---- Amp stream-json event builders (Claude Code-compatible schema) ----
// Source: `amp --help` ("Claude Code-compatible stream JSON format") + the
// verified claude factory schema. See module header / #30.

/** assistant line carrying a text block. */
function ampAssistantText(text: string, model = 'amp-default'): string {
  return JSON.stringify({
    type: 'assistant',
    message: { model, content: [{ type: 'text', text }] },
  });
}

/** assistant line carrying a tool_use block. */
function ampToolUse(toolName: string, id: string, input?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: toolName, id, input }] },
  });
}

/** user line echoing a tool_result block (Claude Code shape). */
function ampToolResult(toolUseId: string, content: unknown): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  });
}

/** assistant line whose usage block drives cost extraction. */
function ampAssistantUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}, model = 'amp-default'): string {
  return JSON.stringify({
    type: 'assistant',
    message: { model, usage, content: [] },
  });
}

/** terminal result line. */
function ampResult(): string {
  return JSON.stringify({ type: 'result' });
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
  it('spawns amp in execute mode with -x <prompt> --stream-json', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'Analyze the auth module');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('amp');
    // -x must be immediately followed by the prompt (positional message form).
    expect(args[0]).toBe('-x');
    expect(args[1]).toBe('Analyze the auth module');
    expect(args).toContain('--stream-json');
  });

  it('does NOT use the invented "chat"/"--message"/"--format" flags', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('chat');
    expect(args).not.toContain('--message');
    expect(args).not.toContain('--format');
    expect(args).not.toContain('--no-interactive');
  });

  it('includes --mode when a mode is specified', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, mode: 'deep' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--mode');
    expect(args).toContain('deep');
  });

  it('does NOT include --mode when mode is omitted', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--mode');
  });

  it('does NOT include the invented --deep / --max-agents / --session flags', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, mode: 'deep' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).not.toContain('--deep');
    expect(args).not.toContain('--max-agents');
    expect(args).not.toContain('--session');
  });

  it('appends extraArgs to the spawn call', async () => {
    const { backend } = createAmpBackend({
      ...BASE_OPTIONS,
      extraArgs: ['--effort', 'high'],
    });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--effort');
    expect(args).toContain('high');
  });

  it('injects ONLY AMP_API_KEY (no cross-vendor ANTHROPIC_API_KEY leak)', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, apiKey: 'amp-key-456' });
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess);
    await promptPromise;

    const [, , spawnOptions] = mockSpawn.mock.calls[0];
    expect(spawnOptions.env.AMP_API_KEY).toBe('amp-key-456');
    // SECURITY: the Amp token must NOT be forwarded to the Anthropic var.
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
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
// AmpBackend — stream-json parsing and event emission (Claude-compatible)
// ===========================================================================

describe('AmpBackend — stream-json parsing and event emission', () => {
  it('emits model-output for an assistant text block', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [ampAssistantText('Here is your refactored code.')]);
    await promptPromise;

    const outputs = messages.filter((m: any) => m.type === 'model-output');
    expect(outputs.length).toBeGreaterThan(0);
    // Claude-compatible parser emits fullText (not incremental textDelta).
    const text = outputs.map((m: any) => m.fullText).join('');
    expect(text).toContain('Here is your refactored code.');
  });

  it('does not emit model-output when an assistant block has no text', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text' }] } }),
    ]);
    await promptPromise;

    expect(messages.filter((m: any) => m.type === 'model-output').length).toBe(0);
  });

  it('emits tool-call for an assistant tool_use block', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampToolUse('Grep', 'call-10', { pattern: '*.ts' }),
    ]);
    await promptPromise;

    const toolCalls = messages.filter((m: any) => m.type === 'tool-call');
    expect(toolCalls.length).toBe(1);
    const call = toolCalls[0] as any;
    expect(call.toolName).toBe('Grep');
    expect(call.callId).toBe('call-10');
    expect(call.args.pattern).toBe('*.ts');
  });

  it('emits tool-result for a user tool_result block', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampToolResult('call-11', 'const x = 1;'),
    ]);
    await promptPromise;

    const toolResults = messages.filter((m: any) => m.type === 'tool-result');
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).callId).toBe('call-11');
    expect((toolResults[0] as any).result).toBe('const x = 1;');
  });

  it('emits fs-edit when an assistant tool_use is a Write with file_path', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampToolUse('Write', 'call-12', { file_path: 'src/payments.ts' }),
    ]);
    await promptPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits.length).toBe(1);
    const edit = fsEdits[0] as any;
    expect(edit.path).toBe('src/payments.ts');
    expect(edit.description).toContain('Write');
    expect(edit.description).toContain('src/payments.ts');
  });

  it('emits fs-edit for an Edit tool with path input key', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampToolUse('Edit', 'call-13', { path: 'lib/db.ts' }),
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
      ampToolUse('Bash', 'call-14', { command: 'ls' }),
    ]);
    await promptPromise;

    expect(messages.filter((m: any) => m.type === 'fs-edit').length).toBe(0);
  });

  it('emits a cost-report from an assistant usage block (via shared claude parser)', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampAssistantUsage({ input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 50 }),
    ]);
    await promptPromise;

    const reports = messages.filter((m: any) => m.type === 'cost-report');
    expect(reports.length).toBe(1);
    const r = (reports[0] as any).report;
    expect(r.inputTokens).toBe(500);
    expect(r.outputTokens).toBe(200);
    expect(r.cacheReadTokens).toBe(50);
  });

  // SKIP (#30 — needs keyed session): The exact field name Amp uses for an
  // agent-reported USD cost (claude's stream-json carries no per-line cost; the
  // total only appears on the `result` line) could not be byte-verified without
  // a live keyed run. The shared claude parser sets costUsd=0 from usage lines,
  // so a precise per-event cost assertion would be testing an unverified shape.
  it.skip('reports a precise per-event USD cost (UNVERIFIED — needs keyed amp session, #30)', () => {});

  it('ignores non-JSON stdout lines without crashing', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      'Initializing Amp...',
      ampAssistantText('Done.'),
    ]);

    await expect(promptPromise).resolves.not.toThrow();
  });

  it('handles partial/malformed JSON lines without crashing', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      '{ broken',
      ampAssistantText('Recovered.'),
    ]);

    await expect(promptPromise).resolves.not.toThrow();
  });

  it('handles stdout chunks split across multiple data events', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const fullLine = ampAssistantText('Chunked response from Amp');
    const half1 = fullLine.slice(0, Math.floor(fullLine.length / 2));
    const half2 = fullLine.slice(Math.floor(fullLine.length / 2)) + '\n';

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half1));
    (currentMockProcess.stdout as EventEmitter).emit('data', Buffer.from(half2));
    currentMockProcess.emit('close', 0);
    await promptPromise;

    const outputs = messages.filter((m: any) => m.type === 'model-output');
    const text = outputs.map((m: any) => m.fullText).join('');
    expect(text).toContain('Chunked response from Amp');
  });

  it('emits idle status after the result line + clean exit', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [ampResult()], 0);
    await promptPromise;

    const lastStatus = messages
      .filter((m: any) => m.type === 'status')
      .at(-1) as any;

    expect(lastStatus?.status).toBe('idle');
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

  // WHY removed: the prior factory scanned stderr text for "Error"/"failed" and
  // synthesized an error status. The rewrite mirrors ClaudeBackend — stderr is
  // debug-logged only; real failures surface via a non-zero exit code (covered
  // above) or the process 'error' event (covered below). Heuristic stderr-string
  // matching produced false-positive error frames (e.g. amp printing a benign
  // "no errors found" line), so it is intentionally gone.

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

  // WHY removed (2 tests): the prior factory wrote 'y\n'/'n\n' to amp's stdin to
  // answer an interactive permission prompt. That flow does not exist — execute
  // mode (`amp -x`) is non-interactive and is spawned with stdin ignored. The
  // base StreamingAgentBackendBase.respondToPermission is emit-only (verified by
  // the two tests above), which is the correct behavior for amp.
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
 * Tests for the unified CostReport event emitted from Amp's stream-json usage.
 *
 * WHY: migration 022 persists billing_model / source / raw_agent_payload. Amp is
 * BYOK (AMP_API_KEY) so it always emits source=agent-reported, billingModel=
 * api-key. The report is built by re-stamping the shared claude parser's output
 * with agentType='amp', so the schema stays single-owner.
 *
 * SCHEMA NOTE (#30): usage field names mirror claude's verified stream-json
 * (`input_tokens` / `cache_read_input_tokens` / etc.). Not byte-verified against
 * a real keyed amp run — see the cost-precision skip in the parsing describe.
 */
describe('AmpBackend — cost-report emission', () => {
  it('emits cost-report with billingModel=api-key and source=agent-reported on a usage line', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampAssistantUsage(
        { input_tokens: 800, output_tokens: 300, cache_read_input_tokens: 50 },
        'claude-sonnet-4',
      ),
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

  it('re-stamps the report model from options when provided', async () => {
    const { backend } = createAmpBackend({ ...BASE_OPTIONS, model: 'amp-smart' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'task');
    simulateProcess(currentMockProcess, [
      ampAssistantUsage({ input_tokens: 300, output_tokens: 100 }, 'some-other-model'),
    ]);
    await promptPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r.report.model).toBe('amp-smart');
  });

  it('cost-report has messageId=null (Amp does not expose per-message IDs)', async () => {
    const { backend } = createAmpBackend(BASE_OPTIONS);
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      ampAssistantUsage({ input_tokens: 10, output_tokens: 5 }),
    ]);
    await promptPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r.report.messageId).toBeNull();
  });
});
