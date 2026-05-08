/**
 * cloud-tasks service test suite
 *
 * Covers the cancelCloudTask helper that backs the mobile Cloud Tasks
 * screen's onCancelTask prop.
 */

// ============================================================================
// Mock Setup
// ============================================================================

// styrby-shared: import only the type, no runtime values needed.
jest.mock('styrby-shared', () => ({}));

// Supabase chain mock — captures the full call shape so we can assert on it.
type ChainResult = { data?: unknown; error?: { message: string } | null };

// SELECT chain (cancelCloudTask uses this for the pre-flight status check)
const mockMaybeSingle = jest.fn<Promise<ChainResult>, []>();
const mockSelectEq = { maybeSingle: mockMaybeSingle };
const mockSelect = jest.fn(() => ({ eq: jest.fn(() => mockSelectEq) }));

// UPDATE chain (cancelCloudTask)
const mockUpdateChain = {
  eq: jest.fn<Promise<ChainResult>, [string, string]>(),
};
const mockUpdate = jest.fn(() => mockUpdateChain);

// INSERT chain (submitCloudTask uses .insert(...).select('*').single())
const mockInsertSingle = jest.fn<Promise<ChainResult>, []>();
const mockInsertSelect = jest.fn(() => ({ single: mockInsertSingle }));
// Typed with the row argument so .mock.calls[0][0] is a Record, not undefined.
const mockInsert = jest.fn<{ select: typeof mockInsertSelect }, [Record<string, unknown>]>(
  () => ({ select: mockInsertSelect }),
);

const mockFrom = jest.fn(() => ({
  select: mockSelect,
  update: mockUpdate,
  insert: mockInsert,
}));

// Auth mock for submitCloudTask (it calls auth.getUser).
type GetUserResult = {
  data: { user: { id: string } | null };
  error: { message: string } | null;
};
const mockGetUser = jest.fn<Promise<GetUserResult>, []>(async () => ({
  data: { user: { id: 'user-1' } },
  error: null,
}));

jest.mock('../../lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args as []),
    auth: {
      getUser: () => mockGetUser(),
    },
  },
}));

import {
  cancelCloudTask,
  submitCloudTask,
  CANCELLABLE_STATUSES,
  SUBMITTABLE_AGENTS,
} from '../cloud-tasks';

// ============================================================================
// Tests
// ============================================================================

