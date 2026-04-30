/**
 * Context Command Handler (H41 Phase 4-step2)
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
 * ## H41 Phase 4-step2
 *
 * Every Postgres operation now flows through the typed StyrbyApiClient against
 * /api/v1/* endpoints. The CLI no longer instantiates a Supabase client here —
 * all auth/rate-limit/RLS enforcement lives server-side, behind the styrby_*
 * bearer key. See PR notes for the full Strategy C transition plan.
 *
 * Notable simplifications versus the pre-swap implementation:
 *   - Optimistic-locking retry loop removed: POST /api/v1/contexts uses an
 *     INSERT … ON CONFLICT (session_group_id) DO UPDATE; concurrent writes
 *     resolve server-side, with the version field acting as a best-effort
 *     monotonic counter (see contexts route JSDoc for the concurrency model).
 *   - dbRowToContextMemory still maps the snake_case API row into the camelCase
 *     domain interface, so callers downstream of `fetchContextMemory` see the
 *     same shape as before the swap.
 *
 * ## Why
 *
 * When a user switches from Claude Code to Codex mid-task, Codex starts cold —
 * no knowledge of what was being worked on, which files were touched, or what
 * the last conversation was about. `styrby context` commands let users inspect,
 * refresh, and transplant context memory so the new agent hits the ground running.
 *
 * The "magic" happens automatically on focus change (POST /api/v1/sessions/groups/[id]/focus),
 * but these CLI commands give power users fine-grained control and visibility.
 *
 * ## Security
 *
 * - All context is scrubbed by the Phase 3.3 scrub engine before storing or printing.
 * - Session group membership is enforced server-side via the API auth middleware
 *   plus an explicit ownership check on the `agent_session_groups` row.
 * - Cross-user resource lookups return 404 (not 403) to prevent enumeration.
 * - The `--from` source session must belong to the authenticated user (server enforced).
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
import { logger } from '@/ui/logger';
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
import { getApiClient, MissingStyrbyKeyError } from '@/api/clientFromPersistence';
import { StyrbyApiError, type StyrbyApiClient } from '@/api/styrbyApiClient';

// ============================================================================
// Constants
// ============================================================================

/**
 * UUID v4 validation regex for group and session IDs.
 *
 * WHY: IDs are appended into URL paths (e.g. /api/v1/contexts/[group_id]).
 * Restricting to UUID format prevents path-traversal characters and keeps
 * 400-error UX consistent across subcommands.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maximum number of recent messages fetched from the API for sync.
 *
 * WHY 40 not 20: We fetch 40 so the summarizer has a larger pool to extract
 * file refs from. The summarizer itself caps the output at CONTEXT_MESSAGE_LIMIT (20).
 * More input -> better file ref signal -> better context quality.
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
// API client wiring
// ============================================================================

/**
 * Loads an authenticated StyrbyApiClient or exits the process.
 *
 * Mirrors the helper in commands/template.ts. We re-implement (not import) so
 * the per-file flow stays self-contained — every CLI command file owns its
 * authentication failure UX.
 *
 * @returns A StyrbyApiClient ready for use, or process exits with code 1.
 */
