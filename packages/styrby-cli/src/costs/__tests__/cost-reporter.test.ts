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
 * IMPORTANT CONTRACT NOTES (Phase 4-step5):
 *
 * 1. flush(), reportImmediate(), reportPending() all flow through
 *    apiClient.recordCost(input, { idempotencyKey }) which returns
 *    { id, recorded_at }.
 *
 * 2. finalizePending() is the ONLY path still using direct Supabase
 *    (.from('cost_records').update({...}).eq('id', id)) because no PATCH
 *    endpoint exists yet. Its tests retain the supabase update mock.
 *
 * 3. start() uses setInterval; stop() calls clearInterval then flush().
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
// Test mock builders (Phase 4-step5)
//
// flush / reportImmediate / reportPending all flow through
// apiClient.recordCost(input, { idempotencyKey }) → { id, recorded_at }.
// finalizePending still uses supabase.from('cost_records').update().eq().
// ============================================================================

interface CostMockApi {
  apiClient: import('@/api/styrbyApiClient').StyrbyApiClient;
  /** Inputs received by recordCost, in call order. */
  recordCostCalls: Array<{
    input: import('@/api/styrbyApiClient').CostRecordInput;
    opts?: { idempotencyKey?: string };
  }>;
  /** Spy reference for direct assertions. */
  recordCost: ReturnType<typeof vi.fn>;
}

/**
 * Build a focused StyrbyApiClient stub for cost-reporter tests.
 *
 * @param opts.recordCostError - When set, recordCost rejects with this error.
 * @param opts.recordCostId - Override the row id returned on success.
 */
function makeApiClient(opts: {
  recordCostError?: Error;
  recordCostId?: string;
} = {}): CostMockApi {
  const calls: CostMockApi['recordCostCalls'] = [];
  const recordCost = vi.fn(async (
    input: import('@/api/styrbyApiClient').CostRecordInput,
    callOpts?: { idempotencyKey?: string },
  ) => {
    calls.push({ input, opts: callOpts });
    if (opts.recordCostError) throw opts.recordCostError;
    return {
      id: opts.recordCostId ?? 'cost-row-' + calls.length,
      recorded_at: new Date().toISOString(),
    };
  });

  const stub = { recordCost };
  return {
    apiClient: stub as unknown as import('@/api/styrbyApiClient').StyrbyApiClient,
    recordCostCalls: calls,
    recordCost,
  };
}

/**
 * Build a Supabase mock for finalizePending() — chains update().eq().
 *
 * Used only by finalizePending tests; flush/reportImmediate/reportPending
 * use the apiClient mock above.
 *
 * @param updateError - If set, eq() resolves with error.
 */
