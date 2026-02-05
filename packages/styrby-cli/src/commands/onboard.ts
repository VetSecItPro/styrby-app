/**
 * Onboard Command
 *
 * 60-second interactive setup wizard for new users.
 * Handles authentication, machine registration, and mobile pairing.
 *
 * Flow:
 * 1. Pre-flight checks (Node version, network, config dir)
 * 2. Browser OAuth authentication
 * 3. Machine registration in Supabase
 * 4. QR code for mobile pairing
 * 5. Wait for mobile connection via Realtime
 *
 * @module commands/onboard
 */

import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/ui/logger';
import { isAuthenticated, setConfigValue, loadConfig } from '@/configuration';
import { savePersistedData, loadPersistedData } from '@/persistence';
import { startBrowserAuth, AuthError } from '@/auth/browser-auth';
import { registerMachine, getMachineName } from '@/auth/machine-registration';
import { getAllAgentStatus, type AgentStatus } from '@/auth/agent-credentials';
import {
  generatePairingToken,
  encodePairingUrl,
  PAIRING_EXPIRY_MINUTES,
} from 'styrby-shared';
import { RelayClient, createRelayClient } from 'styrby-shared';
import { VERSION } from '@/index';

// ============================================================================
// Types
// ============================================================================

/**
 * Onboard command options
 */
export interface OnboardOptions {
  /** Skip QR code pairing step */
  skipPairing?: boolean;
  /** Skip pre-flight diagnostic checks */
  skipDoctor?: boolean;
  /** Force re-authentication even if already authenticated */
  force?: boolean;
  /** Authentication timeout in milliseconds (default: 120000) */
  timeout?: number;
  /** Pairing wait timeout in milliseconds (default: 300000 = 5 minutes) */
  pairingTimeout?: number;
}

/**
 * Onboard result
 */
export interface OnboardResult {
  /** Whether onboarding completed successfully */
  success: boolean;
  /** User ID */
  userId?: string;
  /** User email */
  userEmail?: string;
  /** Machine ID */
  machineId?: string;
  /** Whether mobile was paired */
  mobilePaired?: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Pre-flight check result
 */
interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
}

// ============================================================================
// Constants
// ============================================================================

import { config } from '@/env';
const SUPABASE_URL = config.supabaseUrl;
const SUPABASE_ANON_KEY = config.supabaseAnonKey;

// ============================================================================
// Pre-flight Checks
// ============================================================================

/**
 * Run pre-flight diagnostic checks.
 *
 * @returns Array of check results
 */
async function runPreflightChecks(): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  // Check Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  checks.push({
    name: 'Node.js 20+',
    passed: nodeMajor >= 20,
    message: nodeMajor >= 20 ? 'OK' : `${nodeVersion} (requires 20+)`,
  });

  // Check network connectivity
  let networkOk = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch('https://supabase.co', { signal: controller.signal, method: 'HEAD' });
    clearTimeout(timeout);
    networkOk = true;
  } catch {
    networkOk = false;
  }
  checks.push({
    name: 'Network',
    passed: networkOk,
    message: networkOk ? 'OK' : 'No internet connection',
  });

  // Check config directory
  const { ensureConfigDir, CONFIG_DIR } = await import('@/configuration');
  let configOk = false;
  try {
    ensureConfigDir();
    configOk = true;
  } catch {
    configOk = false;
  }
  checks.push({
    name: 'Config directory',
    passed: configOk,
    message: configOk ? 'OK' : `Cannot create ${CONFIG_DIR}`,
  });

  return checks;
}

/**
 * Display pre-flight check results.
 *
 * @param checks - Check results
 * @returns True if all checks passed
 */
function displayPreflightChecks(checks: PreflightCheck[]): boolean {
  console.log(chalk.bold('\n  [1/6] Pre-flight checks...'));

  for (const check of checks) {
    const icon = check.passed ? chalk.green('OK') : chalk.red('FAIL');
    console.log(`        ${check.name.padEnd(18)} ${icon}`);
    if (!check.passed) {
      console.log(chalk.dim(`        ${check.message}`));
    }
  }

  return checks.every((c) => c.passed);
}

// ============================================================================
// Authentication Step
// ============================================================================

/**
 * Run browser authentication.
 *
 * @param options - Onboard options
 * @returns Auth result with tokens and user info
 */
async function runAuthentication(
  options: OnboardOptions
): Promise<{
  accessToken: string;
  refreshToken: string;
  userId: string;
  userEmail?: string;
}> {
  console.log(chalk.bold('\n  [2/6] Opening browser for authentication...'));
  console.log('        Please sign in with your Styrby account.');
  console.log(chalk.dim('        Waiting for authentication...'));

  try {
    const result = await startBrowserAuth({
      supabaseUrl: SUPABASE_URL,
      provider: 'github',
      timeout: options.timeout || 120000,
    });

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.user.id,
      userEmail: result.user.email,
    };
  } catch (error) {
    if (error instanceof AuthError) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
    throw error;
  }
}

