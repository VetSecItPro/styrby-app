/**
 * Doctor - CLI Health Check
 *
 * Runs diagnostics to verify CLI setup and connectivity.
 *
 * @module ui/doctor
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { isAuthenticated, getMachineId } from '@/configuration';
import { loadPersistedData } from '@/persistence';
import { config } from '@/env';

const execAsync = promisify(exec);

/**
 * Diagnostic check result
 */
export interface DiagnosticResult {
  name: string;
  passed: boolean;
  message: string;
  fix?: string;
}

/**
 * Check if a CLI command exists.
 *
 * @param command - Command to check
 * @returns True if command exists
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    // Use 'which' on Unix, 'where' on Windows
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    await execAsync(`${whichCmd} ${command}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check network connectivity to a URL.
 *
 * @param url - URL to check
 * @param timeoutMs - Timeout in milliseconds
 * @returns True if reachable
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
 * @returns Array of diagnostic results
 */
export async function runDiagnostics(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  // Check Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  results.push({
    name: 'Node.js Version',
    passed: nodeMajor >= 20,
    message: nodeMajor >= 20
      ? `Node.js ${nodeVersion} ✓`
      : `Node.js ${nodeVersion} (requires 20+)`,
    fix: nodeMajor < 20 ? 'Upgrade Node.js to version 20 or later' : undefined,
  });

  // Check network connectivity
  const networkOk = await checkNetwork('https://supabase.co');
  results.push({
    name: 'Network',
    passed: networkOk,
    message: networkOk ? 'Connected ✓' : 'No internet connection',
    fix: !networkOk ? 'Check your internet connection' : undefined,
  });

  // Check Supabase connectivity
  const supabaseOk = await checkNetwork(`${config.supabaseUrl}/rest/v1/`);
  results.push({
    name: 'Supabase',
    passed: supabaseOk,
    message: supabaseOk ? 'Connected ✓' : 'Cannot reach Supabase',
    fix: !supabaseOk ? 'Check SUPABASE_URL environment variable' : undefined,
  });

  // Check authentication
  results.push({
    name: 'Authentication',
    passed: isAuthenticated(),
    message: isAuthenticated()
      ? 'Authenticated ✓'
      : 'Not authenticated',
    fix: !isAuthenticated() ? 'Run `styrby onboard` to authenticate' : undefined,
  });

  // Check machine ID
  const machineId = getMachineId();
  results.push({
    name: 'Machine ID',
    passed: !!machineId,
    message: machineId ? `Machine ID: ${machineId.slice(0, 8)}...` : 'No machine ID',
    fix: !machineId ? 'Run `styrby onboard` to register this machine' : undefined,
  });

  // Check mobile pairing
  const persistedData = loadPersistedData();
  const isPaired = !!persistedData?.pairedAt;
  results.push({
    name: 'Mobile Paired',
    passed: isPaired,
    message: isPaired
      ? `Paired ✓ (${new Date(persistedData!.pairedAt!).toLocaleDateString()})`
      : 'Not paired with mobile app',
    fix: !isPaired ? 'Run `styrby pair` to pair with mobile app' : undefined,
  });

  // Check Claude Code CLI
  const claudeExists = await commandExists('claude');
  results.push({
    name: 'Claude Code CLI',
    passed: claudeExists,
    message: claudeExists ? 'Installed ✓' : 'Not found',
    fix: !claudeExists ? 'Install Claude Code: npm install -g @anthropic-ai/claude-code' : undefined,
  });

  // Check Codex CLI (OpenAI)
  const codexExists = await commandExists('codex');
  results.push({
    name: 'Codex CLI',
    passed: codexExists,
    message: codexExists ? 'Installed ✓' : 'Not found (optional)',
    // No fix - Codex is optional
  });

  // Check Gemini CLI
  const geminiExists = await commandExists('gemini');
  results.push({
    name: 'Gemini CLI',
    passed: geminiExists,
    message: geminiExists ? 'Installed ✓' : 'Not found (optional)',
    // No fix - Gemini is optional
  });

  return results;
}

/**
 * Print diagnostic results to console.
 *
 * @param results - Results to print
 */
export function printDiagnostics(results: DiagnosticResult[]): void {
  console.log('\n🔍 Styrby CLI Diagnostics\n');

  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    console.log(`${icon} ${result.name}: ${result.message}`);
    if (result.fix) {
      console.log(`   💡 Fix: ${result.fix}`);
    }
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks passed\n`);
}

/**
 * Run doctor and print results.
 */
export async function runDoctor(): Promise<boolean> {
  const results = await runDiagnostics();
  printDiagnostics(results);
  return results.every(r => r.passed);
}

export default {
  runDiagnostics,
  printDiagnostics,
  runDoctor,
};
