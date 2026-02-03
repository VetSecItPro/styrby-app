/**
 * Message Formatter for Ink
 *
 * Stub for Happy Coder's Ink message formatter.
 *
 * @module ui/messageFormatterInk
 */

import chalk from 'chalk';

/**
 * Format an agent message for display.
 */
export function formatAgentMessage(message: string, agentType?: string): string {
  const colors: Record<string, (s: string) => string> = {
    claude: chalk.yellow,
    codex: chalk.green,
    gemini: chalk.blue,
  };
  const colorFn = agentType ? colors[agentType] || chalk.white : chalk.white;
  return colorFn(message);
}

/**
 * Format a user message for display.
 */
export function formatUserMessage(message: string): string {
  return chalk.cyan(message);
}

/**
 * Format an error message for display.
 */
export function formatErrorMessage(message: string): string {
  return chalk.red(message);
}

/**
 * Format a system message for display.
 */
export function formatSystemMessage(message: string): string {
  return chalk.gray(message);
}

export default {
  formatAgentMessage,
  formatUserMessage,
  formatErrorMessage,
  formatSystemMessage,
};
