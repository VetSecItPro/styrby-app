/**
 * Styrby CLI Logger
 *
 * Provides structured logging for the CLI. This is a stub replacement
 * for Happy Coder's Ink-based logger. We use simple console output
 * for now; will be enhanced with proper formatting later.
 *
 * @module ui/logger
 */

import chalk from 'chalk';

/**
 * Log levels for filtering output
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Current log level - can be set via STYRBY_LOG_LEVEL env var
 */
const LOG_LEVEL: LogLevel = (process.env.STYRBY_LOG_LEVEL as LogLevel) || 'info';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Check if a message at the given level should be logged
 */
function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[LOG_LEVEL];
}

/**
 * Format a timestamp for log output
 */
function timestamp(): string {
  return new Date().toISOString().split('T')[1].slice(0, 8);
}

/**
 * Logger instance for CLI output.
 * Replaces Happy Coder's Ink-based logger with simple console output.
 */
export const logger = {
  /**
   * Log debug message (only shown when STYRBY_LOG_LEVEL=debug)
   */
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('debug')) {
      console.log(chalk.gray(`[${timestamp()}] DEBUG: ${message}`), ...args);
    }
  },

  /**
   * Log info message
   */
  info(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      console.log(chalk.blue(`[${timestamp()}] INFO: ${message}`), ...args);
    }
  },

  /**
   * Log warning message
   */
  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('warn')) {
      console.warn(chalk.yellow(`[${timestamp()}] WARN: ${message}`), ...args);
    }
  },

  /**
   * Log error message
   */
  error(message: string, ...args: unknown[]): void {
    if (shouldLog('error')) {
      console.error(chalk.red(`[${timestamp()}] ERROR: ${message}`), ...args);
    }
  },

  /**
   * Log a success message (always shown)
   */
  success(message: string, ...args: unknown[]): void {
    console.log(chalk.green(`✓ ${message}`), ...args);
  },

  /**
   * Log agent output (streaming)
   */
  agent(agentType: string, message: string): void {
    const colorFns: Record<string, (s: string) => string> = {
      claude: chalk.yellowBright,
      codex: chalk.greenBright,
      gemini: chalk.blueBright,
    };
    const colorFn = colorFns[agentType] || chalk.white;
    process.stdout.write(colorFn(message));
  },
};

/**
 * Default export for compatibility with Happy Coder imports
 */
export default logger;
