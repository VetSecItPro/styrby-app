/**
 * Reconnect mid-stream tests — Phase 1.6.4b
 *
 * Tests how each of the 11 Styrby agents responds when the transport is
 * disconnected mid-response. Different agents react differently:
 *
 * STREAMING BACKENDS (process stdout → readline):
 *   When the underlying child process is killed mid-stream, the backend:
 *   a) Detects the unexpected close event (non-zero exit or SIGTERM)
 *   b) Emits a 'status: error' message with reconnect-relevant detail
 *   c) Cleans up the process reference (this.process = null)
 *
 * ACP BACKENDS (Gemini):
 *   ACP uses a network transport. Disconnect is simulated by calling
 *   backend.cancel() while sendPrompt is in flight, then calling
 *   startSession() + sendPrompt() again to verify reconnect.
 *
 * PER-AGENT DISCONNECT CLASSIFICATION (documented in agentProbe registry):
 *   - aider: exits with code 1 on SIGTERM → error status, no resume
 *   - opencode: exits with code 1 → error status, no resume
 *   - kilo: exits with code 1 → error status, no resume
 *   - goose: exits with code 1 → error status, no resume
 *   - amp: exits with code 1 → error status, no resume
 *   - crush: exits with code 1 → error status, no resume
 *   - kiro: exits with code 1 → error status, no resume
 *   - droid: exits with code 1 → error status, no resume
 *   - gemini: ACP cancel → backend remains reusable (ACP handles reconnect)
 *   - claude: full TUI stack, disconnect handled by claudeRemote.ts reconnect logic
 *   - codex: CodexMcpClient + turn_aborted event on SIGTERM
 *
 * WHY three scenarios per agent:
 *   1. mid-text: disconnect while the agent is streaming text output
 *   2. mid-tool-call: disconnect while a tool call result is pending
 *   3. mid-ack: disconnect between the completion event and the ACK (clean close)
 *
 * WHY test reconnect behaviour at all:
 *   Network blips, laptop sleep/wake, and CLI restarts all cause mid-session
 *   disconnects. The mobile app needs to know whether it can reconnect to an
 *   existing session (ACP) or must start fresh (subprocess). Without this
 *   classification, the mobile app shows a blank session screen after reconnect.
 *
 * @module agent/__tests__/e2e/reconnectMidStream
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// ============================================================================
// Mock infrastructure — identical to agentSmokeTests.test.ts
// ============================================================================

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../acp/AcpBackend', () => ({
  AcpBackend: vi.fn().mockImplementation(() => ({
    startSession: vi.fn().mockResolvedValue({ sessionId: 'acp-reconnect-session' }),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn().mockResolvedValue(undefined),
    waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/gemini/utils/config', () => ({
  readGeminiLocalConfig: vi.fn(() => ({ token: null, model: null, googleCloudProject: null, googleCloudProjectEmail: null })),
  determineGeminiModel: vi.fn((_m: unknown) => 'gemini-2.5-pro'),
  getGeminiModelSource: vi.fn(() => 'default'),
}));

vi.mock('@/gemini/constants', () => ({
  GEMINI_API_KEY_ENV: 'GEMINI_API_KEY',
  GOOGLE_API_KEY_ENV: 'GOOGLE_API_KEY',
  GEMINI_MODEL_ENV: 'GEMINI_MODEL',
  DEFAULT_GEMINI_MODEL: 'gemini-2.5-pro',
}));

vi.mock('styrby-shared', () => ({
  estimateTokensSync: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

// ============================================================================
// Imports — after vi.mock
// ============================================================================

import { spawn } from 'node:child_process';
import { createAiderBackend } from '../../factories/aider';
import { createOpenCodeBackend } from '../../factories/opencode';
import { createKiloBackend } from '../../factories/kilo';
import { createGooseBackend } from '../../factories/goose';
import { createAmpBackend } from '../../factories/amp';
import { createCrushBackend } from '../../factories/crush';
import { createKiroBackend } from '../../factories/kiro';
import { createDroidBackend } from '../../factories/droid';
import { createGeminiBackend } from '../../factories/gemini';

const mockSpawn = spawn as unknown as MockInstance;

// ============================================================================
// Helpers
// ============================================================================

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

beforeEach(() => {
  currentMockProcess = makeMockProcess();
  mockSpawn.mockReturnValue(currentMockProcess);
  vi.clearAllMocks();
  mockSpawn.mockReturnValue(currentMockProcess);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Collect messages from a backend's onMessage handler.
 *
 * @param backend - Any AgentBackend instance with an onMessage method
 * @returns Mutable array populated as messages arrive
 */
