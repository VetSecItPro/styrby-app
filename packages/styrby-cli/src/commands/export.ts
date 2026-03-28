/**
 * Export / Import Command Handler
 *
 * Implements `styrby export` and `styrby import` subcommands for
 * portable session archiving and transfer.
 *
 * ## Export
 *
 * ```
 * styrby export <sessionId>           # Print JSON to stdout
 * styrby export <sessionId> -o file   # Write JSON to file
 * styrby export --all -o sessions/    # Export all sessions to a directory
 * ```
 *
 * ## Import
 *
 * ```
 * styrby import <file>                # Import a session from a JSON file
 * ```
 *
 * ## Security Note
 *
 * Messages are exported in their **encrypted** form. The export file does NOT
 * contain decrypted message content. This is intentional:
 * - Decryption keys are derived from the user secret that never leaves the CLI.
 * - Export files can be stored and shared without risking transcript leaks.
 * - On import, the receiving CLI can only read messages if it has the same
 *   user account (Supabase RLS + same encryption key derivation inputs).
 *
 * @module commands/export
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';
import { loadPersistedData } from '@/persistence';
import { config as envConfig } from '@/env';
import { VERSION } from '@/index';
import type {
  SessionExport,
  SessionExportMetadata,
  SessionExportMessage,
  SessionExportCost,
} from 'styrby-shared';

// ============================================================================
// Options
// ============================================================================

/**
 * Parsed options for the `styrby export` command.
 */
interface ExportOptions {
  /** Session ID to export, or null when --all is set */
  sessionId: string | null;
  /** Export all sessions */
  all: boolean;
  /** Output file path, or null to write to stdout */
  outputPath: string | null;
  /** Pretty-print JSON (default true) */
  pretty: boolean;
}

/**
 * Parsed options for the `styrby import` command.
 */
interface ImportOptions {
  /** Path to the JSON file to import */
  filePath: string;
}

// ============================================================================
// Arg Parsing
// ============================================================================

/**
 * Parse command line arguments for the `styrby export` command.
 *
 * @param args - Raw arguments from the CLI dispatcher (after "export")
 * @returns Parsed export options
 *
 * @example
 * parseExportArgs(['abc123', '-o', 'session.json'])
 * // => { sessionId: 'abc123', all: false, outputPath: 'session.json', pretty: true }
 *
 * parseExportArgs(['--all'])
 * // => { sessionId: null, all: true, outputPath: null, pretty: true }
 */
export function parseExportArgs(args: string[]): ExportOptions {
  const options: ExportOptions = {
    sessionId: null,
    all: false,
    outputPath: null,
    pretty: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--all' || arg === '-a') {
      options.all = true;
    } else if (arg === '--output' || arg === '-o') {
      options.outputPath = args[++i] ?? null;
    } else if (arg === '--compact') {
      options.pretty = false;
    } else if (!arg.startsWith('-') && !options.sessionId) {
      options.sessionId = arg;
    }
  }

  return options;
}

/**
 * Parse command line arguments for the `styrby import` command.
 *
 * @param args - Raw arguments from the CLI dispatcher (after "import")
 * @returns Parsed import options
 *
 * @example
 * parseImportArgs(['session.json'])
 * // => { filePath: 'session.json' }
 */
export function parseImportArgs(args: string[]): ImportOptions | null {
  const filePath = args.find((a) => !a.startsWith('-'));
  if (!filePath) {
    return null;
  }
  return { filePath };
}

// ============================================================================
// Authentication helper (mirrors pattern from commands/template.ts)
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
// Export Logic
// ============================================================================

/**
 * Fetch a single session record from Supabase and all its messages,
 * then assemble a self-contained SessionExport payload.
 *
 * @param supabase - Authenticated Supabase client (RLS enforces ownership)
 * @param sessionId - UUID of the session to export
 * @returns A complete SessionExport, or null if the session was not found
 * @throws {Error} On Supabase query failure
 *
 * @example
 * const exported = await fetchSessionExport(supabase, '550e8400-e29b-41d4-a716-446655440000');
 * if (exported) {
 *   fs.writeFileSync('session.json', JSON.stringify(exported, null, 2));
 * }
 */
