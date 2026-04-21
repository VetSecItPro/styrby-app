/**
 * Thin command delegates.
 *
 * Each handler here does only the minimum pre-work (arg parsing, process.exit
 * on failure) and then forwards to the real implementation inside
 * `src/commands/*`. Keeping these shims in one file avoids creating a
 * near-empty module per command.
 *
 * WHY dynamic `import(...)`: lazy-loading each command module speeds up
 * CLI startup for commands that don't need every transport/agent wired up.
 *
 * @module cli/handlers/simple
 */

/**
 * Handle the `styrby onboard` command. Parses flags and exits non-zero
 * on failure — the `runOnboard` return shape dictates the exit semantics.
 *
 * @param args - Command arguments (`--force`, `--skip-pairing`, `--skip-doctor`).
 */
export async function handleOnboard(args: string[]): Promise<void> {
  const { runOnboard, parseOnboardArgs } = await import('@/commands/onboard');
  const options = parseOnboardArgs(args);
  const result = await runOnboard(options);

  if (!result.success) {
    process.exit(1);
  }
}

/**
 * Handle the `styrby install` command.
 * Installs AI coding agents (Claude Code, Codex, Gemini CLI, etc.).
 *
 * @param args - Command arguments (the agent name + optional flags).
 */
export async function handleInstall(args: string[]): Promise<void> {
  const { handleInstallCommand } = await import('@/commands/install-agent');
  await handleInstallCommand(args);
}

/**
 * Handle the `styrby auth` command.
 *
 * Re-runs the onboard flow with `skipPairing: true` so the user can
 * refresh credentials without regenerating a QR code.
 */
export async function handleAuth(): Promise<void> {
  const { runOnboard } = await import('@/commands/onboard');

  const result = await runOnboard({ skipPairing: true });

  if (!result.success) {
    process.exit(1);
  }
}

/**
 * Handle the `styrby stop` command. Stops the running daemon process.
 *
 * @param args - Command arguments.
 */
export async function handleStop(args: string[]): Promise<void> {
  const { handleStop: stop } = await import('@/commands/stop');
  await stop(args);
}

/**
 * Handle the `styrby logs` command. Views daemon logs, optionally following.
 *
 * @param args - Command arguments (`--follow`, `--lines N`).
 */
export async function handleLogs(args: string[]): Promise<void> {
  const { handleLogs: logs } = await import('@/commands/logs');
  await logs(args);
}

/**
 * Handle the `styrby upgrade` / `styrby update` command.
 * Checks for and installs CLI updates from npm.
 *
 * @param args - Command arguments (`--check` to only check).
 */
export async function handleUpgrade(args: string[]): Promise<void> {
  const { handleUpgrade: upgrade } = await import('@/commands/upgrade');
  await upgrade(args);
}

/**
 * Handle the `styrby daemon` command.
 * Manages daemon auto-start on boot (install/uninstall/status).
 *
 * @param args - Command arguments (`install`, `uninstall`, `status`).
 */
export async function handleDaemonCommand(args: string[]): Promise<void> {
  const { handleDaemon } = await import('@/commands/daemon');
  await handleDaemon(args);
}

/**
 * Handle the `styrby doctor` command. Runs diagnostic health checks.
 *
 * Exits with status 0 if all checks pass, 1 otherwise.
 */
export async function handleDoctor(): Promise<void> {
  const { runDoctor } = await import('@/ui/doctor');
  const success = await runDoctor();
  process.exit(success ? 0 : 1);
}

/**
 * Handle the `styrby template` / `styrby templates` command family.
 * Manages context templates stored in Supabase.
 *
 * @param args - Command arguments (subcommand: list, create, show, use, delete).
 */
export async function handleTemplateCommand(args: string[]): Promise<void> {
  const { handleTemplate } = await import('@/commands/template');
  await handleTemplate(args);
}

/**
 * Handle the `styrby export` command.
 * Exports one or all sessions as portable JSON.
 *
 * @param args - Command arguments (sessionId, `--all`, `--output`, `--compact`).
 */
export async function handleExportCommand(args: string[]): Promise<void> {
  const { handleExport } = await import('@/commands/export');
  await handleExport(args);
}

/**
 * Handle the `styrby import` command.
 * Imports a session from a previously exported JSON file.
 *
 * @param args - Command arguments (`<file>`).
 */
export async function handleImportCommand(args: string[]): Promise<void> {
  const { handleImport } = await import('@/commands/export');
  await handleImport(args);
}

/**
 * Handle the `styrby checkpoint` / `styrby cp` command.
 * Save, list, restore, and delete named session checkpoints.
 *
 * @param args - Command arguments (`save` | `list` | `restore` | `delete`).
 */
export async function handleCheckpointCommand(args: string[]): Promise<void> {
  const { handleCheckpointCommand: checkpoint } = await import('@/commands/checkpoint');
  await checkpoint(args);
}

/**
 * Handle the `styrby mcp` command family.
 *
 * Currently exposes `mcp serve` to spawn the MCP stdio server. See
 * commands/mcpServe.ts for setup-config examples and tool catalog.
 *
 * @param args - Command arguments (subcommand + options).
 */
export async function handleMcpCommand(args: string[]): Promise<void> {
  const { handleMcpCommand: mcp } = await import('@/commands/mcpServe');
  await mcp(args);
}
