/**
 * Privacy Command Handler
 *
 * Implements `styrby privacy`, `styrby export-data`, and `styrby delete-account`
 * subcommands for GDPR self-service from the terminal.
 *
 * ## `styrby export-data`
 *
 * Exports ALL user data (not just sessions) as a GDPR Art. 15/20 Subject
 * Access Request. Downloads the full export bundle as a JSON file. Calls
 * POST /api/account/export on the web API.
 *
 * ```
 * styrby export-data                          # Write JSON to stdout
 * styrby export-data -o styrby-export.json    # Write to file
 * ```
 *
 * ## `styrby delete-account`
 *
 * CLI equivalent of the web Privacy Center "Delete Account" flow. Two-step
 * confirmation: user must type their account email to proceed.
 *
 * ```
 * styrby delete-account
 * ```
 *
 * ## Security Note
 *
 * Both commands use the Bearer token from the local credentials file. The
 * delete-account command requires confirmation by typing the registered email
 * address (not a passphrase) to align with the web UI's confirmation UX.
 *
 * @module commands/privacy
 *
 * Audit standards:
 *   GDPR Art. 15 — Subject Access Request (export-data)
 *   GDPR Art. 20 — Data portability (export-data)
 *   GDPR Art. 17 — Right to Erasure (delete-account)
 *   SOC2 CC6.5   — Access removal on account deletion
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { createClient } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';
import { loadPersistedData } from '@/persistence';
import { config as envConfig } from '@/env';
import { VERSION } from '@/index';

// ============================================================================
// Auth helper (shared with export.ts pattern)
// ============================================================================

/**
 * Load credentials and create an authenticated Supabase client.
 *
 * @returns Authenticated client + userId + accessToken, or an error message.
 */
async function ensureAuthenticated(): Promise<
  | { success: true; accessToken: string; userId: string }
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

  return { success: true, accessToken: data.accessToken, userId: data.userId };
}

/** Returns the base URL for the Styrby web API. */
function getWebApiBase(): string {
  return process.env.STYRBY_API_URL ?? 'https://styrbyapp.com';
}

// ============================================================================
// Export Data
// ============================================================================

/**
 * Options for the `styrby export-data` command.
 */
interface ExportDataOptions {
  /** Output file path. Null = write JSON to stdout. */
  outputPath: string | null;
  /** Pretty-print JSON (default true). */
  pretty: boolean;
}

/**
 * Parse command-line arguments for `styrby export-data`.
 *
 * @param args - Arguments after "export-data"
 * @returns Parsed options
 *
 * @example
 * parseExportDataArgs(['-o', 'my-data.json'])
 * // => { outputPath: 'my-data.json', pretty: true }
 */
export function parseExportDataArgs(args: string[]): ExportDataOptions {
  const options: ExportDataOptions = { outputPath: null, pretty: true };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' || arg === '-o') {
      options.outputPath = args[++i] ?? null;
    } else if (arg === '--compact') {
      options.pretty = false;
    }
  }

  return options;
}

/**
 * Handle the `styrby export-data` command.
 *
 * Calls POST /api/account/export (same endpoint as the web UI and mobile app)
 * which fetches all 29 user-related tables and returns JSON. Writes the result
 * to a file or stdout.
 *
 * WHY call the web API instead of querying Supabase directly:
 *   The export endpoint uses the service role to ensure all tables are captured
 *   including those not directly accessible via the anon key (e.g. audit_log
 *   can only be inserted via service role). The web API also writes the
 *   data_export_requests audit row and audit_log entry automatically.
 *
 * @param args - Command arguments after "export-data"
 */
