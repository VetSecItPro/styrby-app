/**
 * Checkpoint Command Handler
 *
 * Implements `styrby checkpoint` subcommands for saving and restoring named
 * branch points in a session timeline.
 *
 * ## Subcommands
 *
 * ```
 * styrby checkpoint save <name> [--description "..."]
 * styrby checkpoint list [sessionId]
 * styrby checkpoint restore <name|id>
 * styrby checkpoint delete <name|id>
 * ```
 *
 * ## WHY
 *
 * Inspired by Gemini CLI's `/resume save [name]` command. Long AI coding sessions
 * can evolve in multiple directions. Users want to mark a "known good" state
 * before experimenting so they can restore it if things go wrong — similar to a
 * git stash or a save point in a video game.
 *
 * Checkpoints are stored in Supabase with RLS, so they sync across CLI, Web,
 * and Mobile automatically. The CLI creates and queries checkpoints over the
 * Supabase REST API using the user's existing session token.
 *
 * @module commands/checkpoint
 */

import chalk from 'chalk';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';
import { loadPersistedData } from '@/persistence';
import { config as envConfig } from '@/env';
import type { SessionCheckpoint } from 'styrby-shared';

// ============================================================================
// Constants
// ============================================================================

/**
 * UUID v4 validation regex for checkpoint IDs.
 *
 * WHY (SEC-PATH-003): Checkpoint IDs are used in Supabase `.eq('id', id)`
 * queries. Restricting to UUID format prevents unexpected query shapes from
 * user input that might contain special characters.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maximum allowed length for a checkpoint name.
 *
 * WHY: Names are displayed in table columns on Web and Mobile. Keeping them
 * short ensures the UI renders correctly without truncation.
 */
const MAX_NAME_LENGTH = 80;

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed options for `styrby checkpoint save`.
 */
export interface CheckpointSaveOptions {
  /** User-provided name for the checkpoint */
  name: string;
  /** Optional description */
  description: string | null;
  /** Session ID override (defaults to most recent local session) */
  sessionId: string | null;
}

/**
 * Parsed options for `styrby checkpoint list`.
 */
export interface CheckpointListOptions {
  /** Session ID to list checkpoints for (null = most recent local session) */
  sessionId: string | null;
}

/**
 * Parsed options for `styrby checkpoint restore`.
 */
export interface CheckpointRestoreOptions {
  /** Checkpoint name or UUID */
  nameOrId: string;
  /** Session ID override */
  sessionId: string | null;
}

/**
 * Parsed options for `styrby checkpoint delete`.
 */
export interface CheckpointDeleteOptions {
  /** Checkpoint name or UUID */
  nameOrId: string;
  /** Session ID override */
  sessionId: string | null;
  /** Skip confirmation prompt */
  force: boolean;
}

// ============================================================================
// Arg Parsing
// ============================================================================

/**
 * Parse arguments for `styrby checkpoint save <name> [--description "..."] [--session <id>]`.
 *
 * @param args - Raw arguments after "save"
 * @returns Parsed options or null if name is missing
 *
 * @example
 * parseCheckpointSaveArgs(['before-refactor', '--description', 'Auth works here'])
 * // => { name: 'before-refactor', description: 'Auth works here', sessionId: null }
 */
export function parseCheckpointSaveArgs(args: string[]): CheckpointSaveOptions | null {
  const options: CheckpointSaveOptions = {
    name: '',
    description: null,
    sessionId: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--description' || arg === '-d') {
      options.description = args[++i] ?? null;
    } else if (arg === '--session' || arg === '-s') {
      options.sessionId = args[++i] ?? null;
    } else if (!arg.startsWith('-') && !options.name) {
      options.name = arg;
    }
  }

  if (!options.name) {
    return null;
  }

  return options;
}

