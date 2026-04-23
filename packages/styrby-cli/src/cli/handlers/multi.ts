/**
 * `styrby multi` command handler.
 *
 * Spawns N concurrent agent sessions tied to a single session group,
 * streams all agent output to the terminal with colored per-agent prefixes,
 * and gracefully kills all agents on Ctrl+C or SIGTERM.
 *
 * Usage:
 *   styrby multi --agents claude,codex,gemini --prompt "refactor auth middleware"
 *   styrby multi --agents claude,codex --project /path/to/project
 *   styrby multi --agents claude,codex --dry-run
 *
 * Flags:
 *   --agents, -a   Comma-separated list of agent IDs (required)
 *   --prompt, -p   Initial prompt sent to all agents after spawn (optional)
 *   --project      Working directory override (defaults to cwd)
 *   --name         Human-readable group name override
 *   --dry-run      Validate config, create group record, then exit without
 *                  spawning agents (for testing arg parsing)
 *
 * Exit codes:
 *   0  Normal shutdown (Ctrl+C, SIGTERM, or all agents completed)
 *   1  Authentication error / Supabase connection failure
 *   2  Invalid arguments (unknown agent, too many agents, etc.)
 *
 * WHY per-agent color prefixes:
 *   Without visual differentiation, output from 3 concurrent agents would be
 *   impossible to follow. A leading colored [agentId] tag lets developers
 *   quickly correlate each line to its source agent without toggling focus.
 *
 * WHY process group kill on Ctrl+C:
 *   Agent processes (Claude Code, Codex, Gemini CLI) are child processes.
 *   Sending SIGTERM only to the Node parent leaves them running as orphans
 *   consuming tokens. The MultiAgentOrchestrator registers an 'exit' handler
 *   to SIGTERM all tracked child PIDs when the parent exits — covering
 *   Ctrl+C, SIGTERM, and unhandled promise rejections.
 *
 * @module cli/handlers/multi
 */

import { logger } from '@/ui/logger';
import type { AgentId } from '@/agent/core/AgentBackend';

// ============================================================================
// Valid agents list (mirrors AgentId in AgentBackend.ts)
// ============================================================================

/**
 * All agent IDs accepted by `styrby multi --agents`.
 * WHY explicit list (not inferred from AgentId type): the type lives in a
 * different package and we need a runtime-checkable array for CLI validation.
 */
const VALID_AGENT_IDS: AgentId[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'aider',
  'goose',
  'amp',
  'crush',
  'kilo',
  'kiro',
  'droid',
];

// ============================================================================
// Argument parsing
// ============================================================================

/**
 * Parsed result of the `styrby multi` CLI arguments.
 */
interface MultiArgs {
  /** Agent IDs to spawn */
  agentIds: AgentId[];
  /** Working directory */
  projectPath: string;
  /** Initial prompt (optional) */
  prompt: string | undefined;
  /** Group name override (optional) */
  groupName: string | undefined;
  /** Dry-run mode — no agents spawned */
  dryRun: boolean;
}

/**
 * Parse and validate `styrby multi` CLI arguments.
 *
 * @param args - Raw argv after the `multi` keyword
 * @returns Parsed MultiArgs
 * @throws {ParseError} When required flags are missing or invalid
 */
function parseMultiArgs(args: string[]): MultiArgs {
  let agentList: string | undefined;
  let projectPath = process.cwd();
  let prompt: string | undefined;
  let groupName: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case '--agents':
      case '-a':
        agentList = args[++i];
        break;
      case '--prompt':
      case '-p':
        prompt = args[++i];
        break;
      case '--project':
        projectPath = args[++i] || process.cwd();
        break;
      case '--name':
        groupName = args[++i];
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        // Unknown flag — ignore silently so future flags don't break older
        // installed CLIs (forward-compatible flag parsing).
        break;
    }
  }

  if (!agentList) {
    throw new ParseError('--agents is required. Example: --agents claude,codex,gemini');
  }

  const agentIds = agentList
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean) as AgentId[];

  if (agentIds.length === 0) {
    throw new ParseError('--agents list is empty');
  }

  for (const id of agentIds) {
    if (!VALID_AGENT_IDS.includes(id)) {
      throw new ParseError(
        `Unknown agent: "${id}". Supported agents: ${VALID_AGENT_IDS.join(', ')}`
      );
    }
  }

  const { resolve } = require('path') as typeof import('path');
  projectPath = resolve(projectPath);

  return { agentIds, projectPath, prompt, groupName, dryRun };
}

