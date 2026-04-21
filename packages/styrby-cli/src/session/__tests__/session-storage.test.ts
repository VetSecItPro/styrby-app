/**
 * Tests for session/session-storage.ts — updateState() method
 *
 * Covers the new `updateState` method added in Phase 1.6.2 PR-3:
 *   - Builds the correct UPDATE query (status, last_seen_at, last_activity_at)
 *   - Does not write to unrelated columns (no overwriting cost totals, etc.)
 *   - Throws on Supabase error
 *   - Debug logging fires when debug = true
 *
 * WHY: updateState() is called on every relay heartbeat transition (potentially
 * hundreds of times per session). A regression that writes wrong columns or
 * ignores errors would silently corrupt session data at high frequency.
 *
 * @module session/__tests__/session-storage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStorage, type UpdateStateData } from '../session-storage';

// ============================================================================
// Mock logger
// ============================================================================

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ============================================================================
// Helpers
// ============================================================================

/** Minimal 32-byte user secret */
const TEST_SECRET = new Uint8Array(32).fill(0x11);

/**
 * Build a Supabase client mock that captures the UPDATE chain calls.
 * Returns the mock and a spy that receives the final { status, last_seen_at,
 * last_activity_at } update payload.
 */
function buildSupabaseMock(
  options: { error?: { message: string } } = {}
) {
  const updateSpy = vi.fn();
  const eqSpy = vi.fn();

  const chain = {
    update: (payload: Record<string, unknown>) => {
      updateSpy(payload);
      return chain;
    },
    eq: (col: string, val: unknown) => {
      eqSpy(col, val);
      return chain;
    },
    // updateState does NOT call .select() or .single() — it only needs the
    // error field from the raw update result.
    then: (resolve: (v: { error: { message: string } | null }) => void) => {
      resolve({ error: options.error ?? null });
    },
    // Support await via thenable
    [Symbol.toStringTag]: 'Promise',
  };

  // Make chain awaitable (Supabase builder is a thenable)
  const awaitable = {
    ...chain,
    then: (resolve: (v: { error: { message: string } | null }) => void) => {
      resolve({ error: options.error ?? null });
      return awaitable;
    },
    catch: () => awaitable,
    finally: () => awaitable,
  };

  const supabase = {
    from: vi.fn(() => awaitable),
  };

  // Override update on the awaitable object to capture the payload
  awaitable.update = (payload: Record<string, unknown>) => {
    updateSpy(payload);
    return awaitable;
  };
  awaitable.eq = (col: string, val: unknown) => {
    eqSpy(col, val);
    return awaitable;
  };

  return { supabase, updateSpy, eqSpy };
}

// ============================================================================
// Tests
// ============================================================================

describe('SessionStorage.updateState()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls supabase.from("sessions") with the correct table name', async () => {
    const { supabase } = buildSupabaseMock();
    const storage = new SessionStorage({
      supabase: supabase as never,
      userSecret: TEST_SECRET,
    });

    await storage.updateState({
      sessionId: 'session-uuid-abc',
      state: 'running',
      lastSeenAt: '2026-04-21T12:00:00.000Z',
    });

    expect(supabase.from).toHaveBeenCalledWith('sessions');
  });

  it('writes status, last_seen_at, and last_activity_at to the update payload', async () => {
    const { supabase, updateSpy } = buildSupabaseMock();
    const storage = new SessionStorage({
      supabase: supabase as never,
      userSecret: TEST_SECRET,
    });

    const data: UpdateStateData = {
      sessionId: 'session-uuid-abc',
      state: 'paused',
      lastSeenAt: '2026-04-21T12:05:00.000Z',
    };

    await storage.updateState(data);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'paused',
        last_seen_at: '2026-04-21T12:05:00.000Z',
        last_activity_at: '2026-04-21T12:05:00.000Z',
      })
    );
  });

  it('scopes the UPDATE to the provided sessionId via .eq("id", sessionId)', async () => {
    const { supabase, eqSpy } = buildSupabaseMock();
    const storage = new SessionStorage({
      supabase: supabase as never,
      userSecret: TEST_SECRET,
    });

    await storage.updateState({
      sessionId: 'session-uuid-xyz',
      state: 'error',
      lastSeenAt: '2026-04-21T12:10:00.000Z',
    });

    expect(eqSpy).toHaveBeenCalledWith('id', 'session-uuid-xyz');
  });

  it('does NOT write unrelated columns (no title, summary, cost fields)', async () => {
    const { supabase, updateSpy } = buildSupabaseMock();
    const storage = new SessionStorage({
      supabase: supabase as never,
      userSecret: TEST_SECRET,
    });

    await storage.updateState({
      sessionId: 'session-uuid-abc',
      state: 'running',
      lastSeenAt: '2026-04-21T12:00:00.000Z',
    });

    const payload = updateSpy.mock.calls[0][0] as Record<string, unknown>;
    const allowedKeys = new Set(['status', 'last_seen_at', 'last_activity_at']);
    const unexpectedKeys = Object.keys(payload).filter((k) => !allowedKeys.has(k));

    expect(unexpectedKeys).toHaveLength(0);
  });

  it('throws when Supabase returns an error', async () => {
    const { supabase } = buildSupabaseMock({ error: { message: 'row not found' } });
    const storage = new SessionStorage({
      supabase: supabase as never,
      userSecret: TEST_SECRET,
    });

    await expect(
      storage.updateState({
        sessionId: 'missing-session',
        state: 'error',
        lastSeenAt: new Date().toISOString(),
      })
    ).rejects.toThrow('Failed to update session state: row not found');
  });

  it('resolves without throwing on success', async () => {
    const { supabase } = buildSupabaseMock();
    const storage = new SessionStorage({
      supabase: supabase as never,
      userSecret: TEST_SECRET,
    });

    await expect(
      storage.updateState({
        sessionId: 'session-uuid-ok',
        state: 'stopped',
        lastSeenAt: new Date().toISOString(),
      })
    ).resolves.toBeUndefined();
  });

  it('logs the operation when debug = true', async () => {
    const { supabase } = buildSupabaseMock();
    const storage = new SessionStorage({
      supabase: supabase as never,
      userSecret: TEST_SECRET,
      debug: true,
    });

    const { logger } = await import('@/ui/logger');

    await storage.updateState({
      sessionId: 'session-uuid-debug',
      state: 'running',
      lastSeenAt: '2026-04-21T12:00:00.000Z',
    });

    expect(logger.debug).toHaveBeenCalled();
  });

  it('supports all valid SessionStatus values without throwing', async () => {
    const validStates = [
      'starting', 'running', 'idle', 'paused', 'stopped', 'error', 'expired',
    ] as const;

    for (const state of validStates) {
      const { supabase } = buildSupabaseMock();
      const storage = new SessionStorage({
        supabase: supabase as never,
        userSecret: TEST_SECRET,
      });

      await expect(
        storage.updateState({
          sessionId: 'session-uuid-test',
          state,
          lastSeenAt: new Date().toISOString(),
        })
      ).resolves.toBeUndefined();
    }
  });
});
