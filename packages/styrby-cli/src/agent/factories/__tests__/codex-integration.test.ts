/**
 * Integration smoke test — Codex agent (ACP protocol via createAcpBackend).
 *
 * Verifies the Codex ACP backend pipeline: createAcpBackend (with codex config)
 * -> event emission -> model-output + cost-report delivery to onMessage handlers.
 *
 * WHY no dedicated codex factory file:
 * Codex (codex-acp AgentId) uses createAcpBackend directly with a CodexTransport.
 * There is no separate factories/codex.ts file. This test exercises the ACP
 * backend factory wired with the codex agent name.
 *
 * WHY AcpBackend mock (not MockAgentProcess):
 * Same rationale as the Gemini integration test: the ACP SDK manages the
 * subprocess; we mock AcpBackend to fire events directly.
 *
 * @module factories/__tests__/codex-integration.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentMessageHandler } from '../../core';

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const acpHandlers: AgentMessageHandler[] = [];

const mockAcpInstance = {
  onMessage: vi.fn((h: AgentMessageHandler) => { acpHandlers.push(h); }),
  offMessage: vi.fn((h: AgentMessageHandler) => {
    const idx = acpHandlers.indexOf(h);
    if (idx !== -1) acpHandlers.splice(idx, 1);
  }),
  startSession: vi.fn().mockResolvedValue({ sessionId: 'codex-smoke-session' }),
  sendPrompt: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn(),
  dispose: vi.fn().mockResolvedValue(undefined),
  respondToPermission: vi.fn(),
  waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../acp/AcpBackend', () => ({
  AcpBackend: vi.fn(() => mockAcpInstance),
}));

import { createAcpBackend } from '../../acp/createAcpBackend';

function fireMessages(messages: Array<Record<string, unknown>>): void {
  for (const msg of messages) {
    for (const h of acpHandlers) {
      h(msg as Parameters<AgentMessageHandler>[0]);
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  acpHandlers.length = 0;
});

afterEach(() => { vi.clearAllMocks(); });

describe('Codex factory (ACP) — integration smoke', () => {
  it('completes a smoke session with cost emission', async () => {
    const backend = createAcpBackend({
      agentName: 'codex',
      cwd: '/tmp/smoke',
      command: 'codex',
      args: ['--acp'],
    });

    const messages: unknown[] = [];
    backend.onMessage((m) => messages.push(m));

    const { sessionId } = await backend.startSession('hello smoke test');
    expect(sessionId).toBe('codex-smoke-session');

    fireMessages([
      { type: 'model-output', textDelta: 'Hello! I will assist you using the Codex agent.' },
      { type: 'tool-call', toolName: 'read_file', args: { path: 'src/index.ts' }, callId: 'cdx-c1' },
      { type: 'tool-result', toolName: 'read_file', result: "export function main() { return 'hello'; }", callId: 'cdx-c1' },
      { type: 'model-output', textDelta: ' Reading complete. Preparing the patch.' },
      {
        type: 'patch-apply-begin',
        call_id: 'cdx-patch-1',
        auto_approved: true,
        changes: { 'src/index.ts': { before: "return 'hello'", after: "return 'world'" } },
      },
      {
        type: 'patch-apply-end',
        call_id: 'cdx-patch-1',
        stdout: 'patched 1 file',
        stderr: '',
        success: true,
      },
      { type: 'model-output', textDelta: ' The patch has been applied successfully.' },
      {
        type: 'cost-report',
        report: {
          sessionId: 'codex-smoke-session',
          messageId: null,
          agentType: 'codex',
          model: 'codex-latest',
          timestamp: new Date().toISOString(),
          source: 'agent-reported',
          billingModel: 'api-key',
          costUsd: 0.009,
          inputTokens: 800,
          outputTokens: 175,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          rawAgentPayload: {},
        },
      },
      { type: 'status', status: 'idle' },
    ]);

    const modelOutputs = messages.filter((m) => (m as { type: string }).type === 'model-output');
    const costReports = messages.filter((m) => (m as { type: string }).type === 'cost-report');

    expect(modelOutputs.length).toBeGreaterThanOrEqual(1);
    expect(costReports.length).toBeGreaterThanOrEqual(1);

    await backend.dispose();
  });
});