export async function handleExportData(args: string[]): Promise<void> {
  const options = parseExportDataArgs(args);

  const authResult = await ensureAuthenticated();
  if (!authResult.success) {
    // WHY: TypeScript narrows the discriminated union via the success flag;
    // only after the falsy check does the error field become accessible.
    console.error(chalk.red((authResult as { success: false; error: string }).error));
    process.exit(1);
  }

  const { accessToken } = authResult;

  console.error(chalk.gray('Fetching your data from Styrby...'));
  console.error(chalk.gray('This may take a moment for accounts with many sessions.\n'));

  let response: Response;
  try {
    response = await fetch(`${getWebApiBase()}/api/account/export`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': `styrby-cli/${VERSION}`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Network error: ${msg}`));
    process.exit(1);
  }

  if (response.status === 429) {
    const raw = await response.json().catch(() => ({ retryAfter: 3600 })) as { retryAfter?: number };
    const minutes = Math.ceil((raw.retryAfter ?? 3600) / 60);
    console.error(chalk.yellow(`Rate limited: you can export once per hour. Try again in ${minutes} minutes.`));
    process.exit(1);
  }

  if (!response.ok) {
    const raw = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
    console.error(chalk.red(`Export failed (HTTP ${response.status}): ${raw.error ?? 'Unknown error'}`));
    process.exit(1);
  }

  const exportText = await response.text();

  if (options.outputPath) {
    // Validate path (prevent writing to system dirs)
    const resolved = path.resolve(options.outputPath);
    const dangerous = ['/etc', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/var', '/root', '/boot', '/sys', '/proc'];
    const lower = resolved.toLowerCase();
    for (const prefix of dangerous) {
      if (lower === prefix || lower.startsWith(prefix + '/')) {
        console.error(chalk.red(`Refusing to write to system directory: ${resolved}`));
        process.exit(1);
      }
    }

    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });

    // Re-format if pretty-printing was requested
    let output = exportText;
    if (options.pretty) {
      try {
        output = JSON.stringify(JSON.parse(exportText), null, 2);
      } catch {
        // Leave as-is if JSON.parse fails (already pretty from server)
      }
    }

    fs.writeFileSync(resolved, output, 'utf-8');
    console.log(chalk.green(`\nData exported to: ${resolved}`));
    console.log(chalk.gray('This file contains all your Styrby data (GDPR Art. 15/20).'));
    console.log(chalk.gray('Session message content is encrypted — only your CLI can decrypt it.'));
  } else {
    // Stdout: let the user pipe to jq, pbcopy, etc.
    process.stdout.write(exportText + '\n');
  }
}

// ============================================================================
// Delete Account
// ============================================================================

/**
 * Prompt the user for a line of input from stdin.
 *
 * @param question - Prompt text to display
 * @returns The user's input string
 */
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Handle the `styrby delete-account` command.
 *
 * Two-step confirmation flow:
 *   1. Show what will be deleted and the 30-day grace window.
 *   2. User must type their registered email address to confirm.
 *
 * WHY email confirmation (not passphrase):
 *   The web UI requires typing the account email; the CLI uses the same
 *   gate for consistency. A user who has forgotten their email cannot
 *   confirm the deletion (appropriate security friction).
 *
 * WHY 30-day grace window:
 *   GDPR Art. 17(3)(e) allows a recovery window. We use 30 days matching
 *   the web UI's behavior.
 *
 * @param _args - Not used (no flags for this command)
 */
