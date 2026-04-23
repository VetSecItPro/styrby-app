/**
 * Context Command Handler (Phase 3.5)
 *
 * Implements `styrby context` subcommands for cross-agent context sync:
 *
 * ```
 * styrby context show --group <groupId>       Dump memory as markdown + file_refs JSON
 * styrby context sync --group <groupId>       Recompute memory from recent session messages
 * styrby context export --session <sessionId> Extract memory from a single session
 * styrby context import --session <target> --from <source>  Inject another session's memory
 * ```
 *
 * ## WHY
 *
 * When a user switches from Claude Code to Codex mid-task, Codex starts cold —
 * no knowledge of what was being worked on, which files were touched, or what
 * the last conversation was about. `styrby context` commands let users inspect,
 * refresh, and transplant context memory so the new agent hits the ground running.
 *
 * The "magic" happens automatically on focus change (POST /api/sessions/groups/[id]/focus),
 * but these CLI commands give power users fine-grained control and visibility.
 *
 * ## Security
 *
 * - All context is scrubbed by the Phase 3.3 scrub engine before storing or printing.
 * - Session group membership is verified server-side (RLS + explicit user_id check).
 * - Optimistic locking prevents concurrent sync races from silently clobbering each other.
 * - The `--from` source session must belong to the same authenticated user (server enforces).
 *
 * ## Token budget
 *
 * The `--budget` flag on `sync` is passed to the server but capped at 8000 server-side.
 * Passing a value above 8000 is silently clamped, not rejected, to avoid breaking
 * scripts that set a large budget assuming "unlimited".
 *
 * @module commands/context
 */

import chalk from 'chalk';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';
import { loadPersistedData } from '@/persistence';
import { config as envConfig } from '@/env';
import {
  summarize,
  buildInjectionPrompt,
  TOKEN_BUDGET_DEFAULT,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
} from '@styrby/shared/context-sync';
import type {
  AgentContextMemory,
  SummarizerInputMessage,
  ContextShowOptions,
  ContextSyncOptions,
  ContextExportOptions,
  ContextImportOptions,
} from '@styrby/shared/context-sync';

// ============================================================================
// Constants
// ============================================================================

/**
 * UUID v4 validation regex for group and session IDs.
 *
 * WHY (SEC-PATH-003): IDs are used in Supabase `.eq('id', id)` queries.
 * Restricting to UUID format prevents unexpected query shapes from user input
 * that might contain SQL special characters.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maximum number of recent messages fetched from the DB for sync.
 *
 * WHY 40 not 20: We fetch 40 so the summarizer has a larger pool to extract
 * file refs from. The summarizer itself caps the output at CONTEXT_MESSAGE_LIMIT (20).
 * More input → better file ref signal → better context quality.
 */
const SYNC_FETCH_MESSAGE_LIMIT = 40;

// ============================================================================
// Arg parsing
// ============================================================================

/**
 * Parses `styrby context show` arguments.
 *
 * ```
 * styrby context show --group <groupId> [--json]
 * ```
 *
 * @param args - Arguments after `context show`.
 * @returns Parsed options, or null if --group is missing/invalid.
 */
export function parseContextShowArgs(args: string[]): ContextShowOptions | null {
  const groupIndex = args.indexOf('--group');
  if (groupIndex === -1 || !args[groupIndex + 1]) {
    logger.error('Usage: styrby context show --group <groupId>');
    return null;
  }

  const groupId = args[groupIndex + 1]!;
  if (!UUID_REGEX.test(groupId)) {
    logger.error('Error: --group must be a valid UUID');
    return null;
  }

  return {
    groupId,
    json: args.includes('--json'),
  };
}

/**
 * Parses `styrby context sync` arguments.
 *
 * ```
 * styrby context sync --group <groupId> [--budget <number>]
 * ```
 *
 * @param args - Arguments after `context sync`.
 * @returns Parsed options, or null if --group is missing/invalid.
 */
export function parseContextSyncArgs(args: string[]): ContextSyncOptions | null {
  const groupIndex = args.indexOf('--group');
  if (groupIndex === -1 || !args[groupIndex + 1]) {
    logger.error('Usage: styrby context sync --group <groupId> [--budget <number>]');
    return null;
  }

  const groupId = args[groupIndex + 1]!;
  if (!UUID_REGEX.test(groupId)) {
    logger.error('Error: --group must be a valid UUID');
    return null;
  }

  let tokenBudget: number | undefined;
  const budgetIndex = args.indexOf('--budget');
  if (budgetIndex !== -1 && args[budgetIndex + 1]) {
    const parsed = parseInt(args[budgetIndex + 1]!, 10);
    if (!isNaN(parsed)) {
      // Clamp to valid range (server does this too, but clamp early for UX)
      tokenBudget = Math.min(TOKEN_BUDGET_MAX, Math.max(TOKEN_BUDGET_MIN, parsed));
    }
  }

  return { groupId, tokenBudget };
}

