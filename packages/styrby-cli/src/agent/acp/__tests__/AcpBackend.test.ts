/**
 * Integration tests for `AcpBackend.ts` + `createAcpBackend.ts`.
 *
 * WHY: The sub-modules (retryHelper, errorFormatting, permissionHandling,
 * processLifecycle, sessionUpdateDispatcher, streamBridge) are already unit-
 * tested. This file exercises the *orchestrator* — the AcpBackend class that
 * wires them together and drives the full lifecycle:
 *
 *   startSession → initialize → newSession → sendPrompt → waitForResponse
 *   → cancel → dispose
 *
 * To avoid spawning real processes we mock three things:
 *  1. `node:child_process` — so spawnAgentProcess returns a controllable fake.
 *  2. `@agentclientprotocol/sdk` — so ClientSideConnection and ndJsonStream
 *     are fully controllable stubs.
 *  3. `../streamBridge` — so nodeToWebStreams/createFilteredStdoutStream don't
 *     need real Node streams.
 *
 * All RPC calls (initialize, newSession, prompt, cancel) are vi.fn() stubs
 * that resolve immediately, letting us inspect call counts and arguments.
 *
 * Skipped paths (intentionally):
 *  - Real stdio pipe bridging (covered by streamBridge.ts separately)
 *  - Real process SIGTERM/SIGKILL escalation (involves real OS processes)
 *  - processLifecycle spawn on Windows (platform-specific, CI runs macOS/Linux)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ============================================================================
// Hoisted mock helpers — MUST be at the top with vi.hoisted()
// WHY: vi.mock() factory functions run before any import in the module scope.
// Variables declared with `const` in the test body are NOT yet initialised
// when the factory executes, causing ReferenceError. vi.hoisted() runs the
// factory at mock-hoisting time so the references are always valid.
// ============================================================================

const h = vi.hoisted(() => {
  // Mutable stubs for RPC calls — reset in beforeEach.
  const mockInitialize = vi.fn().mockResolvedValue({ protocolVersion: 1 });
  const mockNewSession = vi.fn().mockResolvedValue({ sessionId: 'acp-session-123' });
  const mockPrompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
  const mockCancel = vi.fn().mockResolvedValue(undefined);

  // Capture callbacks the AcpBackend registers with the client factory so tests
  // can simulate inbound agent updates.
  let capturedSessionUpdateHandler: ((params: unknown) => void) | null = null;
  let capturedPermissionHandler: ((req: unknown) => Promise<unknown>) | null = null;

  /**
   * Stub ClientSideConnection.
   *
   * The real SDK invokes the client factory synchronously in the constructor,
   * which is how AcpBackend wires its sessionUpdate/requestPermission callbacks.
   * We replicate that behaviour here so the capture is reliable.
   */
  class MockClientSideConnection {
    constructor(
      clientFactory: (agent: unknown) => {
        sessionUpdate: (params: unknown) => void;
        requestPermission?: (req: unknown) => Promise<unknown>;
      },
      _stream: unknown
    ) {
      const client = clientFactory({});
      capturedSessionUpdateHandler = client.sessionUpdate as (params: unknown) => void;
      capturedPermissionHandler =
        (client.requestPermission as ((req: unknown) => Promise<unknown>) | null) ?? null;
    }

    initialize = mockInitialize;
    newSession = mockNewSession;
    prompt = mockPrompt;
    cancel = mockCancel;
  }

  return {
    MockClientSideConnection,
    mockInitialize,
    mockNewSession,
    mockPrompt,
    mockCancel,
    getCapturedSessionUpdate: () => capturedSessionUpdateHandler,
    getCapturedPermission: () => capturedPermissionHandler,
    resetCaptures: () => {
      capturedSessionUpdateHandler = null;
      capturedPermissionHandler = null;
    },
  };
});

// ============================================================================
// Mock: node:child_process
// ============================================================================

/** A minimal fake ChildProcess that satisfies AcpBackend's expectations. */
class FakeChildProcess extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 12345;
  killed = false;

  kill(signal?: string): boolean {
    this.killed = true;
    // Immediately emit 'exit' so dispose() doesn't hang.
    process.nextTick(() => this.emit('exit', 0, signal ?? null));
    return true;
  }
}

let fakeProcess: FakeChildProcess;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => fakeProcess),
}));

// ============================================================================
// Mock: ../streamBridge
// ============================================================================

const fakeReadable = {
  pipeTo: vi.fn(),
  getReader: vi.fn(),
  locked: false,
} as unknown as ReadableStream<Uint8Array>;

