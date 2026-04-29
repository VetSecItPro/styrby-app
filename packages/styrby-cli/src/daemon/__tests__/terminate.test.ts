/**
 * Tests for daemon terminate RPC — daemon-side handler + client-side method.
 *
 * TDD: these tests are written BEFORE the implementation. They describe the
 * exact contract the `daemon.terminate` IPC command and `terminateDaemon()`
 * client method must satisfy.
 *
 * Covers (daemon-side handler):
 * - Closes the Realtime subscription cleanly (relay.disconnect() is called)
 * - Persists a final state snapshot before exiting
 * - Closes the IPC server
 * - Calls process.exit(0)
 *
 * Covers (client-side terminateDaemon):
 * - Returns { ok: true } when daemon exits within timeout
 * - Returns { ok: false } on IPC timeout (daemon did not respond)
 *
 * WHY process.exit is tested via mock:
 *   process.exit(0) would terminate the test runner. We spy on it with
 *   vi.spyOn(process, 'exit') and restore after each test.
 *
 * WHY isolated module + vi.mock:
 *   daemonProcess.ts runs main() at module evaluation time. We cannot import
 *   it directly in tests without triggering the daemon loop. Instead we test
 *   the exported handleTerminate function (the extracted handler), plus the
 *   gracefulShutdown flow through a thin integration test of the IPC handler
 *   dispatch. See the implementation plan: handleTerminate is extracted from
 *   the IPC switch statement into a testable function.
 *
 * @module daemon/__tests__/terminate
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';

// ============================================================================
// Mocks — must appear before module imports
// ============================================================================

vi.mock('node:net', () => {
  const serverMock = {
    on: vi.fn().mockReturnThis(),
    listen: vi.fn((_path: string, cb: () => void) => { cb?.(); return serverMock; }),
    close: vi.fn(),
  };
  const createConnection = vi.fn();
  const createServer = vi.fn(() => serverMock);
  return { default: { createConnection, createServer }, createConnection, createServer };
});

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

import { terminateDaemon } from '../controlClient.js';

// ============================================================================
// Setup for handleTerminate tests
// ============================================================================

// WHY: daemonProcess.ts calls main() at module load time and main() calls
// process.send({ type: 'ready' }). Vitest workers use process.send for their
// own IPC channel. If the daemon's message reaches the Vitest host it causes
// a deserialization error that crashes the test worker. Stubbing process.send
// before the dynamic import silently swallows the ready signal.
// _origProcessSend / _processSendStub are declared inside the describe block
// that uses them (handleTerminate tests) to limit scope.

// ============================================================================
// Helpers
// ============================================================================

/** Tracks the last socket created by net.createConnection mock. */
let _lastSocket: ReturnType<typeof buildSocketMock> | null = null;

/**
 * Build a mock Socket that immediately responds with the given JSON line
 * when `write` is called — simulates a fast daemon ACK.
 */
function buildSocketMock(responseJson: object) {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const socket = {
    write: vi.fn<[string], boolean>((msg: string) => {
      void msg;
      Promise.resolve().then(() => {
        const line = JSON.stringify(responseJson) + '\n';
        for (const h of handlers['data'] ?? []) h(Buffer.from(line));
        for (const h of handlers['close'] ?? []) h();
      });
      return true;
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = [...(handlers[event] ?? []), handler];
      return socket as unknown as net.Socket;
    }),
    setTimeout: vi.fn(() => socket as unknown as net.Socket),
    destroy: vi.fn(),
  };
  return socket;
}

/**
 * Build a socket mock that fires a timeout event after handlers are registered,
 * simulating a daemon that never responds (e.g., hung or crashed mid-shutdown).
 */
function buildTimeoutSocketMock() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const socket = {
    write: vi.fn<[string], boolean>(() => true),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = [...(handlers[event] ?? []), handler];
      return socket as unknown as net.Socket;
    }),
    // Trigger the timeout event immediately after setTimeout is called
    setTimeout: vi.fn(() => {
      Promise.resolve().then(() => {
        for (const h of handlers['timeout'] ?? []) h();
      });
      return socket as unknown as net.Socket;
    }),
    destroy: vi.fn(),
  };
  return socket;
}

