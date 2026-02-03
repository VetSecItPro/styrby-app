/**
 * Daemon Control Client
 *
 * Client for communicating with the background daemon process.
 *
 * WHY: Stub module for Happy Coder's daemon control.
 * Used to send commands to the daemon from CLI invocations.
 *
 * @module daemon/controlClient
 */

import { logger } from '@/ui/logger';
import type { DaemonState } from './run';

/**
 * Command types for daemon control
 */
export type DaemonCommand =
  | { type: 'status' }
  | { type: 'start-session'; agentType: string; projectPath: string }
  | { type: 'stop-session'; sessionId: string }
  | { type: 'send-message'; sessionId: string; message: string }
  | { type: 'shutdown' };

/**
 * Response from daemon
 */
export interface DaemonResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Send a command to the daemon.
 *
 * TODO: Implement IPC communication
 * Options:
 * - Unix socket
 * - Named pipe (Windows)
 * - HTTP on localhost
 *
 * @param command - Command to send
 * @returns Promise resolving to daemon response
 */
export async function sendDaemonCommand(command: DaemonCommand): Promise<DaemonResponse> {
  logger.debug('Daemon command (stub)', { command });
  // TODO: Implement actual IPC
  return {
    success: true,
    data: null,
  };
}

/**
 * Check if we can connect to the daemon.
 *
 * @returns True if daemon is reachable
 */
export async function canConnectToDaemon(): Promise<boolean> {
  try {
    const response = await sendDaemonCommand({ type: 'status' });
    return response.success;
  } catch {
    return false;
  }
}

/**
 * Get daemon status via IPC.
 *
 * @returns Daemon state
 */
export async function getDaemonStatusViaIpc(): Promise<DaemonState> {
  const response = await sendDaemonCommand({ type: 'status' });
  return (response.data as DaemonState) || { running: false };
}

/**
 * Default export for compatibility
 */
export default {
  sendDaemonCommand,
  canConnectToDaemon,
  getDaemonStatusViaIpc,
};