const fakeWritable = {
  getWriter: vi.fn(),
  locked: false,
} as unknown as WritableStream<Uint8Array>;

vi.mock('../streamBridge', () => ({
  nodeToWebStreams: vi.fn(() => ({ writable: fakeWritable, readable: fakeReadable })),
  createFilteredStdoutStream: vi.fn(() => fakeReadable),
}));

// ============================================================================
// Mock: @agentclientprotocol/sdk
// WHY: Must reference h.MockClientSideConnection (already hoisted) — never a
// top-level class defined after the vi.mock() call.
// ============================================================================

vi.mock('@agentclientprotocol/sdk', () => ({
  ClientSideConnection: h.MockClientSideConnection,
  ndJsonStream: vi.fn(() => ({})),
}));

// ============================================================================
// Mock: @/ui/logger  (avoid console noise in tests)
// ============================================================================

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ============================================================================
// Mock: @/utils/safeEnv
// ============================================================================

vi.mock('@/utils/safeEnv', () => ({
  buildSafeEnv: vi.fn((env?: Record<string, string>) => ({ ...process.env, ...env })),
}));

// ============================================================================
// Import units-under-test AFTER mocks are registered
// ============================================================================

import { AcpBackend } from '../AcpBackend';
import { createAcpBackend } from '../createAcpBackend';
import type { AcpBackendOptions } from '../AcpBackend';
import type { AgentMessage } from '../../core';
import type { TransportHandler } from '../../transport';

// ============================================================================
// Helpers
// ============================================================================

/** Minimal TransportHandler stub. */
function makeTransport(): TransportHandler {
  return {
    agentName: 'test-agent',
    getInitTimeout: () => 5000,
    getToolPatterns: () => [],
    filterStdoutLine: (line: string) => line,
    handleStderr: () => ({ message: null }),
  } as unknown as TransportHandler;
}

function makeOptions(overrides: Partial<AcpBackendOptions> = {}): AcpBackendOptions {
  return {
    agentName: 'test-agent',
    cwd: '/tmp/test',
    command: 'fake-agent',
    args: ['--acp'],
    transportHandler: makeTransport(),
    ...overrides,
  };
}

/** Collect all messages emitted to a backend. */
function collectMessages(backend: AcpBackend): AgentMessage[] {
  const messages: AgentMessage[] = [];
  backend.onMessage((msg) => messages.push(msg));
  return messages;
}

// ============================================================================
// Test setup / teardown
// ============================================================================