/**
 * Build a socket mock that fires ECONNREFUSED — simulates daemon not running.
 */
function buildErrorSocketMock(code: string = 'ECONNREFUSED') {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const socket = {
    write: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = [...(handlers[event] ?? []), handler];
      return socket as unknown as net.Socket;
    }),
    setTimeout: vi.fn(() => {
      // WHY setTimeout(_, 0): defers the error to the next microtask so the
      // caller's await completes first, preventing a race between socket
      // creation and the error handler being registered via .on('error', ...).
      Promise.resolve().then(() => {
        const err = Object.assign(new Error(`connect ${code}`), { code });
        for (const h of handlers['error'] ?? []) h(err);
      });
      return socket as unknown as net.Socket;
    }),
    destroy: vi.fn(),
  };
  return socket;
}

// ============================================================================
// Tests
// ============================================================================

describe('terminateDaemon (controlClient)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _lastSocket = null;

    // Wire the createConnection mock to use _lastSocket
    vi.mocked(net.createConnection).mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        Promise.resolve().then(() => cb?.());
        return _lastSocket as unknown as net.Socket;
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Happy path: daemon terminates within timeout
  // --------------------------------------------------------------------------

  it('sends { type: "daemon.terminate" } over IPC', async () => {
    _lastSocket = buildSocketMock({ success: true, data: { terminating: true } });

    await terminateDaemon(5000);

    const written = JSON.parse(
      (_lastSocket.write as ReturnType<typeof vi.fn>).mock.calls[0][0].trimEnd()
    ) as { type: string };
    expect(written.type).toBe('daemon.terminate');
  });

  it('returns { ok: true } when daemon ACKs the terminate command', async () => {
    _lastSocket = buildSocketMock({ success: true, data: { terminating: true } });

    const result = await terminateDaemon(5000);

    expect(result).toEqual({ ok: true });
  });

  // --------------------------------------------------------------------------
  // Timeout path: daemon does not respond in time
  // --------------------------------------------------------------------------

  it('returns { ok: false } when daemon does not respond within timeoutMs', async () => {
    _lastSocket = buildTimeoutSocketMock();

    const result = await terminateDaemon(100);

    expect(result).toEqual({ ok: false });
  });

  // --------------------------------------------------------------------------
  // Socket error path: daemon not running
  // --------------------------------------------------------------------------

  it('returns { ok: false } when socket is unreachable (daemon not running)', async () => {
    _lastSocket = buildErrorSocketMock('ECONNREFUSED');

    const result = await terminateDaemon(5000);

    expect(result).toEqual({ ok: false });
  });

  it('returns { ok: false } when daemon returns success: false', async () => {
    _lastSocket = buildSocketMock({ success: false, error: 'already shutting down' });

    const result = await terminateDaemon(5000);

    // A non-successful response still means the daemon received the command but
    // was in a state where it could not ACK gracefully. We treat this as !ok.
    expect(result).toEqual({ ok: false });
  });
});

// ============================================================================
// Handler unit tests — test handleTerminate() in isolation
// ============================================================================