/**
 * Parse arguments for `styrby checkpoint list [sessionId]`.
 *
 * @param args - Raw arguments after "list"
 * @returns Parsed options
 *
 * @example
 * parseCheckpointListArgs(['abc123'])
 * // => { sessionId: 'abc123' }
 */
export function parseCheckpointListArgs(args: string[]): CheckpointListOptions {
  const sessionId = args.find((a) => !a.startsWith('-')) ?? null;
  return { sessionId };
}

/**
 * Parse arguments for `styrby checkpoint restore <name|id> [--session <id>]`.
 *
 * @param args - Raw arguments after "restore"
 * @returns Parsed options or null if nameOrId is missing
 *
 * @example
 * parseCheckpointRestoreArgs(['before-refactor'])
 * // => { nameOrId: 'before-refactor', sessionId: null }
 */
export function parseCheckpointRestoreArgs(args: string[]): CheckpointRestoreOptions | null {
  const options: CheckpointRestoreOptions = {
    nameOrId: '',
    sessionId: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session' || arg === '-s') {
      options.sessionId = args[++i] ?? null;
    } else if (!arg.startsWith('-') && !options.nameOrId) {
      options.nameOrId = arg;
    }
  }

  if (!options.nameOrId) {
    return null;
  }

  return options;
}

/**
 * Parse arguments for `styrby checkpoint delete <name|id> [--force] [--session <id>]`.
 *
 * @param args - Raw arguments after "delete"
 * @returns Parsed options or null if nameOrId is missing
 *
 * @example
 * parseCheckpointDeleteArgs(['before-refactor', '--force'])
 * // => { nameOrId: 'before-refactor', sessionId: null, force: true }
 */
export function parseCheckpointDeleteArgs(args: string[]): CheckpointDeleteOptions | null {
  const options: CheckpointDeleteOptions = {
    nameOrId: '',
    sessionId: null,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--session' || arg === '-s') {
      options.sessionId = args[++i] ?? null;
    } else if (!arg.startsWith('-') && !options.nameOrId) {
      options.nameOrId = arg;
    }
  }

  if (!options.nameOrId) {
    return null;
  }

  return options;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates a checkpoint name for length and character safety.
 *
 * WHY: Names are displayed in UIs and stored as identifiers. We allow letters,
 * numbers, spaces, hyphens, and underscores — similar to git branch names.
 * Rejecting special chars prevents rendering issues in terminals and UIs.
 *
 * @param name - The checkpoint name to validate
 * @returns An error message string, or null if the name is valid
 */
export function validateCheckpointName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return 'Checkpoint name cannot be empty';
  }

  if (name.length > MAX_NAME_LENGTH) {
    return `Checkpoint name must be ${MAX_NAME_LENGTH} characters or fewer (got ${name.length})`;
  }

  // Allow: letters, numbers, spaces, hyphens, underscores, dots
  if (!/^[a-zA-Z0-9 \-_.]+$/.test(name)) {
    return `Checkpoint name may only contain letters, numbers, spaces, hyphens, underscores, and dots`;
  }

  return null;
}

// ============================================================================
// Authentication helper (mirrors pattern from commands/export.ts)
// ============================================================================

/**
 * Load credentials and create an authenticated Supabase client.
 *
 * @returns Authenticated client + userId, or an error message
 */
async function ensureAuthenticated(): Promise<
  | { success: true; supabase: SupabaseClient; userId: string }
  | { success: false; error: string }
> {
  const data = loadPersistedData();

  if (!data?.userId || !data?.accessToken) {
    return {
      success: false,
      error: 'Not authenticated. Run "styrby onboard" first.',
    };
  }

  if (!envConfig.supabaseAnonKey) {
    return {
      success: false,
      error: 'Supabase anonymous key not configured. Set SUPABASE_ANON_KEY.',
    };
  }

  const supabase = createClient(envConfig.supabaseUrl, envConfig.supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    },
  });

  return { success: true, supabase, userId: data.userId };
}

// ============================================================================
// Core Checkpoint Operations
// ============================================================================

