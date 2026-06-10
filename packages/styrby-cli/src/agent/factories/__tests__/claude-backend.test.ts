/**
 * ClaudeBackend — managed binary-spawn (stream-json) test suite.
 *
 * Separate from claude.test.ts (which covers the pure cost helpers and mocks
 * node:fs) so the spawn mock here can't interfere with that file's fs mock.
 *
 * Tests cover:
 *  - createClaudeBackend factory shape + metadata
 *  - registerClaudeAgent registry integration
 *  - spawn arg construction (-p, stream-json, --verbose, --permission-mode,
 *    --model, --allowedTools, --resume from a captured session_id)
 *  - stream-json line -> AgentMessage mapping (assistant text/tool_use, fs-edit,
 *    user tool_result, cost-report from usage)
 *  - lifecycle: clean exit -> idle+resolve, non-zero -> error+reject,
 *    cancel -> SIGTERM+idle, disposed guard
 *
 * The `claude` binary is mocked at node:child_process.spawn. stdout uses a real
 * PassThrough because the backend reads it via the base class's readline-based
 * streamLines().
 *
 * @module factories/__tests__/claude-backend.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill = vi.fn((_sig?: string) => { this.killed = true; return true; });
}

// WHY inline the vi.fn inside the factory (not reference an outer const): vi.mock
// is hoisted above top-level consts, so referencing an outer `spawnMock` at
// factory-execution time hits the temporal dead zone. The factory body only runs
// when spawn() is actually called (in a test), by which point FakeChild/lastChild
// are initialized. We grab the spy below via vi.mocked(spawn).
let lastChild: FakeChild;
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    lastChild = new FakeChild();
    return lastChild;
  }),
}));
vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { spawn } from 'node:child_process';
import { createClaudeBackend, registerClaudeAgent } from '../claude';
import { agentRegistry } from '../../core';
import type { AgentMessage } from '../../core/AgentBackend';

const spawnMock = vi.mocked(spawn);

// WHY interactivePermissions:false by default here: most of these tests assert
// arg construction / stream mapping / lifecycle and should NOT spin up the real
// in-process permission MCP server. The interactive default (true) is covered by
// its own describe block + claudePermissionServer.test.ts.
function makeBackend(opts: Record<string, unknown> = {}) {
  const { backend } = createClaudeBackend({ cwd: '/tmp/project', interactivePermissions: false, ...opts } as any);
  const messages: AgentMessage[] = [];
  backend.onMessage((m) => messages.push(m));
  return { backend, messages };
}

/**
 * Build a backend with interactive per-tool approval ENABLED (the product
 * default). `decide` is reachable via a typed cast for round-trip assertions
 * without standing up the real claude<->MCP transport.
 */
function makeInteractive(opts: Record<string, unknown> = {}) {
  const { backend } = createClaudeBackend({ cwd: '/tmp/project', ...opts } as any);
  const messages: AgentMessage[] = [];
  backend.onMessage((m) => messages.push(m));
  const decide = (toolName: string, input: Record<string, unknown>, id: string | undefined) =>
    (backend as unknown as {
      decide: (t: string, i: Record<string, unknown>, id: string | undefined) => Promise<{ approved: boolean; message?: string }>;
    }).decide(toolName, input, id);
  return { backend, messages, decide };
}

/** Drive a pending sendPrompt: feed JSONL stdout lines, end stream, close proc. */
async function drive(run: Promise<unknown>, lines: Array<Record<string, unknown>>, code: number | null = 0): Promise<void> {
  await new Promise((r) => setImmediate(r)); // let spawn + listeners attach
  for (const line of lines) lastChild.stdout.write(JSON.stringify(line) + '\n');
  lastChild.stdout.end();
  await new Promise((r) => setImmediate(r)); // let readline flush 'line' events
  lastChild.emit('close', code);
  await run;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createClaudeBackend', () => {
  it('returns backend, resolved model, and metadata', () => {
    const r = createClaudeBackend({ cwd: '/tmp/p', model: 'claude-sonnet-4-6' });
    expect(r.backend).toBeDefined();
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.metadata).toEqual({ modelSource: 'explicit', supportsStreaming: true, supportsTools: true });
  });

  it('metadata.modelSource is "default" without a model', () => {
    expect(createClaudeBackend({ cwd: '/tmp/p' }).metadata.modelSource).toBe('default');
  });
});

describe('registerClaudeAgent', () => {
  it('registers "claude" as a working backend', () => {
    registerClaudeAgent();
    expect(agentRegistry.has('claude')).toBe(true);
    expect(agentRegistry.create('claude', { cwd: '/tmp/p' })).toBeDefined();
  });
});

describe('startSession (no prompt)', () => {
  it('returns a sessionId, emits idle, and does NOT spawn', async () => {
    const { backend, messages } = makeBackend();
    const { sessionId } = await backend.startSession();
    expect(sessionId).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === 'status' && m.status === 'idle')).toBe(true);
  });
});

