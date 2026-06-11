/**
 * Codex Backend — test suite
 *
 * Tests cover:
 *  - createCodexBackend factory (return shape + metadata)
 *  - registerCodexAgent (registry integration)
 *  - Session lifecycle: startSession (config + status), sendPrompt, cancel, dispose
 *  - Codex event -> AgentMessage mapping for every handled msg.type
 *  - Permission bridge: handleToolCall -> permission-request -> respondToPermission
 *  - Event emission: onMessage/offMessage, handler-exception isolation
 *
 * The MCP transport (CodexMcpClient) is mocked at the module boundary so these
 * tests exercise the ADAPTER (event mapping + permission bridging), not the
 * subprocess. That mirrors the project rule: mock the third-party client at the
 * boundary, test our logic.
 *
 * @module factories/__tests__/codex.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock CodexMcpClient at the module boundary. vi.hoisted exposes a shared fake
// client (with vi.fn spies) and captures the handler + permission bridge that
// CodexBackend registers in its constructor.
// ---------------------------------------------------------------------------
const { fakeClient, captured } = vi.hoisted(() => {
  const captured: {
    handler: ((e: unknown) => void) | null;
    bridge:
      | { handleToolCall: (id: string, name: string, input: unknown) => Promise<{ decision: string }> }
      | null;
  } = { handler: null, bridge: null };

  const fakeClient = {
    setHandler: vi.fn((h: (e: unknown) => void) => { captured.handler = h; }),
    setPermissionHandler: vi.fn((b: any) => { captured.bridge = b; }),
    connect: vi.fn(async () => {}),
    startSession: vi.fn(async () => ({ content: [] })),
    continueSession: vi.fn(async () => ({ content: [] })),
    getSessionId: vi.fn(() => 'codex-session-123'),
    storeSessionForResume: vi.fn(() => 'codex-session-123'),
    forceCloseSession: vi.fn(async () => {}),
  };

  return { fakeClient, captured };
});

vi.mock('@/codex/codexMcpClient', () => ({
  CodexMcpClient: vi.fn(() => fakeClient),
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Import SUT after mocks are registered.
import { createCodexBackend, registerCodexAgent } from '../codex';
import { agentRegistry } from '../../core';
import type { AgentMessage } from '../../core/AgentBackend';

function makeBackend(opts: Partial<{ cwd: string; model: string }> = {}) {
  const { backend } = createCodexBackend({ cwd: opts.cwd ?? '/tmp/project', model: opts.model });
  const messages: AgentMessage[] = [];
  backend.onMessage((m) => messages.push(m));
  return { backend, messages };
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.handler = null;
  captured.bridge = null;
});

// ---------------------------------------------------------------------------
describe('createCodexBackend', () => {
  it('returns a backend, the resolved model, and capability metadata', () => {
    const result = createCodexBackend({ cwd: '/tmp/p', model: 'gpt-5-codex' });
    expect(result.backend).toBeDefined();
    expect(result.model).toBe('gpt-5-codex');
    expect(result.metadata).toEqual({
      modelSource: 'explicit',
      supportsStreaming: true,
      supportsTools: true,
    });
  });

  it('reports modelSource "default" when no model is given', () => {
    expect(createCodexBackend({ cwd: '/tmp/p' }).metadata.modelSource).toBe('default');
  });

  it('registers the constructor-time event handler and permission bridge', () => {
    makeBackend();
    expect(fakeClient.setHandler).toHaveBeenCalledTimes(1);
    expect(fakeClient.setPermissionHandler).toHaveBeenCalledTimes(1);
    expect(captured.handler).toBeTypeOf('function');
    expect(captured.bridge).toBeTruthy();
  });
});

describe('registerCodexAgent', () => {
  it('registers "codex" in the global registry', () => {
    registerCodexAgent();
    expect(agentRegistry.has('codex')).toBe(true);
    const backend = agentRegistry.create('codex', { cwd: '/tmp/p' });
    expect(backend).toBeDefined();
  });
});

describe('session lifecycle', () => {
  it('startSession connects, sends config, and returns the codex session id', async () => {
    const { backend, messages } = makeBackend({ model: 'gpt-5-codex' });
    const result = await backend.startSession('hello');

    expect(result.sessionId).toBe('codex-session-123');
    expect(fakeClient.startSession).toHaveBeenCalledTimes(1);
    const config = fakeClient.startSession.mock.calls[0][0];
    expect(config).toMatchObject({
      prompt: 'hello',
      cwd: '/tmp/project',
      sandbox: 'workspace-write',
      'approval-policy': 'on-request',
      model: 'gpt-5-codex',
    });
    // status transitions: starting -> running
    expect(messages.map((m) => m.type === 'status' && m.status)).toContain('starting');
    expect(messages.map((m) => m.type === 'status' && m.status)).toContain('running');
  });

  it('falls back to a local UUID when codex reports no session id', async () => {
    fakeClient.getSessionId.mockReturnValueOnce(null);
    const { backend } = makeBackend();
    const result = await backend.startSession();
    expect(result.sessionId).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('sendPrompt forwards to continueSession', async () => {
    const { backend } = makeBackend();
    await backend.startSession('init');
    await backend.sendPrompt('codex-session-123', 'do the thing');
    expect(fakeClient.continueSession).toHaveBeenCalledWith('do the thing', expect.anything());
  });

  it('cancel aborts and keeps the session resumable', async () => {
    const { backend, messages } = makeBackend();
    await backend.startSession('init');
    await backend.cancel('codex-session-123');
    expect(fakeClient.storeSessionForResume).toHaveBeenCalled();
    expect(messages.some((m) => m.type === 'status' && m.detail === 'cancelled')).toBe(true);
  });

  it('dispose force-closes the client and emits stopped', async () => {
    const { backend, messages } = makeBackend();
    await backend.startSession('init');
    await backend.dispose();
    expect(fakeClient.forceCloseSession).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.type === 'status' && m.status === 'stopped')).toBe(true);
  });

  it('sendPrompt after dispose throws', async () => {
    const { backend } = makeBackend();
    await backend.dispose();
    await expect(backend.sendPrompt('s', 'p')).rejects.toThrow(/disposed/);
  });
});

describe('codex event -> AgentMessage mapping', () => {
  function emit(event: Record<string, unknown>): AgentMessage[] {
    const { messages } = makeBackend();
    captured.handler!(event);
    return messages;
  }

  it('agent_message -> model-output fullText', () => {
    const out = emit({ type: 'agent_message', message: 'hi there' });
    expect(out).toContainEqual({ type: 'model-output', fullText: 'hi there' });
  });

  it('agent_message_delta -> model-output textDelta', () => {
    const out = emit({ type: 'agent_message_delta', delta: 'chunk' });
    expect(out).toContainEqual({ type: 'model-output', textDelta: 'chunk' });
  });

  it('agent_reasoning -> reasoning event (not model-output)', () => {
    const out = emit({ type: 'agent_reasoning', text: 'thinking' });
    expect(out).toContainEqual({ type: 'event', name: 'reasoning', payload: { text: 'thinking' } });
    expect(out.some((m) => m.type === 'model-output')).toBe(false);
  });

  it('exec_command_begin -> tool-call shell with command + callId', () => {
    const out = emit({ type: 'exec_command_begin', call_id: 'c1', command: ['ls', '-la'] });
    const tc = out.find((m) => m.type === 'tool-call');
    expect(tc).toMatchObject({ type: 'tool-call', toolName: 'shell', callId: 'c1' });
    expect((tc as any).args.command).toEqual(['ls', '-la']);
  });

  it('exec_approval_request -> exec-approval-request with call_id', () => {
    const out = emit({ type: 'exec_approval_request', call_id: 'c2', command: ['rm', '-rf'] });
    expect(out).toContainEqual(expect.objectContaining({ type: 'exec-approval-request', call_id: 'c2' }));
  });

  it('exec_command_end -> tool-result with callId', () => {
    const out = emit({ type: 'exec_command_end', call_id: 'c1', output: 'done', error: '' });
    expect(out).toContainEqual(expect.objectContaining({ type: 'tool-result', toolName: 'shell', callId: 'c1' }));
  });

  it('patch_apply_begin / patch_apply_end map to patch variants', () => {
    const begin = emit({ type: 'patch_apply_begin', call_id: 'p1', auto_approved: true, changes: { 'a.ts': {} } });
    expect(begin).toContainEqual(expect.objectContaining({ type: 'patch-apply-begin', call_id: 'p1', auto_approved: true }));

    const end = emit({ type: 'patch_apply_end', call_id: 'p1', stdout: 'ok', stderr: '', success: true });
    expect(end).toContainEqual(expect.objectContaining({ type: 'patch-apply-end', call_id: 'p1', success: true }));
  });

  it('turn_diff with unified_diff -> fs-edit', () => {
    const out = emit({ type: 'turn_diff', unified_diff: '--- a\n+++ b\n' });
    expect(out).toContainEqual(expect.objectContaining({ type: 'fs-edit', diff: '--- a\n+++ b\n' }));
  });

  it('token_count -> token-count', () => {
    const out = emit({ type: 'token_count', input_tokens: 10, output_tokens: 5 });
    expect(out).toContainEqual(expect.objectContaining({ type: 'token-count', input_tokens: 10, output_tokens: 5 }));
  });

  it('task_started / task_complete / turn_aborted -> status', () => {
    expect(emit({ type: 'task_started' })).toContainEqual({ type: 'status', status: 'running' });
    expect(emit({ type: 'task_complete' })).toContainEqual({ type: 'status', status: 'idle' });
    expect(emit({ type: 'turn_aborted' })).toContainEqual({ type: 'status', status: 'idle', detail: 'turn_aborted' });
  });

  it('unknown event type -> generic event (not dropped)', () => {
    const out = emit({ type: 'some_future_event', foo: 1 });
    expect(out).toContainEqual(expect.objectContaining({ type: 'event', name: 'some_future_event' }));
  });

  // #26 L7 resilience: the codex MCP event stream is semi-trusted. A buggy
  // server, a truncated frame, or a protocol drift can deliver a null,
  // primitive, or array where an event object is expected. handleCodexEvent
  // guards with `if (!raw || typeof raw !== 'object') return` — these tests
  // lock that guard in so a malformed frame can never throw out of the handler.
  it('ignores null/undefined/primitive frames without throwing or emitting', () => {
    const { messages } = makeBackend();
    for (const bad of [null, undefined, 0, 42, '', 'a string', true, NaN]) {
      expect(() => captured.handler!(bad as never)).not.toThrow();
    }
    expect(messages).toHaveLength(0);
  });

  it('does not throw on an object frame with a missing or non-string type', () => {
    const { messages } = makeBackend();
    for (const bad of [{}, { type: 123 }, { type: null }, { notType: 'x' }, { type: {} }]) {
      expect(() => captured.handler!(bad as never)).not.toThrow();
    }
    // Coercion-heavy fields must not crash even when present with wrong types.
    expect(() => captured.handler!({ type: 'exec_command_begin', call_id: {}, command: 5 } as never)).not.toThrow();
  });

  it('non-object event is ignored', () => {
    const { messages } = makeBackend();
    captured.handler!('not an object');
    captured.handler!(null);
    expect(messages).toHaveLength(0);
  });
});

describe('permission bridge', () => {
  it('handleToolCall emits a permission-request and respondToPermission resolves it (approved)', async () => {
    const { backend, messages } = makeBackend();
    const decisionPromise = captured.bridge!.handleToolCall('call-1', 'CodexBash', { command: ['ls'] });

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'permission-request', id: 'call-1', payload: { command: ['ls'] } }),
    );

    await backend.respondToPermission!('call-1', true);
    await expect(decisionPromise).resolves.toEqual({ decision: 'approved' });
    expect(messages).toContainEqual({ type: 'permission-response', id: 'call-1', approved: true });
  });

  it('respondToPermission(false) resolves denied', async () => {
    const { backend } = makeBackend();
    const decisionPromise = captured.bridge!.handleToolCall('call-2', 'CodexBash', {});
    await backend.respondToPermission!('call-2', false);
    await expect(decisionPromise).resolves.toEqual({ decision: 'denied' });
  });

  it('dispose denies any outstanding approval so its promise never hangs', async () => {
    const { backend } = makeBackend();
    const decisionPromise = captured.bridge!.handleToolCall('call-3', 'CodexBash', {});
    await backend.dispose();
    await expect(decisionPromise).resolves.toEqual({ decision: 'denied' });
  });

  it('respondToPermission for an unknown id is a no-op (does not throw)', async () => {
    const { backend } = makeBackend();
    await expect(backend.respondToPermission!('nope', true)).resolves.toBeUndefined();
  });
});

describe('event emission', () => {
  it('offMessage stops delivery', () => {
    const { backend } = makeBackend();
    const seen: AgentMessage[] = [];
    const handler = (m: AgentMessage) => seen.push(m);
    backend.onMessage(handler);
    captured.handler!({ type: 'task_started' });
    backend.offMessage!(handler);
    captured.handler!({ type: 'task_complete' });
    // handler saw the first but not the second
    expect(seen.filter((m) => m.type === 'status' && m.status === 'running')).toHaveLength(1);
    expect(seen.some((m) => m.type === 'status' && m.status === 'idle')).toBe(false);
  });

  it('a throwing handler does not stop delivery to others', () => {
    const { backend, messages } = makeBackend();
    backend.onMessage(() => { throw new Error('boom'); });
    expect(() => captured.handler!({ type: 'task_started' })).not.toThrow();
    expect(messages).toContainEqual({ type: 'status', status: 'running' });
  });
});
