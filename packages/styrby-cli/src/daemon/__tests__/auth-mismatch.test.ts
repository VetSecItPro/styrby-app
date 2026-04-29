/**
 * Tests for daemon auth-context mismatch detection.
 *
 * Covers the full matrix from Phase 1 spec deliverable #3:
 *
 *   | daemon bound | caller now | active sessions | action                  |
 *   |--------------|------------|-----------------|-------------------------|
 *   | user A       | user A     | any             | proceed normally        |
 *   | user A       | user B     | 0               | rebind: terminate + err |
 *   | user A       | user B     | >0              | refuse AUTH_MISMATCH_ACTIVE_SESSIONS |
 *   | user A       | none       | any             | refuse AUTH_MISSING     |
 *
 * Also covers:
 *   - `daemon.terminate` and `ping` bypass the check entirely
 *   - Error response shapes match spec exactly (code + message fields)
 *
 * OWASP A07:2021 — Identification and Authentication Failures:
 *   Verifying that the daemon refuses to execute commands on behalf of a
 *   caller whose identity differs from the account the daemon was bound to
 *   prevents privilege-confusion attacks where a newly-logged-in user could
 *   silently piggyback on another user's active daemon (and their sessions).
 *
 * SOC 2 CC6.1 — Logical and Physical Access Controls:
 *   The daemon is a long-lived background process with privileged access to
 *   Supabase Realtime channels. Validating caller identity on every mutable
 *   command ensures the daemon's access scope cannot be widened by an
 *   account switch without an explicit re-bind cycle.
 *
 * @module daemon/__tests__/auth-mismatch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Hoist: stub process.exit + set STYRBY_DAEMON before any module evaluates
//
// WHY vi.hoisted: daemonProcess.ts calls main() at module evaluation time.
// main() exits with code 1 if STYRBY_DAEMON is not set. vi.hoisted() runs
// before ALL vi.mock() factories and before the module is imported, so we can
// safely stub process.exit and set the env flag here to prevent the test worker
// from being killed before a single test runs.
// ============================================================================

const { exitStub } = vi.hoisted(() => {
  // Set the daemon env flag before any module loads. This is the earliest safe
  // place to do it — hoisted code runs before static imports are resolved.
  process.env.STYRBY_DAEMON = '1';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';

  // Replace process.send so the daemon's "ready" signal does not reach the
  // Vitest host worker IPC channel and cause a deserialization error.
  (process as NodeJS.Process).send = () => true;

  // Stub process.exit before module evaluation so main()'s process.exit(1)
  // does not terminate the test worker.
  const exitStub = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code?: number | string | null) => never);
  return { exitStub };
});

// ============================================================================
// Mocks — must appear before module imports
// ============================================================================

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
    chmodSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(() => '{}'),
  chmodSync: vi.fn(),
}));

vi.mock('node:net', () => {
  const serverMock = {
    on: vi.fn().mockReturnThis(),
    listen: vi.fn((_path: string, cb: () => void) => { cb?.(); return serverMock; }),
    close: vi.fn(),
  };
  return {
    default: { createServer: vi.fn(() => serverMock) },
    createServer: vi.fn(() => serverMock),
  };
});

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/tmp/styrby-test'),
    hostname: vi.fn(() => 'test-machine'),
    networkInterfaces: vi.fn(() => ({})),
  },
  homedir: vi.fn(() => '/tmp/styrby-test'),
  hostname: vi.fn(() => 'test-machine'),
  networkInterfaces: vi.fn(() => ({})),
}));

vi.mock('../wakeDetector.js', () => ({
  WakeDetector: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('styrby-shared', () => ({
  createRelayClient: vi.fn(() => ({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getConnectedDevices: vi.fn(() => []),
    scheduleReconnect: vi.fn(),
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  })),
}));

vi.mock('../run.js', () => ({
  DAEMON_PATHS: {
    pidFile: '/tmp/styrby-test/daemon.pid',
    statusFile: '/tmp/styrby-test/daemon.status.json',
    logFile: '/tmp/styrby-test/daemon.log',
    socketPath: '/tmp/styrby-test/daemon.sock',
  },
  getDaemonStatus: vi.fn(() => ({ running: false })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { assertAuthContext, type AuthCheckEnvelope, type AuthCheckResult } from '../daemonProcess.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a minimal mock daemon state for assertAuthContext tests.
 */
function makeDaemonState(overrides: { boundUserId?: string | null; activeSessionCount?: number } = {}): {
  boundUserId: string | null;
  activeSessionCount: number;
} {
  return {
    boundUserId: overrides.boundUserId !== undefined ? overrides.boundUserId : 'user-A',
    activeSessionCount: overrides.activeSessionCount !== undefined ? overrides.activeSessionCount : 0,
  };
}

/**
 * Build an IPC envelope for a mutable command.
 */
function makeEnvelope(currentUserId: string | null | undefined, commandType = 'list-sessions'): AuthCheckEnvelope {
  return { type: commandType, currentUserId: currentUserId ?? undefined };
}

// ============================================================================
// Global afterEach — restore process.exit stub
// ============================================================================

