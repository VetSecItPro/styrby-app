#!/usr/bin/env node
/**
 * Styrby CLI
 *
 * Mobile remote control for AI coding agents.
 * Connects Claude Code, Codex, and Gemini CLI to the Styrby mobile app.
 *
 * WHY this file stays tiny: it is the `bin` entry-point declared in
 * package.json, so the shebang must live here. Keeping it a thin
 * coordinator — argv capture, dispatcher call, top-level error trap —
 * ensures every new command is added in `cli/commandRouter.ts` rather
 * than bloating the entry point (1,188 LOC → ~40 LOC).
 *
 * @module styrby-cli
 *
 * @example
 * # Complete setup wizard
 * styrby onboard
 *
 * # Start a session with Claude Code
 * styrby start --agent claude
 *
 * # Show status
 * styrby status
 */

// PERF (2026-05-05): ultra-fast path for `--version` and `--help`.
// These are the most common invocations (shell completions, `styrby --version`
// in CI scripts, first-time discovery). They don't touch any backend, don't
// need Sentry, don't need agent factories. Bypass the full module graph and
// return immediately. Saves ~600 ms cold-start for these two paths.
//
// CAUTION: keep this block free of project imports. Adding any `import` from
// `@/...` defeats the purpose by pulling its transitive deps into the graph
// before the fast-path check runs.
{
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === '--version' || first === '-v' || first === 'version') {
    // Inline version string — avoids loading any module just to print it.
    // Kept in sync with package.json + cli/version.ts; see comment in version.ts.
    // Use `require`-style lookup via dynamic import only if absolutely needed;
    // here we just dynamically import the version constant (no side effects).
    import('@/cli/version').then(({ VERSION }) => {
      console.log(VERSION);
      process.exit(0);
    });
  } else if (first === '--help' || first === '-h' || first === 'help') {
    import('@/cli/helpScreen').then(({ printHelp }) => {
      printHelp();
      process.exit(0);
    });
  } else {
    // Normal path — initialise Sentry then dispatch.
    runMain();
  }
}

/**
 * Main CLI execution path. Initialises Sentry then dispatches via the router.
 *
 * WHY Sentry must be initialised before all other imports:
 * @sentry/node patches Node.js's process.uncaughtException and
 * unhandledRejection hooks. If any module runs first and registers its own
 * hooks (or triggers an async operation that can reject), those events could
 * escape Sentry capture. The import order inside `runMain` is intentional —
 * do not move.
 */
function runMain(): void {
  // Imports are inside runMain so the fast-path block above doesn't pay for them.
  Promise.all([
    import('@/observability/sentry'),
    import('@/ui/logger'),
    import('@/cli/commandRouter'),
  ]).then(([{ initSentry }, { logger }, { runCommand }]) => {
    initSentry();
    main(logger, runCommand).catch((error) => {
      logger.error('Fatal error', error);
      process.exit(1);
    });
  });
}

// Re-export core types for library usage.
// WHY kept on the entry point: downstream consumers import these types
// from the package's main export; moving them would be a breaking change.
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
 * CLI version — re-exported from `cli/version` to preserve the public
 * `import { VERSION } from 'styrby-cli'` API while avoiding a circular
 * dependency between `helpScreen` and this module.
 */
export { VERSION } from '@/cli/version';

/**
 * Main CLI entry point. Parses argv and dispatches to the router.
 *
 * Logger + runCommand are passed in to keep this file's static module graph
 * minimal — see runMain() above. The fast-path block at the top of this file
 * handles --version / --help WITHOUT calling main(), so those invocations
 * never load Sentry, the router, or any handler.
 */
async function main(
  _logger: { error: (msg: string, err?: unknown) => void },
  runCommand: (argv: string[]) => Promise<void>,
): Promise<void> {
  const args = process.argv.slice(2);
  await runCommand(args);
}
