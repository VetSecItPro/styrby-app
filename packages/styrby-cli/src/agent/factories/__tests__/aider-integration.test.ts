/**
 * Integration smoke test — Aider agent factory.
 *
 * Replays a pre-recorded stdout fixture through the AiderBackend pipeline
 * (spawn → stream-parse → cost-report → close) without a real Aider binary.
 *
 * WHY fixture-based:
 * CI nodes do not have `aider` installed. High-fidelity recorded fixtures let
 * us exercise the full factory pipeline — including the `--show-tokens` summary
 * line parser — as a contract test against our own parsing code.
 *
 * @module factories/__tests__/aider-integration.test.ts
 */

import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import type { MockInstance } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('styrby-shared', () => ({ estimateTokensSync: vi.fn((t: string) => Math.ceil(t.length / 4)) }));

import { spawn } from 'node:child_process';
import { createAiderBackend } from '../aider';
import { runAgentSmokeTest } from '../../__tests__/integration/harness';

const mockSpawn = spawn as unknown as MockInstance;

const FIXTURE = resolve(__dirname, '../../__tests__/integration/fixtures/aider-smoke.jsonl');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('Aider factory — integration smoke', () => {
  it('completes a smoke session with cost emission', async () => {
    await runAgentSmokeTest({
      factory: (proc) => {
        mockSpawn.mockReturnValue(proc);
        return createAiderBackend({ cwd: '/tmp/smoke', model: 'gpt-4o' }).backend;
      },
      fixturePath: FIXTURE,
      // WHY: Aider emits cost-report on process 'close' (from the --show-tokens
      // summary line parser), not inline. requireCostReport=true verifies the
      // close-handler path is exercised.
      expected: { minModelOutputs: 1, requireCostReport: true, requireCleanClose: true },
    });
  });
});
