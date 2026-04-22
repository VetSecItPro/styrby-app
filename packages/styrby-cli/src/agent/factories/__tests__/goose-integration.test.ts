/**
 * Integration smoke test — Goose agent factory (Block/AI Alliance).
 *
 * @module factories/__tests__/goose-integration.test.ts
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
import { createGooseBackend } from '../goose';
import { runAgentSmokeTest } from '../../__tests__/integration/harness';

const mockSpawn = spawn as unknown as MockInstance;

const FIXTURE = resolve(__dirname, '../../__tests__/integration/fixtures/goose-smoke.jsonl');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('Goose factory — integration smoke', () => {
  it('completes a smoke session with cost emission', async () => {
    await runAgentSmokeTest({
      factory: (proc) => {
        mockSpawn.mockReturnValue(proc);
        return createGooseBackend({ cwd: '/tmp/smoke', model: 'claude-sonnet-4' }).backend;
      },
      fixturePath: FIXTURE,
      // WHY: Goose emits 'cost-report' inline when a 'cost' event is parsed.
      // The 'finish' event triggers idle status before process close resolves sendPrompt.
      expected: { minModelOutputs: 1, requireCostReport: true, requireCleanClose: true },
    });
  });
});