/**
 * Resolve a session ID: use provided value, or fall back to the most recent
 * locally-stored session for the current working directory.
 *
 * WHY: Most checkpoint commands are run in-context while a session is active.
 * Requiring users to type the full session UUID every time would be hostile
 * UX. We follow the convention of `git` commands that auto-detect the repo.
 *
 * @param sessionId - Explicit session ID (may be null)
 * @returns The resolved session ID or null if none found
 */
async function resolveSessionId(sessionId: string | null): Promise<string | null> {
  if (sessionId) {
    return sessionId;
  }

  const { getRecentSessionForProject } = await import('@/persistence');
  const recent = getRecentSessionForProject(process.cwd());
  return recent?.sessionId ?? null;
}

/**
 * Save a new checkpoint for the current session position.
 *
 * Fetches the latest message sequence number from Supabase, then inserts
 * a checkpoint row. Fails if a checkpoint with the same name already exists
 * in the session (names must be unique per session).
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - Authenticated user's ID
 * @param sessionId - UUID of the target session
 * @param options - Checkpoint save options (name, description)
 * @returns The created checkpoint record
 * @throws {Error} If the Supabase insert fails or name conflicts
 *
 * @example
 * const cp = await saveCheckpoint(supabase, userId, sessionId, {
 *   name: 'before-refactor',
 *   description: 'Auth endpoint working, about to refactor storage',
 *   sessionId: null,
 * });
 * console.log('Checkpoint saved at sequence', cp.messageSequenceNumber);
 */
