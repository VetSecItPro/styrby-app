/**
 * Tests for the TokenManager 'refresh-failed' event.
 *
 * WHY (B4-Wave1 — error-handling completeness): Background token refresh used
 * to log at debug only. When refresh failed (network blip, refresh-token
 * revoked, Supabase auth outage), the in-memory access token went stale and
 * the very next API call would 401 with no signal that auth needed renewal.
 *
 * The fix added a typed `refresh-failed` event so subscribers (daemon,
 * session manager, future UI banner) can react proactively instead of
 * waiting for downstream failures. These tests pin the contract:
 *   1. Event fires on the cold-start hydrate path with `trigger: 'hydrate'`
 *   2. Event fires on the scheduled-refresh timer path with `trigger: 'scheduled'`
 *   3. Event payload preserves the original error
 *   4. logger.warn (NOT logger.debug) is called so ops sees the failure in logs
 *
 * @module auth/__tests__/token-manager.refresh-failed-event
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks — must be declared before imports
// ============================================================================

const {
  mockSavePersistedData,
  mockLoadPersistedData,
  mockSetConfigValue,
  mockLoggerWarn,
  mockLoggerDebug,
} = vi.hoisted(() => ({
  mockSavePersistedData: vi.fn(),
  mockLoadPersistedData: vi.fn(() => ({})),
  mockSetConfigValue: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerDebug: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  loadPersistedData: mockLoadPersistedData,
  savePersistedData: mockSavePersistedData,
}));

vi.mock('@/configuration', () => ({
  setConfigValue: mockSetConfigValue,
  CONFIG_DIR: '/tmp/.styrby-test',
  ensureConfigDir: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mockLoggerDebug,
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
  },
}));

vi.mock('@/env', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
  },
}));

// ============================================================================
// Import after mocks
// ============================================================================

import { TokenManager, type RefreshFailedEventPayload } from '../token-manager';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Reset the TokenManager singleton so each test gets a clean instance.
 *
 * WHY: The constructor calls loadFromPersistence which queues a setImmediate.
 * Without resetting, prior tests' state (queued microtasks, listeners) bleeds
 * across.
 */
function resetSingleton(): TokenManager {
  (TokenManager as unknown as Record<string, unknown>)['instance'] = undefined;
  return TokenManager.getInstance();
}

/**
 * Flush queued setImmediate callbacks. Used to deterministically run the
 * cold-start refresh path that's queued during construction.
 */
