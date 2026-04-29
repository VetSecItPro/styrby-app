/**
 * Tests for TokenManager.clearTokens() — logout correctness
 *
 * WHY (SOC 2 CC6.1 — auth context lifecycle hygiene): Logout must atomically
 * destroy all auth context: in-process state, persisted tokens (including
 * `authenticatedAt`), config entries, and the refresh timer. Subscribers
 * (daemon, future hooks) must be notified via the 'logout' event so they can
 * tear down their own session state. A stale `authenticatedAt` surviving
 * logout could inflate MFA-grace-period windows or mislead "last login"
 * display in the mobile UI.
 *
 * @module auth/__tests__/token-manager.logout
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks — must be declared before imports
// ============================================================================

/**
 * WHY: vi.mock() factories are hoisted to the top of the file by vitest.
 * Variables initialized in the module body are not yet available at hoist
 * time, causing "Cannot access before initialization" errors. vi.hoisted()
 * runs its callback at hoist time, making the mock fns available to factories.
 */
const { mockSavePersistedData, mockLoadPersistedData, mockSetConfigValue } = vi.hoisted(() => ({
  mockSavePersistedData: vi.fn(),
  mockLoadPersistedData: vi.fn(() => ({})),
  mockSetConfigValue: vi.fn(),
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
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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

import { TokenManager } from '../token-manager';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Reset the singleton so each test gets a clean TokenManager instance.
 *
 * WHY: TokenManager uses a static singleton. Without resetting between tests,
 * state (refreshTimer, event listeners, userId) bleeds across test cases,
 * causing false positives or false negatives.
 */
function resetSingleton(): TokenManager {
  // Access the private static field via bracket notation
  (TokenManager as unknown as Record<string, unknown>)['instance'] = undefined;
  return TokenManager.getInstance();
}

/**
 * Arm a manager with a realistic authenticated state.
 */
function armWithSession(
  manager: TokenManager,
  userId = 'user-abc-123'
): void {
  manager.setTokens({
    accessToken: 'at-test',
    refreshToken: 'rt-test',
    expiresIn: 3600,
    userId,
    userEmail: 'test@example.com',
  });
  // Reset call counters so logout assertions are clean
  mockSavePersistedData.mockClear();
  mockSetConfigValue.mockClear();
}

// ============================================================================
// Tests
// ============================================================================

describe('TokenManager.clearTokens()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPersistedData.mockReturnValue({});
  });

  // --------------------------------------------------------------------------
  // 1. authenticatedAt is cleared from persistence
  // --------------------------------------------------------------------------
  it('clears authenticatedAt from persistence after clearTokens()', () => {
    const manager = resetSingleton();
    armWithSession(manager);

    manager.clearTokens();

    const savedPayload = mockSavePersistedData.mock.calls[0]?.[0];
    expect(savedPayload).toBeDefined();
    expect(savedPayload).toHaveProperty('authenticatedAt', undefined);
  });

  // --------------------------------------------------------------------------
  // 2. Regression guard — existing fields are still cleared
  // --------------------------------------------------------------------------
  it('clears accessToken and refreshToken from persistence (regression guard)', () => {
    const manager = resetSingleton();
    armWithSession(manager);

    manager.clearTokens();

    const savedPayload = mockSavePersistedData.mock.calls[0]?.[0];
    expect(savedPayload).toHaveProperty('accessToken', undefined);
    expect(savedPayload).toHaveProperty('refreshToken', undefined);
  });

  it('clears authToken and userId from config (regression guard)', () => {
    const manager = resetSingleton();
    armWithSession(manager);

    manager.clearTokens();

    const configCalls = mockSetConfigValue.mock.calls;
    const authTokenCall = configCalls.find(([key]) => key === 'authToken');
    const userIdCall = configCalls.find(([key]) => key === 'userId');

    expect(authTokenCall).toBeDefined();
    expect(authTokenCall![1]).toBeUndefined();
    expect(userIdCall).toBeDefined();
    expect(userIdCall![1]).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // 3. 'logout' event is emitted with previous userId
  // --------------------------------------------------------------------------
  it("emits 'logout' event with { userId: previousUserId }", () => {
    const manager = resetSingleton();
    armWithSession(manager, 'user-xyz-789');

    const listener = vi.fn();
    manager.on('logout', listener);

    manager.clearTokens();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ userId: 'user-xyz-789' });
  });

  // --------------------------------------------------------------------------
  // 4. 'logout' event payload is { userId: null } when already logged out
  // --------------------------------------------------------------------------
  it("emits 'logout' event with { userId: null } when already logged out", () => {
    const manager = resetSingleton();
    // Do NOT call armWithSession — manager is unauthenticated

    const listener = vi.fn();
    manager.on('logout', listener);

    manager.clearTokens();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ userId: null });
  });

  // --------------------------------------------------------------------------
  // 5. Refresh timer is cancelled (regression guard)
  // --------------------------------------------------------------------------
  it('cancels the refresh timer after clearTokens()', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const manager = resetSingleton();

    // Arm with future-expiring session so scheduleRefresh sets a timer
    manager.setTokens({
      accessToken: 'at-test',
      refreshToken: 'rt-test',
      expiresIn: 3600,
      userId: 'user-timer-test',
    });
    mockSavePersistedData.mockClear();

    manager.clearTokens();

    // clearTimeout must have been called at least once for the refresh timer
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // 6. Event fires AFTER state is cleared — subscriber sees isAuthenticated: false
  // --------------------------------------------------------------------------
  it("fires 'logout' event after state is cleared (subscriber sees isAuthenticated: false)", () => {
    const manager = resetSingleton();
    armWithSession(manager);

    let stateAtEventTime: boolean | undefined;

    manager.on('logout', () => {
      stateAtEventTime = manager.getState().isAuthenticated;
    });

    manager.clearTokens();

    expect(stateAtEventTime).toBe(false);
  });
});
