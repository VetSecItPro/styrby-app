/**
 * Integration smoke test — Gemini factory (ACP protocol).
 *
 * Verifies the Gemini factory pipeline: createGeminiBackend -> AcpBackend ->
 * event emission -> model-output + cost-report delivery to onMessage handlers.
 *
 * WHY AcpBackend mock (not MockAgentProcess):
 * Gemini uses the Agent Client Protocol via @agentclientprotocol/sdk rather
 * than raw stdout parsing. Mocking AcpBackend lets us fire AgentMessage events
 * directly, testing that the Gemini factory correctly wires the AcpBackend and
 * that messages flow through to callers without an installed gemini binary.
 *
 * @module factories/__tests__/gemini-integration.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentMessageHandler } from '../../core';

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/gemini/utils/config', () => ({
  readGeminiLocalConfig: vi.fn(() => ({
    token: null,
    model: null,
    googleCloudProject: null,
    googleCloudProjectEmail: null,
  })),
  determineGeminiModel: vi.fn((_m: unknown) => 'gemini-2.5-pro'),
  getGeminiModelSource: vi.fn(() => 'default'),
}));

vi.mock('@/gemini/constants', () => ({
  GEMINI_API_KEY_ENV: 'GEMINI_API_KEY',
  GOOGLE_API_KEY_ENV: 'GOOGLE_API_KEY',
  GEMINI_MODEL_ENV: 'GEMINI_MODEL',
  DEFAULT_GEMINI_MODEL: 'gemini-2.5-pro',
}));

/**
 * Minimal AcpBackend mock that stores registered handlers and exposes
 * a fireMessages helper so the test can replay the smoke fixture events.
 *
 * WHY store handlers manually rather than using EventEmitter:
 * AcpBackend implements the AgentBackend interface with `onMessage` /
 * `offMessage` methods (not Node.js EventEmitter), so tests must interact
 * through that interface.
 */
const acpHandlers: AgentMessageHandler[] = [];

const mockAcpInstance = {
  onMessage: vi.fn((h: AgentMessageHandler) => { acpHandlers.push(h); }),
  offMessage: vi.fn((h: AgentMessageHandler) => {
    const idx = acpHandlers.indexOf(h);
    if (idx !== -1) acpHandlers.splice(idx, 1);
  }),
  startSession: vi.fn().mockResolvedValue({ sessionId: 'gemini-smoke-session' }),
  sendPrompt: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn(),
  dispose: vi.fn().mockResolvedValue(undefined),
  respondToPermission: vi.fn(),
  waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../acp/AcpBackend', () => ({
  AcpBackend: vi.fn(() => mockAcpInstance),
}));

import { createGeminiBackend } from '../gemini';

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

describe('Gemini factory — integration smoke', () => {
  it('completes a smoke session with cost emission', async () => {
    const { backend } = createGeminiBackend({ cwd: '/tmp/smoke' });

    const messages: unknown[] = [];
    backend.onMessage((m) => messages.push(m));

    const { sessionId } = await backend.startSession('hello smoke test');
    expect(sessionId).toBe('gemini-smoke-session');

    fireMessages([
      { type: 'model-output', textDelta: 'Hello! I will help you with that task using Gemini.' },
      { type: 'tool-call', toolName: 'read_file', args: { path: 'src/index.ts' }, callId: 'gem-c1' },
      { type: 'tool-result', toolName: 'read_file', result: "export function main() { return 'hello'; }", callId: 'gem-c1' },
      { type: 'model-output', textDelta: ' I can see the file. Let me update it.' },
      {
        type: 'cost-report',
        report: {
          sessionId: 'gemini-smoke-session',
          messageId: null,
          agentType: 'gemini',
          model: 'gemini-2.5-pro',
          timestamp: new Date().toISOString(),
          source: 'agent-reported',
          billingModel: 'api-key',
          costUsd: 0.012,
          inputTokens: 950,
          outputTokens: 200,
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