beforeEach(() => {
  fakeProcess = new FakeChildProcess();
  h.mockInitialize.mockResolvedValue({ protocolVersion: 1 });
  h.mockNewSession.mockResolvedValue({ sessionId: 'acp-session-123' });
  h.mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  h.mockCancel.mockResolvedValue(undefined);
  h.resetCaptures();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// createAcpBackend factory
// ============================================================================

describe('createAcpBackend', () => {
  it('returns an object with the AgentBackend interface', () => {
    const backend = createAcpBackend({
      agentName: 'gemini',
      cwd: '/tmp',
      command: 'gemini',
    });

    expect(typeof backend.startSession).toBe('function');
    expect(typeof backend.sendPrompt).toBe('function');
    expect(typeof backend.cancel).toBe('function');
    expect(typeof backend.dispose).toBe('function');
    expect(typeof backend.onMessage).toBe('function');
    expect(typeof backend.offMessage).toBe('function');
  });

  it('returns an AcpBackend instance', () => {
    const backend = createAcpBackend({ agentName: 'test', cwd: '/tmp', command: 'agent' });
    expect(backend).toBeInstanceOf(AcpBackend);
  });
});

// ============================================================================
// startSession
// ============================================================================

describe('AcpBackend.startSession', () => {
  it('emits status=starting as the first message', async () => {
    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);

    await backend.startSession();
    await backend.dispose();

    expect(messages[0]).toEqual({ type: 'status', status: 'starting' });
  });

  it('calls initialize and newSession RPCs exactly once', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();
    await backend.dispose();

    expect(h.mockInitialize).toHaveBeenCalledTimes(1);
    expect(h.mockNewSession).toHaveBeenCalledTimes(1);
  });

  it('passes cwd to newSession', async () => {
    const backend = new AcpBackend(makeOptions({ cwd: '/my/project' }));
    await backend.startSession();
    await backend.dispose();

    expect(h.mockNewSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/my/project' })
    );
  });

  it('returns a non-empty string sessionId', async () => {
    const backend = new AcpBackend(makeOptions());
    const result = await backend.startSession();
    await backend.dispose();

    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('emits status=idle after successful startup', async () => {
    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);

    await backend.startSession();
    await backend.dispose();

    const statuses = messages
      .filter((m) => m.type === 'status')
      .map((m) => (m as { status: string }).status);
    expect(statuses).toContain('idle');
  });

  it('emits status=error and rethrows on initialize failure (all retries)', async () => {
    // WHY: withRetry retries maxAttempts=3 times. With real timers this takes
    // 1s + 2s = 3s of delay. We mock all 3 attempts to fail immediately so
    // the retry loop short-circuits on each attempt's rejection without waiting
    // for the delay to fire — the delay is awaited in a `await delay(delayMs)`
    // call between retries. Using fake timers plus runAllTimersAsync advances
    // those delays instantly.
    vi.useFakeTimers();
    h.mockInitialize.mockRejectedValue(new Error('init failed'));

    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);

    const startPromise = backend.startSession();

    // Drive all pending timers (retry delays, withTimeout timers) to completion.
    // Loop until the promise settles to handle timers created during async execution.
    let settled = false;
    startPromise.catch(() => { settled = true; });
    for (let i = 0; i < 20 && !settled; i++) {
      await vi.runAllTimersAsync();
      await Promise.resolve(); // flush microtask queue
    }

    await expect(startPromise).rejects.toThrow('init failed');

    const errorMsg = messages.find(
      (m) => m.type === 'status' && (m as { status: string }).status === 'error'
    );
    expect(errorMsg).toBeDefined();
    vi.useRealTimers();
  });

  it('emits status=error and rethrows when newSession fails (all retries)', async () => {
    vi.useFakeTimers();
    h.mockNewSession.mockRejectedValue(new Error('session creation failed'));

    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);

    const startPromise = backend.startSession();

    let settled = false;
    startPromise.catch(() => { settled = true; });
    for (let i = 0; i < 20 && !settled; i++) {
      await vi.runAllTimersAsync();
      await Promise.resolve();
    }

    await expect(startPromise).rejects.toThrow('session creation failed');

    const errorMsg = messages.find(
      (m) => m.type === 'status' && (m as { status: string }).status === 'error'
    );
    expect(errorMsg).toBeDefined();
    vi.useRealTimers();
  });

  it('throws when already disposed', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.dispose();

    await expect(backend.startSession()).rejects.toThrow('disposed');
  });

  it('sends initialPrompt via sendPrompt when provided', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession('hello agent');

    // Give the async sendPrompt chain a tick to fire.
    await new Promise((r) => setTimeout(r, 20));
    await backend.dispose();

    expect(h.mockPrompt).toHaveBeenCalledTimes(1);
  });

  it('passes mcpServers array to newSession when configured', async () => {
    const backend = new AcpBackend(
      makeOptions({
        mcpServers: {
          myServer: { command: 'node', args: ['server.js'] },
        },
      })
    );
    await backend.startSession();
    await backend.dispose();

    expect(h.mockNewSession).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: expect.any(Array) })
    );
  });

  it('does not throw when called without args (no initialPrompt)', async () => {
    const backend = new AcpBackend(makeOptions());
    await expect(backend.startSession()).resolves.toBeDefined();
    await backend.dispose();
  });
});

// ============================================================================
// sendPrompt
// ============================================================================

