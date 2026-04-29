/**
 * Daemon Control Client
 *
 * Client for communicating with the background daemon process via a Unix
 * domain socket. Used by CLI commands (e.g., `styrby status`, `styrby stop`)
 * to query or control the daemon.
 *
 * WHY: The IPC socket enables richer interactions than the status file --
 * real-time status, session listing, and graceful shutdown commands.
 *
 * Protocol: newline-delimited JSON over ~/.styrby/daemon.sock
 *
 * @module daemon/controlClient
 */

import * as net from 'node:net';
import { logger } from '@/ui/logger';
import { DAEMON_PATHS, type DaemonState } from './run';

/**
 * Base fields present on every IPC command envelope.
 *
 * currentUserId carries the caller's authenticated identity so the daemon
 * can enforce account-context isolation on every mutable command.
 *
 * OWASP A07:2021 — Identification and Authentication Failures:
 *   The caller is responsible for supplying its current userId. The daemon
 *   validates it against the account it was bound to at startup.
 *
 * SOC 2 CC6.1 — Logical and Physical Access Controls:
 *   Identity must travel with the command — not assumed from socket ownership —
 *   so the daemon can distinguish a legitimate same-account call from an
 *   account-switch scenario that requires a rebind or refusal.
 *
 * WHY optional (not required):
 *   Read-only health-check commands (ping, status) and the terminate command
 *   are exempt from the auth check. Callers MAY omit currentUserId for those
 *   command types. The daemon's assertAuthContext skips validation for exempt
 *   types, so a missing field is harmless for them.
 */
interface DaemonCommandBase {
  /**
   * The userId of the account currently logged into the CLI on the calling machine.
   * Populated by TokenManager.getCurrentUserId() before sending any mutable command.
   * Absent / omitted for exempt commands (daemon.terminate, ping, status).
   */
  currentUserId?: string;
}

/**
 * Commands that can be sent to the daemon via IPC.
 */
export type DaemonCommand =
  | (DaemonCommandBase & { type: 'status' })
  | (DaemonCommandBase & { type: 'ping' })
  | (DaemonCommandBase & { type: 'stop' })
  | (DaemonCommandBase & { type: 'list-sessions' })
  | (DaemonCommandBase & { type: 'start-session'; agentType: string; projectPath: string })
  | (DaemonCommandBase & { type: 'stop-session'; sessionId: string })
  | (DaemonCommandBase & { type: 'send-message'; sessionId: string; message: string })
  | (DaemonCommandBase & { type: 'shutdown' })
  /**
   * Re-attach the daemon's RelayClient to an existing session's Realtime channel.
   * The daemon updates `sessions.status = 'running'` and `last_seen_at = now()`.
   * Does NOT spawn a new agent process — relay-reconnect only.
   */
  | (DaemonCommandBase & { type: 'attach-relay'; sessionId: string })
  /**
   * Terminate the daemon process cleanly.
   *
   * The daemon will:
   * 1. ACK this command
   * 2. Persist a final state snapshot
   * 3. Close the Realtime subscription
   * 4. Close the IPC server
   * 5. Call process.exit(0)
   *
   * Used by `styrby logout` to tear down the daemon before clearing tokens.
   * SOC 2 CC7.2: Ensures no orphaned Realtime subscriptions on logout.
   * WHY no currentUserId required: daemon.terminate is exempt from auth check —
   * logout must always be able to stop the daemon regardless of identity state.
   */
  | (DaemonCommandBase & { type: 'daemon.terminate' });

/**
 * Response received from the daemon via IPC.
 */
export interface DaemonResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** WHY: 3s is long enough for a response, short enough to not hang the CLI. */
const IPC_TIMEOUT_MS = 3_000;

/**
 * Send a command to the daemon via Unix domain socket.
 *
 * Opens a connection to ~/.styrby/daemon.sock, sends newline-delimited JSON,
 * reads the response, and closes the connection.
 *
 * @param command - Command to send to the daemon
 * @returns Promise resolving to the daemon's response
 * @throws {Error} If the socket connection fails or times out
 */
