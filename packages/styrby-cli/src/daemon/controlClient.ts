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
 * Commands that can be sent to the daemon via IPC.
 */
export type DaemonCommand =
  | { type: 'status' }
  | { type: 'ping' }
  | { type: 'stop' }
  | { type: 'list-sessions' }
  | { type: 'start-session'; agentType: string; projectPath: string }
  | { type: 'stop-session'; sessionId: string }
  | { type: 'send-message'; sessionId: string; message: string }
  | { type: 'shutdown' };

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

export default {
  sendDaemonCommand, canConnectToDaemon, getDaemonStatusViaIpc,
  requestDaemonStop, listConnectedDevices,
};
