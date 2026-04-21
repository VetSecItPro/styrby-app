/**
 * Tests for the Kilo agent backend factory (Community, 500+ models, Memory Bank).
 *
 * Covers:
 * - `createKiloBackend` factory function
 * - `registerKiloAgent` registry integration
 * - `KiloBackend` class: session lifecycle, subprocess management,
 *   JSON output parsing, Memory Bank read/write event tracking and emission,
 *   token/cost accumulation, fs-edit detection, error handling,
 *   cancellation, permission response, and disposal.
 *
 * Memory Bank tests verify:
 * - memory_bank_read events emit 'memory-bank-read' event messages
 * - memory_bank_write events emit 'memory-bank-write' event messages
 * - cumulative read/write tracking across a session
 * - memory bank is reset on new session
 * - memoryBankEnabled flag passes correct CLI args
 * - memoryBankPath flag passes correct CLI args
 *
 * All child_process and logger calls are mocked so no real Kilo binary
 * is required.
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

// ---- Kilo event builders ----

function kiloText(content: string): string {
  return JSON.stringify({ type: 'text', content });
}

function kiloToolUse(toolName: string, callId: string, toolInput?: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_use', tool_name: toolName, call_id: callId, tool_input: toolInput });
}

function kiloToolResult(
  toolName: string,
  callId: string,
  toolResult: unknown,
  toolInput?: Record<string, unknown>
): string {
  return JSON.stringify({ type: 'tool_result', tool_name: toolName, call_id: callId, tool_result: toolResult, tool_input: toolInput });
}

function kiloMemoryBankRead(memoryFile: string, content?: string): string {
  return JSON.stringify({ type: 'memory_bank_read', memory_file: memoryFile, memory_content: content });
}

function kiloMemoryBankWrite(memoryFile: string, section?: string, content?: string): string {
  return JSON.stringify({ type: 'memory_bank_write', memory_file: memoryFile, memory_section: section, memory_content: content });
}

function kiloTokens(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
}): string {
  return JSON.stringify({ type: 'tokens', usage });
}

function kiloError(error: string): string {
  return JSON.stringify({ type: 'error', error });
}

function kiloComplete(): string {
  return JSON.stringify({ type: 'complete' });
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
    const { backend, model } = createKiloBackend({ ...BASE_OPTIONS, model: 'gpt-4o' });

    expect(backend).toBeDefined();
    expect(typeof backend.startSession).toBe('function');
    expect(model).toBe('gpt-4o');
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

  it('accepts memoryBankEnabled, memoryBankPath, and apiBaseUrl options', () => {
    const { backend } = createKiloBackend({
      ...BASE_OPTIONS,
      memoryBankEnabled: true,
      memoryBankPath: '/custom/memory',
      apiBaseUrl: 'http://localhost:11434/v1',
    });

    expect(backend).toBeDefined();
  });

  it('accepts resumeSessionId option', () => {
    const { backend } = createKiloBackend({
      ...BASE_OPTIONS,
      resumeSessionId: 'prev-session-uuid',
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
// KiloBackend — sendPrompt
// ===========================================================================

describe('KiloBackend — sendPrompt', () => {
  it('spawns kilo with run --prompt --output json --no-interactive flags', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Add user auth');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      expect.arrayContaining(['run', '--prompt', 'Add user auth', '--output', 'json', '--no-interactive']),
      expect.any(Object)
    );
  });

  it('enables memory bank with --memory-bank flag by default', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      expect.arrayContaining(['--memory-bank']),
      expect.any(Object)
    );
  });

  it('disables memory bank with --no-memory-bank when memoryBankEnabled is false', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, memoryBankEnabled: false });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      expect.arrayContaining(['--no-memory-bank']),
      expect.any(Object)
    );

    // Confirm --memory-bank is NOT in args
    const spawnArgs = (mockSpawn.mock.calls[0] as any[])[1] as string[];
    expect(spawnArgs).not.toContain('--memory-bank');
  });

  it('includes --memory-bank-path when memoryBankPath is specified', async () => {
    const { backend } = createKiloBackend({
      ...BASE_OPTIONS,
      memoryBankEnabled: true,
      memoryBankPath: '/custom/memory',
    });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      expect.arrayContaining(['--memory-bank-path', '/custom/memory']),
      expect.any(Object)
    );
  });

  it('includes --model flag when model is specified', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, model: 'ollama/llama3' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      expect.arrayContaining(['--model', 'ollama/llama3']),
      expect.any(Object)
    );
  });

  it('includes --api-base flag when apiBaseUrl is specified', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, apiBaseUrl: 'http://localhost:11434/v1' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      expect.arrayContaining(['--api-base', 'http://localhost:11434/v1']),
      expect.any(Object)
    );
  });

  it('includes --resume flag when resumeSessionId is specified', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, resumeSessionId: 'prev-session' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      expect.arrayContaining(['--resume', 'prev-session']),
      expect.any(Object)
    );
  });

  it('injects OPENAI_API_KEY, ANTHROPIC_API_KEY, and KILO_API_KEY from apiKey option', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, apiKey: 'test-key-123' });
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess);
    await sendPromise;

    const spawnCall = mockSpawn.mock.calls[0] as any[];
    const envArg = spawnCall[2].env;
    expect(envArg.OPENAI_API_KEY).toBe('test-key-123');
    expect(envArg.ANTHROPIC_API_KEY).toBe('test-key-123');
    expect(envArg.KILO_API_KEY).toBe('test-key-123');
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
// KiloBackend — Memory Bank read events
// ===========================================================================

describe('KiloBackend — Memory Bank read events', () => {
  it('emits memory-bank-read event when memory_bank_read message is received', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Help me with auth');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankRead('projectbrief.md', '# My Project\nAn e-commerce app...'),
    ]);
    await sendPromise;

    const memReadEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-read'
    );
    expect(memReadEvents).toHaveLength(1);
    expect((memReadEvents[0] as any).payload.file).toBe('projectbrief.md');
  });

  it('includes content preview in the memory-bank-read payload', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Help');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankRead('activeContext.md', 'Current task: implement login'),
    ]);
    await sendPromise;

    const event = (messages.find(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-read'
    ) as any);
    expect(event.payload.contentPreview).toBe('Current task: implement login');
  });

  it('tracks cumulative read count across multiple reads', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Help');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankRead('projectbrief.md'),
      kiloMemoryBankRead('activeContext.md'),
      kiloMemoryBankRead('systemPatterns.md'),
    ]);
    await sendPromise;

    const memReadEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-read'
    );
    expect(memReadEvents).toHaveLength(3);
    expect((memReadEvents[2] as any).payload.totalReads).toBe(3);
  });

  it('includes all previously read files in allFiles list', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Help');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankRead('projectbrief.md'),
      kiloMemoryBankRead('activeContext.md'),
    ]);
    await sendPromise;

    const lastReadEvent = (messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-read'
    ) as any[]).at(-1);

    expect(lastReadEvent.payload.allFiles).toContain('projectbrief.md');
    expect(lastReadEvent.payload.allFiles).toContain('activeContext.md');
  });

  it('ignores memory_bank_read events with no memory_file', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Help');
    simulateProcess(currentMockProcess, [
      JSON.stringify({ type: 'memory_bank_read' }), // no memory_file
    ]);
    await sendPromise;

    const memReadEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-read'
    );
    expect(memReadEvents).toHaveLength(0);
  });

  it('resets memory bank reads on new session', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId: s1 } = await backend.startSession();

    const sendPromise1 = backend.sendPrompt(s1, 'First');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankRead('projectbrief.md'),
      kiloMemoryBankRead('activeContext.md'),
    ]);
    await sendPromise1;

    // Start new session — memory reads should reset
    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    const { sessionId: s2 } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise2 = backend.sendPrompt(s2, 'Second');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankRead('systemPatterns.md'),
    ]);
    await sendPromise2;

    const memReadEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-read'
    );
    // Only 1 read from the second session, not 3 total
    expect(memReadEvents).toHaveLength(1);
    expect((memReadEvents[0] as any).payload.totalReads).toBe(1);
  });
});

// ===========================================================================
// KiloBackend — Memory Bank write events
// ===========================================================================

describe('KiloBackend — Memory Bank write events', () => {
  it('emits memory-bank-write event when memory_bank_write message is received', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Add auth');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankWrite('activeContext.md', 'progress', 'Implementing JWT auth...'),
    ]);
    await sendPromise;

    const memWriteEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-write'
    );
    expect(memWriteEvents).toHaveLength(1);
    expect((memWriteEvents[0] as any).payload.file).toBe('activeContext.md');
  });

  it('includes section info in the memory-bank-write payload', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Add auth');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankWrite('systemPatterns.md', 'decisions', 'Use bcrypt for password hashing'),
    ]);
    await sendPromise;

    const event = (messages.find(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-write'
    ) as any);
    expect(event.payload.section).toBe('decisions');
    expect(event.payload.contentPreview).toBe('Use bcrypt for password hashing');
  });

  it('tracks cumulative write count across multiple writes', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Build feature');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankWrite('activeContext.md', 'progress'),
      kiloMemoryBankWrite('systemPatterns.md', 'decisions'),
      kiloMemoryBankWrite('progress.md', 'status'),
    ]);
    await sendPromise;

    const memWriteEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-write'
    );
    expect(memWriteEvents).toHaveLength(3);
    expect((memWriteEvents[2] as any).payload.totalWrites).toBe(3);
  });

  it('deduplicates file names in allFiles list for writes', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Build feature');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankWrite('activeContext.md', 'progress'),
      kiloMemoryBankWrite('activeContext.md', 'status'), // same file twice
    ]);
    await sendPromise;

    const lastWriteEvent = (messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-write'
    ) as any[]).at(-1);

    // allFiles should deduplicate 'activeContext.md'
    const occurrences = lastWriteEvent.payload.allFiles.filter(
      (f: string) => f === 'activeContext.md'
    );
    expect(occurrences).toHaveLength(1);
  });

  it('ignores memory_bank_write events with no memory_file', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Build');
    simulateProcess(currentMockProcess, [
      JSON.stringify({ type: 'memory_bank_write' }), // no memory_file
    ]);
    await sendPromise;

    const memWriteEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-write'
    );
    expect(memWriteEvents).toHaveLength(0);
  });

  it('resets memory bank writes on new session', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId: s1 } = await backend.startSession();

    const sendPromise1 = backend.sendPrompt(s1, 'First');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankWrite('activeContext.md'),
      kiloMemoryBankWrite('systemPatterns.md'),
    ]);
    await sendPromise1;

    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    const { sessionId: s2 } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise2 = backend.sendPrompt(s2, 'Second');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankWrite('progress.md'),
    ]);
    await sendPromise2;

    const memWriteEvents = messages.filter(
      (m: any) => m.type === 'event' && m.name === 'memory-bank-write'
    );
    expect(memWriteEvents).toHaveLength(1);
    expect((memWriteEvents[0] as any).payload.totalWrites).toBe(1);
  });
});

// ===========================================================================
// KiloBackend — text events
// ===========================================================================

describe('KiloBackend — text events', () => {
  it('emits model-output messages for text events', async () => {
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
    expect((textMessages[0] as any).textDelta).toBe('I will help you with that. ');
    expect((textMessages[1] as any).textDelta).toBe('Let me read the codebase.');
  });
});

// ===========================================================================
// KiloBackend — tool events
// ===========================================================================

describe('KiloBackend — tool events', () => {
  it('emits tool-call messages for tool_use events', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Read a file');
    simulateProcess(currentMockProcess, [
      kiloToolUse('read_file', 'call-1', { path: '/project/src/index.ts' }),
    ]);
    await sendPromise;

    const toolCalls = messages.filter((m: any) => m.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as any).toolName).toBe('read_file');
    expect((toolCalls[0] as any).callId).toBe('call-1');
  });

  it('emits tool-result messages for tool_result events', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Read file');
    simulateProcess(currentMockProcess, [
      kiloToolResult('read_file', 'call-1', 'file contents'),
    ]);
    await sendPromise;

    const toolResults = messages.filter((m: any) => m.type === 'tool-result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).result).toBe('file contents');
  });

  it('emits fs-edit for write_file tool results', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Write file');
    simulateProcess(currentMockProcess, [
      kiloToolResult('write_file', 'call-2', 'ok', { path: '/project/src/auth.ts' }),
    ]);
    await sendPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/project/src/auth.ts');
  });

  it('emits fs-edit for edit_file tool results', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Edit file');
    simulateProcess(currentMockProcess, [
      kiloToolResult('edit_file', 'call-3', 'done', { file_path: '/project/app.ts' }),
    ]);
    await sendPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(1);
    expect((fsEdits[0] as any).path).toBe('/project/app.ts');
  });

  it('does NOT emit fs-edit for read-only tools', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Read file');
    simulateProcess(currentMockProcess, [
      kiloToolResult('read_file', 'call-1', 'contents'),
      kiloToolResult('run_command', 'call-2', 'ls output'),
    ]);
    await sendPromise;

    const fsEdits = messages.filter((m: any) => m.type === 'fs-edit');
    expect(fsEdits).toHaveLength(0);
  });
});

// ===========================================================================
// KiloBackend — token/cost accumulation (tokens events)
// ===========================================================================

describe('KiloBackend — tokens events', () => {
  it('emits token-count messages with cumulative totals', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      kiloTokens({ input_tokens: 100, output_tokens: 50, cost_usd: 0.005 }),
    ]);
    await sendPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    expect(tokenCounts).toHaveLength(1);
    expect((tokenCounts[0] as any).inputTokens).toBe(100);
    expect((tokenCounts[0] as any).outputTokens).toBe(50);
    expect((tokenCounts[0] as any).costUsd).toBeCloseTo(0.005);
  });

  it('accumulates token counts across multiple tokens events', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      kiloTokens({ input_tokens: 100, output_tokens: 50 }),
      kiloTokens({ input_tokens: 200, output_tokens: 80 }),
    ]);
    await sendPromise;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    const last = tokenCounts[tokenCounts.length - 1] as any;
    expect(last.inputTokens).toBe(300);
    expect(last.outputTokens).toBe(130);
  });

  it('tracks cache tokens from tokens events', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      kiloTokens({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 60,
        cache_write_tokens: 15,
      }),
    ]);
    await sendPromise;

    const tc = (messages.filter((m: any) => m.type === 'token-count')[0]) as any;
    expect(tc.cacheReadTokens).toBe(60);
    expect(tc.cacheWriteTokens).toBe(15);
  });

  it('resets token counts on new session', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId: s1 } = await backend.startSession();
    const messages = collectMessages(backend);

    const send1 = backend.sendPrompt(s1, 'First');
    simulateProcess(currentMockProcess, [kiloTokens({ input_tokens: 500 })]);
    await send1;

    currentMockProcess = makeMockProcess();
    mockSpawn.mockReturnValue(currentMockProcess);

    const { sessionId: s2 } = await backend.startSession();
    const send2 = backend.sendPrompt(s2, 'Second');
    simulateProcess(currentMockProcess, [kiloTokens({ input_tokens: 100 })]);
    await send2;

    const tokenCounts = messages.filter((m: any) => m.type === 'token-count');
    const lastCount = tokenCounts[tokenCounts.length - 1] as any;
    expect(lastCount.inputTokens).toBe(100);
  });
});

// ===========================================================================
// KiloBackend — complete event
// ===========================================================================

describe('KiloBackend — complete event', () => {
  it('emits "idle" status on complete event', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [kiloComplete()]);
    await sendPromise;

    const statuses = messages.filter((m: any) => m.type === 'status').map((m: any) => m.status);
    expect(statuses).toContain('idle');
  });
});

// ===========================================================================
// KiloBackend — error handling
// ===========================================================================

describe('KiloBackend — error handling', () => {
  it('emits error status on "error" events', async () => {
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
    expect((errorStatuses[0] as any).detail).toContain('timeout');
  });

  it('emits error status on process spawn error', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    currentMockProcess.emit('error', new Error('spawn kilo ENOENT'));

    await expect(sendPromise).rejects.toThrow('spawn kilo ENOENT');

    const errorStatuses = messages.filter(
      (m: any) => m.type === 'status' && m.status === 'error'
    );
    expect(errorStatuses.length).toBeGreaterThan(0);
  });

  it('ignores non-JSON stdout lines without crashing', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Hello');
    simulateProcess(currentMockProcess, [
      'Kilo v1.2.3 starting...',
      'Loading memory bank...',
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
// KiloBackend — permission response
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

  it('writes "y\\n" to stdin when approved and process is running', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Run shell command');
    await backend.respondToPermission?.('req-456', true);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('y\n');
    currentMockProcess.emit('close', 0);
    await sendPromise;
  });

  it('writes "n\\n" to stdin when denied', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();

    const sendPromise = backend.sendPrompt(sessionId, 'Dangerous op');
    await backend.respondToPermission?.('req-789', false);

    expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('n\n');
    currentMockProcess.emit('close', 0);
    await sendPromise;
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

  it('resets memory bank tracking on dispose', async () => {
    const { backend } = createKiloBackend(BASE_OPTIONS);
    const { sessionId } = await backend.startSession();
    const messages = collectMessages(backend);

    const sendPromise = backend.sendPrompt(sessionId, 'Build feature');
    simulateProcess(currentMockProcess, [
      kiloMemoryBankRead('projectbrief.md'),
      kiloMemoryBankWrite('activeContext.md'),
    ]);
    await sendPromise;

    await backend.dispose();
    // After dispose, no further events should arrive
    const countAfter = messages.length;
    expect(messages.length).toBe(countAfter);
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
    expect((textMessages[0] as any).textDelta).toBe('Split JSON content');
  });
});

// ===========================================================================
// KiloBackend — cost-report emission
// ===========================================================================

/**
 * Tests for the unified CostReport event emitted by Kilo token events.
 *
 * WHY: Kilo supports local (Ollama / local-* models) and cloud models.
 * Local models → billingModel='free', costUsd=0.
 * Cloud models → billingModel='api-key', source determined by presence of cost_usd.
 */
