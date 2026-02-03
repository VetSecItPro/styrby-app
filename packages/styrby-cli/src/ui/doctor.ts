/**
 * Doctor - CLI Health Check
 *
 * Runs diagnostics to verify CLI setup and connectivity.
 *
 * @module ui/doctor
 */

import { logger } from './logger';
import { isAuthenticated, getMachineId } from '@/configuration';

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

  // Check authentication
  results.push({
    name: 'Authentication',
    passed: isAuthenticated(),
    message: isAuthenticated()
      ? 'Authenticated ✓'
      : 'Not authenticated',
    fix: !isAuthenticated() ? 'Run `styrby auth` to authenticate' : undefined,
  });

  // Check machine ID
  const machineId = getMachineId();
  results.push({
    name: 'Machine ID',
    passed: !!machineId,
    message: machineId ? `Machine ID: ${machineId.slice(0, 8)}...` : 'No machine ID',
  });

  // TODO: Add more checks
  // - Supabase connectivity
  // - Claude Code CLI installed
  // - Codex CLI installed
  // - Gemini CLI installed

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