/**
 * Structured parse error for argument validation failures.
 * Caught by handleMulti to print a user-facing message and exit(2).
 */
class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle the `styrby multi` command.
 *
 * @param args - Raw CLI arguments after the `multi` keyword
 * @returns Promise that resolves when all agent sessions have ended
 */
export async function handleMulti(args: string[]): Promise<void> {
  const chalk = (await import('chalk')).default;
  const os = await import('os');
  const { createClient } = await import('@supabase/supabase-js');

  // ── Parse arguments ───────────────────────────────────────────────────────
  let parsed: MultiArgs;
  try {
    parsed = parseMultiArgs(args);
  } catch (error) {
    if (error instanceof ParseError) {
      console.log(chalk.red(`\nArgument error: ${error.message}\n`));
      console.log('Usage: styrby multi --agents claude,codex,gemini --prompt "your task"\n');
      process.exit(2);
    }
    throw error;
  }

  const { agentIds, projectPath, prompt, groupName, dryRun } = parsed;

  console.log('');
  console.log(chalk.bold('Styrby Multi-Agent Mode'));
  console.log(chalk.gray(`Agents:  ${agentIds.join(', ')}`));
  console.log(chalk.gray(`Project: ${projectPath}`));
  if (prompt) {
    console.log(chalk.gray(`Prompt:  ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`));
  }
  if (dryRun) {
    console.log(chalk.yellow('\n[dry-run] Validating configuration...'));
  }
  console.log('');

  // ── Authentication ─────────────────────────────────────────────────────────
  const { loadPersistedData } = await import('@/persistence');
  const data = loadPersistedData();

  if (!data?.userId || !data?.accessToken) {
    console.log(chalk.red('\nNot authenticated.'));
    console.log('Run ' + chalk.cyan('styrby onboard') + ' to authenticate.\n');
    process.exit(1);
  }

  const machineId = data.machineId || `machine_${crypto.randomUUID()}`;
  const deviceName = os.hostname();

  // ── Supabase client ────────────────────────────────────────────────────────
  const { config: envConfig } = await import('@/env');

  const supabase = createClient(envConfig.supabaseUrl, envConfig.supabaseAnonKey!, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    },
  });

  // ── Relay connection ───────────────────────────────────────────────────────
  const { StyrbyApi } = await import('@/api/api');
  const apiClient = new StyrbyApi();

  apiClient.configure({
    supabase,
    userId: data.userId,
    machineId,
    machineName: deviceName,
    debug: process.env.STYRBY_LOG_LEVEL === 'debug',
  });

  try {
    await apiClient.connect();
  } catch (error) {
    console.log(chalk.red('\nFailed to connect to relay.'));
    console.log('Check your internet connection and try again.');
    if (error instanceof Error) {
      logger.debug('Relay connection error', { message: error.message });
    }
    process.exit(1);
  }

  console.log(chalk.green('Connected to relay.'));

  // ── Spawn agents via orchestrator ─────────────────────────────────────────
  const { MultiAgentOrchestrator } = await import('@/agent/multiAgentOrchestrator');
  const orchestrator = new MultiAgentOrchestrator();

  let group: import('@/agent/multiAgentOrchestrator').MultiAgentGroup;

  try {
    group = await orchestrator.start({
      supabase,
      api: apiClient,
      agentIds,
      projectPath,
      userId: data.userId,
      machineId,
      prompt,
      groupName,
      dryRun,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`\nFailed to start agents: ${msg}\n`));
    await apiClient.disconnect();
    process.exit(1);
  }

  if (dryRun) {
    console.log(chalk.green('\n[dry-run] Configuration is valid. Exiting without spawning agents.\n'));
    await apiClient.disconnect();
    return;
  }

  // Print running session IDs so operators can reference them
  console.log(chalk.bold.green(`\nAll ${agentIds.length} agents started (group: ${group.groupId.slice(0, 8)}...)\n`));
  for (const agent of group.agents) {
    console.log(
      `  ${agent.color}[${agent.agentId}]\x1b[0m  session: ${chalk.gray(agent.sessionId.slice(0, 8))}...`
    );
  }
  console.log('');
  console.log('Output from all agents is interleaved below (prefixed by [agentId]).');
  console.log('Press ' + chalk.cyan('Ctrl+C') + ' to stop all agents.\n');

  // ── Wait for shutdown ──────────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  console.log(chalk.gray('\nShutting down all agents...'));

  await group.stop();
  await apiClient.disconnect();

  console.log(chalk.green('\nAll agents stopped.\n'));
}