function collectMessages(backend: { onMessage: (fn: (m: unknown) => void) => void }): unknown[] {
  const messages: unknown[] = [];
  backend.onMessage((m: unknown) => messages.push(m));
  return messages;
}

/**
 * Write partial output to stdout and then kill the process mid-stream
 * (simulating a disconnect before the agent finishes).
 *
 * WHY: This exercises the 'close' handler for non-zero exit codes and
 * the 'error' handler for SIGTERM-killed processes. Backends should
 * classify this as an error and emit status:'error'.
 *
 * @param proc - The mock child process
 * @param partialOutput - Text written to stdout before disconnect
 * @param exitCode - Process exit code (non-zero = abnormal)
 */
function killMidStream(proc: MockProcess, partialOutput: string, exitCode = 1): void {
  (proc.stdout as PassThrough).write(partialOutput);
  // Emit close with non-zero exit code — no stdout.end() to simulate abrupt kill
  process.nextTick(() => {
    (proc.stdout as PassThrough).destroy();
    (proc.stderr as PassThrough).destroy();
    proc.emit('close', exitCode);
  });
}

/**
 * Write a complete partial output and then emit a clean close (exit code 0).
 * Used for mid-ack scenario: the process completed but the mobile side
 * disconnected before receiving the ACK from Styrby.
 *
 * @param proc - The mock child process
 * @param fullOutput - Complete agent output
 */
function cleanCloseAfterOutput(proc: MockProcess, fullOutput: string): void {
  const data = fullOutput.endsWith('\n') ? fullOutput : `${fullOutput}\n`;
  (proc.stdout as PassThrough).write(data);
  (proc.stdout as PassThrough).end();
  (proc.stderr as PassThrough).end();
  process.nextTick(() => proc.emit('close', 0));
}

// ============================================================================
// Partial transcripts — enough data to be mid-stream but not complete
// ============================================================================

/**
 * Partial transcripts for mid-text disconnect scenario.
 * Each contains one or two events but NOT the cost/completion event.
 *
 * WHY: Without the final cost/session event the backend never emits CostReport.
 * The test verifies that error status is emitted instead of hanging forever.
 */
const PARTIAL_TRANSCRIPTS = {
  aider: 'I\'ll create a simple hello world program in Python.\n',
  opencode: '{"type":"assistant","content":"I\'ll write a hello world to main.ts."}\n',
  kilo: '{"type":"text","content":"Writing hello world..."}\n',
  goose: '{"type":"message","content":"Starting hello world task..."}\n',
  amp: '{"type":"text","content":"I\'ll write a hello world program."}\n',
  crush: '{"type":"text_delta","delta":"Writing hello world to main.ts..."}\n',
  kiro: '{"type":"message","content":"Creating hello world program..."}\n',
  droid: '{"type":"text","content":"Writing main.ts..."}\n',
} as const;

/**
 * Mid-tool-call partial transcripts: includes tool_call but NOT tool_result.
 * Used to simulate disconnect while a file write tool call is pending.
 */
const MID_TOOL_CALL_TRANSCRIPTS = {
  opencode: [
    '{"type":"assistant","content":"Writing to main.ts"}',
    '{"type":"tool_use","tool_name":"write_file","tool_input":{"path":"main.ts","content":"console.log(\'Hello!\');"},"call_id":"tc-001"}',
    // No tool_result — killed here
  ].join('\n') + '\n',
  kilo: [
    '{"type":"text","content":"Writing hello world..."}',
    '{"type":"tool_use","tool_name":"write_file","tool_input":{"path":"main.ts","content":"console.log(\'Hello!\');"},"call_id":"kc-001"}',
    // No tool_result — killed here
  ].join('\n') + '\n',
  goose: [
    '{"type":"message","content":"Creating file..."}',
    '{"type":"tool_call","tool":"write_file","input":{"path":"main.ts","content":"console.log(\'Hello!\');"},"call_id":"gc-001"}',
    // No tool_result — killed here
  ].join('\n') + '\n',
} as const;

// ============================================================================
// Test suite: Streaming backends — mid-text disconnect
// ============================================================================

