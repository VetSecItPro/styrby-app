/**
 * Tests for the cloud command handlers.
 *
 * Covers:
 * - dispatchCloudCommand routing to the correct handler
 * - handleCloudSubmit: argument validation, Supabase insert, CLI output
 * - handleCloudStatus: task lookup, status/result/error formatting
 * - handleCloudList: pagination, status filtering, empty state
 * - handleCloudCancel: status validation, cancellation
 * - submitCloudTask: success/failure paths
 * - Authentication guard (unauthenticated → exit 1)
 *
 * WHY: Cloud tasks are asynchronous and rely on Supabase interactions.
 * Unit tests with mocked Supabase ensure the logic is correct without
 * network calls and catch regressions in argument parsing and output formatting.
 *
 * @module commands/__tests__/cloud.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks — must be defined before vi.mock factory references them.
// WHY: vi.mock is hoisted to the top of the file by vitest; any variables
// it closes over must be defined before the factory runs. Using vi.fn() inline
// in the factory avoids the "cannot access before initialization" error.
// ============================================================================

vi.mock('@supabase/supabase-js', () => {
  /**
   * Builds a fluent chain mock that resolves to `result` when .single() or
   * the terminal async call is awaited.
   */
  function chain(result: unknown) {
    const c: Record<string, unknown> = {};
    const self = () => c;
    c.select = vi.fn(self);
    c.insert = vi.fn(self);
    c.update = vi.fn(self);
    c.eq    = vi.fn(self);
    c.order = vi.fn(self);
    c.limit = vi.fn().mockResolvedValue(result);
    c.single = vi.fn().mockResolvedValue(result);
    // Make the object itself a thenable so awaiting it directly works
    c.then = (resolve: (v: unknown) => void) => resolve(result);
    return c;
  }

  const mockAuth = {
    getUser: vi.fn(),
    setSession: vi.fn().mockResolvedValue({ error: null }),
  };

  const mockClient = {
    auth: mockAuth,
    from: vi.fn(),
  };

  return {
    createClient: vi.fn(() => mockClient),
    __mock: { client: mockClient, chain },
  };
});

vi.mock('@/persistence', () => ({
  loadPersistedData: vi.fn().mockResolvedValue({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    userId: 'user-uuid-001',
    machineId: 'machine-001',
  }),
}));

vi.mock('@/env', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    isDev: true,
    isProd: false,
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    log:   vi.fn(),
    error: vi.fn(),
    warn:  vi.fn(),
    info:  vi.fn(),
  },
}));

// ============================================================================
// Import after mocks
// ============================================================================

import {
  submitCloudTask,
  handleCloudSubmit,
  handleCloudStatus,
  handleCloudList,
  handleCloudCancel,
  dispatchCloudCommand,
} from '../cloud';

import { createClient } from '@supabase/supabase-js';
import { loadPersistedData } from '@/persistence';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns the mock supabase client instance created by vi.mock.
 */
function getMockClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (createClient as any)() as {
    auth: { getUser: ReturnType<typeof vi.fn>; setSession: ReturnType<typeof vi.fn> };
    from: ReturnType<typeof vi.fn>;
  };
}

/**
 * Builds a fluent Supabase chain mock that terminates to `result`.
 *
 * @param result - The value all terminal calls (.single(), .limit()) will resolve to
 */
function buildChain(result: unknown) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.select = vi.fn(self);
  c.insert = vi.fn(self);
  c.update = vi.fn(self);
  c.eq    = vi.fn(self);
  c.order = vi.fn(self);
  c.limit = vi.fn().mockResolvedValue(result);
  c.single = vi.fn().mockResolvedValue(result);
  return c as unknown as ReturnType<typeof getMockClient>['from'];
}

// ============================================================================
// Fixtures
// ============================================================================

const MOCK_TASK_ROW = {
  id: 'task-uuid-001',
  user_id: 'user-uuid-001',
  session_id: null,
  agent_type: 'claude',
  status: 'queued',
  prompt: 'Write unit tests for auth.ts',
  result: null,
  error_message: null,
  started_at: new Date().toISOString(),
  completed_at: null,
  estimated_duration_ms: null,
  cost_usd: null,
  metadata: null,
};

const MOCK_COMPLETED_TASK_ROW = {
  ...MOCK_TASK_ROW,
  id: 'task-uuid-002',
  status: 'completed',
  result: 'Generated 12 test cases covering happy paths and edge cases.',
  completed_at: new Date().toISOString(),
  cost_usd: 0.0042,
};

// ============================================================================
// Tests: submitCloudTask
// ============================================================================

