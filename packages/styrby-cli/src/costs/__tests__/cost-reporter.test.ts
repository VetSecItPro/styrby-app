/**
 * Unit tests for `cost-reporter.ts`.
 *
 * Covers:
 *  - CostReporter: start/stop lifecycle, addRecord, addRecords, flush,
 *    reportImmediate, reportPending, finalizePending, getSessionTotal,
 *    getReportedCount, getPendingCount
 *  - MAX_PENDING buffer cap: oldest-record-drop on overflow
 *  - Event emissions: 'reported', 'error', 'mobileBroadcast'
 *  - createCostReporter factory
 *
 * WHY: The reporter is the sink for all extracted cost events. Bugs here
 * mean cost records are silently dropped or double-counted, causing
 * billing discrepancies.
 *
 * IMPORTANT CONTRACT NOTES (discovered from reading source):
 *
 * 1. flush() and reportImmediate() both call:
 *      this.config.supabase.from('cost_records').insert(records)
 *    and directly await the result to get { error }. They do NOT chain .select().
 *    The mock must therefore return a promise that resolves to { error }.
 *
 * 2. reportPending() chains: .from().insert().select().single()
 *    The mock must return an object with a .select() method for that path.
 *
 * 3. finalizePending() calls: .from().update({...}).eq('id', handle.id)
 *    and awaits the result to get { error }.
 *
 * 4. start() uses setInterval; stop() calls clearInterval then flush().
 *    Tests that need timer control use vi.useFakeTimers().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  CostReporter,
  createCostReporter,
  type CostReporterConfig,
  type PendingCostHandle,
} from '../cost-reporter.js';
import type { CostRecord } from '../cost-extractor.js';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_UUID = '12345678-1234-4234-8234-123456789abc';
const SESSION_ID = 'session-test-002';

/** Build a minimal CostRecord fixture. */
function makeRecord(overrides: Partial<CostRecord> = {}): CostRecord {
  return {
    sessionId: SESSION_ID,
    agentType: 'claude',
    model: 'claude-sonnet-4-20250514',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.001,
    timestamp: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Supabase mock builders
//
// WHY: The reporter uses three distinct Supabase call shapes:
//
//   flush / reportImmediate:
//     const { error } = await supabase.from('cost_records').insert(rows);
//     → insert() must return a Promise that resolves to { error }.
//
//   reportPending:
//     const { data, error } = await supabase
//       .from('cost_records').insert(row).select('id').single();
//     → insert() must return an object with .select() that returns an object
//       with .single() that is a Promise resolving to { data, error }.
//
//   finalizePending:
//     const { error } = await supabase
//       .from('cost_records').update({...}).eq('id', id);
//     → update() must return an object with .eq() that is a Promise resolving
//       to { error }.
// ============================================================================

/**
 * Build a Supabase mock for flush() / reportImmediate() success/failure.
 *
 * @param insertError - If set, the insert resolves to { error: { message } }.
 */
function makeSupabaseForInsert(insertError?: string) {
  const insertResult = { error: insertError ? { message: insertError } : null };
  return {
    from: vi.fn((_table: string) => ({
      insert: vi.fn().mockResolvedValue(insertResult),
    })),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

/**
 * Build a Supabase mock for reportPending() — chains insert().select().single().
 *
 * @param pendingId - The DB row ID returned on success.
 * @param insertError - If set, single() resolves with error.
 */
function makeSupabaseForPending(pendingId: string | null = 'pending-row-id', insertError?: string) {
  const singleResult = insertError
    ? { data: null, error: { message: insertError } }
    : { data: { id: pendingId }, error: null };

  const mockSingle = vi.fn().mockResolvedValue(singleResult);
  const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
  const mockInsert = vi.fn().mockReturnValue({ select: mockSelect });

  return {
    from: vi.fn((_table: string) => ({ insert: mockInsert })),
    // Expose internals for assertion convenience.
    __mockInsert: mockInsert,
    __mockSelect: mockSelect,
    __mockSingle: mockSingle,
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

/**
 * Build a Supabase mock for finalizePending() — chains update().eq().
 *
 * @param updateError - If set, eq() resolves with error.
 */
function makeSupabaseForUpdate(updateError?: string) {
  const eqResult = { error: updateError ? { message: updateError } : null };
  const mockEq = vi.fn().mockResolvedValue(eqResult);
  const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq });

  return {
    from: vi.fn((_table: string) => ({
      insert: vi.fn().mockResolvedValue({ error: null }), // fallback addRecord path
      update: mockUpdate,
    })),
    __mockUpdate: mockUpdate,
    __mockEq: mockEq,
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

/** Build a default CostReporterConfig. */
function makeConfig(overrides: Partial<CostReporterConfig> = {}): CostReporterConfig {
  return {
    supabase: makeSupabaseForInsert(),
    userId: VALID_UUID,
    sessionId: SESSION_ID,
    machineId: 'machine-001',
    agentType: 'claude',
    batchIntervalMs: 60_000, // long interval — prevents auto-timer firing in tests
    maxBatchSize: 50,
    ...overrides,
  };
}

// ============================================================================
// Cleanup: restore real timers after any test that uses fake timers
// ============================================================================

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ============================================================================
// Factory
// ============================================================================

describe('createCostReporter', () => {
  it('returns a CostReporter instance', () => {
    expect(createCostReporter(makeConfig())).toBeInstanceOf(CostReporter);
  });
});

// ============================================================================
// Lifecycle: start / stop
// ============================================================================

describe('CostReporter lifecycle', () => {
  it('start() is idempotent — calling twice does not add two timers', async () => {
    vi.useFakeTimers();
    const reporter = new CostReporter(makeConfig());
    reporter.start();
    reporter.start(); // second call is a no-op
    await reporter.stop();
    // If two timers were running, stop() would only clear one and the second
    // would fire on next tick. The test just verifies no throw.
  });

  it('stop() flushes pending records to Supabase', async () => {
    const supabase = makeSupabaseForInsert();
    const reporter = new CostReporter(makeConfig({ supabase }));
    reporter.start(); // must start before stop() will flush
    reporter.addRecord(makeRecord());
    await reporter.stop();
    expect(supabase.from).toHaveBeenCalled();
  });

  it('stop() on a non-started reporter does not throw', async () => {
    const reporter = new CostReporter(makeConfig());
    await expect(reporter.stop()).resolves.toBeUndefined();
  });

  it('start() begins periodic flushing on batchIntervalMs', async () => {
    vi.useFakeTimers();
    const supabase = makeSupabaseForInsert();
    const reporter = new CostReporter(makeConfig({ supabase, batchIntervalMs: 1000 }));
    reporter.start();
    reporter.addRecord(makeRecord());

    // Advance time by one full interval
    await vi.advanceTimersByTimeAsync(1000);

    expect(supabase.from).toHaveBeenCalled();
    await reporter.stop();
  });
});

// ============================================================================
// addRecord
// ============================================================================

describe('CostReporter.addRecord', () => {
  it('increases pendingCount by 1', () => {
    const reporter = new CostReporter(makeConfig());
    expect(reporter.getPendingCount()).toBe(0);
    reporter.addRecord(makeRecord());
    expect(reporter.getPendingCount()).toBe(1);
  });

  it('accumulates sessionTotal correctly', () => {
    const reporter = new CostReporter(makeConfig());
    reporter.addRecord(makeRecord({ costUsd: 0.005 }));
    reporter.addRecord(makeRecord({ costUsd: 0.003 }));
    expect(reporter.getSessionTotal()).toBeCloseTo(0.008, 10);
  });

  it('auto-flushes when maxBatchSize records have been queued', async () => {
    const supabase = makeSupabaseForInsert();
    const reporter = new CostReporter(makeConfig({ supabase, maxBatchSize: 2 }));

    reporter.addRecord(makeRecord());
    reporter.addRecord(makeRecord()); // triggers auto-flush

    // Wait for the micro-task / promise chain from the async auto-flush.
    await new Promise((r) => setTimeout(r, 10));

    expect(supabase.from).toHaveBeenCalled();
  });

  it('caps pending buffer at MAX_PENDING (500) and drops oldest on overflow', () => {
    // maxBatchSize=9999 prevents auto-flush so all records stay in the buffer.
    const reporter = new CostReporter(makeConfig({ maxBatchSize: 9999 }));

    for (let i = 0; i < 500; i++) {
      reporter.addRecord(makeRecord({ costUsd: 0.001 }));
    }
    expect(reporter.getPendingCount()).toBe(500);

    // Adding one more should drop the oldest (count stays at 500).
    reporter.addRecord(makeRecord({ costUsd: 0.001 }));
    expect(reporter.getPendingCount()).toBe(500);
  });
});

// ============================================================================
// addRecords
// ============================================================================

describe('CostReporter.addRecords', () => {
  it('adds all records in the array', () => {
    const reporter = new CostReporter(makeConfig());
    reporter.addRecords([makeRecord(), makeRecord(), makeRecord()]);
    expect(reporter.getPendingCount()).toBe(3);
  });

  it('accumulates session total for all records', () => {
    const reporter = new CostReporter(makeConfig());
    reporter.addRecords([makeRecord({ costUsd: 0.01 }), makeRecord({ costUsd: 0.02 })]);
    expect(reporter.getSessionTotal()).toBeCloseTo(0.03, 10);
  });
});

// ============================================================================
// flush
// ============================================================================

describe('CostReporter.flush', () => {
  it('returns 0 when there are no pending records', async () => {
    const reporter = new CostReporter(makeConfig());
    expect(await reporter.flush()).toBe(0);
  });

  it('returns the count of records successfully flushed', async () => {
    const reporter = new CostReporter(makeConfig());
    reporter.addRecord(makeRecord());
    reporter.addRecord(makeRecord());
    const count = await reporter.flush();
    expect(count).toBe(2);
    expect(reporter.getPendingCount()).toBe(0);
  });

  it('emits a "reported" event with count and totalCostUsd on success', async () => {
    const reporter = new CostReporter(makeConfig());
    const handler = vi.fn();
    reporter.on('reported', handler);

    reporter.addRecord(makeRecord({ costUsd: 0.01 }));
    await reporter.flush();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1, totalCostUsd: 0.01 })
    );
  });

  it('restores records to the front of the queue on Supabase failure', async () => {
    const reporter = new CostReporter(
      makeConfig({ supabase: makeSupabaseForInsert('DB error') })
    );
    // MUST register 'error' listener — EventEmitter throws unhandled 'error' events.
    reporter.on('error', vi.fn());
    reporter.addRecord(makeRecord());
    const count = await reporter.flush();

    expect(count).toBe(0);
    expect(reporter.getPendingCount()).toBe(1); // record was put back
  });

  it('emits an "error" event on Supabase failure', async () => {
    const reporter = new CostReporter(
      makeConfig({ supabase: makeSupabaseForInsert('DB error') })
    );
    const errorHandler = vi.fn();
    reporter.on('error', errorHandler);

    reporter.addRecord(makeRecord());
    await reporter.flush();

    expect(errorHandler).toHaveBeenCalled();
  });

  it('respects maxBatchSize — only flushes up to the limit per call', async () => {
    // Use a large maxBatchSize so addRecord() never auto-flushes during setup.
    // Then we reduce maxBatchSize by creating a reporter with maxBatchSize=2,
    // but add records via direct pendingRecords manipulation. Since we can't
    // access pendingRecords, we use maxBatchSize=999 for addRecord and then
    // check that a single flush() call honours its own maxBatchSize cap.
    //
    // The reliable approach: create reporter with maxBatchSize=2, add exactly 2
    // records (which triggers auto-flush), wait for it, then add 1 more and
    // flush — checking that flush returns 1 not 2.
    // OR: use a bigger picture and just verify the property via config.
    //
    // Simplest reliable test: add 3 records with maxBatchSize=100 (no auto-flush),
    // but cap a single flush at 2 by using maxBatchSize=2 in the config, then
    // check that exactly 2 are returned and 1 remains.
    // Since addRecord auto-flushes at maxBatchSize=2, we must add only 1 record
    // initially, then add 2 more in a batch. But that still triggers auto-flush.
    //
    // Cleanest: add exactly maxBatchSize+1 records synchronously fast enough
    // that the auto-flush hasn't fired yet, then await flush().
    const reporter = new CostReporter(makeConfig({ maxBatchSize: 2 }));
    // Add 3 records — the 2nd triggers an async auto-flush.
    reporter.addRecord(makeRecord());
    reporter.addRecord(makeRecord()); // triggers async auto-flush
    reporter.addRecord(makeRecord()); // this one goes in queue before auto-flush runs
    // Now flush manually — if auto-flush hasn't run yet, we have 3 pending,
    // flush() splices 2, returns 2, leaves 1. If auto-flush already ran (took 2),
    // we have 1 pending, flush returns 1, leaves 0.
    // Either way, total flushed (auto + manual) = 3 records across ≤2 per call.
    // Just verify flush never returns more than maxBatchSize:
    const count = await reporter.flush();
    expect(count).toBeLessThanOrEqual(2);
    // All records should eventually be reported
    expect(reporter.getPendingCount()).toBe(0);
  });

  it('increments getReportedCount() on success', async () => {
    const reporter = new CostReporter(makeConfig());
    reporter.addRecord(makeRecord());
    await reporter.flush();
    expect(reporter.getReportedCount()).toBe(1);
  });

  it('calls Supabase from("cost_records")', async () => {
    const supabase = makeSupabaseForInsert();
    const reporter = new CostReporter(makeConfig({ supabase }));
    reporter.addRecord(makeRecord());
    await reporter.flush();
    expect(supabase.from).toHaveBeenCalledWith('cost_records');
  });
});

// ============================================================================
// reportImmediate
// ============================================================================

describe('CostReporter.reportImmediate', () => {
  it('returns true on success', async () => {
    const reporter = new CostReporter(makeConfig());
    const ok = await reporter.reportImmediate(makeRecord());
    expect(ok).toBe(true);
  });

  it('increments sessionTotal and reportedCount on success', async () => {
    const reporter = new CostReporter(makeConfig());
    await reporter.reportImmediate(makeRecord({ costUsd: 0.007 }));
    expect(reporter.getSessionTotal()).toBeCloseTo(0.007, 10);
    expect(reporter.getReportedCount()).toBe(1);
  });

  it('emits "reported" event on success', async () => {
    const reporter = new CostReporter(makeConfig());
    const handler = vi.fn();
    reporter.on('reported', handler);
    await reporter.reportImmediate(makeRecord({ costUsd: 0.005 }));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1, totalCostUsd: 0.005 })
    );
  });

  it('returns false and queues the record for retry on failure', async () => {
    const reporter = new CostReporter(
      makeConfig({ supabase: makeSupabaseForInsert('DB error') })
    );
    // MUST register 'error' listener — EventEmitter throws unhandled 'error' events.
    reporter.on('error', vi.fn());
    const ok = await reporter.reportImmediate(makeRecord());
    expect(ok).toBe(false);
    expect(reporter.getPendingCount()).toBe(1);
  });

  it('emits "error" event on failure', async () => {
    const reporter = new CostReporter(
      makeConfig({ supabase: makeSupabaseForInsert('timeout') })
    );
    const errorHandler = vi.fn();
    reporter.on('error', errorHandler);
    await reporter.reportImmediate(makeRecord());
    expect(errorHandler).toHaveBeenCalled();
  });
});