/**
 * Parses `styrby context export` arguments.
 *
 * ```
 * styrby context export --session <sessionId> [--json]
 * ```
 *
 * @param args - Arguments after `context export`.
 * @returns Parsed options, or null if --session is missing/invalid.
 */
export function parseContextExportArgs(args: string[]): ContextExportOptions | null {
  const sessionIndex = args.indexOf('--session');
  if (sessionIndex === -1 || !args[sessionIndex + 1]) {
    logger.error('Usage: styrby context export --session <sessionId>');
    return null;
  }

  const sessionId = args[sessionIndex + 1]!;
  if (!UUID_REGEX.test(sessionId)) {
    logger.error('Error: --session must be a valid UUID');
    return null;
  }

  return {
    sessionId,
    json: args.includes('--json'),
  };
}

/**
 * Parses `styrby context import` arguments.
 *
 * ```
 * styrby context import --session <target> --from <source> [--task "description"]
 * ```
 *
 * @param args - Arguments after `context import`.
 * @returns Parsed options, or null if required flags are missing/invalid.
 */
export function parseContextImportArgs(args: string[]): ContextImportOptions | null {
  const sessionIndex = args.indexOf('--session');
  if (sessionIndex === -1 || !args[sessionIndex + 1]) {
    logger.error('Usage: styrby context import --session <target> --from <source>');
    return null;
  }

  const fromIndex = args.indexOf('--from');
  if (fromIndex === -1 || !args[fromIndex + 1]) {
    logger.error('Usage: styrby context import --session <target> --from <source>');
    return null;
  }

  const sessionId = args[sessionIndex + 1]!;
  const fromSessionId = args[fromIndex + 1]!;

  if (!UUID_REGEX.test(sessionId)) {
    logger.error('Error: --session must be a valid UUID');
    return null;
  }

  if (!UUID_REGEX.test(fromSessionId)) {
    logger.error('Error: --from must be a valid UUID');
    return null;
  }

  let task: string | undefined;
  const taskIndex = args.indexOf('--task');
  if (taskIndex !== -1 && args[taskIndex + 1]) {
    task = args[taskIndex + 1];
  }

  return { sessionId, fromSessionId, task };
}

// ============================================================================
// Supabase client factory
// ============================================================================

/**
 * Creates an authenticated Supabase client using the stored user token.
 *
 * WHY inline not imported from a shared helper:
 *   The CLI's Supabase client is constructed differently from the web's
 *   server-side client (cookie-based auth vs. stored token). Reusing the
 *   web helper would introduce a server-only import into the CLI bundle.
 *
 * @returns Authenticated SupabaseClient.
 * @throws {Error} When the user is not authenticated.
 */
function createAuthenticatedClient(): SupabaseClient {
  const persisted = loadPersistedData();
  if (!persisted?.accessToken) {
    throw new Error('Not authenticated. Run `styrby auth` first.');
  }

  const client = createClient(envConfig.supabaseUrl, envConfig.supabaseAnonKey, {
    global: {
      headers: { Authorization: `Bearer ${persisted.accessToken}` },
    },
    auth: { persistSession: false },
  });

  return client;
}

// ============================================================================
// DB helpers
// ============================================================================

/**
 * Fetches the context memory record for a session group.
 *
 * @param supabase - Authenticated Supabase client.
 * @param groupId - UUID of the session group.
 * @returns The memory record, or null if none exists yet.
 * @throws When the Supabase query itself errors (network, RLS denial, etc.)
 */
async function fetchContextMemory(
  supabase: SupabaseClient,
  groupId: string
): Promise<AgentContextMemory | null> {
  const { data, error } = await supabase
    .from('agent_context_memory')
    .select('*')
    .eq('session_group_id', groupId)
    .order('version', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // PostgREST: no rows returned — memory doesn't exist yet
      return null;
    }
    throw new Error(`Failed to fetch context memory: ${error.message}`);
  }

  // Map snake_case DB columns to camelCase TS interface
  return dbRowToContextMemory(data as Record<string, unknown>);
}

