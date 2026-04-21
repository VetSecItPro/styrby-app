/**
 * Tests for daemon/controlClient — IPC command helpers including attach-relay.
 *
 * Covers:
 * - sendDaemonCommand: routes message over the Unix socket and returns parsed response
 * - canConnectToDaemon: returns true on successful ping, false otherwise
 * - getDaemonStatusViaIpc: returns DaemonState on success, fallback on error
 * - requestDaemonStop: returns true when daemon ACKs stop
 * - listConnectedDevices: returns device array on success, empty array on error
 * - attachRelaySession: sends attach-relay command, returns true on success
 * - attachRelaySession: returns false when daemon returns failure
 * - attachRelaySession: returns false when socket is unreachable
 *
 * WHY we test attach-relay separately from the general sendDaemonCommand:
 *   attach-relay is the IPC primitive for `styrby resume`. Its failure modes
 *   (daemon unreachable, daemon returns error) map directly to user-visible
 *   error messages in handleResume, so each path deserves an explicit assertion.
 *
 * WHY we mock node:net at the vi.mock() level (not via spyOn):
 *   controlClient.ts imports `net` at module load time. A vi.spyOn on the
 *   already-imported module would be patching the wrong reference. Declaring
 *   the mock factory before any import ensures our fake createConnection is
 *   the one the module actually calls.
 *
 * @module daemon/__tests__/controlClient
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Socket } from 'node:net';

// ============================================================================
// net mock — must appear before module imports
// ============================================================================

/** Holds the socket instance created by the last createConnection call. */
let _lastSocket: ReturnType<typeof buildSocketMock> | null = null;

/**
 * Build a mock Socket that emits `data` with the given JSON response line
 * immediately after `write` is called (simulating a fast daemon response).
 */
function buildSocketMock(responseJson: object) {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const socket = {
    _responseJson: responseJson,
    write: vi.fn<[string], boolean>((msg: string) => {
      void msg;
      // Deliver the response asynchronously (next microtask)
      Promise.resolve().then(() => {
        const line = JSON.stringify(responseJson) + '\n';
        for (const h of handlers['data'] ?? []) h(Buffer.from(line));
        for (const h of handlers['close'] ?? []) h();
      });
      return true;
    }),
    on: vi.fn<[string, (...args: unknown[]) => void], Socket>((event, handler) => {
      handlers[event] = [...(handlers[event] ?? []), handler];
      return socket as unknown as Socket;
    }),
    setTimeout: vi.fn<[number], Socket>(() => socket as unknown as Socket),
    destroy: vi.fn(),
  };
  return socket;
}

/**
 * Build a socket mock that fires an ENOENT / ECONNREFUSED error.
 */
function buildErrorSocketMock(code: string = 'ECONNREFUSED') {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const socket = {
    write: vi.fn(),
    on: vi.fn<[string, (...args: unknown[]) => void], Socket>((event, handler) => {
      handlers[event] = [...(handlers[event] ?? []), handler];
      return socket as unknown as Socket;
    }),
    // Deliver the error after all handlers are registered
    setTimeout: vi.fn<[number], Socket>(() => {
      Promise.resolve().then(() => {
        const err = Object.assign(new Error(`connect ${code}`), { code });
        for (const h of handlers['error'] ?? []) h(err);
      });
      return socket as unknown as Socket;
    }),
    destroy: vi.fn(),
  };
  return socket;
}

