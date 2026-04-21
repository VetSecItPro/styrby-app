/**
 * Tests for the logs command.
 *
 * Covers:
 * - parseLogsArgs: default values, --follow/-f, --lines/-n, invalid value
 * - handleLogs: no log file exists, empty log file, prints last N lines,
 *   cannot read file (access denied)
 *
 * WHY: parseLogsArgs is pure and easy to exercise exhaustively. handleLogs
 * branches on file existence / readability; wrong branch logic means users
 * see no output or the wrong instructions.
 *
 * @module commands/__tests__/logs.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { R_OK: 4 },
  createReadStream: vi.fn(),
  statSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

vi.mock('@/daemon/run', () => ({
  DAEMON_PATHS: {
    logFile: '/tmp/.styrby/daemon.log',
  },
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
    red: (s: string) => s,
    gray: (s: string) => s,
    green: (s: string) => s,
  },
}));

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { parseLogsArgs, handleLogs } from '../logs';

// ============================================================================
// parseLogsArgs
// ============================================================================

describe('parseLogsArgs', () => {
  it('returns defaults when no args provided', () => {
    const opts = parseLogsArgs([]);
    expect(opts.follow).toBe(false);
    expect(opts.lines).toBe(50);
  });

  it('sets follow=true on --follow', () => {
    expect(parseLogsArgs(['--follow']).follow).toBe(true);
  });

  it('sets follow=true on -f', () => {
    expect(parseLogsArgs(['-f']).follow).toBe(true);
  });

  it('parses --lines N', () => {
    expect(parseLogsArgs(['--lines', '100']).lines).toBe(100);
  });

  it('parses -n N', () => {
    expect(parseLogsArgs(['-n', '200']).lines).toBe(200);
  });

  it('ignores non-numeric value for --lines and keeps default', () => {
    // NaN is not finite, so the guard keeps the default
    expect(parseLogsArgs(['--lines', 'abc']).lines).toBe(50);
  });

  it('ignores zero for --lines and keeps default', () => {
    // parsed = 0, which is not > 0
    expect(parseLogsArgs(['-n', '0']).lines).toBe(50);
  });

  it('parses both -f and -n together', () => {
    const opts = parseLogsArgs(['-f', '-n', '75']);
    expect(opts.follow).toBe(true);
    expect(opts.lines).toBe(75);
  });
});

// ============================================================================
// handleLogs — log file does not exist
// ============================================================================

describe('handleLogs — log file not found', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints "No daemon logs found" message', async () => {
    await handleLogs([]);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /no daemon logs/i.test(m))).toBe(true);
  });
});

// ============================================================================
// handleLogs — log file exists but cannot be read
// ============================================================================

describe('handleLogs — access denied', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw new Error('EACCES');
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints cannot-read error and calls process.exit(1)', async () => {
    await expect(handleLogs([])).rejects.toThrow('process.exit called');

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /cannot read/i.test(m))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ============================================================================
// handleLogs — log file exists, has content, print mode
// ============================================================================

describe('handleLogs — prints last N lines', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.accessSync).mockReturnValue(undefined);

    // Simulate readline emitting lines then closing
    const mockRl = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'line') {
          setImmediate(() => {
            cb('[2026-04-21] log line 1');
            cb('[2026-04-21] log line 2');
          });
        }
        if (event === 'close') {
          setImmediate(() => {
            // Fire close after line events settle
            setTimeout(cb, 5);
          });
        }
        if (event === 'error') {
          // Register but don't call
        }
        return mockRl;
      }),
    };

    vi.mocked(readline.createInterface).mockReturnValue(mockRl as ReturnType<typeof readline.createInterface>);
    vi.mocked(fs.createReadStream).mockReturnValue({} as ReturnType<typeof fs.createReadStream>);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints the log lines to stdout', async () => {
    await handleLogs(['-n', '10']);

    const lines = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('log line 1'))).toBe(true);
    expect(lines.some((l) => l.includes('log line 2'))).toBe(true);
  });
});

// ============================================================================
// handleLogs — log file exists but is empty
// ============================================================================

describe('handleLogs — empty log file', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.accessSync).mockReturnValue(undefined);

    // Simulate readline emitting no lines then closing immediately
    const mockRl = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'close') {
          setImmediate(cb);
        }
        return mockRl;
      }),
    };

    vi.mocked(readline.createInterface).mockReturnValue(mockRl as ReturnType<typeof readline.createInterface>);
    vi.mocked(fs.createReadStream).mockReturnValue({} as ReturnType<typeof fs.createReadStream>);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints "Log file is empty" message', async () => {
    await handleLogs([]);

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => /log file is empty/i.test(m))).toBe(true);
  });
});
