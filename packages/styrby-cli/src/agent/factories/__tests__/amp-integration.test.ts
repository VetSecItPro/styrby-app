/**
 * Integration smoke test — Amp agent factory (Sourcegraph).
 *
 * Replays a pre-recorded JSONL fixture through the AmpBackend pipeline
 * (spawn → JSON-parse → cost-report → close) without a real Amp binary.
 *
 * WHY fixture-based:
 * CI nodes do not have `amp` installed. The fixture exercises the structured-JSON
 * parser (`parseAmpJsonLine`), deep-mode sub-agent event handling, tool-call
 * detection, and cost accumulation via the 'usage' message type.
 *
 * @module factories/__tests__/amp-integration.test.ts
 */

import { describe, it, vi, beforeEach, afterEach } from 'vitest';
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
import { createAmpBackend } from '../amp';
import { runAgentSmokeTest } from '../../__tests__/integration/harness';

const mockSpawn = spawn as unknown as MockInstance;

const FIXTURE = resolve(__dirname, '../../__tests__/integration/fixtures/amp-smoke.jsonl');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('Amp factory — integration smoke', () => {
  it('completes a smoke session with cost emission', async () => {
    await runAgentSmokeTest({
      factory: (proc) => {
        mockSpawn.mockReturnValue(proc);
        return createAmpBackend({ cwd: '/tmp/smoke', model: 'claude-sonnet-4' }).backend;
      },
      fixturePath: FIXTURE,
      // WHY: Amp emits 'cost-report' inline when a 'usage' JSON message is
      // parsed (not on process close), so the report arrives before 'done'.
      expected: { minModelOutputs: 1, requireCostReport: true, requireCleanClose: true },
    });
  });
});
