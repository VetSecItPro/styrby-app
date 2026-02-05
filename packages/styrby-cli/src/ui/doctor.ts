/**
 * Doctor - CLI Health Check
 *
 * Runs diagnostics to verify CLI setup and connectivity.
 * Checks include: Node.js version, network, Supabase, auth, machine ID,
 * mobile pairing, daemon status, config directory, and agent CLI installs.
 *
 * @module ui/doctor
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isAuthenticated, getMachineId } from '@/configuration';
import { loadPersistedData } from '@/persistence';
import { config } from '@/env';
import { getDaemonStatus } from '@/daemon/run';

const execAsync = promisify(exec);

/**
 * Diagnostic check result.
 * Each check produces one of these, indicating pass/fail status and
 * an optional fix suggestion for failures.
 */
export interface DiagnosticResult {
  /** Short name displayed as the check label */
  name: string;
  /** Whether the check passed */
  passed: boolean;
  /** Whether this check is informational only (not a pass/fail) */
  optional?: boolean;
  /** Human-readable status message */
  message: string;
  /** Suggested fix command or instruction (shown only on failure) */
  fix?: string;
}

/**
 * Check if a CLI command exists on the system PATH.
 *
 * @param command - Command name to look up
 * @returns True if the command is found
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    await execAsync(`${whichCmd} ${command}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check network connectivity to a URL via HEAD request.
 *
 * @param url - URL to probe
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns True if the URL responded within the timeout
 */
async function checkNetwork(url: string, timeoutMs: number = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    await fetch(url, { signal: controller.signal, method: 'HEAD' });
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run all diagnostic checks.
 *
 * Categories:
 * 1. Environment (Node.js, config directory)
 * 2. Connectivity (network, Supabase)
 * 3. Authentication & pairing
 * 4. Daemon status
 * 5. Agent CLI availability
 *
 * @returns Array of diagnostic results ordered by category
 */
export async function runDiagnostics(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  // ── Environment ────────────────────────────────────────────────────

  // Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  results.push({
    name: 'Node.js',
    passed: nodeMajor >= 20,
    message: nodeMajor >= 20
      ? `${nodeVersion}`
      : `${nodeVersion} (requires 20+)`,
    fix: nodeMajor < 20 ? 'Upgrade Node.js to version 20 or later' : undefined,
  });

  // Config directory
  const configDir = join(homedir(), '.styrby');
  const configExists = existsSync(configDir);
  results.push({
    name: 'Config Dir',
    passed: configExists,
    message: configExists ? configDir : 'Not found',
    fix: !configExists ? 'Run `styrby onboard` to create config directory' : undefined,
  });

  // ── Connectivity ───────────────────────────────────────────────────

  // Network connectivity (general)
  const networkOk = await checkNetwork('https://supabase.co');
  results.push({
    name: 'Network',
    passed: networkOk,
    message: networkOk ? 'Connected' : 'No internet connection',
    fix: !networkOk ? 'Check your internet connection' : undefined,
  });

  // Supabase project connectivity
  const supabaseOk = await checkNetwork(`${config.supabaseUrl}/rest/v1/`);
  results.push({
    name: 'Supabase',
    passed: supabaseOk,
    message: supabaseOk ? 'Connected' : 'Cannot reach Supabase',
    fix: !supabaseOk ? 'Check SUPABASE_URL environment variable' : undefined,
  });

  // ── Authentication & Pairing ───────────────────────────────────────

  // Authentication status
  const authed = isAuthenticated();
  results.push({
    name: 'Auth',
    passed: authed,
    message: authed ? 'Authenticated' : 'Not authenticated',
    fix: !authed ? 'Run `styrby onboard` to authenticate' : undefined,
  });

  // Machine ID registration
  const machineId = getMachineId();
  results.push({
    name: 'Machine ID',
    passed: !!machineId,
    message: machineId ? `${machineId.slice(0, 8)}...` : 'Not registered',
    fix: !machineId ? 'Run `styrby onboard` to register this machine' : undefined,
  });

  // Mobile pairing
  const persistedData = loadPersistedData();
  const isPaired = !!persistedData?.pairedAt;
  results.push({
    name: 'Mobile',
    passed: isPaired,
    message: isPaired
      ? `Paired (${new Date(persistedData!.pairedAt!).toLocaleDateString()})`
      : 'Not paired',
    fix: !isPaired ? 'Run `styrby pair` to pair with mobile app' : undefined,
  });

  // ── Daemon ─────────────────────────────────────────────────────────

  // WHY: The daemon keeps the relay connection alive in the background.
  // This check tells the user whether background connectivity is active.
  const daemonState = getDaemonStatus();
  results.push({
    name: 'Daemon',
    passed: daemonState.running,
    optional: true,
    message: daemonState.running
      ? `Running (PID ${daemonState.pid || 'unknown'})`
      : 'Stopped',
    fix: !daemonState.running ? 'Start with: styrby start' : undefined,
  });

  // ── Agent CLIs ─────────────────────────────────────────────────────

  // Claude Code CLI (primary agent)
  const claudeExists = await commandExists('claude');
  results.push({
    name: 'Claude Code',
    passed: claudeExists,
    message: claudeExists ? 'Installed' : 'Not found',
    fix: !claudeExists ? 'npm install -g @anthropic-ai/claude-code' : undefined,
  });

  // Codex CLI (optional)
  const codexExists = await commandExists('codex');
  results.push({
    name: 'Codex CLI',
    passed: codexExists,
    optional: true,
    message: codexExists ? 'Installed' : 'Not found (optional)',
  });

  // Gemini CLI (optional)
  const geminiExists = await commandExists('gemini');
  results.push({
    name: 'Gemini CLI',
    passed: geminiExists,
    optional: true,
    message: geminiExists ? 'Installed' : 'Not found (optional)',
  });

  return results;
}