/**
 * Maps a DB row from agent_context_memory to the AgentContextMemory interface.
 *
 * WHY explicit mapping: Supabase returns snake_case column names. Using a
 * mapper keeps the interface clean (camelCase) and makes renames auditable.
 *
 * @param row - Raw DB row from agent_context_memory.
 * @returns Typed AgentContextMemory record.
 */
export function dbRowToContextMemory(row: Record<string, unknown>): AgentContextMemory {
  return {
    id: String(row['id'] ?? ''),
    sessionGroupId: String(row['session_group_id'] ?? ''),
    summaryMarkdown: String(row['summary_markdown'] ?? ''),
    fileRefs: (row['file_refs'] as AgentContextMemory['fileRefs']) ?? [],
    recentMessages: (row['recent_messages'] as AgentContextMemory['recentMessages']) ?? [],
    tokenBudget: Number(row['token_budget'] ?? TOKEN_BUDGET_DEFAULT),
    version: Number(row['version'] ?? 1),
    createdAt: String(row['created_at'] ?? new Date().toISOString()),
    updatedAt: String(row['updated_at'] ?? new Date().toISOString()),
  };
}

/**
 * Fetches recent session messages for a group's active session.
 *
 * Fetches up to SYNC_FETCH_MESSAGE_LIMIT messages from the most recent
 * session in the group. These are used as input to the summarizer.
 *
 * WHY only the active session's messages:
 *   Multi-agent groups can have N concurrent sessions. On sync, we want to
 *   capture what the CURRENTLY ACTIVE agent was doing — not blend all agents'
 *   messages together, which would create a confusing context mix.
 *
 * @param supabase - Authenticated Supabase client.
 * @param groupId - UUID of the session group.
 * @returns Array of summarizer input messages, or empty array if no sessions.
 */
async function fetchGroupMessages(
  supabase: SupabaseClient,
  groupId: string
): Promise<SummarizerInputMessage[]> {
  // Step 1: get the active session for this group
  const { data: group, error: groupError } = await supabase
    .from('agent_session_groups')
    .select('active_agent_session_id')
    .eq('id', groupId)
    .single();

  if (groupError || !group || !group.active_agent_session_id) {
    return [];
  }

  // Step 2: fetch recent messages from the active session
  // WHY decrypted_content doesn't exist: session_messages stores E2E-encrypted
  // content. For sync purposes, we use the token counts + metadata available
  // in plaintext columns. Full decryption requires the session private key,
  // which the CLI has in memory but the sync command doesn't re-derive here.
  //
  // PRAGMATIC CHOICE (Phase 3.5): We use the message_summary column (if present)
  // or fall back to the role + token_count as a proxy for message content.
  // Full decryption-based sync is a Phase 3.6 enhancement.
  const { data: messages, error: messagesError } = await supabase
    .from('session_messages')
    .select('role, message_summary, token_count, created_at')
    .eq('session_id', group.active_agent_session_id)
    .order('created_at', { ascending: false })
    .limit(SYNC_FETCH_MESSAGE_LIMIT);

  if (messagesError || !messages) {
    return [];
  }

  // Convert to SummarizerInputMessage (oldest first)
  return [...messages].reverse().map((row) => ({
    role: (row.role as string) ?? 'user',
    content: (row.message_summary as string) ?? `[${row.token_count ?? 0} tokens]`,
  }));
}

/**
 * Upserts a context memory record using optimistic locking.
 *
 * WHY optimistic locking:
 *   CLI workers can race on sync (e.g. two terminals sharing the same session
 *   group). The optimistic lock ensures the writer with stale data loses
 *   gracefully rather than silently clobbering a newer sync.
 *
 * @param supabase - Authenticated Supabase client.
 * @param groupId - UUID of the session group.
 * @param memory - The memory to write (current version for conflict detection).
 * @param summaryMarkdown - New summary markdown from the summarizer.
 * @param fileRefs - New file refs from the summarizer.
 * @param recentMessages - New message previews from the summarizer.
 * @param tokenBudget - Token budget to store.
 * @returns true if the write succeeded, false if the optimistic lock was violated.
 * @throws On Supabase errors unrelated to optimistic locking.
 */
