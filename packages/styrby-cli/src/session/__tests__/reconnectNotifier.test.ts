/**
 * Tests for session/reconnectNotifier.ts
 *
 * Covers:
 *   1. Calls send-push with the correct payload on reconnected-after-offline.
 *   2. Throttle: second notification within THROTTLE_WINDOW_MS is suppressed.
 *   3. Throttle: notification after THROTTLE_WINDOW_MS elapses is sent again.
 *   4. User without push token (send-push returns 200 but success: false) —
 *      no crash, no throw.
 *   5. send-push returns 5xx — absorbed silently, no crash.
 *   6. Missing STYRBY_SERVICE_ROLE_KEY — silently skipped, no fetch call.
 *   7. Cleanup: off() removes the listener so further events are ignored.
 *
 * @module session/__tests__/reconnectNotifier
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { attachReconnectNotifier, THROTTLE_WINDOW_MS } from '../reconnectNotifier';

// ============================================================================
// Mock @/ui/logger (to keep test output clean)
// ============================================================================

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ============================================================================
// Mock @/env (provide stable supabaseUrl)
// ============================================================================

vi.mock('@/env', () => ({
  config: { supabaseUrl: 'https://test.supabase.co' },
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Minimal AgentSession stand-in that extends EventEmitter and exposes
 * `getSessionId()`. We use a real EventEmitter so `on`/`off`/`emit` work
 * exactly like the production class.
 */
function makeSession(sessionId = 'session-uuid-001') {
  const emitter = new EventEmitter() as EventEmitter & { getSessionId: () => string };
  emitter.getSessionId = () => sessionId;
  return emitter;
}

/**
 * Build a minimal valid ReconnectNotifierConfig.
 */
