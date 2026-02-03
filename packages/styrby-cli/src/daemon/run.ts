/**
 * Daemon Runner
 *
 * Handles running the CLI in daemon mode for persistent connections.
 *
 * WHY: Stub module for Happy Coder's daemon system.
 * The daemon keeps the CLI connected to the relay even when
 * no terminal is active. This allows mobile to connect anytime.
 *
 * @module daemon/run
 */

import { logger } from '@/ui/logger';

/**
 * Daemon state
 */
export interface DaemonState {
  running: boolean;
  pid?: number;
  startedAt?: string;
  connectionState?: 'connected' | 'connecting' | 'disconnected';
}

/**
 * Start the daemon process.
 *
 * TODO: Implement daemon
 * - Fork a child process that stays alive
 * - Keep Supabase Realtime connection open
 * - Handle agent sessions in background
 * - Write PID file for management
 *
 * @returns Promise resolving to daemon state
 */
export async function startDaemon(): Promise<DaemonState> {
  logger.info('Daemon start requested (stub)');
  // TODO: Implement actual daemon
  return {
    running: true,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    connectionState: 'connected',
  };
}

/**
 * Stop the daemon process.
 *
 * @returns Promise resolving when stopped
 */
export async function stopDaemon(): Promise<void> {
  logger.info('Daemon stop requested (stub)');
  // TODO: Implement actual daemon stop
}

/**
 * Get current daemon status.
 *
 * @returns Daemon state
 */
export function getDaemonStatus(): DaemonState {
  // TODO: Read from PID file and check if running
  return {
    running: false,
  };
}

/**
 * Check if daemon is running.
 *
 * @returns True if daemon is active
 */
export function isDaemonRunning(): boolean {
  return getDaemonStatus().running;
}

/**
 * Default export for compatibility
 */
export default {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  isDaemonRunning,
};