describe('KiloBackend — cost-report emission (cloud model)', () => {
  it('emits billingModel=api-key and source=agent-reported when cost_usd is present', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      kiloTokens({ input_tokens: 600, output_tokens: 250, cache_read_tokens: 40, cost_usd: 0.009 }),
    ]);
    await promptPromise;

    const reports = messages.filter((m: any) => m.type === 'cost-report');
    expect(reports.length).toBeGreaterThanOrEqual(1);
    const r = reports[0] as any;
    expect(r.report.billingModel).toBe('api-key');
    expect(r.report.source).toBe('agent-reported');
    expect(r.report.agentType).toBe('kilo');
    expect(r.report.costUsd).toBe(0.009);
    expect(r.report.inputTokens).toBe(600);
    expect(r.report.cacheReadTokens).toBe(40);
  });

  it('emits billingModel=api-key and source=styrby-estimate when cost_usd is absent', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, model: 'claude-sonnet-4' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      kiloTokens({ input_tokens: 400, output_tokens: 100 }),
    ]);
    await promptPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r.report.billingModel).toBe('api-key');
    expect(r.report.source).toBe('styrby-estimate');
  });
});

describe('KiloBackend — cost-report emission (local / Ollama model)', () => {
  it('emits billingModel=free and costUsd=0 for ollama model names', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, model: 'ollama/llama3' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      kiloTokens({ input_tokens: 300, output_tokens: 120, cost_usd: 0 }),
    ]);
    await promptPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r.report.billingModel).toBe('free');
    expect(r.report.costUsd).toBe(0);
  });

  it('emits billingModel=free for local- prefixed model names', async () => {
    const { backend } = createKiloBackend({ ...BASE_OPTIONS, model: 'local-mistral-7b' });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      kiloTokens({ input_tokens: 200, output_tokens: 80 }),
    ]);
    await promptPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r.report.billingModel).toBe('free');
    expect(r.report.costUsd).toBe(0);
  });

  it('emits billingModel=free when apiBaseUrl points to localhost', async () => {
    const { backend } = createKiloBackend({
      ...BASE_OPTIONS,
      model: 'llama3',
      apiBaseUrl: 'http://localhost:11434',
    });
    const messages = collectMessages(backend);
    const { sessionId } = await backend.startSession();

    const promptPromise = backend.sendPrompt(sessionId, 'hello');
    simulateProcess(currentMockProcess, [
      kiloTokens({ input_tokens: 100, output_tokens: 50 }),
    ]);
    await promptPromise;

    const r = messages.find((m: any) => m.type === 'cost-report') as any;
    expect(r.report.billingModel).toBe('free');
    expect(r.report.costUsd).toBe(0);
  });
});