afterEach(() => {
  vi.clearAllMocks();
  // Keep exitStub installed (don't restore) — daemonProcess.ts's main() may
  // still be in the microtask queue. Restoring here would re-enable real exit.
});

// ============================================================================
// Tests: assertAuthContext — the 4-row matrix
// ============================================================================

describe('assertAuthContext — auth-context mismatch detection', () => {
  it('returns { ok: true } when daemon boundUserId matches caller currentUserId (0 sessions)', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 0 });
    const envelope = makeEnvelope('user-A');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(true);
  });

  it('returns { ok: true } when daemon boundUserId matches caller currentUserId (N sessions)', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 5 });
    const envelope = makeEnvelope('user-A');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Row 2: mismatch + 0 active sessions → silently rebind
  // --------------------------------------------------------------------------

  it('returns AUTH_REBIND_REQUIRED when caller is different user and daemon has 0 active sessions', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 0 });
    const envelope = makeEnvelope('user-B');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AUTH_REBIND_REQUIRED');
    expect(typeof result.message).toBe('string');
    expect(result.message!.length).toBeGreaterThan(0);
    // mustTerminate flag tells the dispatcher to trigger daemon.terminate path
    expect(result.mustTerminate).toBe(true);
  });

  it('AUTH_REBIND_REQUIRED message is human-readable and actionable', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 0 });
    const envelope = makeEnvelope('user-B');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    // Must tell user what to do next
    expect(result.message).toContain('styrby login');
  });

  // --------------------------------------------------------------------------
  // Row 3: mismatch + >0 active sessions → refuse
  // --------------------------------------------------------------------------

  it('returns AUTH_MISMATCH_ACTIVE_SESSIONS when caller is different user and daemon has active sessions', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 3 });
    const envelope = makeEnvelope('user-B');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AUTH_MISMATCH_ACTIVE_SESSIONS');
    expect(result.mustTerminate).toBeFalsy();
  });

  it('AUTH_MISMATCH_ACTIVE_SESSIONS message includes session count', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 3 });
    const envelope = makeEnvelope('user-B');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.message).toContain('3');
  });

  it('AUTH_MISMATCH_ACTIVE_SESSIONS message includes styrby logout guidance', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 1 });
    const envelope = makeEnvelope('user-B');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.message).toMatch(/styrby logout/i);
  });

  // --------------------------------------------------------------------------
  // Row 4: caller is logged out (no currentUserId) → AUTH_MISSING
  // --------------------------------------------------------------------------

  it('returns AUTH_MISSING when caller has no currentUserId (logged out)', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 0 });
    const envelope = makeEnvelope(undefined);
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AUTH_MISSING');
    expect(result.mustTerminate).toBeFalsy();
  });

  it('AUTH_MISSING message includes styrby login guidance', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 2 });
    const envelope = makeEnvelope(undefined);
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.message).toContain('styrby login');
  });

  it('AUTH_MISSING fires even if there are active sessions', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 5 });
    const envelope = makeEnvelope(undefined);
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AUTH_MISSING');
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  it('treats empty string currentUserId the same as undefined (AUTH_MISSING)', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 0 });
    const envelope = makeEnvelope('' as unknown as undefined);
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('AUTH_MISSING');
  });

  it('returns { ok: true } when boundUserId is null (unbound daemon) and any user calls', () => {
    // WHY: An unbound daemon (e.g., credentials were never written) should
    // not block callers — the relay connect itself will fail. The auth check
    // only enforces identity once a boundUserId has been established.
    const state = makeDaemonState({ boundUserId: null, activeSessionCount: 0 });
    const envelope = makeEnvelope('user-A');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// Tests: exempt commands bypass auth check
// ============================================================================

describe('assertAuthContext — exempt commands bypass check', () => {
  it('daemon.terminate: always returns ok=true regardless of userId mismatch', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 5 });
    // Mismatched user, active sessions — would normally refuse. Exempt because
    // logout must always be able to stop the daemon.
    const envelope = makeEnvelope('user-B', 'daemon.terminate');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(true);
  });

  it('daemon.terminate: bypasses even when caller has no userId', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 3 });
    const envelope = makeEnvelope(undefined, 'daemon.terminate');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(true);
  });

  it('ping: always returns ok=true (health check)', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 0 });
    const envelope = makeEnvelope('user-B', 'ping');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(true);
  });

  it('status: always returns ok=true (read-only health check)', () => {
    const state = makeDaemonState({ boundUserId: 'user-A', activeSessionCount: 0 });
    const envelope = makeEnvelope(undefined, 'status');
    const result: AuthCheckResult = assertAuthContext(envelope, state);
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// Tests: IPC envelope carries currentUserId
// ============================================================================

describe('IPC envelope — currentUserId field', () => {
  it('AuthCheckEnvelope accepts currentUserId as optional string', () => {
    // Type-level test: if this compiles, the type is correct.
    const withUser: AuthCheckEnvelope = { type: 'list-sessions', currentUserId: 'user-A' };
    const withoutUser: AuthCheckEnvelope = { type: 'list-sessions' };
    expect(withUser.currentUserId).toBe('user-A');
    expect(withoutUser.currentUserId).toBeUndefined();
  });
});
