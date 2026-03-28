/**
 * Cloud Task Command Handler
 *
 * Implements the `styrby cloud` subcommands for submitting and monitoring
 * asynchronous agent tasks that run in the cloud (or via the relay channel).
 *
 * ## Subcommands
 *
 * ```
 * styrby cloud submit "<prompt>" [--agent claude] [--session <id>]
 *   Submit an async prompt to an AI agent and return immediately.
 *   The task runs asynchronously. Use `styrby cloud status <id>` to check.
 *
 * styrby cloud status [taskId]
 *   Print the current status (and result) of a specific task.
 *   Without a taskId, shows the most recently submitted task.
 *
 * styrby cloud list [--limit 10] [--status running]
 *   List recent cloud tasks, optionally filtered by status.
 *
 * styrby cloud cancel <taskId>
 *   Cancel a queued or running task.
 * ```
 *
 * ## Workflow
 *
 * 1. `submit` creates a row in `cloud_tasks` (Supabase) with status='queued'
 * 2. The relay infrastructure picks up the task and runs the agent
 * 3. Status updates flow through Supabase Realtime to mobile + web
 * 4. Push notification fires when status transitions to 'completed' or 'failed'
 * 5. `status` and `list` read directly from Supabase
 *
 * @module commands/cloud
 */

import chalk from 'chalk';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';
import { loadPersistedData } from '@/persistence';
import { config as envConfig } from '@/env';
import type { CloudTask, CloudTaskStatus, AgentType } from 'styrby-shared';

// ============================================================================
// Options
// ============================================================================

/**
 * Parsed options for `styrby cloud submit`.
 */
export interface CloudSubmitOptions {
  /** The prompt to execute asynchronously */
  prompt: string;
  /** Which agent to use for this task */
  agentType: AgentType;
  /** Optional session ID to associate the task with */
  sessionId?: string;
  /** Optional estimated duration hint in milliseconds */
  estimatedDurationMs?: number;
}

/**
 * Parsed options for `styrby cloud list`.
 */
export interface CloudListOptions {
  /** Maximum number of tasks to show */
  limit: number;
  /** Filter by task status (all statuses if omitted) */
  status?: CloudTaskStatus;
}

/**
 * Result returned by `submitCloudTask`.
 */