describe('spawn arg construction', () => {
  it('uses stream-json + verbose + acceptEdits when non-interactive', async () => {
    const { backend } = makeBackend(); // interactivePermissions:false (see makeBackend)
    const { sessionId } = await backend.startSession();
    await drive(backend.sendPrompt(sessionId, 'hello'), [{ type: 'result' }]);

    const [command, args] = spawnMock.mock.calls[0];
    expect(command).toBe('claude');
    expect(args).toEqual(
      expect.arrayContaining(['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']),
    );
    // No interactive plumbing in non-interactive mode.
    expect(args).not.toContain('--permission-prompt-tool');
    expect(args).not.toContain('--mcp-config');
  });

  it('includes --model and --allowedTools when provided', async () => {
    const { backend } = makeBackend({ model: 'claude-opus-4-8', allowedTools: ['Read', 'Bash(git *)'] });
    const { sessionId } = await backend.startSession();
    await drive(backend.sendPrompt(sessionId, 'go'), [{ type: 'result' }]);

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-8', '--allowedTools', 'Read,Bash(git *)']));
  });

  it('resumes the captured claude session_id on the next prompt', async () => {
    const { backend } = makeBackend();
    const { sessionId } = await backend.startSession();
    await drive(backend.sendPrompt(sessionId, 'first'), [
      { type: 'system', subtype: 'init', session_id: 'claude-abc' },
      { type: 'result' },
    ]);
    await drive(backend.sendPrompt(sessionId, 'second'), [{ type: 'result' }]);

    const [, args2] = spawnMock.mock.calls[1];
    expect(args2).toEqual(expect.arrayContaining(['--resume', 'claude-abc']));
  });
});

describe('stream-json -> AgentMessage mapping', () => {
  it('assistant text -> model-output; usage -> cost-report', async () => {
    const { backend, messages } = makeBackend();
    const { sessionId } = await backend.startSession();
    await drive(backend.sendPrompt(sessionId, 'hi'), [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello!' }], usage: { input_tokens: 12, output_tokens: 7 } } },
      { type: 'result' },
    ]);
    expect(messages).toContainEqual({ type: 'model-output', fullText: 'Hello!' });
    expect(messages.some((m) => m.type === 'cost-report')).toBe(true);
  });

  it('assistant tool_use -> tool-call (+ fs-edit for Edit/Write)', async () => {
    const { backend, messages } = makeBackend();
    const { sessionId } = await backend.startSession();
    await drive(backend.sendPrompt(sessionId, 'edit'), [
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/p/a.ts' } },
      ] } },
      { type: 'result' },
    ]);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'tool-call', toolName: 'Bash', callId: 't1' }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'tool-call', toolName: 'Edit', callId: 't2' }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'fs-edit', path: '/p/a.ts' }));
  });

  it('user tool_result -> tool-result', async () => {
    const { backend, messages } = makeBackend();
    const { sessionId } = await backend.startSession();
    await drive(backend.sendPrompt(sessionId, 'x'), [
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] } },
      { type: 'result' },
    ]);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'tool-result', callId: 't1', result: 'output' }));
  });

  it('non-JSON stdout lines are ignored (no model-output, no throw)', async () => {
    const { backend, messages } = makeBackend();
    const { sessionId } = await backend.startSession();
    const run = backend.sendPrompt(sessionId, 'x');
    await new Promise((r) => setImmediate(r));
    lastChild.stdout.write('not json at all\n');
    lastChild.stdout.end();
    await new Promise((r) => setImmediate(r));
    lastChild.emit('close', 0);
    await run;
    expect(messages.some((m) => m.type === 'model-output')).toBe(false);
  });
});