describe('submitCloudTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const client = getMockClient();
    client.auth.setSession.mockResolvedValue({ error: null });
    client.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-uuid-001' } } });
  });

  it('returns success with created task on valid input', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: MOCK_TASK_ROW, error: null }));

    const result = await submitCloudTask({
      prompt: 'Write unit tests',
      agentType: 'claude',
    });

    expect(result.success).toBe(true);
    expect(result.task?.id).toBe('task-uuid-001');
    expect(result.task?.status).toBe('queued');
    expect(result.task?.agentType).toBe('claude');
  });

  it('returns failure when not authenticated', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadPersistedData).mockResolvedValueOnce(null as any);

    const result = await submitCloudTask({
      prompt: 'Write tests',
      agentType: 'codex',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authenticated/i);
  });

  it('returns failure when Supabase insert errors', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: null, error: { message: 'Insert failed' } }));

    const result = await submitCloudTask({
      prompt: 'Refactor this code',
      agentType: 'gemini',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insert failed');
  });

  it('passes sessionId when provided', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({
      data: { ...MOCK_TASK_ROW, session_id: 'sess-001' },
      error: null,
    }));

    const result = await submitCloudTask({
      prompt: 'Add docs',
      agentType: 'claude',
      sessionId: 'sess-001',
    });

    expect(result.success).toBe(true);
    expect(result.task?.sessionId).toBe('sess-001');
  });
});

// ============================================================================
// Tests: handleCloudSubmit
// ============================================================================

describe('handleCloudSubmit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const client = getMockClient();
    client.auth.setSession.mockResolvedValue({ error: null });
    client.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-uuid-001' } } });
  });

  it('returns exit code 1 when prompt is empty', async () => {
    const code = await handleCloudSubmit('', {});
    expect(code).toBe(1);
  });

  it('returns exit code 1 when prompt is whitespace only', async () => {
    const code = await handleCloudSubmit('   ', {});
    expect(code).toBe(1);
  });

  it('returns exit code 1 when agent is invalid', async () => {
    const code = await handleCloudSubmit('Write tests', { agent: 'invalid-agent' });
    expect(code).toBe(1);
  });

  it('returns exit code 0 on successful submission', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: MOCK_TASK_ROW, error: null }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await handleCloudSubmit('Write tests for auth.ts', { agent: 'claude' });
    consoleSpy.mockRestore();

    expect(code).toBe(0);
  });

  it('returns exit code 1 when Supabase insert fails', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: null, error: { message: 'DB error' } }));

    const code = await handleCloudSubmit('Write tests', { agent: 'claude' });
    expect(code).toBe(1);
  });

  it('accepts all valid agent types', async () => {
    const agents = ['claude', 'codex', 'gemini', 'opencode', 'aider', 'goose', 'amp'];
    for (const agent of agents) {
      const client = getMockClient();
      client.from.mockReturnValue(buildChain({
        data: { ...MOCK_TASK_ROW, agent_type: agent },
        error: null,
      }));
      client.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-uuid-001' } } });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const code = await handleCloudSubmit('Test prompt', { agent });
      consoleSpy.mockRestore();

      expect(code, `Expected 0 for agent=${agent}`).toBe(0);
    }
  });

  it('defaults to claude when no agent flag is set', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: MOCK_TASK_ROW, error: null }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await handleCloudSubmit('Write tests', {});
    consoleSpy.mockRestore();

    expect(code).toBe(0);
  });
});

// ============================================================================
// Tests: handleCloudStatus
// ============================================================================

describe('handleCloudStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const client = getMockClient();
    client.auth.setSession.mockResolvedValue({ error: null });
  });

  it('returns exit code 1 when taskId is empty', async () => {
    const code = await handleCloudStatus('');
    expect(code).toBe(1);
  });

  it('returns exit code 1 when task is not found', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: null, error: { message: 'Not found' } }));

    const code = await handleCloudStatus('nonexistent-id');
    expect(code).toBe(1);
  });

  it('returns exit code 0 for a queued task', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: MOCK_TASK_ROW, error: null }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await handleCloudStatus('task-uuid-001');
    consoleSpy.mockRestore();

    expect(code).toBe(0);
  });

  it('displays result for completed task', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: MOCK_COMPLETED_TASK_ROW, error: null }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await handleCloudStatus('task-uuid-002');

    expect(code).toBe(0);
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Generated 12 test cases');
    consoleSpy.mockRestore();
  });

  it('displays error message for failed tasks', async () => {
    const failedTask = { ...MOCK_TASK_ROW, status: 'failed', error_message: 'Agent crashed unexpectedly' };
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: failedTask, error: null }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await handleCloudStatus('task-uuid-err');

    expect(code).toBe(0);
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Agent crashed unexpectedly');
    consoleSpy.mockRestore();
  });

  it('displays prompt in output', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: MOCK_TASK_ROW, error: null }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleCloudStatus('task-uuid-001');

    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Write unit tests for auth.ts');
    consoleSpy.mockRestore();
  });
});

// ============================================================================
// Tests: handleCloudList
// ============================================================================

