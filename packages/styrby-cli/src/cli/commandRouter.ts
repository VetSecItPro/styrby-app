/**
 * Command dispatcher for the Styrby CLI.
 *
 * Splits `main()` into two pieces:
 *   1. A fast-path branch for the bare command and agent-shorthand
 *      invocations (`styrby`, `styrby claude`, `styrby codex`, etc.),
 *      which may auto-run `onboard` if the user is not yet authenticated.
 *   2. A switch-based dispatch for every explicit subcommand, each of
 *      which prints the `Styrby CLI v<VERSION>` header before running.
 *
 * WHY a dedicated module: keeping the 25-case switch out of `index.ts`
 * means the entry point stays small enough to audit at a glance, and
 * every new subcommand is added here (not in the entry file) — reducing
 * merge-conflict risk across parallel feature PRs.
 *
 * @module cli/commandRouter
 */

import { logger } from '@/ui/logger';
import { VERSION } from '@/cli/version';
import { buildStartArgs, isAgentShorthand, isBareCommand } from '@/cli/agentShorthand';
import { printHelp } from '@/cli/helpScreen';
import { handleStart } from '@/cli/handlers/start';
import { handlePair } from '@/cli/handlers/pair';
import { handleResume } from '@/cli/handlers/resume';
import { handleStatus } from '@/cli/handlers/status';
import { handleCosts } from '@/cli/handlers/costs';
import {
  handleAuth,
  handleCheckpointCommand,
  handleDaemonCommand,
  handleDoctor,
  handleExportCommand,
  handleImportCommand,
  handleInstall,
  handleLogs,
  handleMcpCommand,
  handleOnboard,
  handleStop,
  handleTemplateCommand,
  handleUpgrade,
} from '@/cli/handlers/simple';

/**
 * Run the Styrby CLI for the given argv.
 *
 * Dispatches to the correct handler, preserving every early-exit
 * (auth-required, unknown-command) from the pre-refactor index.ts.
 *
 * WHY bare command starts a session: Every AI coding agent CLI follows
 * this pattern — `claude`, `codex`, `gemini`, `aider` all start a session
 * when you type the bare command. Users expect `styrby` to do something
 * immediately, not show a menu. If not authenticated, we auto-onboard first.
 *
 * @param argv - The arguments after `process.argv.slice(2)`.
 */
export async function runCommand(argv: string[]): Promise<void> {
  const command = argv[0];

  // Fast path: bare `styrby` or agent shorthand (`styrby codex`).
  if (isBareCommand(command) || isAgentShorthand(command)) {
    await runBareOrShorthand(argv, command);
    return;
  }

  // Only show version header for non-interactive commands.
  // WHY: the bare-command / shorthand path prints the header only when it
  // needs to auto-onboard, because an interactive agent TUI would scroll
  // that header off-screen anyway.
  logger.info(`Styrby CLI v${VERSION}`);

  const rest = argv.slice(1);

  switch (command) {
    case 'onboard':
      await handleOnboard(rest);
      break;

    case 'install':
      await handleInstall(rest);
      break;

    case 'auth':
      await handleAuth();
      break;

    case 'pair':
      await handlePair();
      break;

    case 'start':
      await handleStart(rest);
      break;

    case 'stop':
      await handleStop(rest);
      break;

    case 'resume':
      await handleResume(rest);
      break;

    case 'status':
      await handleStatus();
      break;

    case 'logs':
      await handleLogs(rest);
      break;

    case 'upgrade':
    case 'update':
      await handleUpgrade(rest);
      break;

    case 'daemon':
      await handleDaemonCommand(rest);
      break;

    case 'doctor':
      await handleDoctor();
      break;

    case 'costs':
      await handleCosts(rest);
      break;

    case 'template':
    case 'templates':
      await handleTemplateCommand(rest);
      break;

    case 'export':
      await handleExportCommand(rest);
      break;

    case 'import':
      await handleImportCommand(rest);
      break;

    case 'checkpoint':
    case 'cp':
      await handleCheckpointCommand(rest);
      break;

    case 'mcp':
      await handleMcpCommand(rest);
      break;

    case 'help':
    case '--help':
    case '-h':
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
 * Handle the bare-command and agent-shorthand invocations.
 *
 * This flow may:
 *   - Auto-run `onboard` when the user is unauthenticated (printing the
 *     version header first, since the onboard screen is not a TUI)
 *   - Forward to `handleStart` with the correct agent selected via
 *     shorthand, config default, or downstream default.
 *
 * @param argv - Full argv passed to `runCommand`.
 * @param command - Cached `argv[0]` (undefined if bare).
 */
async function runBareOrShorthand(argv: string[], command: string | undefined): Promise<void> {
  const { isAuthenticated, getConfigValue } = await import('@/configuration');
  if (!isAuthenticated()) {
    logger.info(`Styrby CLI v${VERSION}`);
    const { runOnboard } = await import('@/commands/onboard');
    const result = await runOnboard({ skipPairing: true });
    if (!result.success) {
      process.exit(1);
    }
  }

  // Determine agent: shorthand > --agent flag > config default > claude
  const agentFromShorthand = isAgentShorthand(command) ? command : null;
  const configDefault = getConfigValue('defaultAgent');
  const startArgs = buildStartArgs(argv, agentFromShorthand, configDefault);

  await handleStart(startArgs);
}