describe('lifecycle', () => {
  it('clean exit (code 0) emits idle and resolves', async () => {
    const { backend, messages } = makeBackend();
    const { sessionId } = await backend.startSession();
    await drive(backend.sendPrompt(sessionId, 'x'), [{ type: 'result' }], 0);
    expect(messages.some((m) => m.type === 'status' && m.status === 'idle')).toBe(true);
  });

  it('non-zero exit rejects with an error status', async () => {
    const { backend, messages } = makeBackend();
    const { sessionId } = await backend.startSession();
    const run = backend.sendPrompt(sessionId, 'x');
    await new Promise((r) => setImmediate(r));
    lastChild.stdout.end();
    await new Promise((r) => setImmediate(r));
    lastChild.emit('close', 2);
    await expect(run).rejects.toThrow(/code 2/);
    expect(messages.some((m) => m.type === 'status' && m.status === 'error')).toBe(true);
  });

  it('cancel sends SIGTERM, emits idle, and the run resolves (intentional cancel)', async () => {
    const { backend, messages } = makeBackend();
    const { sessionId } = await backend.startSession();
    const run = backend.sendPrompt(sessionId, 'x');
    await new Promise((r) => setImmediate(r));
    await backend.cancel(sessionId);
    expect(lastChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(messages.some((m) => m.type === 'status' && m.status === 'idle')).toBe(true);
    lastChild.emit('close', null); // cancelled exit
    await expect(run).resolves.toBeUndefined();
  });

  it('sendPrompt after dispose throws', async () => {
    const { backend } = makeBackend();
    await backend.dispose();
    await expect(backend.sendPrompt('s', 'p')).rejects.toThrow(/disposed/);
  });

  it('sendPrompt with a mismatched sessionId throws', async () => {
    const { backend } = makeBackend();
    await backend.startSession();
    await expect(backend.sendPrompt('wrong-id', 'p')).rejects.toThrow(/Invalid session ID/);
  });
});

describe('billing detection from stream-json apiKeySource', () => {
  it('init apiKeySource:"none" → cost-report billed as subscription ($0)', async () => {
    const { backend, messages } = makeBackend();
    const { sessionId } = await backend.startSession();
    await drive(backend.sendPrompt(sessionId, 'hi'), [
      { type: 'system', subtype: 'init', session_id: 'claude-x', apiKeySource: 'none' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: 'result' },
    ]);

    const cost = messages.find((m) => m.type === 'cost-report') as
      | { type: 'cost-report'; report: { billingModel: string; costUsd: number } }
      | undefined;
    expect(cost).toBeDefined();
    // Corrected from the api-key seed to subscription via the init line.
    expect(cost!.report.billingModel).toBe('subscription');
    expect(cost!.report.costUsd).toBe(0);
  });
});

describe('interactive per-tool permissions', () => {
  it('spawns with default mode + permission-prompt-tool + mcp-config (the product default)', async () => {
    const { backend } = makeInteractive();
    const { sessionId } = await backend.startSession();
    await drive(backend.sendPrompt(sessionId, 'go'), [{ type: 'result' }]);

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining([
        '--permission-mode', 'default',
        '--strict-mcp-config',
        '--permission-prompt-tool', 'mcp__styrby__permission_prompt',
      ]),
    );
    // --mcp-config points at a real temp file path.
    const cfgIdx = args.indexOf('--mcp-config');
    expect(cfgIdx).toBeGreaterThan(-1);
    expect(typeof args[cfgIdx + 1]).toBe('string');
    // --settings carries the permissions.ask list that forces gated tools to
    // prompt (ask > allow) even under a permissive local config.
    const setIdx = args.indexOf('--settings');
    expect(setIdx).toBeGreaterThan(-1);
    const settings = JSON.parse(args[setIdx + 1] as string);
    expect(settings.permissions.ask).toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit']),
    );
    // It must NOT pass the fixed acceptEdits mode in interactive sessions.
    expect(args).not.toContain('acceptEdits');
    await backend.dispose();
  });

  it('decide() emits a permission-request and respondToPermission(true) approves', async () => {
    const { backend, messages, decide } = makeInteractive();
    const pending = decide('Bash', { command: 'ls' }, 'tool-1');

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'permission-request', id: 'tool-1', payload: { command: 'ls' } }),
    );

    await backend.respondToPermission('tool-1', true);
    await expect(pending).resolves.toEqual({ approved: true });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'permission-response', id: 'tool-1', approved: true }),
    );
    await backend.dispose();
  });

  it('respondToPermission(false) denies the parked tool-use', async () => {
    const { backend, decide } = makeInteractive();
    const pending = decide('Edit', { file_path: '/x.ts' }, 'tool-2');
    await backend.respondToPermission('tool-2', false);
    await expect(pending).resolves.toEqual({ approved: false });
    await backend.dispose();
  });

  it('fails CLOSED (deny) when approval times out', async () => {
    const { backend, messages, decide } = makeInteractive({ permissionTimeoutMs: 20 });
    const pending = decide('Bash', { command: 'rm -rf /' }, 'tool-3');
    await expect(pending).resolves.toEqual({ approved: false, message: 'Approval timed out' });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'permission-response', id: 'tool-3', approved: false }),
    );
    await backend.dispose();
  });

  it('generates a correlation id when claude provides no tool_use id', async () => {
    const { backend, messages, decide } = makeInteractive();
    const pending = decide('Read', { file_path: '/y.ts' }, undefined);
    const req = messages.find((m) => m.type === 'permission-request') as { id: string } | undefined;
    expect(req?.id).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    await backend.respondToPermission(req!.id, true);
    await expect(pending).resolves.toEqual({ approved: true });
    await backend.dispose();
  });

  it('dispose() denies any still-parked approvals so claude can exit', async () => {
    const { backend, decide } = makeInteractive();
    const pending = decide('Bash', { command: 'sleep 999' }, 'tool-4');
    await backend.dispose();
    await expect(pending).resolves.toEqual(expect.objectContaining({ approved: false }));
  });
});