describe('handleCloudList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const client = getMockClient();
    client.auth.setSession.mockResolvedValue({ error: null });
  });

  function buildListChain(result: unknown) {
    // List uses .order().limit() — both must be mocked
    const c: Record<string, unknown> = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn(() => c);
    c.order = vi.fn(() => c);
    c.limit = vi.fn().mockResolvedValue(result);
    return c;
  }

  it('returns exit code 0 with empty task list', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildListChain({ data: [], error: null }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await handleCloudList({ limit: 10 });

    expect(code).toBe(0);
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('No cloud tasks');
    consoleSpy.mockRestore();
  });

  it('returns exit code 0 and lists tasks when data exists', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildListChain({
      data: [MOCK_TASK_ROW, MOCK_COMPLETED_TASK_ROW],
      error: null,
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await handleCloudList({ limit: 10 });

    expect(code).toBe(0);
    const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain(MOCK_TASK_ROW.id.slice(0, 8));
    consoleSpy.mockRestore();
  });

  it('returns exit code 1 when Supabase errors', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildListChain({ data: null, error: { message: 'Connection refused' } }));

    const code = await handleCloudList({ limit: 10 });
    expect(code).toBe(1);
  });

  it('applies limit via the Supabase chain', async () => {
    const limitSpy = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = getMockClient();
    client.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: limitSpy,
    });

    await handleCloudList({ limit: 5 });
    expect(limitSpy).toHaveBeenCalledWith(5);
  });
});

// ============================================================================
// Tests: handleCloudCancel
// ============================================================================

describe('handleCloudCancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const client = getMockClient();
    client.auth.setSession.mockResolvedValue({ error: null });
  });

  it('returns exit code 1 when taskId is empty', async () => {
    const code = await handleCloudCancel('');
    expect(code).toBe(1);
  });

  it('returns exit code 1 when task is not found', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: null, error: { message: 'Not found' } }));

    const code = await handleCloudCancel('nonexistent-id');
    expect(code).toBe(1);
  });

  it('returns exit code 1 when task is already completed', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({
      data: { id: 'task-uuid-002', status: 'completed' },
      error: null,
    }));

    const code = await handleCloudCancel('task-uuid-002');
    expect(code).toBe(1);
  });

  it('returns exit code 1 when task is already cancelled', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({
      data: { id: 'task-uuid-003', status: 'cancelled' },
      error: null,
    }));

    const code = await handleCloudCancel('task-uuid-003');
    expect(code).toBe(1);
  });

  it('returns exit code 1 when task is failed', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({
      data: { id: 'task-uuid-004', status: 'failed' },
      error: null,
    }));

    const code = await handleCloudCancel('task-uuid-004');
    expect(code).toBe(1);
  });

  it('returns exit code 0 when successfully cancelling a queued task', async () => {
    const client = getMockClient();
    let callCount = 0;

    client.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: select to check status
        return buildChain({ data: { id: 'task-uuid-001', status: 'queued' }, error: null });
      }
      // Second call: update to cancelled
      const updateChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
      };
      return updateChain;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await handleCloudCancel('task-uuid-001');
    consoleSpy.mockRestore();

    expect(code).toBe(0);
  });

  it('returns exit code 0 when successfully cancelling a running task', async () => {
    const client = getMockClient();
    let callCount = 0;

    client.from.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return buildChain({ data: { id: 'task-uuid-003', status: 'running' }, error: null });
      }
      const updateChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
      };
      return updateChain;
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await handleCloudCancel('task-uuid-003');
    consoleSpy.mockRestore();

    expect(code).toBe(0);
  });
});

// ============================================================================
// Tests: dispatchCloudCommand
// ============================================================================

describe('dispatchCloudCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const client = getMockClient();
    client.auth.setSession.mockResolvedValue({ error: null });
    client.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-uuid-001' } } });
  });

  it('routes submit subcommand and returns 0 on success', async () => {
    const client = getMockClient();
    client.from.mockReturnValue(buildChain({ data: MOCK_TASK_ROW, error: null }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await dispatchCloudCommand('submit', ['Write tests for auth.ts'], { agent: 'claude' });
    consoleSpy.mockRestore();

    expect(code).toBe(0);
  });

  it('routes list subcommand and returns 0 on success', async () => {
    const client = getMockClient();
    client.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await dispatchCloudCommand('list', [], {});
    consoleSpy.mockRestore();

    expect(code).toBe(0);
  });

  it('returns exit code 1 for unknown subcommand', async () => {
    const code = await dispatchCloudCommand('bogus', [], {});
    expect(code).toBe(1);
  });

  it('applies default limit of 10 for list command', async () => {
    const limitSpy = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = getMockClient();
    client.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: limitSpy,
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await dispatchCloudCommand('list', [], {});
    consoleSpy.mockRestore();

    expect(limitSpy).toHaveBeenCalledWith(10);
  });

  it('clamps list limit to 50 maximum', async () => {
    const limitSpy = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = getMockClient();
    client.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: limitSpy,
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await dispatchCloudCommand('list', [], { limit: 999 });
    consoleSpy.mockRestore();

    expect(limitSpy).toHaveBeenCalledWith(50);
  });

  it('clamps list limit to 1 minimum', async () => {
    const limitSpy = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = getMockClient();
    client.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: limitSpy,
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await dispatchCloudCommand('list', [], { limit: 0 });
    consoleSpy.mockRestore();

    expect(limitSpy).toHaveBeenCalledWith(1);
  });
});
