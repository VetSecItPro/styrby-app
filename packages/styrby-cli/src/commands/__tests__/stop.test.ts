/**
 * Tests for the stop command.
 *
 * Covers:
 * - handleStop when daemon is not running (no-op, prints yellow message)
 * - handleStop when daemon is running and stopDaemon succeeds
 * - handleStop when stopDaemon rejects (error path + process.exit(1))
 *
 * WHY: The stop command is a safe-stop gate; skipping the "not running"
 * branch or swallowing the stopDaemon error would leave the daemon alive
 * or show silent failures to users.
 *
 * @module commands/__tests__/stop.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/daemon/run', () => ({
  getDaemonStatus: vi.fn(),
  stopDaemon: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('chalk', () => ({
  default: {
    yellow: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    gray: (s: string) => s,
  },
}));

import { getDaemonStatus, stopDaemon } from '@/daemon/run';
import { handleStop } from '../stop';

// ============================================================================
// Helpers
// ============================================================================

function mockStatus(running: boolean, pid?: number) {
  vi.mocked(getDaemonStatus).mockReturnValue({ running, pid });
}

// ============================================================================
// Tests
// ============================================================================

describe('handleStop — daemon not running', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockStatus(false);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints "No daemon running" message', async () => {
    await handleStop([]);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /no daemon running/i.test(m))).toBe(true);
  });

  it('does not call stopDaemon', async () => {
    await handleStop([]);
    expect(stopDaemon).not.toHaveBeenCalled();
  });
});

describe('handleStop — daemon running, stop succeeds', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockStatus(true, 12345);
    vi.mocked(stopDaemon).mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('calls stopDaemon', async () => {
    await handleStop([]);
    expect(stopDaemon).toHaveBeenCalledOnce();
  });

  it('prints "Daemon stopped" on success', async () => {
    await handleStop([]);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /daemon stopped/i.test(m))).toBe(true);
  });

  it('includes the PID in the stopping message', async () => {
    await handleStop([]);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('12345'))).toBe(true);
  });
});

describe('handleStop — daemon running, stopDaemon rejects', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });
    mockStatus(true, 9999);
    vi.mocked(stopDaemon).mockRejectedValue(new Error('kill EPERM'));
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints failure message containing the error text', async () => {
    await expect(handleStop([])).rejects.toThrow('process.exit called');

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /failed to stop daemon/i.test(m))).toBe(true);
  });

  it('calls process.exit(1) on error', async () => {
    await expect(handleStop([])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('handleStop — daemon running, stopDaemon throws non-Error', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });
    mockStatus(true, 1);
    // WHY: Testing the non-Error branch in the catch clause (error instanceof Error check)
    vi.mocked(stopDaemon).mockRejectedValue('string error');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints "Unknown error" for non-Error rejection', async () => {
    await expect(handleStop([])).rejects.toThrow('process.exit called');

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /unknown error/i.test(m))).toBe(true);
  });
});