export async function saveCheckpoint(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string,
  options: CheckpointSaveOptions
): Promise<SessionCheckpoint> {
  logger.debug('[checkpoint] Saving checkpoint', { sessionId, name: options.name });

  // 1. Fetch the most recent message sequence number for this session
  // WHY: We bookmark the current position by sequence_number so "restore"
  // can reconstruct "show me messages 1 through N" unambiguously.
  const { data: latestMsg, error: msgError } = await supabase
    .from('session_messages')
    .select('sequence_number')
    .eq('session_id', sessionId)
    .order('sequence_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (msgError) {
    throw new Error(`Failed to fetch latest message: ${msgError.message}`);
  }

  const sequenceNumber = latestMsg?.sequence_number ?? 0;

  // 2. Fetch session context window info for the snapshot
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('context_window_used, user_id')
    .eq('id', sessionId)
    .single();

  if (sessionError || !session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Security: verify the session belongs to this user (RLS should enforce
  // this but we do a belt-and-suspenders check in the application layer)
  if (session.user_id !== userId) {
    throw new Error('You do not have access to this session');
  }

  // 3. Insert the checkpoint row
  // WHY: `crypto.randomUUID()` is available in Node 19+ and Supabase edge
  // functions. For CLI use on older Node we fall back to a simple UUID via
  // the `crypto` module's `randomUUID` which is available since Node 14.18.
  const { randomUUID } = await import('node:crypto');
  const checkpointId = randomUUID();

  const row = {
    id: checkpointId,
    session_id: sessionId,
    user_id: userId,
    name: options.name.trim(),
    description: options.description ?? null,
    message_sequence_number: sequenceNumber,
    context_snapshot: {
      totalTokens: session.context_window_used ?? 0,
      fileCount: 0, // WHY: file count comes from the in-memory context breakdown
                    // which is not persisted to Supabase. We store 0 and let
                    // the CLI layer populate this if it has the data.
    },
  };

  const { data: inserted, error: insertError } = await supabase
    .from('session_checkpoints')
    .insert(row)
    .select()
    .single();

  if (insertError) {
    // Unique constraint on (session_id, name) returns code 23505
    if (insertError.code === '23505') {
      throw new Error(
        `A checkpoint named "${options.name}" already exists in this session. ` +
          'Use a different name or delete the existing checkpoint first.'
      );
    }
    throw new Error(`Failed to save checkpoint: ${insertError.message}`);
  }

  return dbRowToCheckpoint(inserted);
}

/**
 * List all checkpoints for a session, ordered by creation time (newest first).
 *
 * @param supabase - Authenticated Supabase client
 * @param sessionId - UUID of the target session
 * @returns Array of checkpoints, newest first
 * @throws {Error} If the Supabase query fails
 *
 * @example
 * const checkpoints = await listCheckpoints(supabase, sessionId);
 * checkpoints.forEach(cp => console.log(cp.name, 'at seq', cp.messageSequenceNumber));
 */
export async function listCheckpoints(
  supabase: SupabaseClient,
  sessionId: string
): Promise<SessionCheckpoint[]> {
  logger.debug('[checkpoint] Listing checkpoints', { sessionId });

  const { data, error } = await supabase
    .from('session_checkpoints')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list checkpoints: ${error.message}`);
  }

  return (data ?? []).map(dbRowToCheckpoint);
}

/**
 * Find a checkpoint by name or UUID within a session.
 *
 * Tries UUID lookup first, then falls back to name lookup. This lets users
 * reference checkpoints by the shorter name in most cases.
 *
 * @param supabase - Authenticated Supabase client
 * @param sessionId - UUID of the parent session
 * @param nameOrId - Checkpoint name or UUID
 * @returns The matching checkpoint, or null if not found
 * @throws {Error} If the Supabase query fails
 *
 * @example
 * const cp = await findCheckpoint(supabase, sessionId, 'before-refactor');
 */
export async function findCheckpoint(
  supabase: SupabaseClient,
  sessionId: string,
  nameOrId: string
): Promise<SessionCheckpoint | null> {
  logger.debug('[checkpoint] Finding checkpoint', { sessionId, nameOrId });

  // Try UUID lookup first (faster, unambiguous)
  if (UUID_REGEX.test(nameOrId)) {
    const { data, error } = await supabase
      .from('session_checkpoints')
      .select('*')
      .eq('id', nameOrId)
      .eq('session_id', sessionId)
      .maybeSingle();

    if (error) throw new Error(`Failed to find checkpoint: ${error.message}`);
    if (data) return dbRowToCheckpoint(data);
  }

  // Fall back to name lookup
  const { data, error } = await supabase
    .from('session_checkpoints')
    .select('*')
    .eq('session_id', sessionId)
    .eq('name', nameOrId.trim())
    .maybeSingle();

  if (error) throw new Error(`Failed to find checkpoint by name: ${error.message}`);
  if (!data) return null;

  return dbRowToCheckpoint(data);
}

/**
 * Delete a checkpoint by name or UUID.
 *
 * RLS ensures only the checkpoint owner can delete it.
 *
 * @param supabase - Authenticated Supabase client
 * @param sessionId - UUID of the parent session
 * @param nameOrId - Checkpoint name or UUID to delete
 * @returns true if deleted, false if not found
 * @throws {Error} If the Supabase delete fails
 *
 * @example
 * const deleted = await deleteCheckpoint(supabase, sessionId, 'before-refactor');
 */
export async function deleteCheckpoint(
  supabase: SupabaseClient,
  sessionId: string,
  nameOrId: string
): Promise<boolean> {
  const checkpoint = await findCheckpoint(supabase, sessionId, nameOrId);

  if (!checkpoint) {
    return false;
  }

  const { error } = await supabase
    .from('session_checkpoints')
    .delete()
    .eq('id', checkpoint.id);

  if (error) {
    throw new Error(`Failed to delete checkpoint: ${error.message}`);
  }

  logger.debug('[checkpoint] Checkpoint deleted', { id: checkpoint.id, name: checkpoint.name });
  return true;
}

// ============================================================================
// DB Row ↔ Type Mapping
// ============================================================================

/**
 * Maps a raw Supabase database row to a typed SessionCheckpoint.
 *
 * WHY: Supabase returns snake_case columns. Our shared type uses camelCase.
 * Centralising this mapping prevents scattered column-name bugs across
 * callers.
 *
 * @param row - Raw database row from session_checkpoints
 * @returns Typed SessionCheckpoint
 */
export function dbRowToCheckpoint(row: Record<string, unknown>): SessionCheckpoint {
  const snapshot = (row.context_snapshot ?? {}) as Record<string, unknown>;
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    messageSequenceNumber: (row.message_sequence_number as number) ?? 0,
    contextSnapshot: {
      totalTokens: (snapshot.totalTokens as number) ?? 0,
      fileCount: (snapshot.fileCount as number) ?? 0,
    },
    createdAt: row.created_at as string,
  };
}

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * Handle the `styrby checkpoint` command and all its subcommands.
 *
 * Dispatches to the appropriate subcommand handler based on the first
 * positional argument. Prints usage if no subcommand is given.
 *
 * @param args - Command arguments (after "checkpoint")
 * @returns Promise that resolves when the command completes
 *
 * @example
 * styrby checkpoint save "before refactor" --description "auth working"
 * styrby checkpoint list
 * styrby checkpoint restore "before refactor"
 * styrby checkpoint delete "before refactor"
 */
export async function handleCheckpointCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'save':
      await handleCheckpointSave(subArgs);
      break;

    case 'list':
    case 'ls':
      await handleCheckpointList(subArgs);
      break;

    case 'restore':
      await handleCheckpointRestore(subArgs);
      break;

    case 'delete':
    case 'rm':
    case 'remove':
      await handleCheckpointDelete(subArgs);
      break;

    default:
      printCheckpointUsage();
      if (subcommand) {
        process.exit(1);
      }
  }
}

/**
 * Print usage information for the checkpoint command.
 */
function printCheckpointUsage(): void {
  console.log(chalk.yellow('Usage: styrby checkpoint <subcommand>'));
  console.log('');
  console.log(chalk.white('Subcommands:'));
  console.log(chalk.gray('  save <name> [--description "..."]   Save current session position'));
  console.log(chalk.gray('  list [sessionId]                    List checkpoints for a session'));
  console.log(chalk.gray('  restore <name|id>                   Restore session to a checkpoint'));
  console.log(chalk.gray('  delete <name|id>                    Delete a checkpoint'));
  console.log('');
  console.log(chalk.white('Options (all subcommands):'));
  console.log(chalk.gray('  --session, -s <id>    Specify session ID (defaults to most recent)'));
  console.log('');
  console.log(chalk.white('Examples:'));
  console.log(chalk.gray('  styrby checkpoint save "before refactor"'));
  console.log(chalk.gray('  styrby checkpoint save v1-complete --description "All tests passing"'));
  console.log(chalk.gray('  styrby checkpoint list'));
  console.log(chalk.gray('  styrby checkpoint restore "before refactor"'));
  console.log(chalk.gray('  styrby checkpoint delete "before refactor" --force'));
}

/**
 * Handle `styrby checkpoint save <name> [--description "..."] [--session <id>]`.
 *
 * Creates a named checkpoint at the current message position in the active
 * or specified session.
 *
 * @param args - Arguments after "save"
 */
async function handleCheckpointSave(args: string[]): Promise<void> {
  const options = parseCheckpointSaveArgs(args);

  if (!options) {
    console.log(chalk.yellow('Usage: styrby checkpoint save <name> [--description "..."]'));
    console.log(chalk.gray('  Example: styrby checkpoint save "before refactor"'));
    process.exit(1);
  }

  // Validate name
  const nameError = validateCheckpointName(options.name);
  if (nameError) {
    console.log(chalk.red(`Invalid checkpoint name: ${nameError}`));
    process.exit(1);
  }

  const sessionId = await resolveSessionId(options.sessionId);
  if (!sessionId) {
    console.log(chalk.red('No active session found. Specify --session <id> or start a session.'));
    process.exit(1);
  }

  const authResult = await ensureAuthenticated();
  if (authResult.success === false) {
    console.log(chalk.red(authResult.error));
    process.exit(1);
  }

  const { supabase, userId } = authResult;

  console.log(chalk.gray(`Saving checkpoint "${options.name}"...`));

  try {
    const checkpoint = await saveCheckpoint(supabase, userId, sessionId, options);
    console.log(chalk.green(`Checkpoint saved: "${checkpoint.name}"`));
    console.log(chalk.gray(`  ID:       ${checkpoint.id}`));
    console.log(chalk.gray(`  Sequence: ${checkpoint.messageSequenceNumber} messages`));
    if (checkpoint.description) {
      console.log(chalk.gray(`  Note:     ${checkpoint.description}`));
    }
    console.log(chalk.gray(`  Created:  ${new Date(checkpoint.createdAt).toLocaleString()}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`Failed to save checkpoint: ${msg}`));
    process.exit(1);
  }
}