vi.mock('node:net', () => ({
  default: {
    createConnection: vi.fn<[{ path: string }, () => void], Socket>(
      (_opts: { path: string }, _cb: () => void) => {
        // Immediately call the connect callback so the socket write fires
        if (_lastSocket) {
          Promise.resolve().then(() => _cb?.());
        }
        return _lastSocket as unknown as Socket;
      }
    ),
  },
  createConnection: vi.fn<[{ path: string }, () => void], Socket>(
    (_opts: { path: string }, cb: () => void) => {
      Promise.resolve().then(() => cb?.());
      return _lastSocket as unknown as Socket;
    }
  ),
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

import {
  sendDaemonCommand,
  canConnectToDaemon,
  getDaemonStatusViaIpc,
  requestDaemonStop,
  listConnectedDevices,
  attachRelaySession,
} from '../controlClient.js';

// ============================================================================
// Tests
// ============================================================================

describe('controlClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _lastSocket = null;
  });

  // ── sendDaemonCommand ────────────────────────────────────────────────────

  describe('sendDaemonCommand', () => {
    it('sends ping and returns parsed response', async () => {
      _lastSocket = buildSocketMock({ success: true, data: { pong: true } });

      const result = await sendDaemonCommand({ type: 'ping' });

      expect(result.success).toBe(true);
      expect((result.data as { pong: boolean }).pong).toBe(true);
    });

    it('resolves with success: false on ECONNREFUSED', async () => {
      _lastSocket = buildErrorSocketMock('ECONNREFUSED');

      const result = await sendDaemonCommand({ type: 'ping' });

      expect(result.success).toBe(false);
    });
  });

  // ── canConnectToDaemon ───────────────────────────────────────────────────

  describe('canConnectToDaemon', () => {
    it('returns true when daemon responds to ping', async () => {
      _lastSocket = buildSocketMock({ success: true, data: { pong: true } });

      const result = await canConnectToDaemon();

      expect(result).toBe(true);
    });

    it('returns false when socket is unreachable (ENOENT)', async () => {
      _lastSocket = buildErrorSocketMock('ENOENT');

      const result = await canConnectToDaemon();

      expect(result).toBe(false);
    });
  });

  // ── attachRelaySession ───────────────────────────────────────────────────

  describe('attachRelaySession', () => {
    const SESSION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    it('sends { type: attach-relay, sessionId } and returns true on success', async () => {
      _lastSocket = buildSocketMock({
        success: true,
        data: { attached: true, sessionId: SESSION_ID },
      });

      const result = await attachRelaySession(SESSION_ID);

      expect(result).toBe(true);
      // Verify payload written to socket
      const written = JSON.parse(
        (_lastSocket.write as ReturnType<typeof vi.fn>).mock.calls[0][0].trimEnd()
      ) as { type: string; sessionId: string };
      expect(written.type).toBe('attach-relay');
      expect(written.sessionId).toBe(SESSION_ID);
    });

    it('returns true when daemon ACKs with success: true', async () => {
      _lastSocket = buildSocketMock({ success: true });
      const result = await attachRelaySession(SESSION_ID);
      expect(result).toBe(true);
    });

    it('returns false when daemon returns success: false', async () => {
      _lastSocket = buildSocketMock({ success: false, error: 'session not found in daemon' });
      const result = await attachRelaySession(SESSION_ID);
      expect(result).toBe(false);
    });

    it('returns false when socket is unreachable', async () => {
      _lastSocket = buildErrorSocketMock('ECONNREFUSED');
      const result = await attachRelaySession(SESSION_ID);
      expect(result).toBe(false);
    });
  });

  // ── getDaemonStatusViaIpc ────────────────────────────────────────────────

  describe('getDaemonStatusViaIpc', () => {
    it('returns daemon state on success', async () => {
      _lastSocket = buildSocketMock({
        success: true,
        data: { running: true, pid: 12345, connectionState: 'connected' },
      });

      const state = await getDaemonStatusViaIpc();

      expect(state.running).toBe(true);
      expect(state.pid).toBe(12345);
    });

    it('returns { running: false } fallback when IPC is unavailable', async () => {
      _lastSocket = buildErrorSocketMock('ENOENT');

      const state = await getDaemonStatusViaIpc();

      expect(state.running).toBe(false);
    });
  });

  // ── requestDaemonStop ────────────────────────────────────────────────────

  describe('requestDaemonStop', () => {
    it('returns true when daemon ACKs stop', async () => {
      _lastSocket = buildSocketMock({ success: true, data: { stopping: true } });

      const result = await requestDaemonStop();

      expect(result).toBe(true);
    });
  });

  // ── listConnectedDevices ─────────────────────────────────────────────────

  describe('listConnectedDevices', () => {
    it('returns devices array from daemon response', async () => {
      const devices = [{ device_type: 'mobile', id: 'mob-1' }];
      _lastSocket = buildSocketMock({ success: true, data: { devices } });

      const result = await listConnectedDevices();

      expect(result).toEqual(devices);
    });

    it('returns empty array when daemon is unreachable', async () => {
      _lastSocket = buildErrorSocketMock('ECONNREFUSED');

      const result = await listConnectedDevices();

      expect(result).toEqual([]);
    });
  });
});
