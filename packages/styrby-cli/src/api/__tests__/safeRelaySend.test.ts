/**
 * Tests for safeRelaySend — uniform error-handling wrapper for relay sends.
 *
 * WHY (B4-Wave2): The wrapper REPLACES ~10 disparate `.catch(() => {})` and
 * `.catch((e) => logger.debug(...))` sites in apiSession.ts. The contract that
 * matters:
 *   1. Always resolves (never rejects); callers don't need their own .catch
 *   2. Success returns { ok: true; result }
 *   3. Failure returns { ok: false; error } AND logs at WARN with full context
 *   4. Context (sessionId, messageType, detail) reaches the warn line
 *
 * @module api/__tests__/safeRelaySend
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
  },
}));

import { safeRelaySend, type SafeRelaySendContext } from '../safeRelaySend';

describe('safeRelaySend', () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear();
  });

  // --------------------------------------------------------------------------
  // Success path
  // --------------------------------------------------------------------------

  it('returns { ok: true; result } when the inner send resolves', async () => {
    const ctx: SafeRelaySendContext = { sessionId: 's-1', messageType: 'session-state' };
    const r = await safeRelaySend(Promise.resolve('sent'), ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result).toBe('sent');
    }
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('preserves the resolved value type (object / number / void are all fine)', async () => {
    const objRes = await safeRelaySend(Promise.resolve({ id: 123 }), {
      sessionId: 's-2',
      messageType: 'agent-response',
    });
    expect(objRes.ok).toBe(true);
    if (objRes.ok) expect(objRes.result).toEqual({ id: 123 });

    const numRes = await safeRelaySend(Promise.resolve(42), {
      sessionId: 's-3',
      messageType: 'permission-request',
    });
    if (numRes.ok) expect(numRes.result).toBe(42);

    const voidRes = await safeRelaySend<void>(Promise.resolve(), {
      sessionId: 's-4',
      messageType: 'unknown',
    });
    if (voidRes.ok) expect(voidRes.result).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Failure path — never rethrows
  // --------------------------------------------------------------------------

  it('returns { ok: false; error } when the inner send rejects (does NOT rethrow)', async () => {
    const failure = new Error('relay-down');
    const ctx: SafeRelaySendContext = { sessionId: 's-5', messageType: 'agent-response' };

    // The very fact that `await` doesn't throw is the contract we're pinning
    const r = await safeRelaySend(Promise.reject(failure), ctx);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(failure);
    }
  });

  it('handles non-Error rejections (string, plain object) without crashing', async () => {
    const stringErr = await safeRelaySend(Promise.reject('not-an-error-instance'), {
      sessionId: 's-6',
      messageType: 'session-state',
    });
    expect(stringErr.ok).toBe(false);
    if (!stringErr.ok) expect(stringErr.error).toBe('not-an-error-instance');

    const objErr = await safeRelaySend(Promise.reject({ code: 'EBOOM' }), {
      sessionId: 's-7',
      messageType: 'session-state',
    });
    expect(objErr.ok).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Logging contract
  // --------------------------------------------------------------------------

  it('logs at WARN (not debug) on rejection with sessionId + messageType + error in context', async () => {
    await safeRelaySend(Promise.reject(new Error('network-blip')), {
      sessionId: 'sess-abc-123',
      messageType: 'permission-request',
      detail: 'tool-Bash',
    });

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = mockLoggerWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('Relay send failed');
    expect(ctx.sessionId).toBe('sess-abc-123');
    expect(ctx.messageType).toBe('permission-request');
    expect(ctx.detail).toBe('tool-Bash');
    expect(ctx.error).toBe('network-blip');
  });

  it('logs the string form of non-Error rejections so log-grep still works', async () => {
    await safeRelaySend(Promise.reject({ status: 503 }), {
      sessionId: 's-9',
      messageType: 'session-state',
    });

    const [, ctx] = mockLoggerWarn.mock.calls[0] as [string, Record<string, unknown>];
    // Non-Error → stringified via String(error). For plain object, that's '[object Object]'.
    // The exact representation doesn't matter; the field must be present + non-empty.
    expect(typeof ctx.error).toBe('string');
    expect((ctx.error as string).length).toBeGreaterThan(0);
  });

  it('does NOT log on success (no warn spam for the happy path)', async () => {
    await safeRelaySend(Promise.resolve('ok'), {
      sessionId: 's-10',
      messageType: 'agent-response',
    });

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('keeps detail field optional (undefined) — no crash if caller omits it', async () => {
    await safeRelaySend(Promise.reject(new Error('x')), {
      sessionId: 's-11',
      messageType: 'unknown',
      // detail intentionally omitted
    });

    const [, ctx] = mockLoggerWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(ctx.detail).toBeUndefined();
  });
});

describe('safeRelaySend — fire-and-forget call site idiom', () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear();
  });

  it("the void-prefix idiom (`void safeRelaySend(...)`) doesn't propagate rejections to the unhandled-rejection handler", async () => {
    // Simulate the apiSession.ts pattern where we DON'T await the result.
    // The call returns a promise; if that promise ever rejected, Node's
    // unhandled-rejection handler would fire. The point of safeRelaySend
    // is that this CAN'T happen — internal try/catch absorbs everything.
    let unhandledFired = false;
    const handler = (): void => {
      unhandledFired = true;
    };
    process.on('unhandledRejection', handler);

    void safeRelaySend(Promise.reject(new Error('drop me silently from external view')), {
      sessionId: 's-fire',
      messageType: 'agent-response',
    });

    // Wait long enough that any unhandled-rejection would have fired.
    // 50ms is well past the microtask + nextTick boundary.
    await new Promise((r) => setTimeout(r, 50));

    process.off('unhandledRejection', handler);

    expect(unhandledFired).toBe(false);
    // BUT the warn DID fire — failure is visible via logs, not via unhandled-rejection.
    expect(mockLoggerWarn).toHaveBeenCalled();
  });
});
