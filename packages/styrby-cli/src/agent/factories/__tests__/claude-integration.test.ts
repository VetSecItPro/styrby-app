/**
 * Integration smoke test — Claude factory helpers.
 *
 * Replays a pre-recorded JSONL fixture through the Claude factory's parser
 * pipeline (`detectClaudeBillingModel` + `parseClaudeJsonlLine`) to verify
 * that a realistic Claude JSONL sequence produces model-output events and at
 * least one CostReport with the correct shape.
 *
 * WHY no real spawn:
 * The `claude.ts` factory module exports pure helpers, not an AgentBackend class
 * (Claude runs via ACP through AcpBackend). This test validates the JSONL-path
 * cost extraction helpers that are reused by the ACP session handler.
 *
 * @module factories/__tests__/claude-integration.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    existsSync: vi.fn((p: string) => {
      if (String(p).endsWith('auth.json')) return false;
      return real.existsSync(p);
    }),
    readFileSync: vi.fn((p: unknown, ...args: unknown[]) => {
      if (String(p).endsWith('auth.json')) return '{}';
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...args);
    }),
  };
});

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { detectClaudeBillingModel, parseClaudeJsonlLine } from '../claude';

const FIXTURE = resolve(__dirname, '../../__tests__/integration/fixtures/claude-smoke.jsonl');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('Claude factory helpers — integration smoke', () => {
  it('completes a smoke session with cost emission', () => {
    const billingModel = detectClaudeBillingModel();
    expect(billingModel).toBe('api-key');

    const raw = readFileSync(FIXTURE, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const sessionId = 'smoke-claude-session-001';

    const modelOutputLines: string[] = [];
    const costReports: ReturnType<typeof parseClaudeJsonlLine>[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { type?: string; message?: { content?: unknown[] } };
        if (
          parsed.type === 'assistant' &&
          Array.isArray(parsed.message?.content)
        ) {
          const textBlocks = (parsed.message.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text' && b.text);
          if (textBlocks.length > 0) {
            modelOutputLines.push(line);
          }
        }
      } catch {
        // skip non-JSON
      }

      const report = parseClaudeJsonlLine(line, sessionId, billingModel);
      if (report) {
        costReports.push(report);
      }
    }

    expect(modelOutputLines.length).toBeGreaterThanOrEqual(1);
    expect(costReports.length).toBeGreaterThanOrEqual(1);

    const firstReport = costReports[0]!;
    expect(firstReport.agentType).toBe('claude');
    expect(firstReport.billingModel).toBe('api-key');
    expect(firstReport.source).toBe('agent-reported');
    expect(firstReport.sessionId).toBe(sessionId);
    expect(firstReport.inputTokens).toBeGreaterThan(0);
  });
});
