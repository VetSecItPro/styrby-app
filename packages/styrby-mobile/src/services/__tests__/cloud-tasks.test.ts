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

const mockMaybeSingle = jest.fn<Promise<ChainResult>, []>();
const mockUpdateChain = {
  eq: jest.fn<Promise<ChainResult>, [string, string]>(),
};
const mockUpdate = jest.fn(() => mockUpdateChain);
const mockSelectEq = {
  maybeSingle: mockMaybeSingle,
};
const mockSelect = jest.fn(() => ({ eq: jest.fn(() => mockSelectEq) }));
const mockFrom = jest.fn(() => ({
  select: mockSelect,
  update: mockUpdate,
}));

jest.mock('../../lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args as []),
  },
}));

import { cancelCloudTask, CANCELLABLE_STATUSES } from '../cloud-tasks';

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
});