export async function sendDaemonCommand(command: DaemonCommand): Promise<DaemonResponse> {
  const socketPath = DAEMON_PATHS.socketPath;

  return new Promise<DaemonResponse>((resolve, reject) => {
    let buffer = '';
    let resolved = false;

    const socket = net.createConnection({ path: socketPath }, () => {
      socket.write(JSON.stringify(command) + '\n');
    });

    socket.setTimeout(IPC_TIMEOUT_MS);

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const responseLine = buffer.substring(0, newlineIndex).trim();
        if (responseLine && !resolved) {
          resolved = true;
          try {
            socket.destroy();
            resolve(JSON.parse(responseLine) as DaemonResponse);
          } catch {
            socket.destroy();
            reject(new Error(`Invalid response from daemon: ${responseLine}`));
          }
        }
      }
    });

    socket.on('timeout', () => {
      if (!resolved) { resolved = true; socket.destroy(); reject(new Error('Daemon IPC timed out')); }
    });

    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        const errCode = (err as NodeJS.ErrnoException).code;
        if (errCode === 'ECONNREFUSED' || errCode === 'ENOENT') {
          logger.debug('Daemon IPC socket not available', { code: errCode });
          resolve({ success: false, error: 'Daemon not running or IPC not available' });
        } else {
          reject(err);
        }
      }
    });

    socket.on('close', () => {
      if (!resolved) { resolved = true; resolve({ success: false, error: 'Connection closed before response' }); }
    });
  });
}

/**
 * Check if we can connect to the daemon via IPC.
 * Sends a ping and checks for a successful response.
 *
 * @returns True if the daemon responded to the ping
 */
export async function canConnectToDaemon(): Promise<boolean> {
  try {
    const response = await sendDaemonCommand({ type: 'ping' });
    return response.success;
  } catch {
    return false;
  }
}

/**
 * Get daemon status via the IPC socket.
 * Falls back to { running: false } if daemon is unreachable.
 *
 * @returns Daemon state as reported by the daemon itself
 */
export async function getDaemonStatusViaIpc(): Promise<DaemonState> {
  try {
    const response = await sendDaemonCommand({ type: 'status' });
    if (response.success && response.data) return response.data as DaemonState;
  } catch {
    logger.debug('Could not get daemon status via IPC');
  }
  return { running: false };
}

/**
 * Request the daemon to stop gracefully via IPC.
 *
 * @returns True if the daemon acknowledged the stop command
 */
export async function requestDaemonStop(): Promise<boolean> {
  try {
    const response = await sendDaemonCommand({ type: 'stop' });
    return response.success;
  } catch {
    return false;
  }
}

/**
 * List connected devices/sessions via IPC.
 *
 * @returns Array of connected device presence states
 */
export async function listConnectedDevices(): Promise<unknown[]> {
  try {
    const response = await sendDaemonCommand({ type: 'list-sessions' });
    if (response.success && response.data) {
      return (response.data as { devices?: unknown[] }).devices || [];
    }
  } catch {
    logger.debug('Could not list connected devices via IPC');
  }
  return [];
}

/**
 * Request the daemon to re-attach its RelayClient to an existing session channel.
 *
 * This is the client-side half of `styrby resume`. The daemon handler updates
 * `sessions.status = 'running'` and `last_seen_at = now()`, then re-subscribes
 * the RelayClient to the session's Supabase Realtime channel keyed on machine_id.
 *
 * WHY NOT re-spawn agent: attach-relay is a relay-reconnect, not a process
 * re-launch. The agent process may still be alive; creating a new one would
 * produce duplicate relay messages and corrupt the session state.
 *
 * @param sessionId - UUID of the session to re-attach to
 * @returns True if the daemon acknowledged and is re-attaching
 */
export async function attachRelaySession(sessionId: string): Promise<boolean> {
  try {
    const response = await sendDaemonCommand({ type: 'attach-relay', sessionId });
    return response.success;
  } catch {
    logger.debug('Could not attach relay session via IPC', { sessionId });
    return false;
  }
}