export async function handleDeleteAccount(_args: string[]): Promise<void> {
  const authResult = await ensureAuthenticated();
  if (!authResult.success) {
    // WHY: TypeScript narrows the discriminated union via the success flag;
    // only after the falsy branch does the error field become accessible.
    console.error(chalk.red((authResult as { success: false; error: string }).error));
    process.exit(1);
  }

  const { accessToken } = authResult;

  // Step 1: Info
  console.log(chalk.bold.red('\nDelete Account'));
  console.log('');
  console.log(chalk.yellow('This will permanently delete:'));
  console.log(chalk.gray('  - All sessions and message history'));
  console.log(chalk.gray('  - Machine pairings and encryption keys'));
  console.log(chalk.gray('  - Agent configurations and budget alerts'));
  console.log(chalk.gray('  - Billing history and subscription data'));
  console.log(chalk.gray('  - Audit log and all settings'));
  console.log('');
  console.log(chalk.bold('30-day grace window:'));
  console.log(chalk.gray('  Your account is deactivated immediately.'));
  console.log(chalk.gray('  All data is permanently removed after 30 days.'));
  console.log(chalk.gray('  Contact support@styrbyapp.com within that window to cancel.'));
  console.log('');

  // First confirmation
  const firstConfirm = await promptLine(
    chalk.yellow('Type "yes" to continue (or press Enter to cancel): '),
  );

  if (firstConfirm.toLowerCase() !== 'yes') {
    console.log(chalk.gray('Cancelled.'));
    return;
  }

  // Step 2: Email confirmation
  console.log('');
  const emailInput = await promptLine(
    chalk.yellow('Type your account email address to confirm: '),
  );

  // Fetch the current user's email to validate
  const supabase = createClient(
    envConfig.supabaseUrl,
    envConfig.supabaseAnonKey ?? '',
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    },
  );

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user?.email) {
    console.error(chalk.red('Could not verify your account. Please try again.'));
    process.exit(1);
  }

  if (emailInput.toLowerCase() !== user.email.toLowerCase()) {
    console.error(chalk.red(`Email does not match. Expected: ${user.email}`));
    console.error(chalk.gray('Account deletion cancelled.'));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.gray('Initiating account deletion...'));

  let deleteResponse: Response;
  try {
    deleteResponse = await fetch(`${getWebApiBase()}/api/account/delete`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': `styrby-cli/${VERSION}`,
      },
      body: JSON.stringify({
        confirmation: 'DELETE MY ACCOUNT',
        reason: 'User-initiated from styrby-cli delete-account command',
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Network error: ${msg}`));
    process.exit(1);
  }

  if (deleteResponse.status === 429) {
    console.error(chalk.yellow('Rate limited: account deletion can only be attempted once per day.'));
    process.exit(1);
  }

  if (!deleteResponse.ok) {
    const raw = await deleteResponse.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
    console.error(chalk.red(`Deletion failed (HTTP ${deleteResponse.status}): ${raw.error ?? 'Unknown error'}`));
    process.exit(1);
  }

  const result = await deleteResponse.json() as { message?: string };

  console.log('');
  console.log(chalk.green('Account deletion initiated.'));
  console.log(chalk.gray(result.message ?? 'Your data will be permanently removed in 30 days.'));
  console.log('');
  console.log(chalk.gray('Your local pairing information has been left in place.'));
  console.log(chalk.gray('Run "styrby onboard" on a new account to start fresh.'));

  logger.debug('[privacy] delete-account completed', { userId: user.id });
}

// ============================================================================
// Privacy Hub
// ============================================================================

/**
 * Handle the `styrby privacy` command (shows available privacy subcommands).
 *
 * @param args - Arguments after "privacy"
 */
export async function handlePrivacy(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'export':
    case 'export-data':
      await handleExportData(rest);
      break;

    case 'delete':
    case 'delete-account':
      await handleDeleteAccount(rest);
      break;

    default:
      console.log(chalk.bold('Styrby Privacy Controls'));
      console.log('');
      console.log(chalk.gray('Available commands:'));
      console.log('  ' + chalk.cyan('styrby privacy export') + chalk.gray('           — Export all your data (GDPR Art. 15/20)'));
      console.log('  ' + chalk.cyan('styrby privacy delete') + chalk.gray('           — Delete your account (GDPR Art. 17)'));
      console.log('');
      console.log(chalk.gray('Options for export:'));
      console.log('  ' + chalk.gray('-o, --output <file>') + chalk.gray('  Write to file (default: stdout)'));
      console.log('  ' + chalk.gray('--compact') + chalk.gray('           Output compact JSON'));
      console.log('');
      console.log(chalk.gray('See also: https://styrbyapp.com/dashboard/privacy'));
      break;
  }
}

export default { handlePrivacy, handleExportData, handleDeleteAccount, parseExportDataArgs };