async function upsertContextMemory(
  supabase: SupabaseClient,
  groupId: string,
  existing: AgentContextMemory | null,
  summaryMarkdown: string,
  fileRefs: AgentContextMemory['fileRefs'],
  recentMessages: AgentContextMemory['recentMessages'],
  tokenBudget: number
): Promise<boolean> {
  if (!existing) {
    // INSERT — no existing record, no version conflict possible
    const { error } = await supabase.from('agent_context_memory').insert({
      session_group_id: groupId,
      summary_markdown: summaryMarkdown,
      file_refs: fileRefs,
      recent_messages: recentMessages,
      token_budget: Math.min(TOKEN_BUDGET_MAX, Math.max(TOKEN_BUDGET_MIN, tokenBudget)),
      version: 1,
    });

    if (error) {
      if (error.code === '23505') {
        // Unique constraint violation — concurrent insert; re-fetch and retry
        return false;
      }
      throw new Error(`Failed to insert context memory: ${error.message}`);
    }
    return true;
  }

  // UPDATE with optimistic lock: WHERE version = existing.version
  const { data: updated, error } = await supabase
    .from('agent_context_memory')
    .update({
      summary_markdown: summaryMarkdown,
      file_refs: fileRefs,
      recent_messages: recentMessages,
      token_budget: Math.min(TOKEN_BUDGET_MAX, Math.max(TOKEN_BUDGET_MIN, tokenBudget)),
      version: existing.version + 1,
    })
    .eq('session_group_id', groupId)
    .eq('version', existing.version) // Optimistic lock condition
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to update context memory: ${error.message}`);
  }

  // If updated is null, the WHERE version = <expected> matched 0 rows →
  // optimistic lock violated (concurrent write won).
  return updated !== null;
}

// ============================================================================
// Command implementations
// ============================================================================

/**
 * Handles `styrby context show --group <groupId> [--json]`.
 *
 * Fetches and displays the current context memory for a session group.
 * In default mode, pretty-prints the summary markdown and file refs.
 * In --json mode, outputs raw JSON for scripting.
 *
 * @param args - Command arguments.
 */
async function handleContextShow(args: string[]): Promise<void> {
  const options = parseContextShowArgs(args);
  if (!options) {
    process.exit(1);
  }

  let supabase: SupabaseClient;
  try {
    supabase = createAuthenticatedClient();
  } catch (err) {
    logger.error((err as Error).message);
    process.exit(1);
  }

  const memory = await fetchContextMemory(supabase, options.groupId);

  if (!memory) {
    logger.info(
      chalk.yellow('No context memory found for this group. Run `styrby context sync` to create one.')
    );
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(memory, null, 2));
    return;
  }

  // Pretty-print
  console.log(chalk.bold.cyan('\n── Context Memory ──────────────────────────────────────'));
  console.log(chalk.dim(`Group: ${memory.sessionGroupId}  |  Version: ${memory.version}  |  Budget: ${memory.tokenBudget} tokens`));
  console.log(chalk.dim(`Last synced: ${new Date(memory.updatedAt).toLocaleString()}`));
  console.log('');
  console.log(memory.summaryMarkdown);

  if (memory.fileRefs.length > 0) {
    console.log('');
    console.log(chalk.bold('\nFile references:'));
    for (const ref of memory.fileRefs) {
      const bar = '█'.repeat(Math.round(ref.relevance * 10));
      const empty = '░'.repeat(10 - bar.length);
      console.log(
        chalk.cyan(`  ${bar}${empty}`) +
        chalk.dim(` ${ref.relevance.toFixed(2)}`) +
        `  ${ref.path}`
      );
    }
  }

  console.log(chalk.bold.cyan('────────────────────────────────────────────────────────\n'));
}

/**
 * Handles `styrby context sync --group <groupId> [--budget <n>]`.
 *
 * Recomputes the context memory from the group's recent session messages
 * and writes it back to agent_context_memory. Uses optimistic locking;
 * retries once on conflict.
 *
 * @param args - Command arguments.
 */
async function handleContextSync(args: string[]): Promise<void> {
  const options = parseContextSyncArgs(args);
  if (!options) {
    process.exit(1);
  }

  let supabase: SupabaseClient;
  try {
    supabase = createAuthenticatedClient();
  } catch (err) {
    logger.error((err as Error).message);
    process.exit(1);
  }

  logger.info(chalk.dim('Fetching session messages…'));

  const messages = await fetchGroupMessages(supabase, options.groupId);

  if (messages.length === 0) {
    logger.info(
      chalk.yellow('No messages found. The session group may have no active session yet.')
    );
    return;
  }

  logger.info(chalk.dim(`Summarizing ${messages.length} messages…`));

  const summarizerOutput = summarize({
    messages,
    tokenBudget: options.tokenBudget,
  });

  // Fetch existing memory for optimistic locking
  const existing = await fetchContextMemory(supabase, options.groupId);

  // Retry once on optimistic lock violation
  for (let attempt = 0; attempt < 2; attempt++) {
    const existingForWrite = attempt === 0 ? existing : await fetchContextMemory(supabase, options.groupId);

    const success = await upsertContextMemory(
      supabase,
      options.groupId,
      existingForWrite,
      summarizerOutput.summaryMarkdown,
      summarizerOutput.fileRefs,
      summarizerOutput.recentMessages,
      options.tokenBudget ?? TOKEN_BUDGET_DEFAULT
    );

    if (success) {
      logger.info(
        chalk.green('✓') +
        ` Context memory synced — ${summarizerOutput.estimatedTokens} tokens, ` +
        `${summarizerOutput.fileRefs.length} file refs, ` +
        `${summarizerOutput.recentMessages.length} messages`
      );

      // Audit log (non-fatal)
      await supabase.from('audit_log').insert({
        action: 'context_memory_synced',
        metadata: {
          group_id: options.groupId,
          estimated_tokens: summarizerOutput.estimatedTokens,
          file_ref_count: summarizerOutput.fileRefs.length,
          message_count: summarizerOutput.recentMessages.length,
        },
      }).then(({ error }) => {
        if (error) {
          // WHY non-fatal: audit log failure must not block user operations.
          logger.warn(`[context sync] Audit log failed: ${error.message}`);
        }
      });

      return;
    }

    if (attempt === 0) {
      logger.info(chalk.dim('Concurrent write detected — retrying with fresh version…'));
    }
  }

  logger.error('Failed to sync context memory after retry. Please try again.');
  process.exit(1);
}

/**
 * Handles `styrby context export --session <sessionId> [--json]`.
 *
 * Finds the session's group, fetches the context memory, and prints it.
 * If the session has no group or no memory, prints an informative message.
 *
 * @param args - Command arguments.
 */
async function handleContextExport(args: string[]): Promise<void> {
  const options = parseContextExportArgs(args);
  if (!options) {
    process.exit(1);
  }

  let supabase: SupabaseClient;
  try {
    supabase = createAuthenticatedClient();
  } catch (err) {
    logger.error((err as Error).message);
    process.exit(1);
  }

  // Resolve session → group
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id, session_group_id')
    .eq('id', options.sessionId)
    .single();

  if (sessionError || !session) {
    logger.error(`Session not found: ${options.sessionId}`);
    process.exit(1);
  }

  if (!session.session_group_id) {
    logger.info(
      chalk.yellow(
        'This session is not part of a session group. ' +
        'Context sync is available for multi-agent groups started with `styrby multi`.'
      )
    );
    return;
  }

  const memory = await fetchContextMemory(supabase, session.session_group_id as string);

  if (!memory) {
    logger.info(
      chalk.yellow(
        'No context memory found for this session\'s group. ' +
        `Run \`styrby context sync --group ${session.session_group_id as string}\` to create one.`
      )
    );
    return;
  }

  // Audit log
  await supabase.from('audit_log').insert({
    action: 'context_memory_exported',
    metadata: { session_id: options.sessionId, group_id: session.session_group_id },
  }).then(({ error }) => {
    if (error) logger.warn(`[context export] Audit log failed: ${error.message}`);
  });

  if (options.json) {
    console.log(JSON.stringify(memory, null, 2));
    return;
  }

  // Pretty-print (same as `show`)
  const payload = buildInjectionPrompt(memory);
  console.log(chalk.bold.cyan('\n── Exported Context (Injection Preview) ────────────────'));
  console.log(chalk.dim(`~${payload.estimatedTokens} tokens  |  ${payload.messageCount} messages  |  ${payload.includedFileRefs.length} file refs`));
  console.log('');
  console.log(payload.systemPrompt);
  console.log(chalk.bold.cyan('────────────────────────────────────────────────────────\n'));
}