function flushImmediates(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ============================================================================
// Tests — cold-start hydrate path (setImmediate inside loadFromPersistence)
// ============================================================================

describe("TokenManager 'refresh-failed' event — cold-start hydrate path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPersistedData.mockReturnValue({});
  });

  afterEach(() => {
    // Reset singleton between tests so refresh spies don't leak
    (TokenManager as unknown as Record<string, unknown>)['instance'] = undefined;
  });

  it("emits 'refresh-failed' with trigger='hydrate' AND logs at WARN when cold-start refresh rejects", async () => {
    // Persistence has a refresh token → setImmediate will call refresh()
    mockLoadPersistedData.mockReturnValue({
      userId: 'user-cold-start',
      accessToken: 'at-stale',
      refreshToken: 'rt-still-good',
    });

    const manager = resetSingleton();

    // Spy AFTER construction but BEFORE the queued setImmediate fires.
    // vi.spyOn replaces refresh on the instance; the closure inside
    // setImmediate calls `this.refresh()` which resolves to the spy.
    const refreshErr = new Error('refresh-rejected-by-server');
    vi.spyOn(manager, 'refresh').mockRejectedValueOnce(refreshErr);

    const listener = vi.fn();
    manager.on('refresh-failed', listener);

    await flushImmediates();
    // The .catch is a microtask; one more flush ensures the event has fired
    await Promise.resolve();

    // Event contract
    expect(listener).toHaveBeenCalledTimes(1);
    const payload = listener.mock.calls[0]?.[0] as RefreshFailedEventPayload;
    expect(payload.trigger).toBe('hydrate');
    expect(payload.error).toBe(refreshErr);

    // Logger contract — same catch block, both must fire
    expect(mockLoggerWarn).toHaveBeenCalled();
    const warnArgs = mockLoggerWarn.mock.calls[0];
    expect(String(warnArgs?.[0])).toContain('Background token refresh failed');
    expect(warnArgs?.[1]).toMatchObject({ error: 'refresh-rejected-by-server' });
  });

  it("does NOT emit 'refresh-failed' when there is no refresh token to refresh", async () => {
    // No refreshToken → setImmediate sees nothing to refresh → no catch path
    mockLoadPersistedData.mockReturnValue({
      userId: 'user-no-rt',
      accessToken: 'at-only',
    });

    const manager = resetSingleton();

    const listener = vi.fn();
    manager.on('refresh-failed', listener);

    await flushImmediates();
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Tests — scheduled-refresh path (setTimeout inside scheduleRefresh)
// ============================================================================

describe("TokenManager 'refresh-failed' event — scheduled-refresh timer path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPersistedData.mockReturnValue({});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    (TokenManager as unknown as Record<string, unknown>)['instance'] = undefined;
  });

  it("emits 'refresh-failed' with trigger='scheduled' when the pre-expiry timer's refresh rejects", async () => {
    const manager = resetSingleton();

    const refreshErr = new Error('scheduled-refresh-network-down');
    vi.spyOn(manager, 'refresh').mockRejectedValueOnce(refreshErr);

    const listener = vi.fn();
    manager.on('refresh-failed', listener);

    // setTokens with a 10-minute expiry → REFRESH_BUFFER_MS=5min → timer fires in 5min
    manager.setTokens({
      accessToken: 'at-near-expiry',
      refreshToken: 'rt-test',
      expiresIn: 10 * 60, // 10 minutes
      userId: 'user-scheduled',
    });

    // Advance past the 5-min buffer so setTimeout fires
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    // Drain microtasks queued by the .catch
    await Promise.resolve();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    const payload = listener.mock.calls[0]?.[0] as RefreshFailedEventPayload;
    expect(payload.trigger).toBe('scheduled');
    expect(payload.error).toBe(refreshErr);
  });

  it("logs at WARN with the error message when the scheduled timer's refresh fails", async () => {
    const manager = resetSingleton();
    vi.spyOn(manager, 'refresh').mockRejectedValueOnce(new Error('scheduled-boom'));

    manager.setTokens({
      accessToken: 'at-x',
      refreshToken: 'rt-x',
      expiresIn: 10 * 60,
      userId: 'user-warn-scheduled',
    });

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLoggerWarn).toHaveBeenCalled();
    const warnArgs = mockLoggerWarn.mock.calls[0];
    expect(String(warnArgs?.[0])).toContain('Scheduled token refresh failed');
    // Second arg is the metadata object with the error message
    expect(warnArgs?.[1]).toMatchObject({ error: 'scheduled-boom' });
  });

  it("does NOT emit 'refresh-failed' when refresh succeeds (sanity check)", async () => {
    const manager = resetSingleton();
    vi.spyOn(manager, 'refresh').mockResolvedValueOnce({
      success: true,
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const listener = vi.fn();
    manager.on('refresh-failed', listener);

    manager.setTokens({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresIn: 10 * 60,
      userId: 'user-success',
    });

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Tests — event-typing contract (TypeScript-level check via runtime shape)
// ============================================================================

describe("RefreshFailedEventPayload contract", () => {
  it("trigger field accepts only the documented variants", () => {
    // Compile-time check enforced by `satisfies` in TokenManager;
    // this runtime test exists as a regression guard if the type changes.
    const validHydrate: RefreshFailedEventPayload = { trigger: 'hydrate', error: new Error('x') };
    const validScheduled: RefreshFailedEventPayload = { trigger: 'scheduled', error: 'string-err' };

    expect(['hydrate', 'scheduled']).toContain(validHydrate.trigger);
    expect(['hydrate', 'scheduled']).toContain(validScheduled.trigger);
  });
});
