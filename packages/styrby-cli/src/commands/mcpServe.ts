/**
 * `styrby mcp serve` Command Handler
 *
 * Spawns the Styrby MCP server bound to stdio so an MCP-aware coding agent
 * (Claude Code, Codex, Cursor) can call Styrby tools as part of its session.
 *
 * ## Wiring it up
 *
 * Most MCP clients accept a server config like:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "styrby": {
 *       "command": "styrby",
 *       "args": ["mcp", "serve"]
 *     }
 *   }
 * }
 * ```
 *
 * The agent spawns this command and writes JSON-RPC messages to its stdin;
 * we write tool results back on stdout. All other CLI logging is routed
 * to stderr so it never confuses the protocol stream.
 *
 * ## Auth
 *
 * The server runs in the user's authenticated CLI context — it loads the
 * same persisted credentials as `styrby start`. If the user hasn't onboarded,
 * we exit with a clear error rather than silently failing tools.
 *
 * @module commands/mcpServe
 */

import chalk from 'chalk';
import { loadPersistedData } from '@/persistence';
import { logger } from '@/ui/logger';
import { runStdioServer } from '@/mcp/server';
import { createSupabaseApprovalHandler } from '@/mcp/approvalHandler';

/**
 * Top-level entry for `styrby mcp <subcommand>`.
 *
 * Phase 1 supports only `serve`. Future subcommands could include `list`
 * (show what tools this server exposes) or `test` (round-trip a tool call
 * locally for debugging).
 *
 * @param args - argv slice after `mcp`
 */
export async function handleMcpCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'serve':
      await handleMcpServe();
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printMcpHelp();
      return;
    default:
      logger.error(`Unknown mcp subcommand: ${subcommand}`);
      printMcpHelp();
      process.exit(1);
  }
}

/**
 * Starts the MCP server on stdio. Blocks until the parent agent closes
 * our stdin (the normal "agent quit" signal).
 *
 * WHY all log output goes to stderr: stdout is the JSON-RPC channel.
 * Any stray write to stdout corrupts the framing and causes the agent
 * to disconnect with a parse error. Logger already writes to stderr by
 * default, but we double-check by avoiding any console.log in this path.
 */
async function handleMcpServe(): Promise<void> {
  const data = loadPersistedData();

  if (!data?.userId || !data?.accessToken) {
    logger.error('Not authenticated. Run "styrby onboard" first.');
    process.exit(1);
  }

  if (!data.machineId) {
    logger.error(
      'No machine ID found. Run "styrby pair" to register this machine first.',
    );
    process.exit(1);
  }

  // H41 Phase 4-step4: load the styrby_* key and build a typed apiClient.
  // Replaces the prior direct-Supabase auth path (no more anon-key + JWT
  // dance for the MCP server). MissingStyrbyKeyError fires if the user
  // ran the CLI before Phase 5's exchange flow minted the key — fix is to
  // re-onboard.
  let apiClient: import('@/api/styrbyApiClient').StyrbyApiClient;
  try {
    const { getApiClient } = await import('@/api/clientFromPersistence');
    apiClient = getApiClient();
  } catch (err) {
    const { MissingStyrbyKeyError } = await import('@/api/clientFromPersistence');
    if (err instanceof MissingStyrbyKeyError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const handler = createSupabaseApprovalHandler(apiClient, data.userId, data.machineId);

  // Banner goes to stderr — invisible to the JSON-RPC protocol on stdout.
  logger.info(chalk.bold.cyan('Styrby MCP server starting on stdio…'));
  logger.info(chalk.gray('  Tools exposed: request_approval'));
  logger.info(chalk.gray('  Awaiting client handshake'));

  await runStdioServer(handler);

  logger.info(chalk.gray('MCP transport closed; exiting.'));
}

/**
 * Prints help for the `mcp` command family.
 */
function printMcpHelp(): void {
  // Help to stderr too, in case the user accidentally pipes us into an agent.
  logger.info('');
  logger.info(chalk.bold('styrby mcp') + ' — Model Context Protocol server');
  logger.info('');
  logger.info('Subcommands:');
  logger.info('  serve              Start MCP server on stdio (for agent integration)');
  logger.info('  help               Show this help');
  logger.info('');
  logger.info('Setup example (Claude Code .mcp.json):');
  logger.info(chalk.gray('  {'));
  logger.info(chalk.gray('    "mcpServers": {'));
  logger.info(chalk.gray('      "styrby": {'));
  logger.info(chalk.gray('        "command": "styrby",'));
  logger.info(chalk.gray('        "args": ["mcp", "serve"]'));
  logger.info(chalk.gray('      }'));
  logger.info(chalk.gray('    }'));
  logger.info(chalk.gray('  }'));
  logger.info('');
}