/**
 * Handle `styrby checkpoint list [sessionId]`.
 *
 * Prints a formatted table of all checkpoints for the specified or most
 * recent session.
 *
 * @param args - Arguments after "list"
 */
async function handleCheckpointList(args: string[]): Promise<void> {
  const options = parseCheckpointListArgs(args);

  const sessionId = await resolveSessionId(options.sessionId);
  if (!sessionId) {
    console.log(chalk.red('No session found. Specify a session ID or start a session.'));
    process.exit(1);
  }

  const authResult = await ensureAuthenticated();
  if (authResult.success === false) {
    console.log(chalk.red(authResult.error));
    process.exit(1);
  }

  const { supabase } = authResult;

  try {
    const checkpoints = await listCheckpoints(supabase, sessionId);

    if (checkpoints.length === 0) {
      console.log(chalk.yellow(`No checkpoints found for session ${sessionId}.`));
      console.log(chalk.gray('  Create one with: styrby checkpoint save <name>'));
      return;
    }

    console.log(chalk.white(`Checkpoints for session ${sessionId}:`));
    console.log('');

    // Header row
    console.log(
      chalk.gray(
        `${'NAME'.padEnd(30)} ${'SEQ'.padStart(6)}  ${'CREATED'.padEnd(20)}  DESCRIPTION`
      )
    );
    console.log(chalk.gray('─'.repeat(85)));

    for (const cp of checkpoints) {
      const name = cp.name.length > 28 ? cp.name.slice(0, 27) + '…' : cp.name;
      const seq = String(cp.messageSequenceNumber).padStart(6);
      const created = new Date(cp.createdAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      const desc = cp.description
        ? cp.description.length > 30
          ? cp.description.slice(0, 29) + '…'
          : cp.description
        : '';

      console.log(
        chalk.white(name.padEnd(30)) +
          ' ' +
          chalk.cyan(seq) +
          '  ' +
          chalk.gray(created.padEnd(20)) +
          '  ' +
          chalk.gray(desc)
      );
    }

    console.log('');
    console.log(chalk.gray(`${checkpoints.length} checkpoint(s) total`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`Failed to list checkpoints: ${msg}`));
    process.exit(1);
  }
}

/**
 * Handle `styrby checkpoint restore <name|id> [--session <id>]`.
 *
 * Outputs the restore information (sequence number and context) so the
 * caller can reconstruct the session state. In a future version, this will
 * signal the active agent to roll back its context.
 *
 * WHY: True in-process context rollback requires agent-specific IPC (e.g.,
 * sending a signal to Claude Code's subprocess). That is out of scope for
 * the first checkpoint implementation. For now, `restore` prints the
 * checkpoint metadata so the user can manually re-start from that point.
 * The Web and Mobile surfaces will handle UI-driven restoration.
 *
 * @param args - Arguments after "restore"
 */
async function handleCheckpointRestore(args: string[]): Promise<void> {
  const options = parseCheckpointRestoreArgs(args);

  if (!options) {
    console.log(chalk.yellow('Usage: styrby checkpoint restore <name|id>'));
    process.exit(1);
  }

  const sessionId = await resolveSessionId(options.sessionId);
  if (!sessionId) {
    console.log(chalk.red('No session found. Specify --session <id> or start a session.'));
    process.exit(1);
  }

  const authResult = await ensureAuthenticated();
  if (authResult.success === false) {
    console.log(chalk.red(authResult.error));
    process.exit(1);
  }

  const { supabase } = authResult;

  try {
    const checkpoint = await findCheckpoint(supabase, sessionId, options.nameOrId);

    if (!checkpoint) {
      console.log(
        chalk.red(`Checkpoint "${options.nameOrId}" not found in session ${sessionId}.`)
      );
      console.log(chalk.gray('  Use "styrby checkpoint list" to see available checkpoints.'));
      process.exit(1);
    }

    console.log(chalk.green(`Checkpoint: "${checkpoint.name}"`));
    console.log('');
    console.log(chalk.white('Restore point details:'));
    console.log(chalk.gray(`  Message sequence: ${checkpoint.messageSequenceNumber}`));
    console.log(chalk.gray(`  Context tokens:   ${checkpoint.contextSnapshot.totalTokens.toLocaleString()}`));
    console.log(chalk.gray(`  Files in context: ${checkpoint.contextSnapshot.fileCount}`));
    if (checkpoint.description) {
      console.log(chalk.gray(`  Description:      ${checkpoint.description}`));
    }
    console.log(chalk.gray(`  Saved at:         ${new Date(checkpoint.createdAt).toLocaleString()}`));
    console.log('');
    console.log(
      chalk.yellow(
        `To view session messages up to this checkpoint, open the session in the Styrby app\n` +
          `or visit: https://app.styrby.com/dashboard/sessions/${sessionId}?checkpoint=${checkpoint.id}`
      )
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`Failed to restore checkpoint: ${msg}`));
    process.exit(1);
  }
}