describe('cloud-tasks service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('CANCELLABLE_STATUSES', () => {
    it('matches the CLI cancel whitelist (queued + running only)', () => {
      // Mirrors packages/styrby-cli/src/commands/cloud.ts:484 — drift here
      // means UI offers a Cancel button the backend will reject.
      expect(CANCELLABLE_STATUSES).toEqual(['queued', 'running']);
    });
  });

  describe('cancelCloudTask()', () => {
    it('updates status to cancelled when task is queued', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: { status: 'queued' }, error: null });
      mockUpdateChain.eq.mockResolvedValueOnce({ data: null, error: null });

      await cancelCloudTask('task-1');

      expect(mockFrom).toHaveBeenCalledWith('cloud_tasks');
      expect(mockUpdate).toHaveBeenCalledWith({ status: 'cancelled' });
      expect(mockUpdateChain.eq).toHaveBeenCalledWith('id', 'task-1');
    });

    it('updates status to cancelled when task is running', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: { status: 'running' }, error: null });
      mockUpdateChain.eq.mockResolvedValueOnce({ data: null, error: null });

      await cancelCloudTask('task-2');

      expect(mockUpdate).toHaveBeenCalledWith({ status: 'cancelled' });
    });

    it('rejects when task is already completed', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: { status: 'completed' }, error: null });

      await expect(cancelCloudTask('task-3')).rejects.toThrow(
        'Cannot cancel task with status "completed"'
      );
      // CRITICAL: no UPDATE was issued — preventing the silent "succeeds-on-
      // a-finished-task" footgun the pre-flight SELECT exists to prevent.
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects when task is already failed', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: { status: 'failed' }, error: null });

      await expect(cancelCloudTask('task-4')).rejects.toThrow(
        'Cannot cancel task with status "failed"'
      );
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects when task is already cancelled', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: { status: 'cancelled' }, error: null });

      await expect(cancelCloudTask('task-5')).rejects.toThrow(
        'Cannot cancel task with status "cancelled"'
      );
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects with task-not-found message when SELECT returns no rows', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

      await expect(cancelCloudTask('missing-task')).rejects.toThrow(
        'Task missing-task not found'
      );
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects when SELECT itself errors', async () => {
      mockMaybeSingle.mockResolvedValueOnce({
        data: null,
        error: { message: 'connection timeout' },
      });

      await expect(cancelCloudTask('task-6')).rejects.toThrow('connection timeout');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects when UPDATE itself errors (after passing the gate)', async () => {
      mockMaybeSingle.mockResolvedValueOnce({ data: { status: 'queued' }, error: null });
      mockUpdateChain.eq.mockResolvedValueOnce({
        data: null,
        error: { message: 'permission denied' },
      });

      await expect(cancelCloudTask('task-7')).rejects.toThrow('permission denied');
      // UPDATE was attempted — this distinguishes "RLS rejected" from the
      // "wrong-status" rejection that should never reach the UPDATE call.
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe('SUBMITTABLE_AGENTS', () => {
    it('matches the CLI submit agent whitelist (all 11 agents)', () => {
      // Mirrors packages/styrby-cli/src/commands/cloud.ts:265 — drift here
      // means the picker offers an agent the cloud_tasks.agent_type CHECK
      // will reject.
      expect(SUBMITTABLE_AGENTS).toEqual([
        'claude', 'codex', 'gemini', 'opencode', 'aider',
        'goose', 'amp', 'crush', 'kilo', 'kiro', 'droid',
      ]);
    });
  });

  describe('submitCloudTask()', () => {
    function makeCompleteRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'new-task-id',
        user_id: 'user-1',
        session_id: null,
        agent_type: 'claude',
        status: 'queued',
        prompt: 'do the thing',
        result: null,
        error_message: null,
        started_at: '2026-05-08T10:00:00.000Z',
        completed_at: null,
        estimated_duration_ms: null,
        cost_usd: null,
        metadata: null,
        ...overrides,
      };
    }

    it('rejects empty prompt (CLI parity: cloud.ts:259)', async () => {
      await expect(
        submitCloudTask({ prompt: '   ', agentType: 'claude' }),
      ).rejects.toThrow('Prompt is required');
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('rejects unknown agent type (CLI parity: cloud.ts:265)', async () => {
      await expect(
        // @ts-expect-error — intentionally passing an invalid agent to verify validation
        submitCloudTask({ prompt: 'hello', agentType: 'gpt5' }),
      ).rejects.toThrow('Invalid agent');
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('rejects when user is not authenticated', async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
      await expect(
        submitCloudTask({ prompt: 'hello', agentType: 'claude' }),
      ).rejects.toThrow('Not authenticated');
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('inserts a queued task with the correct shape', async () => {
      const row = makeCompleteRow();
      mockInsertSingle.mockResolvedValueOnce({ data: row, error: null });

      const task = await submitCloudTask({
        prompt: 'do the thing',
        agentType: 'claude',
      });

      // The insert call shape mirrors the CLI's submitCloudTask.
      const insertCall = mockInsert.mock.calls[0][0];
      expect(insertCall).toMatchObject({
        user_id: 'user-1',
        session_id: null,
        agent_type: 'claude',
        status: 'queued',
        prompt: 'do the thing',
        metadata: null,
        estimated_duration_ms: null,
      });
      expect(typeof insertCall?.started_at).toBe('string');

      // Returned task is the typed CloudTask form
      expect(task).toEqual({
        id: 'new-task-id',
        sessionId: null,
        agentType: 'claude',
        status: 'queued',
        prompt: 'do the thing',
        result: null,
        errorMessage: null,
        startedAt: '2026-05-08T10:00:00.000Z',
        completedAt: null,
        estimatedDurationMs: null,
        costUsd: null,
        metadata: null,
      });
    });

    it('forwards optional sessionId + metadata to the row', async () => {
      mockInsertSingle.mockResolvedValueOnce({
        data: makeCompleteRow({
          session_id: 'sess-42',
          metadata: { projectPath: '/repo', gitBranch: 'main' },
        }),
        error: null,
      });

      await submitCloudTask({
        prompt: 'review the PR',
        agentType: 'claude',
        sessionId: 'sess-42',
        metadata: { projectPath: '/repo', gitBranch: 'main' },
      });

      const insertCall = mockInsert.mock.calls[0][0];
      expect(insertCall.session_id).toBe('sess-42');
      expect(insertCall.metadata).toEqual({ projectPath: '/repo', gitBranch: 'main' });
    });

    it('trims surrounding whitespace from the prompt before insert', async () => {
      mockInsertSingle.mockResolvedValueOnce({
        data: makeCompleteRow({ prompt: 'hello' }),
        error: null,
      });

      await submitCloudTask({ prompt: '   hello   ', agentType: 'claude' });

      const insertCall = mockInsert.mock.calls[0][0];
      expect(insertCall.prompt).toBe('hello');
    });

    it('rejects when the INSERT itself errors (e.g. RLS blocks free-tier user)', async () => {
      mockInsertSingle.mockResolvedValueOnce({
        data: null,
        error: { message: 'row violates row-level security policy' },
      });

      await expect(
        submitCloudTask({ prompt: 'hello', agentType: 'claude' }),
      ).rejects.toThrow('row violates row-level security policy');
    });

    it('rejects when auth.getUser itself errors', async () => {
      mockGetUser.mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'session expired' },
      });

      await expect(
        submitCloudTask({ prompt: 'hello', agentType: 'claude' }),
      ).rejects.toThrow('session expired');
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});