// ============================================================================
// Machine Registration Step
// ============================================================================

/**
 * Register this machine with Supabase.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - User ID
 * @returns Machine ID
 */
async function runMachineRegistration(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  console.log(chalk.bold('\n  [4/6] Registering this machine...'));

  const machineName = getMachineName();
  console.log(`        Machine: ${machineName}`);

  const result = await registerMachine(supabase, userId);

  console.log(`        ID: ${result.machine.machineId.slice(0, 16)}...`);

  if (result.isNew) {
    console.log(chalk.dim('        (New machine registered)'));
  } else {
    console.log(chalk.dim('        (Existing machine reconnected)'));
  }

  return result.machine.machineId;
}

// ============================================================================
// Mobile Pairing Step
// ============================================================================

/**
 * Generate QR code and wait for mobile pairing.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - User ID
 * @param machineId - Machine ID
 * @param options - Onboard options
 * @returns True if mobile paired successfully
 */
/**
 * Detect and display installed agents.
 *
 * @returns Agent detection results
 */
async function runAgentDetection(): Promise<Record<string, AgentStatus>> {
  console.log(chalk.bold('\n  [5/6] Detecting AI coding agents...'));

  const agents = await getAllAgentStatus();
  const installed = Object.values(agents).filter((a) => a.installed);

  if (installed.length === 0) {
    console.log(chalk.yellow('        No agents found'));
    console.log(chalk.dim('        Install Claude Code, Codex, or Gemini CLI'));
  } else {
    for (const agent of Object.values(agents)) {
      if (agent.installed) {
        const status = agent.configured
          ? chalk.green('ready')
          : chalk.yellow('needs login');
        console.log(`        ${agent.name.padEnd(14)} ${status}`);
      } else {
        console.log(`        ${chalk.dim(agent.name.padEnd(14))} ${chalk.dim('not installed')}`);
      }
    }
  }

  return agents;
}

async function runMobilePairing(
  supabase: SupabaseClient,
  userId: string,
  machineId: string,
  options: OnboardOptions
): Promise<boolean> {
  console.log(chalk.bold('\n  [6/6] Generate QR code for mobile pairing...'));

  // Generate pairing token and QR code
  const token = generatePairingToken();
  const deviceName = getMachineName();

  const payload = {
    version: 1 as const,
    token,
    userId,
    machineId,
    deviceName,
    supabaseUrl: SUPABASE_URL,
    expiresAt: new Date(Date.now() + PAIRING_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  };

  const pairingUrl = encodePairingUrl(payload);

  // Display QR code
  console.log('\n');

  await new Promise<void>((resolve) => {
    qrcode.generate(pairingUrl, { small: true }, (qr: string) => {
      // Indent the QR code
      const indented = qr
        .split('\n')
        .map((line) => '        ' + line)
        .join('\n');
      console.log(indented);
      resolve();
    });
  });

  console.log('\n        Scan with Styrby app on your phone');
  console.log(`        Expires in ${PAIRING_EXPIRY_MINUTES} minutes`);
  console.log(chalk.dim('        Waiting for mobile to connect...'));
  console.log(chalk.dim('        (Press Ctrl+C to skip)\n'));

  // Create relay client and wait for mobile presence
  const relay = createRelayClient({
    supabase,
    userId,
    deviceId: machineId,
    deviceType: 'cli',
    deviceName,
    platform: process.platform,
    debug: process.env.STYRBY_LOG_LEVEL === 'debug',
  });

  try {
    await relay.connect();

    // Wait for mobile device to join
    const pairingTimeoutMs = options.pairingTimeout || 300000;
    const paired = await waitForMobile(relay, pairingTimeoutMs);

    if (paired) {
      // Send test ping
      await relay.sendCommand('ping');
      console.log(chalk.green('\n  SUCCESS! Mobile paired successfully.\n'));
      return true;
    } else {
      console.log(chalk.yellow('\n  Pairing skipped or timed out.\n'));
      return false;
    }
  } catch (error) {
    logger.debug('Pairing error', { error });
    console.log(chalk.yellow('\n  Could not complete pairing. You can pair later with: styrby pair\n'));
    return false;
  } finally {
    await relay.disconnect();
  }
}

/**
 * Wait for mobile device to join the relay channel.
 *
 * @param relay - Connected relay client
 * @param timeoutMs - Timeout in milliseconds
 * @returns True if mobile joined
 */
function waitForMobile(relay: RelayClient, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, timeoutMs);

    // Check if mobile is already connected
    if (relay.isDeviceTypeOnline('mobile')) {
      clearTimeout(timeout);
      resolve(true);
      return;
    }

    // Wait for mobile to join
    const onJoin = (presence: { device_type: string }) => {
      if (presence.device_type === 'mobile') {
        clearTimeout(timeout);
        relay.off('presence_join', onJoin);
        resolve(true);
      }
    };

    relay.on('presence_join', onJoin);

    // Handle Ctrl+C gracefully
    const onInterrupt = () => {
      clearTimeout(timeout);
      relay.off('presence_join', onJoin);
      process.off('SIGINT', onInterrupt);
      resolve(false);
    };

    process.on('SIGINT', onInterrupt);
  });
}