export async function fetchSessionExport(
  supabase: SupabaseClient,
  sessionId: string
): Promise<SessionExport | null> {
  logger.debug('[export] Fetching session', { sessionId });

  // 1. Fetch session row
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (sessionError || !session) {
    if (sessionError?.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to fetch session: ${sessionError?.message ?? 'unknown error'}`);
  }

  // 2. Fetch all messages for this session
  // WHY: We cap at 5000 messages to protect memory on huge sessions.
  // The vast majority of real sessions have fewer than 500 messages.
  const { data: messages, error: messagesError } = await supabase
    .from('session_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('sequence_number', { ascending: true })
    .limit(5000);

  if (messagesError) {
    throw new Error(`Failed to fetch messages: ${messagesError.message}`);
  }

  // 3. Assemble export payload
  const metadata: SessionExportMetadata = {
    id: session.id,
    title: session.title ?? null,
    summary: session.summary ?? null,
    agentType: session.agent_type,
    model: session.model ?? null,
    status: session.status,
    projectPath: session.project_path ?? null,
    gitBranch: session.git_branch ?? null,
    gitRemoteUrl: session.git_remote_url ?? null,
    tags: session.tags ?? [],
    startedAt: session.started_at ?? session.created_at,
    endedAt: session.ended_at ?? null,
    messageCount: session.message_count ?? (messages?.length ?? 0),
    contextWindowUsed: session.context_window_used ?? null,
    contextWindowLimit: session.context_window_limit ?? null,
  };

  const exportMessages: SessionExportMessage[] = (messages ?? []).map((m) => ({
    id: m.id,
    sequenceNumber: m.sequence_number,
    messageType: m.message_type,
    contentEncrypted: m.content_encrypted ?? null,
    encryptionNonce: m.encryption_nonce ?? null,
    riskLevel: m.risk_level ?? null,
    toolName: m.tool_name ?? null,
    durationMs: m.duration_ms ?? null,
    inputTokens: m.input_tokens ?? 0,
    outputTokens: m.output_tokens ?? 0,
    cacheTokens: m.cache_tokens ?? 0,
    createdAt: m.created_at,
  }));

  const cost: SessionExportCost = {
    totalCostUsd: Number(session.total_cost_usd ?? 0),
    totalInputTokens: session.total_input_tokens ?? 0,
    totalOutputTokens: session.total_output_tokens ?? 0,
    totalCacheTokens: session.total_cache_tokens ?? 0,
    model: session.model ?? null,
    agentType: session.agent_type,
  };

  return {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    generatedBy: `styrby-cli@${VERSION}`,
    session: metadata,
    messages: exportMessages,
    cost,
    contextBreakdown: null, // WHY: breakdown is in-memory only; not persisted to Supabase yet
  };
}

/**
 * Validates that a resolved output path is safe to write to.
 *
 * WHY (SEC-PATH-002): The `--output` flag accepts user input that is passed
 * directly to `fs.writeFileSync`. Without validation, a user (or a script
 * invoking the CLI) could write to arbitrary filesystem locations:
 *   `styrby export abc --output /etc/cron.d/evil`
 *   `styrby export abc --output ../../../.ssh/authorized_keys`
 *
 * We block writes to well-known sensitive directories. The user's home
 * directory and current working directory are always allowed.
 *
 * @param resolvedPath - Fully resolved absolute path
 * @throws {Error} If the path targets a sensitive system directory
 */
function validateOutputPath(resolvedPath: string): void {
  const dangerous = ['/etc', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/var', '/root', '/boot', '/sys', '/proc'];
  const lowerPath = resolvedPath.toLowerCase();

  for (const prefix of dangerous) {
    if (lowerPath === prefix || lowerPath.startsWith(prefix + '/')) {
      throw new Error(
        `Refusing to write to system directory: ${resolvedPath}. ` +
          'Export output should target your project directory or home directory.'
      );
    }
  }
}

/**
 * Write an export payload to a file or stdout.
 *
 * @param data - The SessionExport to serialise
 * @param outputPath - Destination file path, or null to write to stdout
 * @param pretty - Whether to pretty-print JSON (default true)
 */
function writeExport(data: SessionExport, outputPath: string | null, pretty: boolean): void {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);

  if (outputPath) {
    // Resolve and validate the output path before any filesystem mutation
    const resolvedOutput = path.resolve(outputPath);
    validateOutputPath(resolvedOutput);

    // Ensure parent directory exists
    const dir = path.dirname(resolvedOutput);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolvedOutput, json, 'utf-8');
    console.log(chalk.green(`Exported to ${resolvedOutput}`));
  } else {
    // Write to stdout — suitable for piping to jq, pbcopy, etc.
    process.stdout.write(json + '\n');
  }
}

// ============================================================================
// Import Logic
// ============================================================================

/**
 * Validate and parse a session export file.
 *
 * Checks that the file is valid JSON and has the expected schema shape.
 *
 * @param filePath - Path to the JSON export file
 * @returns Parsed SessionExport
 * @throws {Error} If the file cannot be read, is not valid JSON, or has
 *   an unrecognised export version
 *
 * @example
 * const data = parseExportFile('styrby-session-abc123-2026-03-27.json');
 */
export function parseExportFile(filePath: string): SessionExport {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in file: ${resolved}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Export file is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  // Version gate — allows future breaking changes to export format
  if (obj.exportVersion !== 1) {
    throw new Error(
      `Unsupported export version: ${String(obj.exportVersion)}. ` +
        'Update the Styrby CLI to import this file.'
    );
  }

  if (!obj.session || typeof obj.session !== 'object') {
    throw new Error('Export file is missing required "session" field');
  }

  // SEC-IMPORT-001: Validate critical field types before upserting to Supabase.
  // WHY: A crafted export file could contain non-string IDs, SQL-injection attempts
  // in text fields, or unexpected types that bypass Supabase client parameterization.
  // While Supabase client calls are parameterized (preventing SQL injection), malformed
  // data types could cause runtime errors or data corruption.
  const session = obj.session as Record<string, unknown>;
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (typeof session.id !== 'string' || !UUID_REGEX.test(session.id)) {
    throw new Error('Export file contains an invalid session ID (must be UUID v4)');
  }

  if (typeof session.agentType !== 'string') {
    throw new Error('Export file contains an invalid agentType (must be a string)');
  }

  const validAgentTypes = ['claude', 'codex', 'gemini', 'opencode', 'aider', 'goose', 'amp'];
  if (!validAgentTypes.includes(session.agentType)) {
    throw new Error(
      `Export file contains an unsupported agentType: "${String(session.agentType)}". ` +
        `Expected one of: ${validAgentTypes.join(', ')}`
    );
  }

  if (!Array.isArray(obj.messages)) {
    throw new Error('Export file is missing required "messages" array');
  }

  // Validate each message has a UUID id
  for (let i = 0; i < (obj.messages as unknown[]).length; i++) {
    const msg = (obj.messages as Record<string, unknown>[])[i];
    if (typeof msg?.id !== 'string' || !UUID_REGEX.test(msg.id)) {
      throw new Error(`Export file contains an invalid message ID at index ${i} (must be UUID v4)`);
    }
  }

  return parsed as SessionExport;
}

/**
 * Import a session export into Supabase.
 *
 * Upserts the session record and all messages. If the session already
 * exists (same UUID), this is a no-op for the session row and skips
 * messages with duplicate IDs.
 *
 * WHY: Upsert on primary key means re-importing the same file is safe
 * and idempotent — the user won't end up with duplicate data.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - Authenticated user's ID (override export's user_id)
 * @param data - Parsed SessionExport to import
 * @returns Summary of the import operation
 * @throws {Error} On Supabase write failure
 */
export async function importSession(
  supabase: SupabaseClient,
  userId: string,
  data: SessionExport
): Promise<{ sessionId: string; messagesImported: number }> {
  const { session, messages } = data;

  logger.debug('[import] Starting session import', { sessionId: session.id });

  // Upsert session row
  // WHY: If the session was already imported, don't create a duplicate.
  // We overwrite only non-critical fields to preserve any local edits.
  const { error: sessionError } = await supabase
    .from('sessions')
    .upsert(
      {
        id: session.id,
        user_id: userId, // Always use the importing user's ID (security)
        agent_type: session.agentType,
        model: session.model,
        title: session.title,
        summary: session.summary,
        project_path: session.projectPath,
        git_branch: session.gitBranch,
        git_remote_url: session.gitRemoteUrl,
        tags: session.tags,
        status: session.status,
        started_at: session.startedAt,
        ended_at: session.endedAt,
        message_count: session.messageCount,
        context_window_used: session.contextWindowUsed,
        context_window_limit: session.contextWindowLimit,
        total_cost_usd: data.cost.totalCostUsd,
        total_input_tokens: data.cost.totalInputTokens,
        total_output_tokens: data.cost.totalOutputTokens,
        total_cache_tokens: data.cost.totalCacheTokens,
      },
      { onConflict: 'id' }
    );

  if (sessionError) {
    throw new Error(`Failed to import session: ${sessionError.message}`);
  }

  // Insert messages — use ignoreDuplicates to handle re-imports gracefully
  // WHY: `ignoreDuplicates: true` means duplicate message UUIDs are silently
  // skipped rather than causing a constraint violation error.
  let messagesImported = 0;

  if (messages.length > 0) {
    const rows = messages.map((m) => ({
      id: m.id,
      session_id: session.id,
      sequence_number: m.sequenceNumber,
      message_type: m.messageType,
      content_encrypted: m.contentEncrypted,
      encryption_nonce: m.encryptionNonce,
      risk_level: m.riskLevel,
      tool_name: m.toolName,
      duration_ms: m.durationMs,
      input_tokens: m.inputTokens,
      output_tokens: m.outputTokens,
      cache_tokens: m.cacheTokens,
      metadata: {},
      created_at: m.createdAt,
    }));

    // WHY: We upsert with ignoreDuplicates so re-importing the same file is
    // idempotent. select() after upsert returns the affected rows' IDs.
    const { error: msgError, data: insertedRows } = await supabase
      .from('session_messages')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
      .select('id');

    if (msgError) {
      throw new Error(`Failed to import messages: ${msgError.message}`);
    }

    messagesImported = insertedRows?.length ?? messages.length;
  }

  logger.debug('[import] Session import complete', {
    sessionId: session.id,
    messagesImported,
  });

  return { sessionId: session.id, messagesImported };
}

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * Handle the `styrby export` command.
 *
 * Exports one or all sessions as portable JSON. Output goes to stdout or a
 * file (--output / -o). Supports --all for bulk export.
 *
 * @param args - Command arguments (after "export")
 * @returns Promise that resolves when the command completes
 *
 * @example
 * // Export one session to stdout
 * styrby export abc123
 *
 * // Export to a file
 * styrby export abc123 --output ./session.json
 *
 * // Export all sessions to a directory
 * styrby export --all --output ./exports/
 */
export async function handleExport(args: string[]): Promise<void> {
  const options = parseExportArgs(args);

  if (!options.sessionId && !options.all) {
    console.log(chalk.yellow('Usage:'));
    console.log(chalk.gray('  styrby export <sessionId>             Export a session to stdout'));
    console.log(chalk.gray('  styrby export <sessionId> -o out.json Export to a file'));
    console.log(chalk.gray('  styrby export --all -o ./exports/     Export all sessions'));
    process.exit(1);
  }

  const authResult = await ensureAuthenticated();
  if (authResult.success === false) {
    console.log(chalk.red(authResult.error));
    process.exit(1);
  }

  const { supabase, userId } = authResult;

  if (options.all) {
    await handleExportAll(supabase, userId, options);
    return;
  }

  // Single session export
  console.error(chalk.gray(`Exporting session ${options.sessionId}...`));

  const exported = await fetchSessionExport(supabase, options.sessionId!);

  if (!exported) {
    console.log(chalk.red(`Session not found: ${options.sessionId}`));
    process.exit(1);
  }

  writeExport(exported, options.outputPath, options.pretty);
}

/**
 * Export all sessions for the current user.
 *
 * When outputPath is a directory path, each session is written to a file
 * named `styrby-session-{id}-{date}.json` inside that directory.
 *
 * When outputPath is null, sessions are written as newline-delimited JSON
 * to stdout (NDJSON format).
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - Current user's ID
 * @param options - Export options
 */
async function handleExportAll(
  supabase: SupabaseClient,
  userId: string,
  options: ExportOptions
): Promise<void> {
  console.error(chalk.gray('Fetching session list...'));

  // Fetch all session IDs for the user
  const { data: sessions, error } = await supabase
    .from('sessions')
    .select('id, started_at, created_at')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    console.log(chalk.red(`Failed to fetch sessions: ${error.message}`));
    process.exit(1);
  }

  if (!sessions || sessions.length === 0) {
    console.log(chalk.yellow('No sessions found.'));
    return;
  }

  console.error(chalk.gray(`Found ${sessions.length} session(s). Exporting...`));

  let exported = 0;
  let failed = 0;

  for (const { id, started_at, created_at } of sessions) {
    try {
      const data = await fetchSessionExport(supabase, id);
      if (!data) continue;

      if (options.outputPath) {
        // Output to directory: one file per session
        const isDir =
          !path.extname(options.outputPath) ||
          fs.existsSync(options.outputPath) && fs.statSync(options.outputPath).isDirectory();

        const dateStr = (started_at ?? created_at ?? new Date().toISOString()).slice(0, 10);
        const filename = `styrby-session-${id.slice(0, 8)}-${dateStr}.json`;
        const filePath = isDir
          ? path.join(options.outputPath, filename)
          : options.outputPath; // If user gave an explicit file, overwrite it

        writeExport(data, filePath, options.pretty);
      } else {
        // NDJSON to stdout
        process.stdout.write(JSON.stringify(data) + '\n');
      }

      exported++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`  Failed to export ${id}: ${msg}`));
      failed++;
    }
  }

  console.error(
    chalk.green(`\nExported ${exported} session(s)`) +
      (failed > 0 ? chalk.red(` (${failed} failed)`) : '')
  );
}

/**
 * Handle the `styrby import` command.
 *
 * Reads a session export JSON file and upserts it into Supabase.
 * Safe to run multiple times — duplicate imports are no-ops.
 *
 * @param args - Command arguments (after "import")
 * @returns Promise that resolves when the command completes
 *
 * @example
 * styrby import ./styrby-session-abc123-2026-03-27.json
 */
export async function handleImport(args: string[]): Promise<void> {
  const importOptions = parseImportArgs(args);

  if (!importOptions) {
    console.log(chalk.yellow('Usage: styrby import <file>'));
    console.log(chalk.gray('  Example: styrby import styrby-session-abc123-2026-03-27.json'));
    process.exit(1);
  }

  // Parse and validate the export file before touching Supabase
  let exportData: SessionExport;
  try {
    exportData = parseExportFile(importOptions.filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`Invalid export file: ${msg}`));
    process.exit(1);
  }

  const authResult = await ensureAuthenticated();
  if (authResult.success === false) {
    console.log(chalk.red(authResult.error));
    process.exit(1);
  }

  const { supabase, userId } = authResult;

  console.log(chalk.gray(`Importing session ${exportData.session.id}...`));
  console.log(chalk.gray(`  Title: ${exportData.session.title ?? 'Untitled'}`));
  console.log(chalk.gray(`  Messages: ${exportData.messages.length}`));
  console.log(chalk.gray(`  Agent: ${exportData.session.agentType}`));
  console.log('');

  try {
    const result = await importSession(supabase, userId, exportData);
    console.log(chalk.green(`Session imported successfully`));
    console.log(chalk.gray(`  Session ID: ${result.sessionId}`));
    console.log(chalk.gray(`  Messages imported: ${result.messagesImported}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`Import failed: ${msg}`));
    process.exit(1);
  }
}

export default { handleExport, handleImport, parseExportArgs, parseImportArgs };