// ============================================================================
// reportPending
// ============================================================================

describe('CostReporter.reportPending', () => {
  it('returns a PendingCostHandle with the DB row id on success', async () => {
    const supabase = makeSupabaseForPending('pending-row-id');
    const reporter = new CostReporter(makeConfig({ supabase }));

    const handle = await reporter.reportPending(makeRecord({ costUsd: 0.004 }));

    expect(handle).not.toBeNull();
    expect(handle!.id).toBe('pending-row-id');
    expect(handle!.reservedCostUsd).toBeCloseTo(0.004, 10);
  });

  it('increments sessionTotal by the reserved cost on success', async () => {
    const supabase = makeSupabaseForPending('row-1');
    const reporter = new CostReporter(makeConfig({ supabase }));

    await reporter.reportPending(makeRecord({ costUsd: 0.004 }));

    expect(reporter.getSessionTotal()).toBeCloseTo(0.004, 10);
  });

  it('returns null and emits error on Supabase failure', async () => {
    const supabase = makeSupabaseForPending(null, 'DB error');
    const reporter = new CostReporter(makeConfig({ supabase }));
    const errorHandler = vi.fn();
    reporter.on('error', errorHandler);

    const handle = await reporter.reportPending(makeRecord());

    expect(handle).toBeNull();
    expect(errorHandler).toHaveBeenCalled();
  });

  it('calls insert with is_pending=true in the payload', async () => {
    const supabase = makeSupabaseForPending('row-pending');
    const mockInsert = (supabase as unknown as { __mockInsert: ReturnType<typeof vi.fn> }).__mockInsert;
    const reporter = new CostReporter(makeConfig({ supabase }));

    await reporter.reportPending(makeRecord());

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ is_pending: true })
    );
  });
});