describe('AcpBackend.sendPrompt', () => {
  it('calls connection.prompt with the ACP session ID', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    await backend.sendPrompt('irrelevant-local-id', 'do something');
    await backend.dispose();

    expect(h.mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'acp-session-123' })
    );
  });

  it('wraps prompt text in a ContentBlock', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    await backend.sendPrompt('s1', 'my prompt text');
    await backend.dispose();

    expect(h.mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'my prompt text' }),
        ]),
      })
    );
  });

  it('emits status=running before calling the RPC', async () => {
    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);
    await backend.startSession();
    messages.length = 0; // clear startup messages

    await backend.sendPrompt('s1', 'hello');
    await backend.dispose();

    expect(messages[0]).toEqual({ type: 'status', status: 'running' });
  });

  it('emits status=error and rethrows when the prompt RPC fails', async () => {
    h.mockPrompt.mockRejectedValueOnce(new Error('network error'));

    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);
    await backend.startSession();

    await expect(backend.sendPrompt('s1', 'hello')).rejects.toThrow();

    const errorMsg = messages.find(
      (m) => m.type === 'status' && (m as { status: string }).status === 'error'
    );
    expect(errorMsg).toBeDefined();
    await backend.dispose();
  });

  it('throws "Session not started" when called before startSession', async () => {
    const backend = new AcpBackend(makeOptions());
    await expect(backend.sendPrompt('s1', 'hello')).rejects.toThrow('Session not started');
  });

  it('throws "disposed" when called after dispose', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();
    await backend.dispose();

    await expect(backend.sendPrompt('s1', 'hello')).rejects.toThrow('disposed');
  });

  it('allows multiple sequential sendPrompt calls', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    await backend.sendPrompt('s1', 'first');
    await backend.sendPrompt('s1', 'second');
    await backend.dispose();

    expect(h.mockPrompt).toHaveBeenCalledTimes(2);
  });

  it('honours hasChangeTitleInstruction callback when provided', async () => {
    const hasChangeTitle = vi.fn().mockReturnValue(true);
    const backend = new AcpBackend(makeOptions({ hasChangeTitleInstruction: hasChangeTitle }));
    await backend.startSession();

    await backend.sendPrompt('s1', 'change_title something');
    await backend.dispose();

    expect(hasChangeTitle).toHaveBeenCalledWith('change_title something');
  });
});

// ============================================================================
// sessionUpdate handling (inbound stream from agent)
// ============================================================================

describe('AcpBackend session update handling', () => {
  it('dispatches an agent_message_chunk update and emits a model-output event', async () => {
    // WHY: The dispatcher routes 'agent_message_chunk' (not 'message_chunk').
    // handleAgentMessageChunk emits type='model-output' with textDelta for
    // normal (non-thinking) text chunks.
    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);
    await backend.startSession();

    h.getCapturedSessionUpdate()?.({
      sessionId: 'acp-session-123',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'Hello from agent' },
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    await backend.dispose();

    const modelOutputMessages = messages.filter((m) => m.type === 'model-output');
    expect(modelOutputMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('does not crash on an unknown update type', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    expect(() => {
      h.getCapturedSessionUpdate()?.({
        sessionId: 'acp-session-123',
        update: { sessionUpdate: '__completely_unknown_type__' },
      });
    }).not.toThrow();

    await backend.dispose();
  });

  it('ignores updates emitted after dispose', async () => {
    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);
    await backend.startSession();
    await backend.dispose();

    const countBeforeDisposedUpdate = messages.length;
    h.getCapturedSessionUpdate()?.({
      sessionId: 'acp-session-123',
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'too late' } },
    });

    expect(messages.length).toBe(countBeforeDisposedUpdate);
  });
});

// ============================================================================
// waitForResponseComplete
// ============================================================================

describe('AcpBackend.waitForResponseComplete', () => {
  it('resolves immediately when not waiting for a response', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    await expect(backend.waitForResponseComplete(1000)).resolves.toBeUndefined();
    await backend.dispose();
  });

  it('times out when idle status is never emitted', { timeout: 10000 }, async () => {
    // WHY: waitForResponseComplete sets a setTimeout. We test it with a very
    // short timeout (50ms) so the test doesn't block for long, while still
    // exercising the actual timeout code path.
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    // Make the next prompt hang (idle is never emitted).
    h.mockPrompt.mockReturnValueOnce(new Promise(() => {}));

    // Fire sendPrompt without await — it will be in-flight.
    backend.sendPrompt('s1', 'hello').catch(() => {});

    // waitForResponseComplete with a very short timeout — should reject quickly.
    await expect(backend.waitForResponseComplete(50)).rejects.toThrow('Timeout');

    await backend.dispose();
  });
});

// ============================================================================
// cancel
// ============================================================================

describe('AcpBackend.cancel', () => {
  it('calls connection.cancel with the ACP session ID', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    await backend.cancel('local-session-id');
    await backend.dispose();

    expect(h.mockCancel).toHaveBeenCalledWith({ sessionId: 'acp-session-123' });
  });

  it('emits status=stopped after cancel', async () => {
    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);
    await backend.startSession();
    messages.length = 0;

    await backend.cancel('s1');
    await backend.dispose();

    const stopped = messages.find(
      (m) => m.type === 'status' && (m as { status: string }).status === 'stopped'
    );
    expect(stopped).toBeDefined();
  });

  it('resolves without throwing when called before startSession', async () => {
    const backend = new AcpBackend(makeOptions());
    await expect(backend.cancel('s1')).resolves.toBeUndefined();
  });

  it('resolves without throwing when cancel RPC throws', async () => {
    h.mockCancel.mockRejectedValueOnce(new Error('cancel failed'));

    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    // cancel() swallows errors internally
    await expect(backend.cancel('s1')).resolves.toBeUndefined();
    await backend.dispose();
  });
});