describe('handleTerminate (daemon IPC handler)', () => {
  // WHY module-scoped stubs are kept inside this describe block:
  // _origProcessSend and _processSendStub are only needed here; keeping them
  // at describe scope (not module scope) prevents accidental leakage into the
  // terminateDaemon describe block above.
  const _origProcessSend = process.send;
  const _processSendStub = vi.fn(() => true);

  /** Spy on process.exit to prevent test runner termination. */
  let exitSpy: ReturnType<typeof vi.spyOn>;
  /** Mock relay — captures disconnect() calls. */
  let mockRelay: { disconnect: ReturnType<typeof vi.fn> };
  /** Mock IPC server — captures close() calls. */
  let mockIpcServer: { close: ReturnType<typeof vi.fn> };
  /** Mock stateSnapshot — captures persist calls. */
  let mockStateSnapshot: { persistNow: ReturnType<typeof vi.fn>; clearOnExit: ReturnType<typeof vi.fn> };
  /** Mock socket connection passed into the handler. */
  let mockConn: { write: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null | undefined) => {
      // Prevent actual exit — just capture the call
      return undefined as never;
    });

    // Stub process.send to prevent daemon's "ready" signal from crashing the
    // Vitest worker's IPC channel. See WHY comment above.
    (process as NodeJS.Process).send = _processSendStub;

    // Set env flags so main() inside daemonProcess runs its startup path
    process.env.STYRBY_DAEMON = '1';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';

    mockRelay = { disconnect: vi.fn().mockResolvedValue(undefined) };
    mockIpcServer = { close: vi.fn() };
    mockStateSnapshot = {
      persistNow: vi.fn(),
      clearOnExit: vi.fn(),
    };
    mockConn = { write: vi.fn() };
  });

  afterEach(() => {
    exitSpy.mockRestore();
    (process as NodeJS.Process).send = _origProcessSend;
    delete process.env.STYRBY_DAEMON;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    vi.restoreAllMocks();
  });

  it('is exported as handleTerminate from daemonProcess module', async () => {
    // WHY: The handler must be exported so tests (and the auth-mismatch tests)
    // can invoke it directly without spinning up the full daemon loop.
    const mod = await import('../daemonProcess.js');
    expect(typeof (mod as Record<string, unknown>)['handleTerminate']).toBe('function');
  });

  it('calls relay.disconnect() to close Realtime subscription cleanly', async () => {
    const { handleTerminate } = await import('../daemonProcess.js') as {
      handleTerminate: (
        relay: typeof mockRelay | null,
        ipcServer: typeof mockIpcServer | null,
        snapshot: typeof mockStateSnapshot,
        conn: typeof mockConn
      ) => Promise<void>;
    };

    await handleTerminate(mockRelay, mockIpcServer, mockStateSnapshot, mockConn);

    expect(mockRelay.disconnect).toHaveBeenCalledOnce();
  });

  it('calls snapshot.persistNow() before exit (final state flush)', async () => {
    const { handleTerminate } = await import('../daemonProcess.js') as {
      handleTerminate: (
        relay: typeof mockRelay | null,
        ipcServer: typeof mockIpcServer | null,
        snapshot: typeof mockStateSnapshot,
        conn: typeof mockConn
      ) => Promise<void>;
    };

    await handleTerminate(mockRelay, mockIpcServer, mockStateSnapshot, mockConn);

    expect(mockStateSnapshot.persistNow).toHaveBeenCalledOnce();
  });

  it('calls ipcServer.close() before exit', async () => {
    const { handleTerminate } = await import('../daemonProcess.js') as {
      handleTerminate: (
        relay: typeof mockRelay | null,
        ipcServer: typeof mockIpcServer | null,
        snapshot: typeof mockStateSnapshot,
        conn: typeof mockConn
      ) => Promise<void>;
    };

    await handleTerminate(mockRelay, mockIpcServer, mockStateSnapshot, mockConn);

    expect(mockIpcServer.close).toHaveBeenCalledOnce();
  });

  it('calls process.exit(0) as the final action', async () => {
    const { handleTerminate } = await import('../daemonProcess.js') as {
      handleTerminate: (
        relay: typeof mockRelay | null,
        ipcServer: typeof mockIpcServer | null,
        snapshot: typeof mockStateSnapshot,
        conn: typeof mockConn
      ) => Promise<void>;
    };

    await handleTerminate(mockRelay, mockIpcServer, mockStateSnapshot, mockConn);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('writes ACK to socket before shutdown sequence begins', async () => {
    const { handleTerminate } = await import('../daemonProcess.js') as {
      handleTerminate: (
        relay: typeof mockRelay | null,
        ipcServer: typeof mockIpcServer | null,
        snapshot: typeof mockStateSnapshot,
        conn: typeof mockConn
      ) => Promise<void>;
    };

    await handleTerminate(mockRelay, mockIpcServer, mockStateSnapshot, mockConn);

    // The first write must be the ACK, before relay disconnects
    expect(mockConn.write).toHaveBeenCalledOnce();
    const ackJson = JSON.parse(
      (mockConn.write as ReturnType<typeof vi.fn>).mock.calls[0][0].trimEnd()
    ) as { success: boolean };
    expect(ackJson.success).toBe(true);

    // Verify strict invocation order: ACK → relay.disconnect → ipcServer.close → process.exit
    const connWriteMock = mockConn.write as ReturnType<typeof vi.fn>;
    const relayDisconnectMock = mockRelay.disconnect as ReturnType<typeof vi.fn>;
    const ipcServerCloseMock = mockIpcServer.close as ReturnType<typeof vi.fn>;

    expect(connWriteMock.mock.invocationCallOrder[0]).toBeLessThan(
      relayDisconnectMock.mock.invocationCallOrder[0]
    );
    expect(relayDisconnectMock.mock.invocationCallOrder[0]).toBeLessThan(
      ipcServerCloseMock.mock.invocationCallOrder[0]
    );
    expect(ipcServerCloseMock.mock.invocationCallOrder[0]).toBeLessThan(
      exitSpy.mock.invocationCallOrder[0]
    );
  });

  it('still ACKs and proceeds through full shutdown even if persistNow() throws', async () => {
    // WHY: persistNow() failure (e.g., disk full, FS permission error) must
    // never halt the shutdown sequence. The daemon must still disconnect
    // Realtime, close the IPC server, and exit — leaving orphaned state is
    // better than leaving an orphaned daemon process.
    mockStateSnapshot.persistNow.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const { handleTerminate } = await import('../daemonProcess.js') as {
      handleTerminate: (
        relay: typeof mockRelay | null,
        ipcServer: typeof mockIpcServer | null,
        snapshot: typeof mockStateSnapshot,
        conn: typeof mockConn
      ) => Promise<void>;
    };

    await handleTerminate(mockRelay, mockIpcServer, mockStateSnapshot, mockConn);

    // Caller must still receive the ACK despite the persistNow error
    expect(mockConn.write).toHaveBeenCalledOnce();
    const ackJson = JSON.parse(
      (mockConn.write as ReturnType<typeof vi.fn>).mock.calls[0][0].trimEnd()
    ) as { success: boolean };
    expect(ackJson.success).toBe(true);

    // Full shutdown sequence must still execute
    expect(mockRelay.disconnect).toHaveBeenCalledOnce();
    expect(mockIpcServer.close).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('works when relay is null (daemon never connected to Realtime)', async () => {
    const { handleTerminate } = await import('../daemonProcess.js') as {
      handleTerminate: (
        relay: null,
        ipcServer: typeof mockIpcServer | null,
        snapshot: typeof mockStateSnapshot,
        conn: typeof mockConn
      ) => Promise<void>;
    };

    // Should not throw — relay disconnect is skipped gracefully
    await expect(
      handleTerminate(null, mockIpcServer, mockStateSnapshot, mockConn)
    ).resolves.not.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closes IPC server even if relay.disconnect() rejects', async () => {
    mockRelay.disconnect.mockRejectedValue(new Error('relay already closed'));

    const { handleTerminate } = await import('../daemonProcess.js') as {
      handleTerminate: (
        relay: typeof mockRelay | null,
        ipcServer: typeof mockIpcServer | null,
        snapshot: typeof mockStateSnapshot,
        conn: typeof mockConn
      ) => Promise<void>;
    };

    await handleTerminate(mockRelay, mockIpcServer, mockStateSnapshot, mockConn);

    // IPC must close even after relay error
    expect(mockIpcServer.close).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