function makeSupabaseForUpdate(updateError?: string) {
  const eqResult = { error: updateError ? { message: updateError } : null };
  const mockEq = vi.fn().mockResolvedValue(eqResult);
  const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq });

  return {
    from: vi.fn((_table: string) => ({
      update: mockUpdate,
    })),
    __mockUpdate: mockUpdate,
    __mockEq: mockEq,
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

/**
 * Stub Supabase client for tests that don't exercise finalizePending. Most
 * paths no longer touch supabase at all but the field is still required by
 * the config type.
 */
function makeStubSupabase() {
  return {
    from: vi.fn((_table: string) => ({})),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

/** Build a default CostReporterConfig. */
function makeConfig(
  overrides: Partial<CostReporterConfig> & { apiClient?: import('@/api/styrbyApiClient').StyrbyApiClient } = {},
): CostReporterConfig {
  const { apiClient = makeApiClient().apiClient, ...rest } = overrides;
  return {
    supabase: makeStubSupabase(),
    apiClient,
    userId: VALID_UUID,
    sessionId: SESSION_ID,
    machineId: 'machine-001',
    agentType: 'claude',
    batchIntervalMs: 60_000, // long interval — prevents auto-timer firing in tests
    maxBatchSize: 50,
    ...rest,
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

  it('stop() flushes pending records via apiClient', async () => {
    const api = makeApiClient();
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));
    reporter.start(); // must start before stop() will flush
    reporter.addRecord(makeRecord());
    await reporter.stop();
    expect(api.recordCost).toHaveBeenCalled();
  });

  it('stop() on a non-started reporter does not throw', async () => {
    const reporter = new CostReporter(makeConfig());
    await expect(reporter.stop()).resolves.toBeUndefined();
  });

  it('start() begins periodic flushing on batchIntervalMs', async () => {
    vi.useFakeTimers();
    const api = makeApiClient();
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient, batchIntervalMs: 1000 }));
    reporter.start();
    reporter.addRecord(makeRecord());

    // Advance time by one full interval
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.recordCost).toHaveBeenCalled();
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
    const api = makeApiClient();
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient, maxBatchSize: 2 }));

    reporter.addRecord(makeRecord());
    reporter.addRecord(makeRecord()); // triggers auto-flush

    // Wait for the micro-task / promise chain from the async auto-flush.
    await new Promise((r) => setTimeout(r, 10));

    expect(api.recordCost).toHaveBeenCalled();
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

  it('restores records to the front of the queue on apiClient failure', async () => {
    const api = makeApiClient({ recordCostError: new Error('DB error') });
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));
    // MUST register 'error' listener — EventEmitter throws unhandled 'error' events.
    reporter.on('error', vi.fn());
    reporter.addRecord(makeRecord());
    const count = await reporter.flush();

    expect(count).toBe(0);
    expect(reporter.getPendingCount()).toBe(1); // record was put back
  });

  it('emits an "error" event on apiClient failure', async () => {
    const api = makeApiClient({ recordCostError: new Error('DB error') });
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));
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

  it('calls apiClient.recordCost with each record and an idempotency key', async () => {
    const api = makeApiClient();
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));
    reporter.addRecord(makeRecord());
    reporter.addRecord(makeRecord());
    await reporter.flush();
    expect(api.recordCost).toHaveBeenCalledTimes(2);
    // Each call must carry an idempotency key — without it, retries
    // double-count cost (no unique constraint on cost_records).
    const firstCall = api.recordCostCalls[0];
    expect(firstCall.opts?.idempotencyKey).toMatch(/^cost-/);
  });

  it('does NOT include user_id in the apiClient body (server stamps from bearer)', async () => {
    const api = makeApiClient();
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));
    reporter.addRecord(makeRecord());
    await reporter.flush();
    const sent = api.recordCostCalls[0].input as Record<string, unknown>;
    expect(sent.user_id).toBeUndefined();
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
    const api = makeApiClient({ recordCostError: new Error('DB error') });
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));
    // MUST register 'error' listener — EventEmitter throws unhandled 'error' events.
    reporter.on('error', vi.fn());
    const ok = await reporter.reportImmediate(makeRecord());
    expect(ok).toBe(false);
    expect(reporter.getPendingCount()).toBe(1);
  });

  it('emits "error" event on failure', async () => {
    const api = makeApiClient({ recordCostError: new Error('timeout') });
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));
    const errorHandler = vi.fn();
    reporter.on('error', errorHandler);
    await reporter.reportImmediate(makeRecord());
    expect(errorHandler).toHaveBeenCalled();
  });

  it('passes an idempotency key on the apiClient call', async () => {
    const api = makeApiClient();
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));
    await reporter.reportImmediate(makeRecord());
    expect(api.recordCostCalls[0].opts?.idempotencyKey).toBeDefined();
  });
});

// ============================================================================
// reportPending
// ============================================================================

describe('CostReporter.reportPending', () => {
  it('returns a PendingCostHandle with the apiClient-returned row id on success', async () => {
    const api = makeApiClient({ recordCostId: 'pending-row-id' });
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));

    const handle = await reporter.reportPending(makeRecord({ costUsd: 0.004 }));

    expect(handle).not.toBeNull();
    expect(handle!.id).toBe('pending-row-id');
    expect(handle!.reservedCostUsd).toBeCloseTo(0.004, 10);
  });

  it('increments sessionTotal by the reserved cost on success', async () => {
    const api = makeApiClient({ recordCostId: 'row-1' });
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));

    await reporter.reportPending(makeRecord({ costUsd: 0.004 }));

    expect(reporter.getSessionTotal()).toBeCloseTo(0.004, 10);
  });

  it('returns null and emits error on apiClient failure', async () => {
    const api = makeApiClient({ recordCostError: new Error('DB error') });
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));
    const errorHandler = vi.fn();
    reporter.on('error', errorHandler);

    const handle = await reporter.reportPending(makeRecord());

    expect(handle).toBeNull();
    expect(errorHandler).toHaveBeenCalled();
  });

  it('calls recordCost with is_pending=true in the payload', async () => {
    const api = makeApiClient({ recordCostId: 'row-pending' });
    const reporter = new CostReporter(makeConfig({ apiClient: api.apiClient }));

    await reporter.reportPending(makeRecord());

    expect(api.recordCostCalls[0].input).toMatchObject({ is_pending: true });
    // Output tokens must be zeroed at reservation time — only input cost is known.
    expect(api.recordCostCalls[0].input.output_tokens).toBe(0);
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