// ============================================================================
// respondToPermission (UI-only event, does NOT call the ACP protocol)
// ============================================================================

describe('AcpBackend.respondToPermission', () => {
  it('emits a permission-response event with correct id and approved=true', async () => {
    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission('perm-123', true);
    await backend.dispose();

    const permMsg = messages.find((m) => m.type === 'permission-response');
    expect(permMsg).toEqual(
      expect.objectContaining({ type: 'permission-response', id: 'perm-123', approved: true })
    );
  });

  it('emits permission-response with approved=false when denied', async () => {
    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);
    await backend.startSession();

    await backend.respondToPermission('perm-456', false);
    await backend.dispose();

    const permMsg = messages.find((m) => m.type === 'permission-response');
    expect(permMsg).toEqual(
      expect.objectContaining({ type: 'permission-response', id: 'perm-456', approved: false })
    );
  });
});

// ============================================================================
// dispose
// ============================================================================

describe('AcpBackend.dispose', () => {
  it('is idempotent — calling twice does not throw', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    await backend.dispose();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  it('calls connection.cancel during graceful shutdown', async () => {
    const backend = new AcpBackend(makeOptions());
    await backend.startSession();

    await backend.dispose();

    expect(h.mockCancel).toHaveBeenCalledWith({ sessionId: 'acp-session-123' });
  });

  it('clears listeners so no further events can be received', async () => {
    const backend = new AcpBackend(makeOptions());
    const messages = collectMessages(backend);
    await backend.startSession();
    await backend.dispose();

    // After dispose, emit() is guarded — messages.length must not grow.
    const countAtDispose = messages.length;
    h.getCapturedSessionUpdate()?.({
      sessionId: 'acp-session-123',
      update: { sessionUpdate: 'message_chunk', content: { text: 'after dispose' } },
    });
    expect(messages.length).toBe(countAtDispose);
  });

  it('dispose before startSession does not throw', async () => {
    const backend = new AcpBackend(makeOptions());
    await expect(backend.dispose()).resolves.toBeUndefined();
  });
});

// ============================================================================
// onMessage / offMessage
// ============================================================================

describe('AcpBackend.onMessage / offMessage', () => {
  it('onMessage registers a handler that receives events during startSession', async () => {
    const backend = new AcpBackend(makeOptions());
    const handler = vi.fn();
    backend.onMessage(handler);

    await backend.startSession();
    await backend.dispose();

    expect(handler).toHaveBeenCalled();
  });

  it('offMessage deregisters a handler — handler receives no further events', async () => {
    const backend = new AcpBackend(makeOptions());
    const handler = vi.fn();
    backend.onMessage(handler);
    backend.offMessage(handler);

    await backend.startSession();
    await backend.dispose();

    expect(handler).not.toHaveBeenCalled();
  });

  it('offMessage is a no-op when handler was never registered', () => {
    const backend = new AcpBackend(makeOptions());
    expect(() => backend.offMessage(vi.fn())).not.toThrow();
  });

  it('multiple handlers all receive the same events', async () => {
    const backend = new AcpBackend(makeOptions());
    const h1 = vi.fn();
    const h2 = vi.fn();
    backend.onMessage(h1);
    backend.onMessage(h2);

    await backend.startSession();
    await backend.dispose();

    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });
});

// ============================================================================
// Error resilience
// ============================================================================

describe('AcpBackend error resilience', () => {
  it('does not propagate errors thrown by a message handler', async () => {
    const backend = new AcpBackend(makeOptions());
    backend.onMessage(() => {
      throw new Error('handler crash');
    });

    // startSession triggers status events → handler crashes → must not surface.
    await expect(backend.startSession()).resolves.toBeDefined();
    await backend.dispose();
  });

  it('continues to deliver events to subsequent handlers when one throws', async () => {
    const backend = new AcpBackend(makeOptions());
    const okHandler = vi.fn();
    backend.onMessage(() => {
      throw new Error('first handler crash');
    });
    backend.onMessage(okHandler);

    await backend.startSession();
    await backend.dispose();

    expect(okHandler).toHaveBeenCalled();
  });
});