// ============================================================================
// Main Onboard Function
// ============================================================================

/**
 * Run the complete onboarding flow.
 *
 * @param options - Onboard options
 * @returns Onboard result
 *
 * @example
 * const result = await runOnboard();
 * if (result.success) {
 *   console.log('Welcome,', result.userEmail);
 * }
 */
export async function runOnboard(options: OnboardOptions = {}): Promise<OnboardResult> {
  // Header
  console.log(chalk.bold.cyan(`\n  Styrby CLI v${VERSION}`));
  console.log("  Let's get you set up in under 60 seconds!\n");

  // Check if already authenticated
  if (isAuthenticated() && !options.force) {
    const data = loadPersistedData();
    console.log(chalk.yellow('  Already authenticated!'));
    console.log(`  User: ${data?.userId || 'unknown'}`);
    console.log('\n  Run with --force to re-authenticate.\n');

    return {
      success: true,
      userId: data?.userId,
      machineId: data?.machineId,
      mobilePaired: false,
    };
  }

  // Step 1: Pre-flight checks
  if (!options.skipDoctor) {
    const checks = await runPreflightChecks();
    const allPassed = displayPreflightChecks(checks);

    if (!allPassed) {
      console.log(chalk.red('\n  Pre-flight checks failed. Please fix the issues above.\n'));
      return {
        success: false,
        error: 'Pre-flight checks failed',
      };
    }
  }

  // Step 2: Authentication
  let authData: Awaited<ReturnType<typeof runAuthentication>>;
  try {
    authData = await runAuthentication(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Authentication failed';
    console.log(chalk.red(`\n  ${message}\n`));
    return {
      success: false,
      error: message,
    };
  }

  // Step 3: Display welcome
  console.log(chalk.bold('\n  [3/6] Authentication complete!'));
  console.log(`        Welcome, ${authData.userEmail || authData.userId}`);

  // Save credentials
  savePersistedData({
    userId: authData.userId,
    accessToken: authData.accessToken,
    refreshToken: authData.refreshToken,
    authenticatedAt: new Date().toISOString(),
  });

  setConfigValue('userId', authData.userId);
  setConfigValue('authToken', authData.accessToken);

  // Create authenticated Supabase client
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${authData.accessToken}`,
      },
    },
  });

  // Step 4: Machine registration
  let machineId: string;
  try {
    machineId = await runMachineRegistration(supabase, authData.userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Machine registration failed';
    console.log(chalk.red(`\n  ${message}\n`));
    return {
      success: false,
      userId: authData.userId,
      userEmail: authData.userEmail,
      error: message,
    };
  }

  // Save machine ID
  savePersistedData({
    machineId,
    machineName: getMachineName(),
  });

  setConfigValue('machineId', machineId);

  // Step 5: Agent detection
  await runAgentDetection();

  // Step 6: Mobile pairing (optional)
  let mobilePaired = false;
  if (!options.skipPairing) {
    try {
      mobilePaired = await runMobilePairing(supabase, authData.userId, machineId, options);
    } catch (error) {
      logger.debug('Pairing error', { error });
      // Don't fail onboarding if pairing fails
    }

    if (mobilePaired) {
      savePersistedData({
        pairedAt: new Date().toISOString(),
      });
    }
  }

  // Success!
  console.log(chalk.green("  You're all set!"));
  console.log('');
  console.log('  Try these commands:');
  console.log(chalk.cyan('    styrby              ') + chalk.dim('Interactive mode'));
  console.log(chalk.cyan('    styrby start        ') + chalk.dim('Start a coding session'));
  console.log(chalk.cyan('    styrby doctor       ') + chalk.dim('Check system health'));
  console.log('');

  return {
    success: true,
    userId: authData.userId,
    userEmail: authData.userEmail,
    machineId,
    mobilePaired,
  };
}

/**
 * Parse onboard command arguments.
 *
 * @param args - Command line arguments
 * @returns Parsed options
 */
export function parseOnboardArgs(args: string[]): OnboardOptions {
  const options: OnboardOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--skip-pairing':
        options.skipPairing = true;
        break;
      case '--skip-doctor':
        options.skipDoctor = true;
        break;
      case '--force':
      case '-f':
        options.force = true;
        break;
      case '--timeout':
        options.timeout = parseInt(args[++i], 10);
        break;
    }
  }

  return options;
}

/**
 * Default export for module
 */
export default {
  runOnboard,
  parseOnboardArgs,
};
