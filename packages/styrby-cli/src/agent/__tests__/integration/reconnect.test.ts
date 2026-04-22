/**
 * Reconnect resilience test — mid-stream disconnect and fresh factory restart.
 *
 * Simulates the scenario where the agent process dies mid-stream:
 *   1. Replay the first half of the Goose smoke fixture into a backend.
 *   2. Kill the mock process (non-zero exit) mid-stream.
 *   3. Instantiate a fresh factory for the same agent type.
 *   4. Replay the remaining fixture lines into the new backend.
 *   5. Assert:
 *      - No double-counting of cost-report events across both backends.
 *      - No stuck promises (both sendPrompt calls settle, not hang).
 *      - The second backend emits its own cost-report independently.
 *
 * WHY Goose for this test:
 * Goose's fixture includes a 'cost' event at line index 6 (before 'finish' at 7).
 * Splitting at line 4 puts the cost event in the second half — so the first
 * run ends with NO cost-report and the second run ends with ONE. This verifies
 * no accidental accumulation across backends.
 *
 * @module agent/__tests__/integration/reconnect.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import type { MockInstance } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/utils/safeEnv', () => ({
  buildSafeEnv: vi.fn((e: Record<string, string>) => e),
  safeBufferAppend: vi.fn((buf: string, text: string) => buf + text),
  validateExtraArgs: vi.fn((a: string[]) => a),
}));

import { spawn } from 'node:child_process';
import { createGooseBackend } from '../../factories/goose';
import { MockAgentProcess, loadFixture, replayPartial } from './harness';

const mockSpawn = spawn as unknown as MockInstance;

const FIXTURE = resolve(__dirname, './fixtures/goose-smoke.jsonl');

function collectMessages(backend: ReturnType<typeof createGooseBackend>['backend']): unknown[] {
  const messages: unknown[] = [];
  backend.onMessage((m) => messages.push(m));
  return messages;
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('reconnect resilience — mid-stream disconnect', () => {
  it('no double-counting of cost and no stuck promises after reconnect', async () => {
    const lines = loadFixture(FIXTURE);

    // ---- Phase 1: First backend, killed mid-stream at line 4 ----

    const proc1 = new MockAgentProcess();
    mockSpawn.mockReturnValue(proc1);
    const { backend: backend1 } = createGooseBackend({ cwd: '/tmp/smoke', model: 'claude-sonnet-4' });
    const messages1 = collectMessages(backend1);

    const sessionPromise1 = backend1.startSession('hello smoke test');

    // Lines 0-3: message, tool_call, tool_result, message — no cost event yet
    replayPartial(proc1, lines, 4);

    // Simulate a mid-stream crash with exit code 1
    proc1.simulateClose(1);

    // The first sendPrompt should reject (non-zero exit)
    await sessionPromise1.catch(() => {});

    const costReports1 = messages1.filter((m) => (m as { type: string }).type === 'cost-report');
    // WHY: Lines 0-3 contain no 'cost' event. First backend must NOT have a cost-report.
    expect(costReports1.length).toBe(0);

    await backend1.dispose();

    // ---- Phase 2: Fresh backend, replay remaining lines ----

    const proc2 = new MockAgentProcess();
    mockSpawn.mockReturnValue(proc2);
    const { backend: backend2 } = createGooseBackend({ cwd: '/tmp/smoke', model: 'claude-sonnet-4' });
    const messages2 = collectMessages(backend2);

    const sessionPromise2 = backend2.startSession('hello smoke test resumed');

    // Replay remaining lines (index 4+): tool_call, tool_result, cost, finish
    const remaining = lines.slice(4);
    for (const line of remaining) {
      proc2.stdout.write(`${line}\n`);
    }

    proc2.simulateClose(0);

    await expect(sessionPromise2).resolves.toMatchObject({ sessionId: expect.any(String) });

    const modelOutputs2 = messages2.filter((m) => (m as { type: string }).type === 'model-output');
    const costReports2 = messages2.filter((m) => (m as { type: string }).type === 'cost-report');

    // Second backend receives the cost event (from line 6) and finish (line 7)
    expect(modelOutputs2.length).toBeGreaterThanOrEqual(1);
    expect(costReports2.length).toBeGreaterThanOrEqual(1);

    // WHY: Total across both backends must be exactly 1 — no double-counting.
    const totalCostReports = costReports1.length + costReports2.length;
    expect(totalCostReports).toBe(1);

    await backend2.dispose();
  });
});
