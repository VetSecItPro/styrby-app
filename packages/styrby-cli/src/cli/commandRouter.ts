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
 * PERF (2026-05-05): every command handler is loaded via dynamic `import()`
 * instead of a static top-of-file import. Previously, invoking `styrby status`
 * would transitively load every other handler's module (agent factories,
 * daemon code, Supabase SDK, etc.), pushing cold-start past the 600 ms
 * budget tested by `src/perf/__tests__/startup.test.ts`. Lazy loading keeps
 * the module graph minimal: only the requested command's handler is loaded.
 *
 * @module cli/commandRouter
 */

import { logger } from '@/ui/logger';
import { VERSION } from '@/cli/version';
import { isAgentShorthand, isBareCommand } from '@/cli/agentShorthand';

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
    case 'onboard': {
      const { handleOnboard } = await import('@/cli/handlers/simple');
      await handleOnboard(rest);
      break;
    }

    case 'install': {
      const { handleInstall } = await import('@/cli/handlers/simple');
      await handleInstall(rest);
      break;
    }

    case 'auth': {
      const { handleAuth } = await import('@/cli/handlers/simple');
      await handleAuth();
      break;
    }

    case 'pair': {
      const { handlePair } = await import('@/cli/handlers/pair');
      await handlePair();
      break;
    }

    case 'start': {
      const { handleStart } = await import('@/cli/handlers/start');
      await handleStart(rest);
      break;
    }

    case 'stop': {
      const { handleStop } = await import('@/cli/handlers/simple');
      await handleStop(rest);
      break;
    }

    case 'resume': {
      const { handleResume } = await import('@/cli/handlers/resume');
      await handleResume(rest);
      break;
    }

    case 'multi': {
      const { handleMulti } = await import('@/cli/handlers/multi');
      await handleMulti(rest);
      break;
    }

    case 'status': {
      const { handleStatus } = await import('@/cli/handlers/status');
      await handleStatus();
      break;
    }

    case 'logs': {
      const { handleLogs } = await import('@/cli/handlers/simple');
      await handleLogs(rest);
      break;
    }

    case 'upgrade':
    case 'update': {
      const { handleUpgrade } = await import('@/cli/handlers/simple');
      await handleUpgrade(rest);
      break;
    }

    case 'daemon': {
      const { handleDaemonCommand } = await import('@/cli/handlers/simple');
      await handleDaemonCommand(rest);
      break;
    }

    case 'doctor': {
      const { handleDoctor } = await import('@/cli/handlers/simple');
      await handleDoctor();
      break;
    }

    case 'costs': {
      const { handleCosts } = await import('@/cli/handlers/costs');
      await handleCosts(rest);
      break;
    }

    case 'template':
    case 'templates': {
      const { handleTemplateCommand } = await import('@/cli/handlers/simple');
      await handleTemplateCommand(rest);
      break;
    }

    case 'export': {
      const { handleExportCommand } = await import('@/cli/handlers/simple');
      await handleExportCommand(rest);
      break;
    }

    case 'import': {
      const { handleImportCommand } = await import('@/cli/handlers/simple');
      await handleImportCommand(rest);
      break;
    }

    case 'checkpoint':
    case 'cp': {
      const { handleCheckpointCommand } = await import('@/cli/handlers/simple');
      await handleCheckpointCommand(rest);
      break;
    }

    case 'privacy': {
      const { handlePrivacyCommand } = await import('@/cli/handlers/simple');
      await handlePrivacyCommand(rest);
      break;
    }

    case 'export-data': {
      const { handleExportDataCommand } = await import('@/cli/handlers/simple');
      await handleExportDataCommand(rest);
      break;
    }

    case 'delete-account': {
      const { handleDeleteAccountCommand } = await import('@/cli/handlers/simple');
      await handleDeleteAccountCommand(rest);
      break;
    }

    case 'mcp': {
      const { handleMcpCommand } = await import('@/cli/handlers/simple');
      await handleMcpCommand(rest);
      break;
    }

    case 'context': {
      const { handleContextCommand } = await import('@/cli/handlers/simple');
      await handleContextCommand(rest);
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      const { printHelp } = await import('@/cli/helpScreen');
      printHelp();
      break;
    }

    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;

    default: {
      logger.error(`Unknown command: ${command}`);
      const { printHelp } = await import('@/cli/helpScreen');
      printHelp();
      process.exit(1);
    }
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
    const { runOnboard, parseOnboardArgs } = await import('@/commands/onboard');
    // WHY (Phase 1.6.5): bare `styrby` is the single-command bootstrap →
    // pair → first session. We must NOT skipPairing here, otherwise the user
    // never sees the QR and has no phone connection. `runBareOrShorthand` only
    // calls runOnboard when !isAuthenticated(), so this path is first-run only.
    //
    // WHY parse argv here too (ESC-1): bare `styrby --browser` should reach
    // the auto-onboard flow with the browser-OAuth path selected. Without
    // this forward, --browser would be silently dropped on the bare path.
    const onboardOpts = parseOnboardArgs(argv);
    const result = await runOnboard({ ...onboardOpts, skipPairing: false });
    if (!result.success) {
      process.exit(1);
    }
  }

  // Determine agent: shorthand > --agent flag > config default > claude
  const { buildStartArgs } = await import('@/cli/agentShorthand');
  const agentFromShorthand = isAgentShorthand(command) ? command : null;
  const configDefault = getConfigValue('defaultAgent');
  const startArgs = buildStartArgs(argv, agentFromShorthand, configDefault);

  const { handleStart } = await import('@/cli/handlers/start');
  await handleStart(startArgs);
}