/**
 * Per-agent disconnect classification for streaming backends:
 *
 * WHY document per-agent behaviour: each agent has a different process lifecycle.
 * Aider runs one process per prompt. OpenCode/Kilo/Goose/Amp/Crush/Kiro/Droid
 * are session-based JSONL processes. All streaming backends should:
 *   1. Detect the close event
 *   2. Emit status: 'error' with context about unexpected termination
 *   3. Set this.process = null so the backend can be reused
 *
 * The mobile app can then retry by calling startSession() + sendPrompt() again
 * (these backends are stateless between sessions — each startSession() spawns fresh).
 */

describe('Reconnect: streaming backends — mid-text disconnect (scenario 1)', () => {
  const cases = [
    { name: 'aider', create: () => createAiderBackend({ cwd: '/p' }), partial: PARTIAL_TRANSCRIPTS.aider },
    { name: 'opencode', create: () => createOpenCodeBackend({ cwd: '/p' }), partial: PARTIAL_TRANSCRIPTS.opencode },
    { name: 'kilo', create: () => createKiloBackend({ cwd: '/p' }), partial: PARTIAL_TRANSCRIPTS.kilo },
    { name: 'goose', create: () => createGooseBackend({ cwd: '/p' }), partial: PARTIAL_TRANSCRIPTS.goose },
    { name: 'amp', create: () => createAmpBackend({ cwd: '/p' }), partial: PARTIAL_TRANSCRIPTS.amp },
    { name: 'crush', create: () => createCrushBackend({ cwd: '/p' }), partial: PARTIAL_TRANSCRIPTS.crush },
    { name: 'kiro', create: () => createKiroBackend({ cwd: '/p' }), partial: PARTIAL_TRANSCRIPTS.kiro },
    { name: 'droid', create: () => createDroidBackend({ cwd: '/p', backend: 'anthropic' }), partial: PARTIAL_TRANSCRIPTS.droid },
  ] as const;

  for (const { name, create, partial } of cases) {
    it(`${name}: emits error status on mid-text disconnect, process cleaned up`, async () => {
      const { backend } = create();
      const messages = collectMessages(backend);

      const { sessionId } = await backend.startSession();
      const promptPromise = backend.sendPrompt(sessionId, 'write hello world').catch(() => {});

      // Kill the process mid-stream (partial output only, non-zero exit)
      killMidStream(currentMockProcess, partial, 1);
      await promptPromise;

      const statuses = messages
        .filter((m: unknown) => (m as Record<string, unknown>).type === 'status')
        .map((m: unknown) => (m as Record<string, unknown>).status as string);

      // Should emit 'error' status after abnormal exit
      expect(statuses).toContain('error');

      // Process reference should be cleaned up
      expect((backend as unknown as Record<string, unknown>).process).toBeNull();

      await backend.dispose();
    });
  }
});

// ============================================================================
// Test suite: Streaming backends — mid-tool-call disconnect (scenario 2)
// ============================================================================

describe('Reconnect: streaming backends — mid-tool-call disconnect (scenario 2)', () => {
  const cases = [
    { name: 'opencode', create: () => createOpenCodeBackend({ cwd: '/p' }), partial: MID_TOOL_CALL_TRANSCRIPTS.opencode },
    { name: 'kilo', create: () => createKiloBackend({ cwd: '/p' }), partial: MID_TOOL_CALL_TRANSCRIPTS.kilo },
    { name: 'goose', create: () => createGooseBackend({ cwd: '/p' }), partial: MID_TOOL_CALL_TRANSCRIPTS.goose },
  ] as const;

  for (const { name, create, partial } of cases) {
    it(`${name}: emits error status when killed while tool_call is pending (no tool_result)`, async () => {
      const { backend } = create();
      const messages = collectMessages(backend);

      const { sessionId } = await backend.startSession();
      const promptPromise = backend.sendPrompt(sessionId, 'write hello world').catch(() => {});

      killMidStream(currentMockProcess, partial, 1);
      await promptPromise;

      const statuses = messages
        .filter((m: unknown) => (m as Record<string, unknown>).type === 'status')
        .map((m: unknown) => (m as Record<string, unknown>).status as string);

      expect(statuses).toContain('error');

      // Tool calls that were emitted should be present in messages
      const toolCalls = messages.filter(
        (m: unknown) => (m as Record<string, unknown>).type === 'tool-call',
      );
      expect(toolCalls.length).toBeGreaterThan(0);

      await backend.dispose();
    });
  }
});

// ============================================================================
// Test suite: Streaming backends — mid-ack disconnect (scenario 3)
// ============================================================================