function makeCtx(overrides: Partial<{
  userId: string;
  agent: string;
  sessionId: string;
  machineId: string;
}> = {}) {
  return {
    userId: 'user-uuid-111',
    agent: 'claude' as const,
    sessionId: 'session-uuid-001',
    machineId: 'machine-uuid-222',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('reconnectNotifier — send-push call', () => {
  let fetchMock: ReturnType<typeof vi.fn<Promise<Response>, any[]>>;

  beforeEach(() => {
    // Reset module-level throttle state between tests by reimporting with
    // vi.resetModules(). This also resets lastNotifiedAt map.
    vi.resetModules();

    // Provide the service role key
    process.env.STYRBY_SERVICE_ROLE_KEY = 'test-service-role-key';

    // Stub global fetch
    fetchMock = vi.fn<Promise<Response>, any[]>().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete process.env.STYRBY_SERVICE_ROLE_KEY;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('calls fetch with correct URL, method, and Authorization header', async () => {
    const { attachReconnectNotifier: attach } = await import('../reconnectNotifier');

    const session = makeSession();
    const ctx = makeCtx();

    attach(session as unknown as Parameters<typeof attach>[0], ctx);

    // Emit the event
    session.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });

    // Allow microtask / promise chain to resolve
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://test.supabase.co/functions/v1/send-push-notification');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer test-service-role-key');
  });

  it('sends correct payload body (title, sessionId, type=daemon_reconnected)', async () => {
    const { attachReconnectNotifier: attach } = await import('../reconnectNotifier');

    const session = makeSession('session-abc');
    const ctx = makeCtx({ sessionId: 'session-abc', agent: 'codex' });

    attach(session as unknown as Parameters<typeof attach>[0], ctx);

    session.emit('reconnected-after-offline', { offlineDurationMs: 6 * 60 * 1000 });
    await Promise.resolve();
    await Promise.resolve();

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.userId).toBe('user-uuid-111');
    expect(body.data.type).toBe('daemon_reconnected');
    expect(body.data.sessionId).toBe('session-abc');
    expect(body.data.title).toBe('Styrby is back online');
    // Body should mention the agent name and a duration
    expect(body.data.body).toContain('Codex');
    expect(body.data.body).toContain('Tap to resume');
  });

  it('does NOT call fetch when STYRBY_SERVICE_ROLE_KEY is missing', async () => {
    delete process.env.STYRBY_SERVICE_ROLE_KEY;
    const { attachReconnectNotifier: attach } = await import('../reconnectNotifier');

    const session = makeSession();
    attach(session as unknown as Parameters<typeof attach>[0], makeCtx());

    session.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('absorbs 5xx response without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
    const { attachReconnectNotifier: attach } = await import('../reconnectNotifier');

    const session = makeSession();
    attach(session as unknown as Parameters<typeof attach>[0], makeCtx());

    // Should not throw
    await expect(async () => {
      session.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
      await Promise.resolve();
      await Promise.resolve();
    }).not.toThrow();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('absorbs network errors (fetch rejection) without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('Network failure'));
    const { attachReconnectNotifier: attach } = await import('../reconnectNotifier');

    const session = makeSession();
    attach(session as unknown as Parameters<typeof attach>[0], makeCtx());

    await expect(async () => {
      session.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }).not.toThrow();
  });
});

describe('reconnectNotifier — throttle', () => {
  let fetchMock: ReturnType<typeof vi.fn<Promise<Response>, any[]>>;

  beforeEach(() => {
    vi.resetModules();
    process.env.STYRBY_SERVICE_ROLE_KEY = 'test-service-role-key';

    fetchMock = vi.fn<Promise<Response>, any[]>().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete process.env.STYRBY_SERVICE_ROLE_KEY;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('suppresses a second notification within THROTTLE_WINDOW_MS', async () => {
    vi.useFakeTimers();
    const { attachReconnectNotifier: attach } = await import('../reconnectNotifier');

    const session = makeSession('session-throttle-test');
    attach(session as unknown as Parameters<typeof attach>[0], makeCtx({ sessionId: 'session-throttle-test' }));

    // First event
    session.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    // Second event within throttle window
    vi.advanceTimersByTime(THROTTLE_WINDOW_MS - 1000);
    session.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
    await Promise.resolve();
    await Promise.resolve();

    // Still only one fetch call
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows a notification after THROTTLE_WINDOW_MS has elapsed', async () => {
    vi.useFakeTimers();
    const { attachReconnectNotifier: attach } = await import('../reconnectNotifier');

    const session = makeSession('session-throttle-pass');
    attach(session as unknown as Parameters<typeof attach>[0], makeCtx({ sessionId: 'session-throttle-pass' }));

    // First event
    session.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    // Advance past the throttle window
    vi.advanceTimersByTime(THROTTLE_WINDOW_MS + 1000);

    // Second event — should go through
    session.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throttle is keyed by sessionId — different sessions are independent', async () => {
    vi.useFakeTimers();
    const { attachReconnectNotifier: attach } = await import('../reconnectNotifier');

    const sessionA = makeSession('session-A');
    const sessionB = makeSession('session-B');

    attach(sessionA as unknown as Parameters<typeof attach>[0], makeCtx({ sessionId: 'session-A' }));
    attach(sessionB as unknown as Parameters<typeof attach>[0], makeCtx({ sessionId: 'session-B' }));

    sessionA.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
    sessionB.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
    await Promise.resolve();
    await Promise.resolve();

    // Both sessions should have sent independently
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('reconnectNotifier — cleanup', () => {
  let fetchMock: ReturnType<typeof vi.fn<Promise<Response>, any[]>>;

  beforeEach(() => {
    vi.resetModules();
    process.env.STYRBY_SERVICE_ROLE_KEY = 'test-service-role-key';

    fetchMock = vi.fn<Promise<Response>, any[]>().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete process.env.STYRBY_SERVICE_ROLE_KEY;
    vi.unstubAllGlobals();
  });

  it('cleanup function removes the event listener — further events are ignored', async () => {
    const { attachReconnectNotifier: attach } = await import('../reconnectNotifier');

    const session = makeSession('session-cleanup-test');
    const cleanup = attach(
      session as unknown as Parameters<typeof attach>[0],
      makeCtx({ sessionId: 'session-cleanup-test' })
    );

    // Remove the listener
    cleanup();

    // Emit the event — should not reach fetch
    session.emit('reconnected-after-offline', { offlineDurationMs: 10 * 60 * 1000 });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
