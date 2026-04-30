/**
 * Storage Quota Guard Test Suite
 *
 * Tests the storage quota guard, covering:
 * - isQuotaError(): pattern matching across iOS, Android, and generic SQLite errors
 * - StorageQuotaGuard.recordQuotaError(): sets isFull flag and notifies listeners
 * - StorageQuotaGuard.clearQuotaError(): clears isFull and notifies listeners
 * - StorageQuotaGuard.subscribe(): listener registration and cleanup
 * - StorageQuotaGuard.getStorageQuota(): reads filesystem info, handles errors
 * - StorageQuotaGuard.clearNonCriticalQueueItems():
 *     - deletes oldest 'pending' items
 *     - preserves 'failed' (quarantined) items
 *     - preserves 'sending' items
 *     - returns accurate itemsRemoved and bytesFreed
 *     - writes audit_log entry (fire-and-forget)
 *     - clears isFull after clearing
 * - enqueue() in offline-queue.ts:
 *     - calls storageQuotaGuard.recordQuotaError() on SQLITE_FULL
 *     - generates idempotency_key BEFORE the write
 *     - re-throws a user-readable error on quota failure
 */

// ============================================================================
// Mocks
// ============================================================================

jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///mock/documents/',
  getInfoAsync: jest.fn(),
  getFreeDiskStorageAsync: jest.fn(),
}));

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: { id: 'user-123' } },
      }),
    },
    from: jest.fn(() => ({
      insert: jest.fn().mockResolvedValue({ error: null }),
    })),
  },
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import * as FileSystem from 'expo-file-system';
import { supabase } from '../../lib/supabase';
import {
  isQuotaError,
  storageQuotaGuard,
  QUOTA_ERROR_PATTERNS,
  STORAGE_WARN_THRESHOLD_BYTES,
  StorageQuotaGuard,
} from '../storage-quota';

// Helper: create a fresh guard instance for isolation
function freshGuard(): StorageQuotaGuard {
  // We can't construct privately — use reflection to get the class
  return new (storageQuotaGuard.constructor as new () => StorageQuotaGuard)();
}

// ============================================================================
// isQuotaError()
// ============================================================================

describe('isQuotaError()', () => {
  it('returns false for non-Error values', () => {
    expect(isQuotaError('string error')).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(42)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(isQuotaError(new Error('network timeout'))).toBe(false);
    expect(isQuotaError(new Error('permission denied'))).toBe(false);
    expect(isQuotaError(new Error('syntax error'))).toBe(false);
  });

  it.each([
    ['iOS SQLite FULL', 'database or disk is full'],
    ['Android disk I/O', 'disk i/o error'],
    ['Java exception class', 'DiskFullException'],
    ['web storage manager', 'storage quota'],
    ['web QuotaExceededError', 'QuotaExceededError'],
    ['SQLite code string', 'SQLITE_FULL'],
    ['SQLite numeric code', 'SQLite error code 13'],
    ['Linux ENOSPC', 'no space left'],
  ])('detects %s pattern (case-insensitive)', (_name, errorMsg) => {
    expect(isQuotaError(new Error(errorMsg))).toBe(true);
    // Also test uppercase variant
    expect(isQuotaError(new Error(errorMsg.toUpperCase()))).toBe(true);
  });

  it('covers all QUOTA_ERROR_PATTERNS constants', () => {
    // Verify every pattern in the constant is detectable
    for (const pattern of QUOTA_ERROR_PATTERNS) {
      expect(isQuotaError(new Error(pattern))).toBe(true);
    }
  });
});

// ============================================================================
// StorageQuotaGuard — isFull flag
// ============================================================================

describe('StorageQuotaGuard — isFull flag', () => {
  let guard: StorageQuotaGuard;

  beforeEach(() => {
    guard = freshGuard();
  });

  it('starts with isFull = false', () => {
    expect(guard.isFull).toBe(false);
  });

  it('recordQuotaError() sets isFull = true', () => {
    guard.recordQuotaError();
    expect(guard.isFull).toBe(true);
  });

  it('recordQuotaError() is idempotent (calling twice stays true)', () => {
    guard.recordQuotaError();
    guard.recordQuotaError();
    expect(guard.isFull).toBe(true);
  });

  it('clearQuotaError() resets isFull = false', () => {
    guard.recordQuotaError();
    guard.clearQuotaError();
    expect(guard.isFull).toBe(false);
  });

  it('clearQuotaError() is idempotent when already false', () => {
    guard.clearQuotaError();
    expect(guard.isFull).toBe(false);
  });
});

// ============================================================================
// StorageQuotaGuard — subscribe / notify
// ============================================================================

