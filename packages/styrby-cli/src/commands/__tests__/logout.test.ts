/**
 * Tests for the logout command.
 *
 * Covers the 4 required edge cases per Phase 1 spec:
 *  1. Happy path: daemon alive, terminate ACK → clearTokens, confirmation, exit 0
 *  2. No daemon running: terminateDaemon ECONNREFUSED-equivalent (ok: false) → skip,
 *     clearTokens, exit 0
 *  3. Daemon terminate timeout (ok: false from live socket) → SIGTERM fallback via
 *     stopDaemon(), then clearTokens, exit 0
 *  4. Already logged out: tokenManager.isAuthenticated() === false → "Not logged in.",
 *     no daemon RPC, no clearTokens, exit 0
 *
 * WHY: Logout is a security-critical path (SOC 2 CC6.1 — auth context lifecycle).
 * Every branch must leave the system in a clean state with no orphaned tokens or
 * daemon processes. These tests verify correctness at each decision fork.
 *
 * OWASP A07:2021 (Identification & Authentication Failures): Incomplete logout
 * (tokens not cleared, daemon still holds session) is a first-class vulnerability.
 *
 * @module commands/__tests__/logout.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks — must be declared before any imports that use them
// ============================================================================

vi.mock('@/daemon/controlClient', () => ({
  terminateDaemon: vi.fn(),
}));

vi.mock('@/daemon/run', () => ({
  stopDaemon: vi.fn(),
}));

vi.mock('@/auth/token-manager', () => ({
  getTokenManager: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('chalk', () => ({
  default: {
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    gray: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
  },
}));

// ============================================================================
// Imports — after mocks
// ============================================================================

import { terminateDaemon } from '@/daemon/controlClient';
import { stopDaemon } from '@/daemon/run';
import { getTokenManager } from '@/auth/token-manager';
import { handleLogout } from '../logout';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a mock TokenManager with a configurable isAuthenticated state.
 *
 * @param authenticated - Whether the mock should report an active session
 * @returns Minimal mock conforming to the TokenManager interface surface used
 *          by handleLogout
 */
function mockTokenManager(authenticated: boolean) {
  return {
    isAuthenticated: vi.fn().mockReturnValue(authenticated),
    clearTokens: vi.fn(),
  };
}

// ============================================================================
// Tests — Edge Case 1: Happy path (daemon alive, terminates cleanly)
// ============================================================================

describe('handleLogout — happy path (daemon alive, ACK received)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tm: ReturnType<typeof mockTokenManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // WHY: process.exit must be intercepted so tests don't actually terminate
    // the Vitest process. Throwing lets us assert it was called.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    tm = mockTokenManager(true);
    vi.mocked(getTokenManager).mockReturnValue(tm as never);
    // Daemon terminates cleanly
    vi.mocked(terminateDaemon).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('sends daemon.terminate with 5 second timeout', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(terminateDaemon).toHaveBeenCalledWith(5_000);
  });

  it('calls clearTokens after daemon terminates', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(tm.clearTokens).toHaveBeenCalledOnce();
  });

  it('does NOT fall back to stopDaemon when terminate succeeds', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('prints confirmation message', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/logged out/i);
    expect(output).toMatch(/daemon stopped/i);
  });

  it('exits with code 0', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ============================================================================
// Tests — Edge Case 2: No daemon running (ECONNREFUSED / ok: false immediately)
// ============================================================================

describe('handleLogout — no daemon running (terminateDaemon ok: false)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tm: ReturnType<typeof mockTokenManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    tm = mockTokenManager(true);
    vi.mocked(getTokenManager).mockReturnValue(tm as never);
    // Daemon not reachable — returns ok: false without a live socket
    vi.mocked(terminateDaemon).mockResolvedValue({ ok: false });
    // stopDaemon: also called as fallback — returns quickly (no pid file)
    vi.mocked(stopDaemon).mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('still clears tokens even when daemon was not running', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(tm.clearTokens).toHaveBeenCalledOnce();
  });

  it('attempts SIGTERM fallback via stopDaemon', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    // WHY: When terminateDaemon returns ok:false, we can't distinguish
    // "not running" from "timed out" — either way we call stopDaemon as
    // a belt-and-suspenders fallback before clearing tokens.
    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it('exits with code 0', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ============================================================================
// Tests — Edge Case 3: Daemon terminate timeout (ok: false from slow daemon)
// ============================================================================

describe('handleLogout — daemon terminate timeout (ok: false, SIGTERM fallback)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tm: ReturnType<typeof mockTokenManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    tm = mockTokenManager(true);
    vi.mocked(getTokenManager).mockReturnValue(tm as never);
    // Daemon exists but terminateDaemon timed out → ok: false
    vi.mocked(terminateDaemon).mockResolvedValue({ ok: false });
    vi.mocked(stopDaemon).mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('calls stopDaemon as SIGTERM fallback', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it('clears tokens after SIGTERM fallback', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(tm.clearTokens).toHaveBeenCalledOnce();
  });

  it('prints confirmation message', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/logged out/i);
  });

  it('exits with code 0', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ============================================================================
// Tests — Edge Case 4: Already logged out (isAuthenticated === false)
// ============================================================================

describe('handleLogout — already logged out', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tm: ReturnType<typeof mockTokenManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    // Not authenticated — already logged out
    tm = mockTokenManager(false);
    vi.mocked(getTokenManager).mockReturnValue(tm as never);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints "Not logged in." message', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toMatch(/not logged in/i);
  });

  it('does not call terminateDaemon', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(terminateDaemon).not.toHaveBeenCalled();
  });

  it('does not call clearTokens', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(tm.clearTokens).not.toHaveBeenCalled();
  });

  it('exits with code 0', async () => {
    await expect(handleLogout([])).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