/**
 * Send `daemon.terminate` and wait for the daemon to shut down cleanly.
 *
 * Behavior:
 * 1. Sends `{ type: 'daemon.terminate' }` over IPC.
 * 2. If the daemon ACKs (success: true) within `timeoutMs`, returns `{ ok: true }`.
 * 3. If no ACK arrives within `timeoutMs`, or the socket is unreachable,
 *    returns `{ ok: false }`.
 *
 * WHY this function doesn't reuse `sendDaemonCommand`:
 *   `sendDaemonCommand` resolves/rejects based on the JSON response and always
 *   throws on timeout. `terminateDaemon` needs a different success shape
 *   (`{ ok: boolean }` not `DaemonResponse`), never throws (callers rely on the
 *   `ok` flag to decide between graceful shutdown and SIGTERM fallback), and
 *   uses a caller-supplied timeout rather than the fixed `IPC_TIMEOUT_MS`.
 *   Fitting all three into `sendDaemonCommand` would have required a brittle
 *   options bag with three overloads — a separate function is cleaner.
 *
 * WHY `{ ok: boolean }` instead of throwing on timeout:
 *   `styrby logout` needs to distinguish a graceful shutdown from a timeout so
 *   it can fall back to SIGTERM via PID file. Throwing would conflate both cases
 *   and force the caller to catch + inspect error messages.
 *
 * WHY we use the standard IPC_TIMEOUT_MS from sendDaemonCommand for the socket
 * read, but `timeoutMs` controls whether we treat that as a timeout result:
 *   The socket-level timeout is a separate concern (prevents the connection
 *   from hanging forever). The `timeoutMs` parameter lets callers specify how
 *   long they are willing to wait for the daemon ACK — distinct from whether
 *   the socket itself is alive.
 *
 * SOC 2 CC7.2: Reliable processing requires that the caller knows whether the
 * daemon stopped cleanly, so it can apply fallback (SIGTERM) rather than
 * leaving the daemon running while tokens are wiped.
 *
 * @param timeoutMs - Max milliseconds to wait for the daemon to ACK (default 5000)
 * @returns `{ ok: true }` on graceful shutdown, `{ ok: false }` on timeout or error
 */
export async function terminateDaemon(timeoutMs: number = 5_000): Promise<{ ok: boolean }> {
  const socketPath = DAEMON_PATHS.socketPath;

  return new Promise<{ ok: boolean }>((resolve) => {
    let buffer = '';
    let settled = false;

    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ ok });
    };

    const socket = net.createConnection({ path: socketPath }, () => {
      socket.write(JSON.stringify({ type: 'daemon.terminate' }) + '\n');
    });

    // WHY custom timeout here instead of reusing IPC_TIMEOUT_MS:
    // The caller-supplied timeoutMs governs how long the logout command will wait.
    // The default socket timeout (IPC_TIMEOUT_MS = 3s) is the inner bound;
    // terminateDaemon's timeout is the outer bound from the caller's perspective.
    socket.setTimeout(timeoutMs);

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const responseLine = buffer.substring(0, newlineIndex).trim();
        if (responseLine) {
          socket.destroy();
          try {
            const resp = JSON.parse(responseLine) as { success: boolean };
            settle(resp.success === true);
          } catch {
            settle(false);
          }
        }
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      settle(false);
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code;
      if (code === 'ECONNREFUSED' || code === 'ENOENT') {
        // Daemon not running — treat as ok=false (nothing to terminate)
        logger.debug('terminateDaemon: daemon not running', { code });
      }
      settle(false);
    });

    socket.on('close', () => {
      // Socket closed without a response line (e.g., daemon closed it right
      // after sending the ACK but before our data handler fired). Treat as ok
      // only if we already settled — otherwise the ACK was lost.
      if (!settled) settle(false);
    });
  });
}

export default {
  sendDaemonCommand, canConnectToDaemon, getDaemonStatusViaIpc,
  requestDaemonStop, listConnectedDevices, attachRelaySession, terminateDaemon,
};
