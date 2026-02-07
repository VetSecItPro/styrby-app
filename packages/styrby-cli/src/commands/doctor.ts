/**
 * Doctor Command
 *
 * Runs a series of health checks to diagnose common issues
 * with the Styrby CLI installation and configuration.
 *
 * Checks performed:
 * 1. Node.js version compatibility
 * 2. Configuration file existence and validity
 * 3. Authentication status
 * 4. Installed agent detection (Claude, Codex, Gemini)
 *
 * @module commands/doctor
 */

import { logger } from '@/ui/logger';
import { isAuthenticated, loadConfig } from '@/configuration';
import { getAllAgentStatus } from '@/auth/agent-credentials';

// ============================================================================
// Types
// ============================================================================

/** Result of a single health check */
interface CheckResult {
  /** Human-readable name of the check */
  name: string;
  /** Whether the check passed */
  passed: boolean;
  /** Optional detail message */
  message?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum supported Node.js major version */
const MIN_NODE_MAJOR = 18;

// ============================================================================
// Health Checks
// ============================================================================

/**
 * Checks that the current Node.js version meets the minimum requirement.
 *
 * @returns A CheckResult indicating whether the Node.js version is sufficient
 */
function checkNodeVersion(): CheckResult {
  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  const passed = major >= MIN_NODE_MAJOR;
  return {
    name: 'Node.js version',
    passed,
    message: passed
      ? `${process.version} (>= ${MIN_NODE_MAJOR} required)`
      : `${process.version} is below minimum v${MIN_NODE_MAJOR}`,
  };
}

/**
 * Checks that the Styrby configuration file can be loaded.
 *
 * @returns A CheckResult indicating whether the config file is valid
 */
function checkConfig(): CheckResult {
  try {
    const config = loadConfig();
    const hasConfig = config !== null && typeof config === 'object';
    return {
      name: 'Configuration',
      passed: hasConfig,
      message: hasConfig ? 'Config file loaded successfully' : 'No config found',
    };
  } catch {
    return {
      name: 'Configuration',
      passed: false,
      message: 'Failed to load config file',
    };
  }
}

/**
 * Checks whether the user is currently authenticated.
 *
 * @returns A CheckResult indicating authentication status
 */
function checkAuth(): CheckResult {
  const authed = isAuthenticated();
  return {
    name: 'Authentication',
    passed: authed,
    message: authed ? 'Authenticated' : 'Not authenticated — run `styrby onboard`',
  };
}

/**
 * Checks which AI agents are installed and accessible.
 *
 * getAllAgentStatus() returns Record<AgentType, AgentStatus>.
 * We convert to an array and filter for installed agents.
 *
 * @returns A CheckResult summarizing agent availability
 */
async function checkAgents(): Promise<CheckResult> {
  try {
    const statusRecord = await getAllAgentStatus();
    const statuses = Object.values(statusRecord);
    const available = statuses.filter((s) => s.installed);
    const names = available.map((s) => s.name).join(', ');
    return {
      name: 'AI Agents',
      passed: available.length > 0,
      message:
        available.length > 0
          ? `${available.length} agent(s) found: ${names}`
          : 'No agents detected — run `styrby install-agent`',
    };
  } catch {
    return {
      name: 'AI Agents',
      passed: false,
      message: 'Could not detect agents',
    };
  }
}

// ============================================================================
// Main
// ============================================================================

/**
 * Runs all health checks and prints a summary report.
 *
 * Called from the interactive menu or directly via `styrby doctor`.
 * Each check runs independently; a single failure does not block others.
 *
 * @returns A promise that resolves when all checks are complete
 */
export async function runDoctor(): Promise<void> {
  logger.info('Running Styrby health checks...\n');

  const results: CheckResult[] = [];

  // Synchronous checks
  results.push(checkNodeVersion());
  results.push(checkConfig());
  results.push(checkAuth());

  // Async checks
  results.push(await checkAgents());

  // Print results
  let allPassed = true;
  for (const result of results) {
    const icon = result.passed ? '✓' : '✗';
    const status = result.passed ? 'PASS' : 'FAIL';
    const detail = result.message ? ` — ${result.message}` : '';
    logger.info(`  ${icon} [${status}] ${result.name}${detail}`);
    if (!result.passed) {
      allPassed = false;
    }
  }

  logger.info('');
  if (allPassed) {
    logger.info('All checks passed. Styrby is healthy.');
  } else {
    logger.info('Some checks failed. Review the issues above.');
  }
}