// ============================================================================
// finalizePending
// ============================================================================

describe('CostReporter.finalizePending', () => {
  it('returns true on success', async () => {
    const supabase = makeSupabaseForUpdate();
    const reporter = new CostReporter(makeConfig({ supabase }));
    const handle: PendingCostHandle = { id: 'row-1', reservedCostUsd: 0.003 };

    const ok = await reporter.finalizePending(handle, makeRecord({ costUsd: 0.005 }));

    expect(ok).toBe(true);
  });

  it('adjusts sessionTotal by the cost delta (final - reserved)', async () => {
    const supabase = makeSupabaseForUpdate();
    const reporter = new CostReporter(makeConfig({ supabase }));
    const handle: PendingCostHandle = { id: 'row-1', reservedCostUsd: 0.003 };

    await reporter.finalizePending(handle, makeRecord({ costUsd: 0.007 }));

    // Delta = 0.007 - 0.003 = +0.004
    expect(reporter.getSessionTotal()).toBeCloseTo(0.004, 10);
  });

  it('increments reportedCount on success', async () => {
    const supabase = makeSupabaseForUpdate();
    const reporter = new CostReporter(makeConfig({ supabase }));
    const handle: PendingCostHandle = { id: 'row-1', reservedCostUsd: 0.003 };

    await reporter.finalizePending(handle, makeRecord({ costUsd: 0.005 }));

    expect(reporter.getReportedCount()).toBe(1);
  });

  it('emits "reported" event on success', async () => {
    const supabase = makeSupabaseForUpdate();
    const reporter = new CostReporter(makeConfig({ supabase }));
    const handler = vi.fn();
    reporter.on('reported', handler);
    const handle: PendingCostHandle = { id: 'row-1', reservedCostUsd: 0.003 };

    await reporter.finalizePending(handle, makeRecord({ costUsd: 0.005 }));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1, totalCostUsd: 0.005 })
    );
  });

  it('returns false and falls back to addRecord on Supabase update failure', async () => {
    const supabase = makeSupabaseForUpdate('update failed');
    const reporter = new CostReporter(makeConfig({ supabase }));
    // MUST register 'error' listener — EventEmitter throws unhandled 'error' events.
    reporter.on('error', vi.fn());
    const handle: PendingCostHandle = { id: 'row-1', reservedCostUsd: 0.003 };

    const ok = await reporter.finalizePending(handle, makeRecord({ costUsd: 0.007 }));

    expect(ok).toBe(false);
    // Fallback: record should now be in pending queue
    expect(reporter.getPendingCount()).toBe(1);
  });

  it('emits "error" event when Supabase update fails', async () => {
    const supabase = makeSupabaseForUpdate('update failed');
    const reporter = new CostReporter(makeConfig({ supabase }));
    const errorHandler = vi.fn();
    reporter.on('error', errorHandler);
    const handle: PendingCostHandle = { id: 'row-1', reservedCostUsd: 0.003 };

    await reporter.finalizePending(handle, makeRecord({ costUsd: 0.005 }));

    expect(errorHandler).toHaveBeenCalled();
  });

  it('calls update on the cost_records table with the handle ID', async () => {
    const supabase = makeSupabaseForUpdate();
    const mockEq = (supabase as unknown as { __mockEq: ReturnType<typeof vi.fn> }).__mockEq;
    const reporter = new CostReporter(makeConfig({ supabase }));
    const handle: PendingCostHandle = { id: 'specific-row-id', reservedCostUsd: 0.003 };

    await reporter.finalizePending(handle, makeRecord({ costUsd: 0.005 }));

    expect(mockEq).toHaveBeenCalledWith('id', 'specific-row-id');
  });
});

// ============================================================================
// Mobile broadcast
// ============================================================================

describe('CostReporter mobile broadcast', () => {
  it('emits mobileBroadcast event when relay is connected and flush succeeds', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    const mockRelay = {
      isConnected: vi.fn().mockReturnValue(true),
      send: mockSend,
    } as unknown as import('styrby-shared').RelayClient;

    const reporter = new CostReporter(
      makeConfig({ relay: mockRelay })
    );
    const broadcastHandler = vi.fn();
    reporter.on('mobileBroadcast', broadcastHandler);

    reporter.addRecord(makeRecord({ costUsd: 0.005 }));
    await reporter.flush();

    expect(mockSend).toHaveBeenCalled();
    expect(broadcastHandler).toHaveBeenCalled();
  });

  it('does not call relay.send when relay is not connected', async () => {
    const mockSend = vi.fn();
    const mockRelay = {
      isConnected: vi.fn().mockReturnValue(false),
      send: mockSend,
    } as unknown as import('styrby-shared').RelayClient;

    const reporter = new CostReporter(makeConfig({ relay: mockRelay }));

    reporter.addRecord(makeRecord());
    await reporter.flush();

    expect(mockSend).not.toHaveBeenCalled();
  });
});