/**
 * Handles `styrby context import --session <target> --from <source> [--task "..."]`.
 *
 * Copies the context memory from the source session's group to the target
 * session's group. Useful when you want to continue work from one session
 * in a different agent or project context.
 *
 * Security:
 *   Both source and target sessions must belong to the authenticated user.
 *   Server-side RLS enforces this; the CLI checks up front for a better error UX.
 *
 * @param args - Command arguments.
 */
async function handleContextImport(args: string[]): Promise<void> {
  const options = parseContextImportArgs(args);
  if (!options) {
    process.exit(1);
  }

  let supabase: SupabaseClient;
  try {
    supabase = createAuthenticatedClient();
  } catch (err) {
    logger.error((err as Error).message);
    process.exit(1);
  }

  // Resolve source session → group
  const { data: sourceSession, error: sourceError } = await supabase
    .from('sessions')
    .select('id, session_group_id')
    .eq('id', options.fromSessionId)
    .single();

  if (sourceError || !sourceSession || !sourceSession.session_group_id) {
    logger.error(
      `Source session not found or not in a group: ${options.fromSessionId}`
    );
    process.exit(1);
  }

  // Resolve target session → group
  const { data: targetSession, error: targetError } = await supabase
    .from('sessions')
    .select('id, session_group_id')
    .eq('id', options.sessionId)
    .single();

  if (targetError || !targetSession || !targetSession.session_group_id) {
    logger.error(
      `Target session not found or not in a group: ${options.sessionId}. ` +
      'The target session must be part of a multi-agent group.'
    );
    process.exit(1);
  }

  // Fetch source memory
  const sourceMemory = await fetchContextMemory(supabase, sourceSession.session_group_id as string);

  if (!sourceMemory) {
    logger.error(
      `No context memory found for source session's group. ` +
      `Run \`styrby context sync --group ${sourceSession.session_group_id as string}\` first.`
    );
    process.exit(1);
  }

  // Re-summarize with optional task override
  const importedSummary = summarize({
    messages: sourceMemory.recentMessages.map((m) => ({
      role: m.role,
      content: m.preview,
    })),
    tokenBudget: sourceMemory.tokenBudget,
    taskOverride: options.task,
  });

  // Fetch existing target memory for optimistic locking
  const existingTarget = await fetchContextMemory(supabase, targetSession.session_group_id as string);

  const success = await upsertContextMemory(
    supabase,
    targetSession.session_group_id as string,
    existingTarget,
    importedSummary.summaryMarkdown,
    importedSummary.fileRefs,
    importedSummary.recentMessages,
    sourceMemory.tokenBudget
  );

  if (!success) {
    logger.error(
      'Concurrent write to target group memory detected. Please retry.'
    );
    process.exit(1);
  }

  // Audit log
  await supabase.from('audit_log').insert({
    action: 'context_memory_imported',
    metadata: {
      source_session_id: options.fromSessionId,
      target_session_id: options.sessionId,
      source_group_id: sourceSession.session_group_id,
      target_group_id: targetSession.session_group_id,
      task_override: options.task ?? null,
    },
  }).then(({ error }) => {
    if (error) logger.warn(`[context import] Audit log failed: ${error.message}`);
  });

  logger.info(
    chalk.green('✓') +
    ` Context imported from session ${options.fromSessionId} → ${options.sessionId}. ` +
    chalk.dim(
      `~${importedSummary.estimatedTokens} tokens, ` +
      `${importedSummary.fileRefs.length} file refs`
    )
  );

  if (options.task) {
    logger.info(chalk.dim(`Task override applied: "${options.task}"`));
  }
}