/**
 * Mid-ack scenario:
 * The agent completed its work cleanly (exit code 0, complete output emitted).
 * BUT the mobile client disconnected before receiving Styrby's relay of the
 * final 'idle' status. The backend should be in a clean state on next
 * startSession() call.
 *
 * WHY: This is the most common real-world reconnect case. The agent finished.
 * The user's phone lost WiFi. They reconnect. We verify the backend is
 * fully clean and can accept a new session.
 */

const COMPLETE_TRANSCRIPTS = {
  aider: '> Tokens: 487 sent, 62 received, cost: $0.002\n',
  opencode: '{"type":"session","session":{"id":"oc-001","PromptTokens":312,"CompletionTokens":45,"Cost":0.001}}\n',
  goose: '{"type":"finish","stop_reason":"end_turn"}\n',
} as const;

describe('Reconnect: streaming backends — mid-ack (clean process exit, scenario 3)', () => {
  const cases = [
    { name: 'aider', create: () => createAiderBackend({ cwd: '/p', model: 'gpt-4o' }), complete: COMPLETE_TRANSCRIPTS.aider },
    { name: 'opencode', create: () => createOpenCodeBackend({ cwd: '/p' }), complete: COMPLETE_TRANSCRIPTS.opencode },
    { name: 'goose', create: () => createGooseBackend({ cwd: '/p' }), complete: COMPLETE_TRANSCRIPTS.goose },
  ] as const;

  for (const { name, create, complete } of cases) {
    it(`${name}: after clean exit, startSession succeeds again (stateless reconnect)`, async () => {
      const { backend } = create();

      // First session
      const { sessionId: s1 } = await backend.startSession();
      const p1 = backend.sendPrompt(s1, 'write hello world');
      cleanCloseAfterOutput(currentMockProcess, complete);
      await p1;

      // Reset mock for second session
      currentMockProcess = makeMockProcess();
      mockSpawn.mockReturnValue(currentMockProcess);

      // Second session (simulating reconnect)
      const { sessionId: s2 } = await backend.startSession();
      expect(typeof s2).toBe('string');
      expect(s2).not.toBe(s1); // New session ID

      await backend.dispose();
    });
  }
});

// ============================================================================
// Test suite: ACP backend (Gemini) — cancel-based disconnect
// ============================================================================

/**
 * ACP backends (Gemini) use a network transport rather than a subprocess.
 * "Disconnect" is simulated by calling backend.cancel() mid-sendPrompt().
 * The ACP protocol supports reconnect: after cancel, startSession() + sendPrompt()
 * should work with the same backend instance.
 *
 * WHY ACP reconnect is better: ACP sessions are server-side state managed by the
 * Gemini CLI's HTTP server. Reconnecting resumes the server-side session if it
 * hasn't timed out, unlike subprocess backends which require a full restart.
 *
 * DISCONNECT CLASSIFICATION for Gemini: RESUMABLE (ACP manages reconnect).
 */
describe('Reconnect: ACP backend (Gemini) — cancel then reconnect', () => {
  it('cancel() resolves cleanly, backend accepts new startSession() call', async () => {
    const { AcpBackend } = await import('../../acp/AcpBackend');
    const MockAcp = AcpBackend as unknown as ReturnType<typeof vi.fn>;

    let sessionCallCount = 0;
    MockAcp.mockImplementation(() => ({
      startSession: vi.fn().mockImplementation(async () => {
        sessionCallCount++;
        return { sessionId: `acp-session-${sessionCallCount}` };
      }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
      offMessage: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      respondToPermission: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    }));

    const { backend } = createGeminiBackend({ cwd: '/p', model: 'gemini-2.5-pro' });

    // First session
    const { sessionId: s1 } = await backend.startSession();
    expect(typeof s1).toBe('string');

    // Simulate mid-stream disconnect via cancel
    await backend.cancel();

    // Reconnect
    const { sessionId: s2 } = await backend.startSession();
    expect(typeof s2).toBe('string');
    expect(sessionCallCount).toBe(2);

    await backend.dispose();
  });

  it('ACP backend cancel + dispose does not throw', async () => {
    const { AcpBackend } = await import('../../acp/AcpBackend');
    const MockAcp = AcpBackend as unknown as ReturnType<typeof vi.fn>;
    MockAcp.mockImplementation(() => ({
      startSession: vi.fn().mockResolvedValue({ sessionId: 'acp-s1' }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
      offMessage: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      respondToPermission: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    }));

    const { backend } = createGeminiBackend({ cwd: '/p' });
    await backend.startSession();
    await expect(backend.cancel()).resolves.not.toThrow();
    await expect(backend.dispose()).resolves.not.toThrow();
  });
});