function ensureApiClientOrExit(): StyrbyApiClient {
  try {
    return getApiClient();
  } catch (err) {
    if (err instanceof MissingStyrbyKeyError) {
      console.log(chalk.red('\n' + err.message));
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Print a contextual error from a StyrbyApiError (or any error) and exit.
 *
 * @param err - The thrown error from an apiClient call.
 * @param verb - Action description used in the error message.
 */
function handleApiError(err: unknown, verb: string): never {
  if (err instanceof StyrbyApiError) {
    logger.error(`Failed to ${verb}: ${err.message}`);
    logger.debug('StyrbyApiError', { status: err.status, code: err.code });
  } else if (err instanceof Error) {
    logger.error(`Failed to ${verb}: ${err.message}`);
  } else {
    logger.error(`Failed to ${verb}: unknown error`);
  }
  process.exit(1);
}

// ============================================================================
// API helpers
// ============================================================================

/**
 * Fetches the context memory record for a session group.
 *
 * Returns null when the API responds 404 (no memory yet for this group),
 * matching the pre-swap behavior where PGRST116 was treated as "no rows".
 *
 * @param apiClient - Authenticated StyrbyApiClient.
 * @param groupId - UUID of the session group.
 * @returns The memory record, or null if none exists yet.
 * @throws StyrbyApiError on non-404 server failures.
 */
async function fetchContextMemory(
  apiClient: StyrbyApiClient,
  groupId: string,
): Promise<AgentContextMemory | null> {
  try {
    const { context } = await apiClient.getContext(groupId);
    return dbRowToContextMemory(context as unknown as Record<string, unknown>);
  } catch (err) {
    if (err instanceof StyrbyApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Maps a context API row to the AgentContextMemory interface.
 *
 * WHY explicit mapping: the API returns snake_case column names. Keeping the
 * mapper here means the rest of the CLI works in camelCase and any rename in
 * the API surface is caught at one location.
 *
 * @param row - Raw row from /api/v1/contexts.
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
 * Shape of session_messages rows returned by GET /api/v1/sessions/[id]/messages.
 *
 * Local declaration because apiClient.listSessionMessages is currently typed
 * `Promise<unknown>`. We pin the subset we actually consume here, keeping the
 * rest opaque so future server-side additions don't churn this file.
 */
interface SessionMessageApiRow {
  message_type: string;
  metadata: unknown;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

/**
 * Maps a session_messages.message_type enum to a SummarizerInputMessage role.
 *
 * The summarizer accepts the union 'user' | 'assistant' | 'tool' | 'tool_result'
 * (plus arbitrary string fallback). Map agent_response/agent_thinking → assistant
 * and tool_use → tool so the downstream summary scaffolding is well-formed.
 *
 * WHY: session_messages.message_type is a Postgres enum (see migration 001).
 * Mapping here keeps the enum-to-role translation testable in one location.
 */
function mapMessageTypeToRole(messageType: string): SummarizerInputMessage['role'] {
  switch (messageType) {
    case 'user_prompt':
      return 'user';
    case 'agent_response':
    case 'agent_thinking':
      return 'assistant';
    case 'tool_use':
      return 'tool';
    case 'tool_result':
      return 'tool_result';
    default:
      return 'user';
  }
}

/**
 * Fetches recent session messages from a group's active session.
 *
 * Two-step flow because the API surface mirrors the underlying tables:
 *   1. listSessionGroups() → resolve the group's active_agent_session_id.
 *   2. listSessionMessages(activeSessionId) → fetch recent rows for summarization.
 *
 * WHY only the active session: multi-agent groups can have N concurrent sessions.
 * On sync, we capture what the *currently active* agent was doing. Blending all
 * agents would muddle the resulting context with cross-agent state transitions.
 *
 * Caveat: session_messages.content_encrypted is end-to-end encrypted with the
 * session's TweetNaCl key, which the server can't decrypt. We surface a token-count
 * proxy plus optional `metadata.summary` (when the agent layer chose to write one)
 * so the summarizer has *something* to chew on without breaking E2E privacy.
 *
 * @param apiClient - Authenticated StyrbyApiClient.
 * @param groupId - UUID of the session group.
 * @returns Array of summarizer input messages, or empty array if no active session.
 */
async function fetchGroupMessages(
  apiClient: StyrbyApiClient,
  groupId: string,
): Promise<SummarizerInputMessage[]> {
  // Step 1: locate the active session for this group.
  let activeSessionId: string | null = null;
  try {
    const { groups } = await apiClient.listSessionGroups();
    const group = groups.find((g) => g.id === groupId);
    activeSessionId = group?.active_agent_session_id ?? null;
  } catch (err) {
    if (err instanceof StyrbyApiError) {
      logger.debug('listSessionGroups failed', { status: err.status });
    }
    return [];
  }

  if (!activeSessionId) {
    return [];
  }

  // Step 2: fetch recent messages from the active session.
  let payload: { messages?: SessionMessageApiRow[] };
  try {
    payload = (await apiClient.listSessionMessages(activeSessionId, {
      limit: SYNC_FETCH_MESSAGE_LIMIT,
    })) as { messages?: SessionMessageApiRow[] };
  } catch (err) {
    if (err instanceof StyrbyApiError) {
      logger.debug('listSessionMessages failed', { status: err.status });
    }
    return [];
  }

  const rows = Array.isArray(payload?.messages) ? payload.messages : [];

  // The /messages endpoint orders ascending by sequence_number; keep the order
  // (oldest first) which is what the summarizer expects.
  return rows.map((row) => {
    const tokenCount = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
    const metadataSummary =
      row.metadata && typeof row.metadata === 'object' && 'summary' in row.metadata
        ? String((row.metadata as { summary: unknown }).summary ?? '')
        : '';
    return {
      role: mapMessageTypeToRole(row.message_type),
      content: metadataSummary || `[${tokenCount} tokens]`,
    };
  });
}

/**
 * Upserts a context memory record via POST /api/v1/contexts.
 *
 * The API uses INSERT … ON CONFLICT (session_group_id) DO UPDATE, so concurrent
 * writes resolve server-side. The pre-swap optimistic-locking retry loop is no
 * longer needed: passing an idempotency key gives us safe retry on transient
 * network failures without risking duplicate inserts.
 *
 * @param apiClient - Authenticated StyrbyApiClient.
 * @param groupId - UUID of the session group.
 * @param summaryMarkdown - New summary markdown from the summarizer.
 * @param fileRefs - New file refs from the summarizer.
 * @param recentMessages - New message previews from the summarizer.
 * @param tokenBudget - Token budget to store.
 * @returns true on success.
 * @throws StyrbyApiError on server failure (auth, rate limit, validation, 5xx).
 */
async function upsertContextMemory(
  apiClient: StyrbyApiClient,
  groupId: string,
  summaryMarkdown: string,
  fileRefs: AgentContextMemory['fileRefs'],
  recentMessages: AgentContextMemory['recentMessages'],
  tokenBudget: number,
): Promise<boolean> {
  await apiClient.upsertContext(
    {
      session_group_id: groupId,
      summary_markdown: summaryMarkdown,
      file_refs: fileRefs,
      recent_messages: recentMessages,
      token_budget: Math.min(TOKEN_BUDGET_MAX, Math.max(TOKEN_BUDGET_MIN, tokenBudget)),
    },
    // WHY a per-call random key: the upsert is idempotent server-side on
    // (session_group_id), but passing a key allows the apiClient's retry
    // middleware to safely replay on transient 5xx without creating
    // double-version-bump artefacts.
    { idempotencyKey: randomIdempotencyKey() },
  );
  return true;
}

/**
 * Generates a per-call idempotency key for upsert operations.
 *
 * Random suffix scoped per-process so retried writes within the same call
 * cycle replay the cached server response, while distinct invocations always
 * issue a fresh key.
 */
function randomIdempotencyKey(): string {
  return `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ============================================================================
// Command implementations
// ============================================================================

/**
 * Handles `styrby context show --group <groupId> [--json]`.
 *
 * Fetches and displays the current context memory for a session group. In the
 * default mode, pretty-prints the summary markdown and file refs. In `--json`
 * mode, outputs the raw memory record for scripting.
 *
 * @param args - Command arguments after `context show`.
 */
async function handleContextShow(args: string[]): Promise<void> {
  const options = parseContextShowArgs(args);
  if (!options) {
    process.exit(1);
  }

  const apiClient = ensureApiClientOrExit();

  let memory: AgentContextMemory | null;
  try {
    memory = await fetchContextMemory(apiClient, options.groupId);
  } catch (err) {
    handleApiError(err, 'fetch context memory');
  }

  if (!memory) {
    logger.info(
      chalk.yellow('No context memory found for this group. Run `styrby context sync` to create one.'),
    );
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(memory, null, 2));
    return;
  }

  console.log(chalk.bold.cyan('\n-- Context Memory ----------------------------------'));
  console.log(
    chalk.dim(
      `Group: ${memory.sessionGroupId}  |  Version: ${memory.version}  |  Budget: ${memory.tokenBudget} tokens`,
    ),
  );
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
          `  ${ref.path}`,
      );
    }
  }

  console.log(chalk.bold.cyan('---------------------------------------------------\n'));
}

/**
 * Handles `styrby context sync --group <groupId> [--budget <n>]`.
 *
 * Recomputes the context memory from the group's recent session messages and
 * upserts it via /api/v1/contexts. The server resolves concurrent writes via
 * INSERT … ON CONFLICT, so the CLI no longer carries an optimistic-lock loop.
 *
 * @param args - Command arguments after `context sync`.
 */
async function handleContextSync(args: string[]): Promise<void> {
  const options = parseContextSyncArgs(args);
  if (!options) {
    process.exit(1);
  }

  const apiClient = ensureApiClientOrExit();

  logger.info(chalk.dim('Fetching session messages...'));

  const messages = await fetchGroupMessages(apiClient, options.groupId);

  if (messages.length === 0) {
    logger.info(
      chalk.yellow('No messages found. The session group may have no active session yet.'),
    );
    return;
  }

  logger.info(chalk.dim(`Summarizing ${messages.length} messages...`));

  const summarizerOutput = summarize({
    messages,
    tokenBudget: options.tokenBudget,
  });

  try {
    await upsertContextMemory(
      apiClient,
      options.groupId,
      summarizerOutput.summaryMarkdown,
      summarizerOutput.fileRefs,
      summarizerOutput.recentMessages,
      options.tokenBudget ?? TOKEN_BUDGET_DEFAULT,
    );
  } catch (err) {
    handleApiError(err, 'sync context memory');
  }

  logger.info(
    chalk.green('✓') +
      ` Context memory synced - ${summarizerOutput.estimatedTokens} tokens, ` +
      `${summarizerOutput.fileRefs.length} file refs, ` +
      `${summarizerOutput.recentMessages.length} messages`,
  );

  // Audit log (non-fatal). WHY catch+swallow: audit failure must not block UX.
  await apiClient
    .writeAuditEvent({
      action: 'context_memory_synced',
      resource_type: 'agent_session_group',
      resource_id: options.groupId,
      metadata: {
        group_id: options.groupId,
        estimated_tokens: summarizerOutput.estimatedTokens,
        file_ref_count: summarizerOutput.fileRefs.length,
        message_count: summarizerOutput.recentMessages.length,
      },
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.warn(`[context sync] Audit log failed: ${msg}`);
    });
}

/**
 * Handles `styrby context export --session <sessionId> [--json]`.
 *
 * Resolves the session's group, fetches the group's context memory, and prints
 * it. If the session has no group or the group has no memory yet, surfaces an
 * informative message instead of erroring.
 *
 * @param args - Command arguments after `context export`.
 */
async function handleContextExport(args: string[]): Promise<void> {
  const options = parseContextExportArgs(args);
  if (!options) {
    process.exit(1);
  }

  const apiClient = ensureApiClientOrExit();

  // Resolve session -> group
  let sessionGroupId: string | null;
  try {
    const { session } = await apiClient.getSession(options.sessionId);
    sessionGroupId = session.session_group_id ?? null;
  } catch (err) {
    if (err instanceof StyrbyApiError && err.status === 404) {
      logger.error(`Session not found: ${options.sessionId}`);
      process.exit(1);
    }
    handleApiError(err, 'fetch session');
  }

  if (!sessionGroupId) {
    logger.info(
      chalk.yellow(
        'This session is not part of a session group. ' +
          'Context sync is available for multi-agent groups started with `styrby multi`.',
      ),
    );
    return;
  }

  let memory: AgentContextMemory | null;
  try {
    memory = await fetchContextMemory(apiClient, sessionGroupId);
  } catch (err) {
    handleApiError(err, 'fetch context memory');
  }

  if (!memory) {
    logger.info(
      chalk.yellow(
        "No context memory found for this session's group. " +
          `Run \`styrby context sync --group ${sessionGroupId}\` to create one.`,
      ),
    );
    return;
  }

  // Audit log (non-fatal).
  await apiClient
    .writeAuditEvent({
      action: 'context_memory_exported',
      resource_type: 'agent_session_group',
      resource_id: sessionGroupId,
      metadata: { session_id: options.sessionId, group_id: sessionGroupId },
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.warn(`[context export] Audit log failed: ${msg}`);
    });

  if (options.json) {
    console.log(JSON.stringify(memory, null, 2));
    return;
  }

  const payload = buildInjectionPrompt(memory);
  console.log(chalk.bold.cyan('\n-- Exported Context (Injection Preview) ------------'));
  console.log(
    chalk.dim(
      `~${payload.estimatedTokens} tokens  |  ${payload.messageCount} messages  |  ${payload.includedFileRefs.length} file refs`,
    ),
  );
  console.log('');
  console.log(payload.systemPrompt);
  console.log(chalk.bold.cyan('---------------------------------------------------\n'));
}

/**
 * Handles `styrby context import --session <target> --from <source> [--task "..."]`.
 *
 * Copies the context memory from the source session's group to the target
 * session's group. Useful when continuing work from one session in a different
 * agent or project context.
 *
 * Security: both source and target sessions are resolved via /api/v1/sessions/[id],
 * which only returns rows owned by the authenticated user (server-enforced).
 * Cross-user IDs surface as 404 here, matching the API's enumeration defense.
 *
 * @param args - Command arguments after `context import`.
 */
async function handleContextImport(args: string[]): Promise<void> {
  const options = parseContextImportArgs(args);
  if (!options) {
    process.exit(1);
  }

  const apiClient = ensureApiClientOrExit();

  // Resolve source session -> group
  let sourceGroupId: string | null;
  try {
    const { session } = await apiClient.getSession(options.fromSessionId);
    sourceGroupId = session.session_group_id ?? null;
  } catch (err) {
    if (err instanceof StyrbyApiError && err.status === 404) {
      logger.error(`Source session not found: ${options.fromSessionId}`);
      process.exit(1);
    }
    handleApiError(err, 'fetch source session');
  }
  if (!sourceGroupId) {
    logger.error(`Source session not in a group: ${options.fromSessionId}`);
    process.exit(1);
  }

  // Resolve target session -> group
  let targetGroupId: string | null;
  try {
    const { session } = await apiClient.getSession(options.sessionId);
    targetGroupId = session.session_group_id ?? null;
  } catch (err) {
    if (err instanceof StyrbyApiError && err.status === 404) {
      logger.error(`Target session not found: ${options.sessionId}`);
      process.exit(1);
    }
    handleApiError(err, 'fetch target session');
  }
  if (!targetGroupId) {
    logger.error(
      `Target session not in a group: ${options.sessionId}. The target session must be part of a multi-agent group.`,
    );
    process.exit(1);
  }

  // Fetch source memory
  let sourceMemory: AgentContextMemory | null;
  try {
    sourceMemory = await fetchContextMemory(apiClient, sourceGroupId);
  } catch (err) {
    handleApiError(err, 'fetch source context memory');
  }
  if (!sourceMemory) {
    logger.error(
      `No context memory found for source session's group. ` +
        `Run \`styrby context sync --group ${sourceGroupId}\` first.`,
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

  try {
    await upsertContextMemory(
      apiClient,
      targetGroupId,
      importedSummary.summaryMarkdown,
      importedSummary.fileRefs,
      importedSummary.recentMessages,
      sourceMemory.tokenBudget,
    );
  } catch (err) {
    handleApiError(err, 'import context memory');
  }

  // Audit log (non-fatal).
  await apiClient
    .writeAuditEvent({
      action: 'context_memory_imported',
      resource_type: 'agent_session_group',
      resource_id: targetGroupId,
      metadata: {
        source_session_id: options.fromSessionId,
        target_session_id: options.sessionId,
        source_group_id: sourceGroupId,
        target_group_id: targetGroupId,
        task_override: options.task ?? null,
      },
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.warn(`[context import] Audit log failed: ${msg}`);
    });

  logger.info(
    chalk.green('✓') +
      ` Context imported from session ${options.fromSessionId} -> ${options.sessionId}. ` +
      chalk.dim(
        `~${importedSummary.estimatedTokens} tokens, ` +
          `${importedSummary.fileRefs.length} file refs`,
      ),
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
 *   show    - Display current context memory for a group
 *   sync    - Recompute and write context memory from recent messages
 *   export  - Print context memory for a session (as markdown or JSON)
 *   import  - Copy context memory from one session's group to another
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
      logger.error(
        subcommand ? `Unknown context subcommand: ${subcommand}` : 'Usage: styrby context <subcommand>',
      );
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