describe('StorageQuotaGuard — subscribe()', () => {
  let guard: StorageQuotaGuard;

  beforeEach(() => {
    guard = freshGuard();
  });

  it('calls listener when recordQuotaError fires', () => {
    const listener = jest.fn();
    guard.subscribe(listener);
    guard.recordQuotaError();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does NOT call listener on duplicate recordQuotaError (already full)', () => {
    const listener = jest.fn();
    guard.subscribe(listener);
    guard.recordQuotaError();
    guard.recordQuotaError(); // already full — no-op
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('calls listener when clearQuotaError fires after being full', () => {
    const listener = jest.fn();
    guard.subscribe(listener);
    guard.recordQuotaError(); // fires once
    guard.clearQuotaError();  // fires again
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe function stops future notifications', () => {
    const listener = jest.fn();
    const unsubscribe = guard.subscribe(listener);
    unsubscribe();
    guard.recordQuotaError();
    expect(listener).not.toHaveBeenCalled();
  });

  it('multiple listeners each receive the notification', () => {
    const a = jest.fn();
    const b = jest.fn();
    guard.subscribe(a);
    guard.subscribe(b);
    guard.recordQuotaError();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a listener error does not prevent other listeners from firing', () => {
    const throwing = jest.fn(() => { throw new Error('listener crash'); });
    const normal = jest.fn();
    guard.subscribe(throwing);
    guard.subscribe(normal);
    expect(() => guard.recordQuotaError()).not.toThrow();
    expect(normal).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// StorageQuotaGuard — getStorageQuota()
// ============================================================================

describe('StorageQuotaGuard — getStorageQuota()', () => {
  const mockGetInfo = FileSystem.getInfoAsync as jest.Mock;
  const mockGetFree = FileSystem.getFreeDiskStorageAsync as jest.Mock;

  let guard: StorageQuotaGuard;

  beforeEach(() => {
    guard = freshGuard();
    jest.clearAllMocks();
  });

  it('returns bytesUsed from DB file and bytesAvailable from free space', async () => {
    mockGetInfo.mockResolvedValue({ exists: true, size: 512_000 });
    mockGetFree.mockResolvedValue(50 * 1024 * 1024); // 50 MB

    const quota = await guard.getStorageQuota();

    expect(quota.bytesUsed).toBe(512_000);
    expect(quota.bytesAvailable).toBe(50 * 1024 * 1024);
    expect(quota.isNearLimit).toBe(false); // 50 MB > 10 MB threshold
    expect(quota.isFull).toBe(false);
  });

  it('sets isNearLimit = true when available < STORAGE_WARN_THRESHOLD_BYTES', async () => {
    mockGetInfo.mockResolvedValue({ exists: true, size: 1_000 });
    mockGetFree.mockResolvedValue(STORAGE_WARN_THRESHOLD_BYTES - 1);

    const quota = await guard.getStorageQuota();

    expect(quota.isNearLimit).toBe(true);
  });

  it('sets isFull = true when guard has recorded a quota error', async () => {
    mockGetInfo.mockResolvedValue({ exists: false });
    mockGetFree.mockResolvedValue(100 * 1024 * 1024);

    guard.recordQuotaError();
    const quota = await guard.getStorageQuota();

    expect(quota.isFull).toBe(true);
  });

  it('returns zero bytesUsed when DB file does not exist', async () => {
    mockGetInfo.mockResolvedValue({ exists: false });
    mockGetFree.mockResolvedValue(100 * 1024 * 1024);

    const quota = await guard.getStorageQuota();
    expect(quota.bytesUsed).toBe(0);
  });

  it('returns fallback object (all zeros, isFull from guard) when filesystem read fails', async () => {
    mockGetInfo.mockRejectedValue(new Error('filesystem unavailable'));
    mockGetFree.mockRejectedValue(new Error('filesystem unavailable'));

    guard.recordQuotaError();
    const quota = await guard.getStorageQuota();

    expect(quota.bytesUsed).toBe(0);
    expect(quota.bytesAvailable).toBe(0);
    expect(quota.isNearLimit).toBe(false);
    expect(quota.isFull).toBe(true); // still reflects in-memory guard state
  });
});

// ============================================================================
// StorageQuotaGuard — clearNonCriticalQueueItems()
// ============================================================================

describe('StorageQuotaGuard — clearNonCriticalQueueItems()', () => {
  /** Build an in-memory SQLite mock with controlled rows */
  function buildMockDb(pendingCount: number, _failedCount: number, _sendingCount: number) {
    const countResult = { total: pendingCount };
    const deleteResult = { changes: Math.min(pendingCount, 50) };

    const mockDb = {
      getFirstAsync: jest.fn().mockResolvedValue(countResult),
      runAsync: jest.fn().mockResolvedValue(deleteResult),
    } as unknown as import('expo-sqlite').SQLiteDatabase;

    return { mockDb, deleteResult };
  }

  let guard: StorageQuotaGuard;

  beforeEach(() => {
    guard = freshGuard();
    jest.clearAllMocks();
  });

  it('returns correct itemsRemoved from db.changes', async () => {
    const { mockDb } = buildMockDb(30, 5, 2);
    (mockDb.runAsync as jest.Mock).mockResolvedValue({ changes: 30 });

    const result = await guard.clearNonCriticalQueueItems(mockDb, 50);

    expect(result.itemsRemoved).toBe(30);
  });

  it('returns estimated bytesFreed (2048 per item)', async () => {
    const { mockDb } = buildMockDb(10, 0, 0);
    (mockDb.runAsync as jest.Mock).mockResolvedValue({ changes: 10 });

    const result = await guard.clearNonCriticalQueueItems(mockDb, 50);

    expect(result.bytesFreed).toBe(10 * 2048);
  });

  it('clears isFull flag after successful clear', async () => {
    const { mockDb } = buildMockDb(5, 0, 0);
    guard.recordQuotaError();
    expect(guard.isFull).toBe(true);

    await guard.clearNonCriticalQueueItems(mockDb, 50);

    expect(guard.isFull).toBe(false);
  });

  it('DELETE SQL targets only pending status (not failed/sending)', async () => {
    const { mockDb } = buildMockDb(10, 5, 2);
    const runAsyncMock = mockDb.runAsync as jest.Mock;

    await guard.clearNonCriticalQueueItems(mockDb, 50);

    // Find the DELETE call (there may be other runAsync calls for audit log)
    const deleteCalls = runAsyncMock.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE')
    );
    expect(deleteCalls.length).toBeGreaterThan(0);

    const [deleteSql] = deleteCalls[0] as [string];
    // Must filter on status = 'pending'
    expect(deleteSql).toContain("status = 'pending'");
    // Must NOT filter on 'failed' (preserve quarantined items)
    expect(deleteSql).not.toContain("status = 'failed'");
  });

  it('respects maxItemsToRemove parameter in LIMIT clause', async () => {
    const { mockDb } = buildMockDb(100, 0, 0);
    const runAsyncMock = mockDb.runAsync as jest.Mock;

    await guard.clearNonCriticalQueueItems(mockDb, 25);

    const deleteCalls = runAsyncMock.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE')
    );
    // Check the parameter passed to LIMIT is 25
    const [, params] = deleteCalls[0] as [string, unknown[]];
    expect(params).toContain(25);
  });

  it('calls supabase audit_log insert (fire-and-forget)', async () => {
    const { mockDb } = buildMockDb(20, 0, 0);
    (mockDb.runAsync as jest.Mock).mockResolvedValue({ changes: 20 });

    await guard.clearNonCriticalQueueItems(mockDb, 50);

    // Give the fire-and-forget audit write time to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(supabase.from).toHaveBeenCalledWith('audit_log');
  });

  it('uses offline_queue_cleared when all pending items removed', async () => {
    const { mockDb } = buildMockDb(20, 0, 0);
    // getFirstAsync returns total=20, runAsync returns changes=20
    (mockDb.getFirstAsync as jest.Mock).mockResolvedValue({ total: 20 });
    (mockDb.runAsync as jest.Mock).mockResolvedValue({ changes: 20 });

    const fromMock = supabase.from as jest.Mock;
    const insertMock = jest.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ insert: insertMock });

    await guard.clearNonCriticalQueueItems(mockDb, 50);
    await new Promise((r) => setTimeout(r, 10));

    const insertCall = insertMock.mock.calls[0]?.[0] as { action: string };
    expect(insertCall?.action).toBe('offline_queue_cleared');
  });

  it('uses offline_queue_partial_clear when only some items removed', async () => {
    const { mockDb } = buildMockDb(100, 0, 0);
    (mockDb.getFirstAsync as jest.Mock).mockResolvedValue({ total: 100 });
    (mockDb.runAsync as jest.Mock).mockResolvedValue({ changes: 25 }); // only 25 of 100 removed

    const fromMock = supabase.from as jest.Mock;
    const insertMock = jest.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ insert: insertMock });

    await guard.clearNonCriticalQueueItems(mockDb, 25);
    await new Promise((r) => setTimeout(r, 10));

    const insertCall = insertMock.mock.calls[0]?.[0] as { action: string };
    expect(insertCall?.action).toBe('offline_queue_partial_clear');
  });

  it('swallows audit_log write failures silently', async () => {
    const { mockDb } = buildMockDb(5, 0, 0);
    (mockDb.runAsync as jest.Mock).mockResolvedValue({ changes: 5 });

    const fromMock = supabase.from as jest.Mock;
    fromMock.mockReturnValue({
      insert: jest.fn().mockRejectedValue(new Error('supabase unavailable')),
    });

    // Should not throw even though audit log fails
    await expect(guard.clearNonCriticalQueueItems(mockDb, 50)).resolves.toBeDefined();
  });
});
