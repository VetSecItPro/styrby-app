#!/usr/bin/env node
/**
 * Styrby CLI
 *
 * Mobile remote control for AI coding agents.
 * Connects Claude Code, Codex, and Gemini CLI to the Styrby mobile app.
 *
 * @module styrby-cli
 *
 * @example
 * # Authenticate with Styrby
 * styrby auth
 *
 * # Start a session with Claude Code
 * styrby start --agent claude
 *
 * # Show status
 * styrby status
 */

import { logger } from '@/ui/logger';

// Re-export core types for library usage
export type {
  AgentBackend,
  AgentId,
  AgentTransport,
  AgentBackendConfig,
  SessionId,
  ToolCallId,
  AgentMessage,
  AgentMessageHandler,
  StartSessionResult,
} from './agent/core/AgentBackend';

export { AgentRegistry } from './agent/core/AgentRegistry';

/**
 * CLI version
 */
export const VERSION = '0.1.0';

/**
 * Main CLI entry point.
 *
 * Parses command line arguments and dispatches to appropriate handlers.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  logger.info(`Styrby CLI v${VERSION}`);

  switch (command) {
    case 'auth':
      await handleAuth();
      break;

    case 'start':
      await handleStart(args.slice(1));
      break;

    case 'status':
      await handleStatus();
      break;

    case 'doctor':
      await handleDoctor();
      break;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;

    default:
      logger.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

/**
 * Handle the 'auth' command.
 * Authenticates with Styrby and pairs with mobile app.
 */
async function handleAuth(): Promise<void> {
  logger.info('Authentication flow starting...');
  // TODO: Implement
  // 1. Generate QR code with pairing token
  // 2. Display QR in terminal
  // 3. Wait for mobile app to scan
  // 4. Exchange keys via Supabase
  // 5. Store credentials locally
  logger.warn('Auth not yet implemented');
}

/**
 * Handle the 'start' command.
 * Starts an agent session.
 *
 * @param args - Command arguments (--agent, --project, etc.)
 */
async function handleStart(args: string[]): Promise<void> {
  // Parse arguments
  let agentType = 'claude';
  let projectPath = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' || args[i] === '-a') {
      agentType = args[++i] || 'claude';
    } else if (args[i] === '--project' || args[i] === '-p') {
      projectPath = args[++i] || process.cwd();
    }
  }

  logger.info(`Starting ${agentType} session in ${projectPath}`);
  // TODO: Implement
  // 1. Check authentication
  // 2. Connect to Supabase Realtime
  // 3. Start agent via AgentBackend
  // 4. Relay messages to mobile
  logger.warn('Start not yet implemented');
}

/**
 * Handle the 'status' command.
 * Shows current connection and session status.
 */
async function handleStatus(): Promise<void> {
  logger.info('Checking status...');
  // TODO: Implement
  // 1. Check if daemon is running
  // 2. Check connection to Supabase
  // 3. List active sessions
  logger.warn('Status not yet implemented');
}

/**
 * Handle the 'doctor' command.
 * Runs diagnostic checks.
 */
async function handleDoctor(): Promise<void> {
  const { runDoctor } = await import('@/ui/doctor');
  const success = await runDoctor();
  process.exit(success ? 0 : 1);
}

/**
 * Print CLI help.
 */
function printHelp(): void {
  console.log(`
Styrby CLI v${VERSION}
Mobile remote control for AI coding agents.

USAGE
  styrby <command> [options]

COMMANDS
  auth          Authenticate and pair with mobile app
  start         Start an agent session
  status        Show connection and session status
  doctor        Run diagnostic checks
  help          Show this help message
  version       Show version

OPTIONS
  --agent, -a   Agent type: claude, codex, gemini (default: claude)
  --project, -p Project directory (default: current directory)

EXAMPLES
  # Authenticate with Styrby
  styrby auth

  # Start Claude Code session
  styrby start --agent claude

  # Start Codex session in specific directory
  styrby start --agent codex --project /path/to/project

  # Check CLI health
  styrby doctor

For more info, visit: https://styrbyapp.com/docs
`);
}

// Run main
main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});
