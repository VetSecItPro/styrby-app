/**
 * Integration smoke test — Kiro agent factory (AWS, credit-based billing).
 *
 * @module factories/__tests__/kiro-integration.test.ts
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
import { createKiroBackend } from '../kiro';
import { runAgentSmokeTest } from '../../__tests__/integration/harness';

const mockSpawn = spawn as unknown as MockInstance;

const FIXTURE = resolve(__dirname, '../../__tests__/integration/fixtures/kiro-smoke.jsonl');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('Kiro factory — integration smoke', () => {
  it('completes a smoke session with cost emission', async () => {
    await runAgentSmokeTest({
      factory: (proc) => {
        mockSpawn.mockReturnValue(proc);
        return createKiroBackend({ cwd: '/tmp/smoke', model: 'claude-sonnet-4' }).backend;
      },
      fixturePath: FIXTURE,
      // WHY: Kiro's credit-based billing model converts credits_consumed -> USD
      // via KIRO_CREDIT_TO_USD constant. The fixture's 'usage' event has
      // credits_consumed=5, so the emitted cost-report should have costUsd=0.05.
      expected: { minModelOutputs: 1, requireCostReport: true, requireCleanClose: true },
    });
  });
});
