/**
 * Integration smoke test — OpenCode agent factory.
 *
 * @module factories/__tests__/opencode-integration.test.ts
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
import { createOpenCodeBackend } from '../opencode';
import { runAgentSmokeTest } from '../../__tests__/integration/harness';

const mockSpawn = spawn as unknown as MockInstance;

const FIXTURE = resolve(__dirname, '../../__tests__/integration/fixtures/opencode-smoke.jsonl');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('OpenCode factory — integration smoke', () => {
  it('completes a smoke session with cost emission', async () => {
    await runAgentSmokeTest({
      factory: (proc) => {
        mockSpawn.mockReturnValue(proc);
        return createOpenCodeBackend({ cwd: '/tmp/smoke', model: 'claude-sonnet-4-20250514' }).backend;
      },
      fixturePath: FIXTURE,
      // WHY: OpenCode emits 'cost-report' when a 'session' event arrives with a
      // non-undefined Cost field. The fixture's session event has Cost=0.017 so
      // this tests the full agent-reported cost path.
      expected: { minModelOutputs: 1, requireCostReport: true, requireCleanClose: true },
    });
  });
});