/**
 * Print diagnostic results to console with chalk formatting.
 *
 * Uses green/red/yellow color coding for pass/fail/optional status.
 * Displays a summary line with pass count and overall status.
 *
 * @param results - Results to print
 */
export async function printDiagnostics(results: DiagnosticResult[]): Promise<void> {
  const chalk = (await import('chalk')).default;

  const SEPARATOR = chalk.gray('\u2500'.repeat(50));
  const LABEL_WIDTH = 14;

  console.log('');
  console.log(chalk.bold.cyan('  Styrby Doctor'));
  console.log(`  ${SEPARATOR}`);

  for (const result of results) {
    const label = chalk.bold(result.name.padEnd(LABEL_WIDTH));
    let statusText: string;

    if (result.passed) {
      statusText = chalk.green(result.message);
    } else if (result.optional) {
      statusText = chalk.yellow(result.message);
    } else {
      statusText = chalk.red(result.message);
    }

    console.log(`  ${label} ${statusText}`);

    if (result.fix && !result.passed) {
      console.log(`  ${''.padEnd(LABEL_WIDTH)} ${chalk.gray(`Fix: ${result.fix}`)}`);
    }
  }

  console.log(`  ${SEPARATOR}`);

  // Summary line: count only required checks (not optional)
  const required = results.filter(r => !r.optional);
  const requiredPassed = required.filter(r => r.passed).length;
  const allPassed = required.every(r => r.passed);

  const summaryColor = allPassed ? chalk.green : chalk.yellow;
  console.log(`  ${summaryColor(`${requiredPassed}/${required.length} required checks passed`)}`);

  const optionalResults = results.filter(r => r.optional);
  if (optionalResults.length > 0) {
    const optionalPassed = optionalResults.filter(r => r.passed).length;
    console.log(`  ${chalk.gray(`${optionalPassed}/${optionalResults.length} optional checks passed`)}`);
  }

  console.log('');
}

/**
 * Run all diagnostics and print formatted results.
 *
 * @returns True if all required (non-optional) checks passed
 */
export async function runDoctor(): Promise<boolean> {
  const results = await runDiagnostics();
  await printDiagnostics(results);
  const required = results.filter(r => !r.optional);
  return required.every(r => r.passed);
}

export default {
  runDiagnostics,
  printDiagnostics,
  runDoctor,
};