// ============================================================================
// Main dispatcher
// ============================================================================

/**
 * Dispatches `styrby context <subcommand>` to the correct handler.
 *
 * Subcommands:
 *   show    — Display current context memory for a group
 *   sync    — Recompute and write context memory from recent messages
 *   export  — Print context memory for a session (as markdown or JSON)
 *   import  — Copy context memory from one session's group to another
 *
 * @param args - Arguments after `styrby context`.
 */
export async function handleContextCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'show':
      await handleContextShow(subArgs);
      break;

    case 'sync':
      await handleContextSync(subArgs);
      break;

    case 'export':
      await handleContextExport(subArgs);
      break;

    case 'import':
      await handleContextImport(subArgs);
      break;

    default:
      logger.error(subcommand ? `Unknown context subcommand: ${subcommand}` : 'Usage: styrby context <subcommand>');
      console.error('');
      console.error('Subcommands:');
      console.error('  show    --group <groupId>                          Show current context memory');
      console.error('  sync    --group <groupId> [--budget <n>]           Recompute from recent messages');
      console.error('  export  --session <sessionId> [--json]             Export memory for a session');
      console.error('  import  --session <target> --from <source>         Copy memory between sessions');
      console.error('');
      process.exit(1);
  }
}

export default { handleContextCommand };
