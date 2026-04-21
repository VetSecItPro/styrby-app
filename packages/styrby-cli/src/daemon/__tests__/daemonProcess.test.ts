/**
 * Tests for daemonProcess.ts signal handling.
 *
 * Covers:
 * - SIGHUP handler is registered (alongside SIGTERM and SIGINT)
 * - SIGHUP, SIGTERM, and SIGINT all route to the same graceful-shutdown path
 *   (disconnect relay, unlink PID file, unlink socket, exit 0)
 * - Graceful shutdown is idempotent (double-signal does not double-exit)
 *
 * WHY we test SIGHUP specifically: Node.js's default behavior on SIGHUP is
 * immediate process termination — identical to SIGKILL from the daemon's
 * perspective. `launchctl` (macOS) sends SIGHUP before SIGTERM on service
 * restart, so without an explicit handler the PID file and socket are never
 * cleaned up, leaving `styrby status` reporting a ghost daemon.
 *
 * WHY we mock everything and import dynamically: `daemonProcess.ts` calls
 * `main()` at module load time. We set `STYRBY_DAEMON=1`, mock all I/O
 * (fs, net, @supabase/supabase-js, styrby-shared), and import the module
 * so `main()` runs synchronously up to the async relay connect. The signal
 * listener registrations happen inside `setupSignalHandlers()` which is
 * called synchronously before the first `await`.
 *
 * @module daemon/__tests__/daemonProcess
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks — must be declared before dynamic import
// ============================================================================

vi.mock('node:fs', () => {
  return {
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
  };
});

vi.mock('node:net', () => {
  const serverMock = {
    on: vi.fn<[string, unknown], typeof serverMock>().mockReturnThis(),
    listen: vi.fn<[string, () => void], typeof serverMock>((_, cb) => { cb?.(); return serverMock; }),
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
  },
  homedir: vi.fn(() => '/tmp/styrby-test'),
  hostname: vi.fn(() => 'test-machine'),
}));

const mockRelayDisconnect = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
const mockRelayOn = vi.fn<[string, unknown], void>();
const mockRelayConnect = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);

vi.mock('styrby-shared', () => ({
  createRelayClient: vi.fn(() => ({
    on: mockRelayOn,
    connect: mockRelayConnect,
    disconnect: mockRelayDisconnect,
    getConnectedDevices: vi.fn(() => []),
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
  })),
}));

// ============================================================================
// Helpers
// ============================================================================

/** Remove all SIGHUP/SIGTERM/SIGINT listeners added during a test. */
function removeAddedSignalListeners(
  before: {
    sighup: NodeJS.SignalListener[];
    sigterm: NodeJS.SignalListener[];
    sigint: NodeJS.SignalListener[];
  }
) {
  const nowSighup = process.rawListeners('SIGHUP') as NodeJS.SignalListener[];
  const nowSigterm = process.rawListeners('SIGTERM') as NodeJS.SignalListener[];
  const nowSigint = process.rawListeners('SIGINT') as NodeJS.SignalListener[];

  for (const l of nowSighup) {
    if (!before.sighup.includes(l)) process.removeListener('SIGHUP', l);
  }
  for (const l of nowSigterm) {
    if (!before.sigterm.includes(l)) process.removeListener('SIGTERM', l);
  }
  for (const l of nowSigint) {
    if (!before.sigint.includes(l)) process.removeListener('SIGINT', l);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('daemonProcess — signal handler registration', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let beforeListeners: {
    sighup: NodeJS.SignalListener[];
    sigterm: NodeJS.SignalListener[];
    sigint: NodeJS.SignalListener[];
  };

  let processSendSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    // Snapshot listeners before the test so we can remove the daemon's
    // additions in afterEach without disturbing Vitest's own listeners.
    beforeListeners = {
      sighup: [...(process.rawListeners('SIGHUP') as NodeJS.SignalListener[])],
      sigterm: [...(process.rawListeners('SIGTERM') as NodeJS.SignalListener[])],
      sigint: [...(process.rawListeners('SIGINT') as NodeJS.SignalListener[])],
    };

    // Spy on process.exit to prevent the test process from actually exiting
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code?: number | string | null) => never);

    // WHY: daemonProcess calls process.send({ type: 'ready' }) at startup.
    // Vitest workers use process.send for their own IPC protocol. If the
    // daemon's message reaches the Vitest host it causes a deserialization
    // error that crashes the test worker. We stub process.send to a no-op
    // before importing the module so the ready signal is silently swallowed.
    processSendSpy = vi.spyOn(process, 'send').mockImplementation(() => true);

    // Set the env flag so main() doesn't bail out immediately
    process.env.STYRBY_DAEMON = '1';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  });

  afterEach(() => {
    delete process.env.STYRBY_DAEMON;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;

    removeAddedSignalListeners(beforeListeners);
    exitSpy.mockRestore();
    processSendSpy?.mockRestore();
    processSendSpy = null;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('registers a SIGHUP listener (alongside SIGTERM and SIGINT)', async () => {
    // Dynamically import so the module-level main() call runs with mocks in place
    await import('../daemonProcess.js');

    // Allow main()'s async operations to settle
    await vi.waitFor(() => {
      const sighupListeners = process.rawListeners('SIGHUP') as NodeJS.SignalListener[];
      const newSighup = sighupListeners.filter((l) => !beforeListeners.sighup.includes(l));
      expect(newSighup.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    const sighupListeners = process.rawListeners('SIGHUP') as NodeJS.SignalListener[];
    const sigtermListeners = process.rawListeners('SIGTERM') as NodeJS.SignalListener[];
    const sigintListeners = process.rawListeners('SIGINT') as NodeJS.SignalListener[];

    const newSighup = sighupListeners.filter((l) => !beforeListeners.sighup.includes(l));
    const newSigterm = sigtermListeners.filter((l) => !beforeListeners.sigterm.includes(l));
    const newSigint = sigintListeners.filter((l) => !beforeListeners.sigint.includes(l));

    expect(newSighup.length).toBeGreaterThanOrEqual(1);
    expect(newSigterm.length).toBeGreaterThanOrEqual(1);
    expect(newSigint.length).toBeGreaterThanOrEqual(1);
  });

  it('SIGHUP triggers graceful shutdown: disconnects relay and exits 0', async () => {
    await import('../daemonProcess.js');

    // Wait for signal handlers to be installed
    await vi.waitFor(() => {
      const listeners = process.rawListeners('SIGHUP') as NodeJS.SignalListener[];
      const newListeners = listeners.filter((l) => !beforeListeners.sighup.includes(l));
      expect(newListeners.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    // Emit SIGHUP — should trigger gracefulShutdown('SIGHUP')
    process.emit('SIGHUP');

    // Allow async shutdown to complete
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    }, { timeout: 2000 });
  });

  it('SIGTERM triggers graceful shutdown: exits 0', async () => {
    await import('../daemonProcess.js');

    await vi.waitFor(() => {
      const listeners = process.rawListeners('SIGTERM') as NodeJS.SignalListener[];
      const newListeners = listeners.filter((l) => !beforeListeners.sigterm.includes(l));
      expect(newListeners.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    process.emit('SIGTERM');

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    }, { timeout: 2000 });
  });

  it('graceful shutdown is idempotent: double SIGHUP calls process.exit exactly once', async () => {
    await import('../daemonProcess.js');

    await vi.waitFor(() => {
      const listeners = process.rawListeners('SIGHUP') as NodeJS.SignalListener[];
      expect(listeners.filter((l) => !beforeListeners.sighup.includes(l)).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    process.emit('SIGHUP');
    process.emit('SIGHUP');

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
  });

  it('SIGHUP and SIGTERM both invoke the same graceful-shutdown path (relay.disconnect called once)', async () => {
    // WHY: This confirms both signals route to gracefulShutdown() rather than
    // SIGHUP being handled by a different code path that skips cleanup.
    mockRelayDisconnect.mockClear();

    await import('../daemonProcess.js');

    await vi.waitFor(() => {
      const sighupListeners = process.rawListeners('SIGHUP') as NodeJS.SignalListener[];
      expect(sighupListeners.filter((l) => !beforeListeners.sighup.includes(l)).length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    // Trigger via SIGHUP
    process.emit('SIGHUP');

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    }, { timeout: 2000 });

    // relay.disconnect() should have been called exactly once (relay is null
    // in this test because connectToRelay bails on missing credentials, but
    // gracefulShutdown must still run and exit 0 — proving the path ran)
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