/**
 * Handle `styrby checkpoint delete <name|id> [--force] [--session <id>]`.
 *
 * Deletes the named checkpoint after optional confirmation. Use `--force`
 * to skip the confirmation prompt (useful for scripts).
 *
 * @param args - Arguments after "delete"
 */
async function handleCheckpointDelete(args: string[]): Promise<void> {
  const options = parseCheckpointDeleteArgs(args);

  if (!options) {
    console.log(chalk.yellow('Usage: styrby checkpoint delete <name|id> [--force]'));
    process.exit(1);
  }

  const sessionId = await resolveSessionId(options.sessionId);
  if (!sessionId) {
    console.log(chalk.red('No session found. Specify --session <id> or start a session.'));
    process.exit(1);
  }

  const authResult = await ensureAuthenticated();
  if (authResult.success === false) {
    console.log(chalk.red(authResult.error));
    process.exit(1);
  }

  const { supabase } = authResult;

  try {
    // Look up checkpoint first so we can show its details in the confirmation
    const checkpoint = await findCheckpoint(supabase, sessionId, options.nameOrId);

    if (!checkpoint) {
      console.log(
        chalk.yellow(`Checkpoint "${options.nameOrId}" not found — nothing to delete.`)
      );
      return;
    }

    // Confirmation prompt unless --force
    if (!options.force) {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await rl.question(
        chalk.yellow(`Delete checkpoint "${checkpoint.name}"? (y/N) `)
      );
      rl.close();

      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(chalk.gray('Aborted.'));
        return;
      }
    }

    await deleteCheckpoint(supabase, sessionId, checkpoint.id);
    console.log(chalk.green(`Checkpoint "${checkpoint.name}" deleted.`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`Failed to delete checkpoint: ${msg}`));
    process.exit(1);
  }
}

export default { handleCheckpointCommand };
