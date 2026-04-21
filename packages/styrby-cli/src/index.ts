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

import { logger } from '@/ui/logger';
import { runCommand } from '@/cli/commandRouter';

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
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  await runCommand(args);
}

// Run main
main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});
