/**
 * Integration smoke test — Crush agent factory (Charmbracelet).
 *
 * Replays a pre-recorded ACP-compatible JSONL fixture through the CrushBackend
 * pipeline without a real Crush binary.
 *
 * @module factories/__tests__/crush-integration.test.ts
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
import { createCrushBackend } from '../crush';
import { runAgentSmokeTest } from '../../__tests__/integration/harness';

const mockSpawn = spawn as unknown as MockInstance;

const FIXTURE = resolve(__dirname, '../../__tests__/integration/fixtures/crush-smoke.jsonl');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('Crush factory — integration smoke', () => {
  it('completes a smoke session with cost emission', async () => {
    await runAgentSmokeTest({
      factory: (proc) => {
        mockSpawn.mockReturnValue(proc);
        return createCrushBackend({ cwd: '/tmp/smoke', model: 'claude-sonnet-4' }).backend;
      },
      fixturePath: FIXTURE,
      // WHY: Crush emits 'cost-report' inline on 'usage' event (before 'done'),
      // so it arrives before process close. requireCostReport validates the parser
      // correctly maps CrushUsageMetadata fields.
      expected: { minModelOutputs: 1, requireCostReport: true, requireCleanClose: true },
    });
  });
});