export interface CloudSubmitResult {
  /** Whether the submission succeeded */
  success: boolean;
  /** The created task, populated on success */
  task?: CloudTask;
  /** Error message, populated on failure */
  error?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates an authenticated Supabase client from CLI persisted credentials.
 *
 * WHY: The CLI stores the user's Supabase access token and refresh token
 * locally (via `loadPersistedData`). We reconstruct a Supabase client from
 * these tokens rather than requiring the user to re-authenticate.
 *
 * @returns Authenticated SupabaseClient, or null if not authenticated
 */
async function getAuthenticatedClient(): Promise<SupabaseClient | null> {
  const persisted = await loadPersistedData();

  if (!persisted?.accessToken) {
    logger.error('Not authenticated. Run `styrby onboard` to sign in.');
    return null;
  }

  const client = createClient(
    envConfig.supabaseUrl,
    envConfig.supabaseAnonKey
  );

  const { error } = await client.auth.setSession({
    access_token: persisted.accessToken,
    refresh_token: persisted.refreshToken ?? '',
  });

  if (error) {
    logger.error('Session restoration failed:', error.message);
    return null;
  }

  return client;
}

/**
 * Maps a raw Supabase cloud_tasks row to the typed CloudTask interface.
 *
 * @param row - Raw row from the cloud_tasks table
 * @returns Typed CloudTask object
 */
function rowToTask(row: Record<string, unknown>): CloudTask {
  return {
    id: row.id as string,
    sessionId: (row.session_id as string | null) ?? null,
    agentType: row.agent_type as AgentType,
    status: row.status as CloudTaskStatus,
    prompt: row.prompt as string,
    result: row.result as string | undefined,
    errorMessage: row.error_message as string | undefined,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | undefined,
    estimatedDurationMs: row.estimated_duration_ms as number | undefined,
    costUsd: row.cost_usd as number | undefined,
    metadata: row.metadata as CloudTask['metadata'],
  };
}

/**
 * Returns the chalk-colored status label for a cloud task status.
 *
 * @param status - The CloudTaskStatus to format
 * @returns Chalk-colored string
 */
function formatStatus(status: CloudTaskStatus): string {
  switch (status) {
    case 'queued':    return chalk.yellow('queued');
    case 'running':   return chalk.blue('running');
    case 'completed': return chalk.green('completed');
    case 'failed':    return chalk.red('failed');
    case 'cancelled': return chalk.gray('cancelled');
  }
}

/**
 * Formats a cost value as a USD string.
 *
 * @param costUsd - Cost in USD, may be undefined or null (from DB NULL columns)
 * @returns Formatted string like "$0.0042" or "" when unknown/null
 */
function formatCost(costUsd?: number | null): string {
  // WHY: Supabase returns NULL DB columns as null (not undefined). Guard both
  // to avoid calling .toFixed() on null which throws TypeError.
  return costUsd != null ? chalk.green(`$${costUsd.toFixed(4)}`) : '';
}

/**
 * Formats an ISO 8601 timestamp as a short human-readable string.
 *
 * @param iso - ISO 8601 timestamp
 * @returns Formatted string like "2 min ago" or "5 hrs ago"
 */
function formatAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${diffHr}h ago`;
}

// ============================================================================
// Submit
// ============================================================================

/**
 * Submits an asynchronous prompt to an AI agent as a cloud task.
 *
 * Creates a row in the `cloud_tasks` Supabase table with status='queued'.
 * The Styrby relay infrastructure picks up queued tasks and runs them.
 *
 * @param options - Submission options (prompt, agentType, sessionId)
 * @returns Result indicating success/failure with the created task
 *
 * @example
 * const result = await submitCloudTask({
 *   prompt: 'Write unit tests for src/auth.ts',
 *   agentType: 'claude',
 * });
 * if (result.success) {
 *   console.log('Task ID:', result.task.id);
 * }
 */
export async function submitCloudTask(options: CloudSubmitOptions): Promise<CloudSubmitResult> {
  const supabase = await getAuthenticatedClient();
  if (!supabase) {
    return { success: false, error: 'Not authenticated' };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: 'Could not retrieve user from session' };
  }

  const { data, error } = await supabase
    .from('cloud_tasks')
    .insert({
      user_id: user.id,
      session_id: options.sessionId ?? null,
      agent_type: options.agentType,
      status: 'queued',
      prompt: options.prompt,
      estimated_duration_ms: options.estimatedDurationMs ?? null,
      started_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error || !data) {
    return { success: false, error: error?.message ?? 'Insert failed' };
  }

  return { success: true, task: rowToTask(data as Record<string, unknown>) };
}

/**
 * CLI handler for `styrby cloud submit`.
 *
 * Prints a success message with the task ID and instructions for checking
 * status, then exits without waiting for completion.
 *
 * @param prompt - The agent prompt to submit
 * @param flags - Parsed CLI flags (--agent, --session)
 * @returns Exit code (0 success, 1 failure)
 */
export async function handleCloudSubmit(
  prompt: string,
  flags: { agent?: string; session?: string }
): Promise<number> {
  if (!prompt.trim()) {
    logger.error('Prompt is required. Usage: styrby cloud submit "<prompt>"');
    return 1;
  }

  const agentType = (flags.agent as AgentType | undefined) ?? 'claude';
  const validAgents: AgentType[] = ['claude', 'codex', 'gemini', 'opencode', 'aider', 'goose', 'amp', 'crush', 'kilo', 'kiro', 'droid'];

  if (!validAgents.includes(agentType)) {
    logger.error(
      `Invalid agent "${agentType}". Valid options: ${validAgents.join(', ')}`
    );
    return 1;
  }

  logger.info(chalk.gray('Submitting task to cloud queue...'));

  const result = await submitCloudTask({
    prompt: prompt.trim(),
    agentType,
    sessionId: flags.session,
  });

  if (!result.success || !result.task) {
    logger.error(`Failed to submit task: ${result.error}`);
    return 1;
  }

  console.log('');
  console.log(chalk.green('✓') + ' Task submitted to cloud queue');
  console.log('');
  console.log('  ' + chalk.bold('Task ID:') + '  ' + chalk.cyan(result.task.id));
  console.log('  ' + chalk.bold('Agent:') + '    ' + result.task.agentType);
  console.log('  ' + chalk.bold('Status:') + '   ' + formatStatus(result.task.status));
  console.log('');
  console.log(chalk.gray('  Check status:  ') + chalk.white(`styrby cloud status ${result.task.id}`));
  console.log(chalk.gray('  List all:      ') + chalk.white('styrby cloud list'));
  console.log('');

  return 0;
}

// ============================================================================
// Status
// ============================================================================

/**
 * Fetches and prints the current status of a specific cloud task.
 *
 * @param taskId - The cloud task UUID to look up
 * @returns Exit code (0 success, 1 failure)
 *
 * @example
 * // styrby cloud status abc-123
 * await handleCloudStatus('abc-123');
 */
export async function handleCloudStatus(taskId: string): Promise<number> {
  if (!taskId.trim()) {
    logger.error('Task ID is required. Usage: styrby cloud status <taskId>');
    return 1;
  }

  const supabase = await getAuthenticatedClient();
  if (!supabase) return 1;

  const { data, error } = await supabase
    .from('cloud_tasks')
    .select('*')
    .eq('id', taskId.trim())
    .single();

  if (error || !data) {
    logger.error(`Task not found: ${taskId}`);
    return 1;
  }

  const task = rowToTask(data as Record<string, unknown>);

  console.log('');
  console.log(chalk.bold('Cloud Task Status'));
  console.log(chalk.gray('─────────────────────────────'));
  console.log('  ' + chalk.bold('ID:') + '     ' + chalk.cyan(task.id));
  console.log('  ' + chalk.bold('Agent:') + '  ' + task.agentType);
  console.log('  ' + chalk.bold('Status:') + ' ' + formatStatus(task.status));
  console.log('  ' + chalk.bold('Age:') + '    ' + formatAge(task.startedAt));

  if (task.metadata?.gitBranch) {
    console.log('  ' + chalk.bold('Branch:') + ' ' + task.metadata.gitBranch);
  }

  if (task.costUsd !== undefined) {
    console.log('  ' + chalk.bold('Cost:') + '   ' + formatCost(task.costUsd));
  }

  console.log('');
  console.log(chalk.gray('Prompt:'));
  console.log('  ' + task.prompt);

  if (task.status === 'completed' && task.result) {
    console.log('');
    console.log(chalk.green('Result:'));
    // WHY: Indent each result line for clean terminal output
    task.result.split('\n').forEach((line) => console.log('  ' + line));
  }

  if (task.status === 'failed' && task.errorMessage) {
    console.log('');
    console.log(chalk.red('Error:'));
    console.log('  ' + task.errorMessage);
  }

  console.log('');
  return 0;
}

// ============================================================================
// List
// ============================================================================

/**
 * Fetches and prints a formatted list of recent cloud tasks.
 *
 * @param options - List options (limit, status filter)
 * @returns Exit code (0 success, 1 failure)
 *
 * @example
 * // styrby cloud list --limit 5 --status running
 * await handleCloudList({ limit: 5, status: 'running' });
 */
export async function handleCloudList(options: CloudListOptions): Promise<number> {
  const supabase = await getAuthenticatedClient();
  if (!supabase) return 1;

  let query = supabase
    .from('cloud_tasks')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(options.limit);

  if (options.status) {
    query = query.eq('status', options.status);
  }

  const { data, error } = await query;

  if (error) {
    logger.error(`Failed to list tasks: ${error.message}`);
    return 1;
  }

  const tasks = (data ?? []).map((row) => rowToTask(row as Record<string, unknown>));

  if (tasks.length === 0) {
    console.log('');
    console.log(chalk.gray('  No cloud tasks found.'));
    console.log(chalk.gray('  Run: ') + chalk.white('styrby cloud submit "<prompt>"'));
    console.log('');
    return 0;
  }

  console.log('');
  console.log(chalk.bold(`Cloud Tasks (${tasks.length})`));
  console.log(chalk.gray('─────────────────────────────────────────────────────'));

  for (const task of tasks) {
    const statusLabel = formatStatus(task.status);
    const costStr = formatCost(task.costUsd);
    const ageStr = chalk.gray(formatAge(task.startedAt));
    const agentStr = chalk.gray(`[${task.agentType}]`);
    const promptPreview = task.prompt.length > 60
      ? task.prompt.slice(0, 57) + '...'
      : task.prompt;

    console.log(
      `  ${chalk.cyan(task.id.slice(0, 8))}  ${statusLabel.padEnd(20)}  ${agentStr.padEnd(15)}  ${ageStr}`
    );
    console.log(`             ${chalk.white(promptPreview)}`);
    if (costStr) {
      console.log(`             Cost: ${costStr}`);
    }
    console.log('');
  }

  return 0;
}

// ============================================================================
// Cancel
// ============================================================================

/**
 * Cancels a queued or running cloud task.
 *
 * Sets the task status to 'cancelled' in Supabase. The relay infrastructure
 * monitors for cancellations and terminates the agent execution.
 *
 * @param taskId - UUID of the task to cancel
 * @returns Exit code (0 success, 1 failure)
 *
 * @example
 * // styrby cloud cancel abc-123
 * await handleCloudCancel('abc-123');
 */
export async function handleCloudCancel(taskId: string): Promise<number> {
  if (!taskId.trim()) {
    logger.error('Task ID is required. Usage: styrby cloud cancel <taskId>');
    return 1;
  }

  const supabase = await getAuthenticatedClient();
  if (!supabase) return 1;

  // First verify the task exists and is in a cancellable state
  const { data: existing, error: fetchError } = await supabase
    .from('cloud_tasks')
    .select('id, status')
    .eq('id', taskId.trim())
    .single();

  if (fetchError || !existing) {
    logger.error(`Task not found: ${taskId}`);
    return 1;
  }

  const currentStatus = existing.status as CloudTaskStatus;
  const cancellableStatuses: CloudTaskStatus[] = ['queued', 'running'];

  if (!cancellableStatuses.includes(currentStatus)) {
    logger.error(
      `Cannot cancel task with status "${currentStatus}". Only queued or running tasks can be cancelled.`
    );
    return 1;
  }

  const { error } = await supabase
    .from('cloud_tasks')
    .update({
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    })
    .eq('id', taskId.trim());

  if (error) {
    logger.error(`Failed to cancel task: ${error.message}`);
    return 1;
  }

  console.log('');
  console.log(chalk.green('✓') + ' Task cancelled: ' + chalk.cyan(taskId.slice(0, 8)));
  console.log('');
  return 0;
}

// ============================================================================
// Command Dispatcher
// ============================================================================

/**
 * Main dispatcher for `styrby cloud` subcommands.
 *
 * Routes the provided subcommand to the appropriate handler function.
 *
 * @param subcommand - The cloud subcommand (submit | status | list | cancel)
 * @param args - Positional arguments after the subcommand
 * @param flags - Parsed CLI flags
 * @returns Exit code
 *
 * @example
 * // Dispatched from the main CLI entry point
 * const code = await dispatchCloudCommand(
 *   'submit',
 *   ['Write tests for auth.ts'],
 *   { agent: 'claude' }
 * );
 */
export async function dispatchCloudCommand(
  subcommand: string,
  args: string[],
  flags: Record<string, string | number | boolean | undefined>
): Promise<number> {
  switch (subcommand) {
    case 'submit':
      return handleCloudSubmit(
        args[0] ?? '',
        { agent: flags.agent as string | undefined, session: flags.session as string | undefined }
      );

    case 'status':
      return handleCloudStatus(args[0] ?? '');

    case 'list':
      return handleCloudList({
        limit: Math.min(50, Math.max(1, Number(flags.limit ?? 10))),
        status: flags.status as CloudTaskStatus | undefined,
      });

    case 'cancel':
      return handleCloudCancel(args[0] ?? '');

    default:
      logger.error(
        `Unknown cloud subcommand: "${subcommand}"\n\n` +
        'Usage:\n' +
        '  styrby cloud submit "<prompt>" [--agent claude]\n' +
        '  styrby cloud status <taskId>\n' +
        '  styrby cloud list [--limit 10] [--status running]\n' +
        '  styrby cloud cancel <taskId>'
      );
      return 1;
  }
}
