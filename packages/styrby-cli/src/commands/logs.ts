/**
 * Logs Command Handler
 *
 * Handles the `styrby logs` command which displays daemon log output.
 * Supports --follow/-f for real-time log tailing and --lines/-n for
 * limiting output to the last N lines.
 *
 * @module commands/logs
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { DAEMON_PATHS } from '@/daemon/run';
import { logger } from '@/ui/logger';

/**
 * Options for the logs command.
 */
interface LogsOptions {
  /** Whether to follow the log in real-time (tail -f behavior) */
  follow: boolean;
  /** Number of lines to show (default: 50) */
  lines: number;
}

/**
 * Parse command line arguments for the logs command.
 *
 * @param args - Raw command arguments from process.argv
 * @returns Parsed options for the logs command
 *
 * @example
 * parseLogsArgs(['--follow', '-n', '100'])
 * // => { follow: true, lines: 100 }
 */
export function parseLogsArgs(args: string[]): LogsOptions {
  const options: LogsOptions = {
    follow: false,
    lines: 50,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--follow' || arg === '-f') {
      options.follow = true;
    } else if (arg === '--lines' || arg === '-n') {
      const value = args[++i];
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.lines = parsed;
      }
    }
  }

  return options;
}

/**
 * Read the last N lines from a file.
 *
 * Uses a reverse buffer approach to efficiently read the tail of large files
 * without loading the entire file into memory.
 *
 * @param filePath - Path to the file to read
 * @param lineCount - Number of lines to return from the end
 * @returns Array of the last N lines (or fewer if file is shorter)
 */
async function readLastLines(filePath: string, lineCount: number): Promise<string[]> {
  const lines: string[] = [];

  return new Promise<string[]>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      lines.push(line);
      // Keep only the last N lines in memory
      if (lines.length > lineCount) {
        lines.shift();
      }
    });

    rl.on('close', () => resolve(lines));
    rl.on('error', (err) => reject(err));
  });
}

/**
 * Follow a log file in real-time (tail -f behavior).
 *
 * Uses fs.watch to detect file changes and streams new content to stdout.
 * Handles Ctrl+C gracefully to clean up watchers.
 *
 * @param filePath - Path to the log file to follow
 * @param initialLines - Lines to show initially before following
 */
async function followLogFile(filePath: string, initialLines: string[]): Promise<void> {
  // Print initial lines
  for (const line of initialLines) {
    console.log(line);
  }

  // Get initial file position
  let position = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

  console.log(chalk.gray('\n--- Following log (Ctrl+C to stop) ---\n'));

  // Create file watcher
  const watcher = fs.watch(filePath, { persistent: true });

  const cleanup = () => {
    watcher.close();
  };

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log(chalk.gray('\n\nStopped following logs.'));
    cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // Watch for file changes
  watcher.on('change', () => {
    try {
      const stats = fs.statSync(filePath);

      // If file was truncated, reset position
      if (stats.size < position) {
        position = 0;
      }

      // Read new content
      if (stats.size > position) {
        const buffer = Buffer.alloc(stats.size - position);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, buffer.length, position);
        fs.closeSync(fd);

        const newContent = buffer.toString('utf-8');
        process.stdout.write(newContent);
        position = stats.size;
      }
    } catch (error) {
      logger.debug('Error reading log file during follow', { error });
    }
  });

  watcher.on('error', (error) => {
    console.log(chalk.red(`\nError watching log file: ${error.message}`));
    cleanup();
    process.exit(1);
  });

  // Keep the process alive
  await new Promise<void>(() => {
    // This promise intentionally never resolves
    // The process exits via SIGINT/SIGTERM handlers
  });
}

/**
 * Handle the `styrby logs` command.
 *
 * Reads and displays daemon log output. Supports:
 * - --follow or -f: Follow the log in real-time (like tail -f)
 * - --lines N or -n N: Show the last N lines (default: 50)
 *
 * @param args - Command arguments
 * @returns Promise that resolves when the command completes
 *
 * @example
 * // Show last 50 lines
 * styrby logs
 *
 * // Follow logs in real-time
 * styrby logs --follow
 *
 * // Show last 100 lines
 * styrby logs -n 100
 *
 * // Follow with 200 lines of context
 * styrby logs -f -n 200
 */
export async function handleLogs(args: string[]): Promise<void> {
  const options = parseLogsArgs(args);
  const logPath = DAEMON_PATHS.logFile;

  // Check if log file exists
  if (!fs.existsSync(logPath)) {
    console.log(chalk.yellow('No daemon logs found'));
    console.log(chalk.gray(`Log file location: ${logPath}`));
    console.log(chalk.gray('Start the daemon with: styrby start --daemon'));
    return;
  }

  // Check if file is readable
  try {
    fs.accessSync(logPath, fs.constants.R_OK);
  } catch {
    console.log(chalk.red(`Cannot read log file: ${logPath}`));
    console.log(chalk.gray('Check file permissions.'));
    process.exit(1);
  }

  // Read initial lines
  const lines = await readLastLines(logPath, options.lines);

  if (lines.length === 0) {
    console.log(chalk.yellow('Log file is empty'));
    console.log(chalk.gray(`Log file location: ${logPath}`));
    return;
  }

  // Follow mode or print and exit
  if (options.follow) {
    await followLogFile(logPath, lines);
  } else {
    for (const line of lines) {
      console.log(line);
    }
  }
}

export default { handleLogs, parseLogsArgs };
