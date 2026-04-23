/**
 * Tests for the Session Handoff Snapshot Writer
 *
 * Verifies debounce behaviour, captureNow override, destroy cancellation,
 * state merging, error callback invocation, and the destroyed-guard.
 *
 * Test strategy: We inject a Supabase mock that records all INSERT calls
 * so we can assert on the exact rows written without any network traffic.
 * Timers are controlled via Vitest's fake-timer API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSnapshotWriter,
  type SnapshotWriterOptions,
  type SupabaseSnapshotClient,
} from '../../src/session-handoff/snapshot-writer';

// ============================================================================
// Mock Supabase client
// ============================================================================

interface InsertCall {
  row: Record<string, unknown>;
  willError?: boolean;
}

/**
 * Creates a mock Supabase client that records INSERT calls.
 *
 * @param failOnce - If true, the first INSERT returns an error.
 * @returns `{ client, inserts }` — client implements SupabaseSnapshotClient;
 *   inserts accumulates every row passed to .insert().
 */
function createMockSupabase(failOnce = false) {
  const inserts: Record<string, unknown>[] = [];
  let callCount = 0;

  const client: SupabaseSnapshotClient = {
    from(_table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          callCount++;
          const shouldFail = failOnce && callCount === 1;
          return Promise.resolve({
            error: shouldFail ? { message: 'simulated DB error' } : null,
          });
        },
      };
    },
  };

  return { client, inserts };
}

// ============================================================================
// Helpers
// ============================================================================

const SESSION_ID = '11111111-1111-4111-a111-111111111111';
const DEVICE_ID = '22222222-2222-7222-a222-222222222222';

function makeOptions(
  overrides: Partial<SnapshotWriterOptions> & { supabase: SupabaseSnapshotClient },
): SnapshotWriterOptions {
  return {
    sessionId: SESSION_ID,
    deviceId: DEVICE_ID,
    debounceMs: 1_000,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createSnapshotWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // captureNow
  // --------------------------------------------------------------------------

  it('captureNow writes a snapshot immediately without waiting for debounce', async () => {
    const { client, inserts } = createMockSupabase();
    const writer = createSnapshotWriter(makeOptions({ supabase: client }));

    await writer.captureNow({ cursorPosition: 5, scrollOffset: 100, activeDraft: 'hello' });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      session_id: SESSION_ID,
      device_id: DEVICE_ID,
      cursor_position: 5,
      scroll_offset: 100,
      active_draft: 'hello',
      snapshot_version: 1,
    });
  });

  it('captureNow stores null for empty activeDraft', async () => {
    const { client, inserts } = createMockSupabase();
    const writer = createSnapshotWriter(makeOptions({ supabase: client }));

    await writer.captureNow({ activeDraft: '' });

    expect(inserts[0]).toMatchObject({ active_draft: null });
  });

  it('captureNow cancels an in-flight debounce timer', async () => {
    const { client, inserts } = createMockSupabase();
    const writer = createSnapshotWriter(makeOptions({ supabase: client }));

    // Schedule a debounced capture — should NOT fire once captureNow runs.
    writer.scheduleCapture({ cursorPosition: 1 });

    // Immediately capture now.
    await writer.captureNow({ cursorPosition: 2 });

    // Advance timers past debounce window.
    vi.advanceTimersByTime(2_000);

    // Only the captureNow insert should have happened.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ cursor_position: 2 });
  });

  // --------------------------------------------------------------------------
  // scheduleCapture + debounce
  // --------------------------------------------------------------------------

  it('scheduleCapture defers the write until debounce window elapses', async () => {
    const { client, inserts } = createMockSupabase();
    const writer = createSnapshotWriter(makeOptions({ supabase: client }));

    writer.scheduleCapture({ cursorPosition: 3 });

    // No write yet.
    expect(inserts).toHaveLength(0);

    // Advance past debounce window.
    await vi.advanceTimersByTimeAsync(1_500);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ cursor_position: 3 });
  });

  it('multiple scheduleCapture calls within the window coalesce into one write with the latest state', async () => {
    const { client, inserts } = createMockSupabase();
    const writer = createSnapshotWriter(makeOptions({ supabase: client }));

    writer.scheduleCapture({ cursorPosition: 1 });
    writer.scheduleCapture({ cursorPosition: 2 });
    writer.scheduleCapture({ cursorPosition: 3 });

    await vi.advanceTimersByTimeAsync(1_500);

    // Only one write; cursor_position reflects the last update.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ cursor_position: 3 });
  });

  it('scheduleCapture merges partial state updates into accumulated state', async () => {
    const { client, inserts } = createMockSupabase();
    const writer = createSnapshotWriter(makeOptions({ supabase: client }));

    writer.scheduleCapture({ cursorPosition: 5 });
    writer.scheduleCapture({ scrollOffset: 200 });
    writer.scheduleCapture({ activeDraft: 'draft text' });

    await vi.advanceTimersByTimeAsync(1_500);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      cursor_position: 5,
      scroll_offset: 200,
      active_draft: 'draft text',
    });
  });

  // --------------------------------------------------------------------------
  // destroy
  // --------------------------------------------------------------------------

  it('destroy cancels the in-flight debounce timer so no write occurs', async () => {
    const { client, inserts } = createMockSupabase();
    const writer = createSnapshotWriter(makeOptions({ supabase: client }));

    writer.scheduleCapture({ cursorPosition: 9 });
    writer.destroy();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(inserts).toHaveLength(0);
  });

  it('destroy prevents captureNow from writing after it is called', async () => {
    const { client, inserts } = createMockSupabase();
    const writer = createSnapshotWriter(makeOptions({ supabase: client }));

    writer.destroy();
    await writer.captureNow({ cursorPosition: 7 });

    expect(inserts).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  it('invokes onError callback when Supabase INSERT returns an error', async () => {
    const { client } = createMockSupabase(/* failOnce */ true);
    const onError = vi.fn();
    const writer = createSnapshotWriter(makeOptions({ supabase: client, onError }));

    await writer.captureNow({});

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toContain('simulated DB error');
  });

  it('logs a console.warn when no onError callback is provided', async () => {
    const { client } = createMockSupabase(/* failOnce */ true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const writer = createSnapshotWriter(makeOptions({ supabase: client }));

    await writer.captureNow({});

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});
