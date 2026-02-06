/**
 * Stop Command Handler
 *
 * Handles the `styrby stop` command which stops the running daemon process.
 *
 * @module commands/stop
 */

import chalk from 'chalk';
import { getDaemonStatus, stopDaemon } from '@/daemon/run';
import { logger } from '@/ui/logger';

/**
 * Handle the `styrby stop` command.
 *
 * Checks if the daemon is running and stops it if so.
 * Displays appropriate feedback for both running and not-running states.
 *
 * @param _args - Command arguments (currently unused)
 * @returns Promise that resolves when the command completes
 *
 * @example
 * // Called from index.ts
 * case 'stop':
 *   await handleStop(args.slice(1));
 *   break;
 */
export async function handleStop(_args: string[]): Promise<void> {
  const status = getDaemonStatus();

  if (!status.running) {
    console.log(chalk.yellow('No daemon running'));
    return;
  }

  logger.debug('Stopping daemon', { pid: status.pid });
  console.log(chalk.gray(`Stopping daemon (PID ${status.pid})...`));

  try {
    await stopDaemon();
    console.log(chalk.green('Daemon stopped'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.log(chalk.red(`Failed to stop daemon: ${message}`));
    logger.error('Failed to stop daemon', { error: message });
    process.exit(1);
  }
}

export default { handleStop };
