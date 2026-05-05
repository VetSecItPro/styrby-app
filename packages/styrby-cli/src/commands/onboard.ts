/**
 * Onboard Command
 *
 * 60-second interactive setup wizard for new users.
 * Handles authentication (inline OTP), machine registration, smart agent
 * detection, QR pairing, and optional --measure timeline reporting.
 *
 * Optimized flow (Phase 1.6.5 - sub-60 s target):
 * 1. Pre-flight checks (Node version, network, config dir)
 * 2. Email OTP authentication  -- replaces browser-OAuth redirect
 * 3. Machine registration in Supabase
 * 4. Smart agent detection: scan PATH + common install locations
 *    - 0 found => redirect to `styrby install --interactive`
 *    - 1 found => auto-select (silent, no prompt)
 *    - N found => numbered picker
 * 5. QR code for mobile pairing (+ plain pair URL fallback)
 * 6. Wait for mobile connection via Realtime
 * 7. If --measure, print per-step timeline
 *
 * @module commands/onboard
 */

// WHY lazy imports at the top of each function:
// Per the CLI startup budget (PR #120), `styrby --version` must resolve in
// <150ms. Importing chalk, qrcode-terminal, supabase, etc. at module-load
// time would blow that budget. Every heavy module is dynamically imported
// inside the function that needs it.

import { logger } from '@/ui/logger';
import { isAuthenticated, setConfigValue } from '@/configuration';
import { savePersistedData, loadPersistedData, type SupportedAgentType } from '@/persistence';
import { registerMachine, getMachineName } from '@/auth/machine-registration';
import { detectAgents, type DetectedAgent, type AgentDetectResult } from '@/onboarding/agentDetect';
import { SpanRecorder } from '@/onboarding/bootstrap';
import { Logger } from '@styrby/shared/logging';
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
  /**
   * Print per-step timing after onboarding completes.
   * Useful for measuring baseline and verifying optimisations.
   */
  measure?: boolean;
  /**
   * Pre-supplied email for the OTP flow (used in testing / CI).
   * Skips the interactive email prompt.
   */
  email?: string;
  /**
   * Use browser OAuth (PKCE) instead of email OTP for authentication.
   *
   * WHY (ESC-1): Email OTP delivery latency dominates time-to-first-success
   * (~30s of email-deliverability wait on a cold inbox). Browser OAuth via the
   * existing PKCE + 127.0.0.1 callback flow finishes in ~10s if the user is
   * already signed into GitHub in their browser. Default stays OTP for
   * backwards compatibility; --browser is opt-in (or auto-suggested when OTP
   * appears stalled — see runOtpAuthentication's fallback prompt).
   */
  browser?: boolean;
  /**
   * First-message wait timeout (ms) after a successful pair (ESC-2).
   * Default: 60000 (60s). Set to 0 to skip the post-pair watcher entirely
   * (used by tests to keep runtime tight).
   */
  firstMessageTimeout?: number;
  /**
   * Threshold in ms before the OTP-stuck fallback prompt fires (ESC-1).
   * If sendOtp resolves but no code is pasted within this window, we offer
   * to switch to browser auth. Default: 5000.
   */
  otpFallbackPromptAfterMs?: number;
  /**
   * Window in ms the fallback prompt stays open before defaulting to "Y".
   * Default: 10000.
   */
  otpFallbackPromptTimeoutMs?: number;
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
  /** Timeline (populated when --measure is passed) */
  timeline?: import('@/onboarding/bootstrap').OnboardingTimeline;
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

/** Pair URL base — users without a camera can visit this in a browser. */
const PAIR_URL_BASE = 'https://pair.styrby.dev';

// ============================================================================
// Pre-flight Checks
// ============================================================================

/**
 * Run pre-flight diagnostic checks.
 *
 * @param spans - Span recorder for timing
 * @returns Array of check results
 */
async function runPreflightChecks(spans: SpanRecorder): Promise<PreflightCheck[]> {
  spans.start('preflight', 'Pre-flight checks');
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

  const allPassed = checks.every((c) => c.passed);
  spans.finish('preflight', allPassed);
  return checks;
}

/**
 * Display pre-flight check results.
 *
 * @param checks - Check results
 * @returns True if all checks passed
 */
async function displayPreflightChecks(checks: PreflightCheck[]): Promise<boolean> {
  const chalk = (await import('chalk')).default;
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
// Authentication Step (inline OTP)
// ============================================================================

/**
 * Auth result shape returned by every authentication path (OTP, browser, fallback).
 */
interface AuthOutcome {
  accessToken: string;
  refreshToken: string;
  userId: string;
  userEmail: string;
}

/**
 * Prompt the user with a yes/no question that defaults to "Y" if they hit
 * Enter, and auto-resolves to "Y" if no input arrives within `timeoutMs`.
 *
 * WHY exposed (ESC-1): the OTP fallback path needs to ask "Try browser auth
 * instead?" without blocking onboarding indefinitely if the user has stepped
 * away from the keyboard. A bare readline.question would hang forever.
 *
 * @param question - The prompt string (without trailing space)
 * @param timeoutMs - How long to wait before defaulting to "Y"
 * @param rl - Optional injected readline interface (for tests)
 * @returns true for "Y" (default), false for "N"
 */
export async function promptYesNoWithTimeout(
  question: string,
  timeoutMs: number,
  rl?: { question: (q: string, cb: (a: string) => void) => void; close?: () => void }
): Promise<boolean> {
  const readline = await import('node:readline');
  const ownsRl = !rl;
  const iface =
    rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ownsRl && 'close' in iface && typeof iface.close === 'function') {
        iface.close();
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(true), timeoutMs);

    iface.question(`${question} [Y/n]: `, (answer) => {
      const trimmed = (answer ?? '').trim().toLowerCase();
      if (trimmed === 'n' || trimmed === 'no') {
        finish(false);
      } else {
        // Empty input (Enter), "y", "yes", or anything else → default Y.
        finish(true);
      }
    });
  });
}

/**
 * Run browser-OAuth authentication via the existing PKCE + 127.0.0.1 server.
 *
 * WHY split out (ESC-1): this path is now reachable from two entry points —
 * an explicit `--browser` flag, and the OTP fallback prompt. Both call into
 * the same primitive; centralising it here keeps the timing/spans consistent.
 *
 * @param options - Onboard options (timeout honoured)
 * @param spans - Span recorder
 * @returns Auth outcome with tokens and user info
 * @throws when the browser flow times out, the user closes the tab, or the
 *   token exchange fails
 */
async function runBrowserAuthentication(
  options: OnboardOptions,
  spans: SpanRecorder
): Promise<AuthOutcome> {
  const chalk = (await import('chalk')).default;
  spans.start('auth_browser', 'Auth: browser OAuth');

  console.log(chalk.bold('\n  [2/6] Authentication — opening browser for sign-in...'));

  const { startBrowserAuth } = await import('@/auth/browser-auth');

  try {
    const result = await startBrowserAuth({
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      provider: 'github',
      timeout: options.timeout ?? 120000,
    });

    spans.finish('auth_browser');
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.user.id,
      userEmail: result.user.email ?? '',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Browser auth failed';
    spans.finish('auth_browser', false, message);
    throw new Error(`Authentication failed: ${message}`);
  }
}

/**
 * Run inline OTP authentication with a smart fallback to browser auth.
 *
 * WHY OTP as default:
 * Browser-OAuth opens a tab + polls a callback server (~10-15s on warm
 * machines, longer on cold ones). OTP email is typically sub-5s delivery and
 * a paste finishes in <2s — IF the email arrives promptly. When delivery
 * stalls (greylisting, spam filters, slow IMAP sync), the user is stuck.
 *
 * WHY the fallback prompt (ESC-1): If the OTP send completes but the user
 * hasn't pasted a code within `otpFallbackPromptAfterMs` (default 5s), we
 * offer to switch to browser auth right then. Default is "Y" so a tired user
 * just hits Enter and the browser flow takes over. They can decline ("n") to
 * keep waiting for the email.
 *
 * @param options - Onboard options (may include pre-supplied email for testing)
 * @param spans - Span recorder
 * @returns Auth result with tokens and user info
 */
async function runOtpAuthentication(
  options: OnboardOptions,
  spans: SpanRecorder
): Promise<AuthOutcome> {
  const chalk = (await import('chalk')).default;
  spans.start('auth_start', 'Auth: send OTP');

  console.log(chalk.bold('\n  [2/6] Authentication — enter your email for a one-time code.'));

  const { sendOtp, verifyOtp, promptEmail, promptOtpCode } = await import(
    '@/onboarding/otpAuth'
  );
  const { createClient } = await import('@supabase/supabase-js');
  const readline = await import('node:readline');

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  // Test/CI shortcut: if the caller pre-supplied an OTP token, run the same
  // single-shot flow as before — no fallback prompt, no readline juggling.
  if (options.email && process.env.STYRBY_TEST_OTP_TOKEN) {
    try {
      await sendOtp(supabase, options.email);
      const result = await verifyOtp(
        supabase,
        options.email,
        process.env.STYRBY_TEST_OTP_TOKEN
      );
      spans.finish('auth_start');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authentication failed';
      spans.finish('auth_start', false, message);
      throw new Error(`Authentication failed: ${message}`);
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const email = options.email ?? (await promptEmail(rl));
    if (!email || !email.includes('@')) {
      throw new Error('Invalid email address');
    }

    console.log(`\n  Sending OTP to ${email}...`);

    try {
      await sendOtp(supabase, email);
    } catch (sendErr) {
      const message = sendErr instanceof Error ? sendErr.message : 'OTP send failed';
      spans.finish('auth_start', false, message);
      throw new Error(`Authentication failed: ${message}`);
    }

    console.log('  Check your inbox for a 6-digit code.');

    // Race the user pasting the OTP against the fallback-prompt timer.
    // WHY: If the email is slow to arrive, we want to proactively offer the
    // browser-auth escape hatch instead of leaving the user staring at the
    // prompt. The user can ignore the prompt to keep waiting (default Y
    // switches them; pressing N keeps them in OTP).
    const fallbackAfterMs = options.otpFallbackPromptAfterMs ?? 5000;
    const fallbackTimeoutMs = options.otpFallbackPromptTimeoutMs ?? 10000;

    const otpPromise = promptOtpCode(rl).then((token) => ({ kind: 'otp' as const, token }));
    const fallbackPromise = new Promise<{ kind: 'fallback' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'fallback' }), fallbackAfterMs);
    });

    const winner = await Promise.race([otpPromise, fallbackPromise]);

    let token: string;
    if (winner.kind === 'otp') {
      token = winner.token;
    } else {
      // Fallback timer fired before the user pasted a code. Offer browser auth.
      console.log('');
      const switchToBrowser = await promptYesNoWithTimeout(
        '  Email looks slow. Try browser auth instead?',
        fallbackTimeoutMs,
        rl
      );

      if (switchToBrowser) {
        // Close the readline so browser auth can take over stdin cleanly.
        rl.close();
        spans.finish('auth_start', false, 'fallback to browser');
        return runBrowserAuthentication(options, spans);
      }

      // User declined: keep waiting for the OTP they originally requested.
      console.log('  Keep waiting for the email...');
      const otp = await otpPromise;
      token = otp.token;
    }

    if (!token || token.length < 6) {
      throw new Error('OTP code must be at least 6 digits');
    }

    const result = await verifyOtp(supabase, email, token);
    spans.finish('auth_start');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Authentication failed';
    // Avoid double-finishing if a nested branch already finished the span.
    try {
      spans.finish('auth_start', false, message);
    } catch {
      /* span already finished — ignore */
    }
    throw new Error(`Authentication failed: ${message}`);
  } finally {
    rl.close();
  }
}

/**
 * Authentication dispatcher. Selects browser-OAuth when `--browser` is set,
 * otherwise runs the OTP path (which may itself fall back to browser).
 *
 * @param options - Onboard options
 * @param spans - Span recorder
 * @returns Auth outcome
 */
async function runAuthentication(
  options: OnboardOptions,
  spans: SpanRecorder
): Promise<AuthOutcome> {
  if (options.browser) {
    return runBrowserAuthentication(options, spans);
  }
  return runOtpAuthentication(options, spans);
}

// ============================================================================
// Machine Registration Step
// ============================================================================

/**
 * Register this machine with Supabase.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - User ID
 * @param spans - Span recorder
 * @returns Machine ID
 */
async function runMachineRegistration(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  spans: SpanRecorder
): Promise<string> {
  const chalk = (await import('chalk')).default;
  spans.start('machine_register', 'Machine registration');
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

  spans.finish('machine_register');
  return result.machine.machineId;
}

// ============================================================================
// Smart Agent Detection Step
// ============================================================================

/**
 * Prompt the user to pick one agent from a numbered list.
 *
 * WHY a plain readline prompt instead of inquirer/prompts:
 * Heavy prompt libraries (inquirer: ~400KB) violate the 150ms startup budget.
 * A bare readline question is zero-weight, fast, and adequate for a 2-digit
 * selection.
 *
 * @param agents - List of detected agents
 * @returns The chosen agent
 */
async function promptAgentPicker(agents: DetectedAgent[]): Promise<DetectedAgent> {
  const chalk = (await import('chalk')).default;
  const readline = await import('node:readline');

  console.log(chalk.bold('\n  Multiple agents detected. Pick your default:'));
  for (let i = 0; i < agents.length; i++) {
    console.log(`    ${chalk.cyan(String(i + 1))}. ${agents[i].name}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    const ask = () => {
      rl.question(`\n  Enter number [1-${agents.length}]: `, (answer) => {
        const choice = parseInt(answer.trim(), 10);
        if (choice >= 1 && choice <= agents.length) {
          rl.close();
          resolve(agents[choice - 1]);
        } else {
          console.log(chalk.red(`  Please enter a number between 1 and ${agents.length}.`));
          ask();
        }
      });
    };
    ask();
  });
}

/**
 * Run smart agent detection and selection.
 *
 * Decision tree:
 * - 0 agents found => run `styrby install --interactive`, then re-detect
 * - 1 agent found  => auto-select (no prompt, keeps onboarding fast)
 * - N agents found => numbered picker
 *
 * WHY single-found auto-select is silent:
 * If the user only has one agent installed they've already made their choice
 * by installing it. Prompting them "is this ok?" adds latency and friction
 * with zero information value.
 *
 * @param spans - Span recorder
 * @returns The selected agent ID as a string
 */
async function runAgentDetection(spans: SpanRecorder): Promise<string> {
  const chalk = (await import('chalk')).default;
  spans.start('agent_detect', 'Agent detection');
  console.log(chalk.bold('\n  [5/6] Detecting AI coding agents...'));

  const result: AgentDetectResult = detectAgents();

  let selectedAgent: DetectedAgent;

  if (result.kind === 'none') {
    // WHY: No agents installed means the product cannot function. We redirect
    // to the interactive installer rather than crashing with a cryptic error.
    console.log(chalk.yellow('        No agents found.'));
    console.log('        Opening interactive agent installer...\n');
    spans.finish('agent_detect', false, 'no agents found');

    // Lazy-import to keep startup fast
    const { handleInstallCommand } = await import('@/commands/install-agent');
    await handleInstallCommand(['--interactive']);

    // Re-detect after installation
    const retryResult = detectAgents();
    if (retryResult.kind === 'none') {
      throw new Error('No agents available after install. Run `styrby install <agent>` manually.');
    }

    selectedAgent =
      retryResult.kind === 'single' ? retryResult.agent : retryResult.agents[0];
    spans.start('agent_detect_retry', 'Agent detection (after install)');
    spans.finish('agent_detect_retry');
  } else if (result.kind === 'single') {
    // Auto-select the only installed agent — no prompt needed.
    selectedAgent = result.agent;
    console.log(`        ${chalk.green(selectedAgent.name)} ${chalk.dim('(auto-selected)')}`);
    spans.finish('agent_detect');
  } else {
    // Multiple agents: let the user pick.
    spans.finish('agent_detect');
    selectedAgent = await promptAgentPicker(result.agents);
    console.log(`        ${chalk.green('Selected:')} ${selectedAgent.name}`);
  }

  console.log(chalk.dim(`        Change anytime: styrby codex, styrby gemini, etc.`));
  return selectedAgent.id;
}

// ============================================================================
// Mobile Pairing Step
// ============================================================================

/**
 * Generate QR code and wait for mobile pairing.
 *
 * Displays both a QR code and a plain pair URL so users on servers without
 * camera-accessible phones (or with broken QR scanners) can still pair.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - User ID
 * @param machineId - Machine ID
 * @param options - Onboard options
 * @param spans - Span recorder
 * @returns True if mobile paired successfully
 */
async function runMobilePairing(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  machineId: string,
  options: OnboardOptions,
  spans: SpanRecorder
): Promise<boolean> {
  const chalk = (await import('chalk')).default;
  const qrcode = await import('qrcode-terminal');
  const { generatePairingToken, encodePairingUrl, PAIRING_EXPIRY_MINUTES, createRelayClient } =
    await import('styrby-shared');

  spans.start('pair_start', 'Pair: QR generation');
  console.log(chalk.bold('\n  [6/6] Generate QR code for mobile pairing...'));

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

  // WHY: Build a short pair URL for server environments where the phone camera
  // can't reach the terminal. The token is embedded so the mobile app can
  // deep-link directly into the pairing confirmation screen.
  const shortPairUrl = `${PAIR_URL_BASE}/${token}`;

  // Display QR code
  console.log('\n');

  await new Promise<void>((resolve) => {
    qrcode.generate(pairingUrl, { small: true }, (qr: string) => {
      const indented = qr
        .split('\n')
        .map((line) => '        ' + line)
        .join('\n');
      console.log(indented);
      resolve();
    });
  });

  console.log('\n        Scan with Styrby app on your phone');
  console.log(`        Or visit: ${chalk.cyan(shortPairUrl)}`);
  console.log(`        Expires in ${PAIRING_EXPIRY_MINUTES} minutes`);
  console.log(chalk.dim('        Waiting for mobile to connect...'));
  console.log(chalk.dim('        (Press Ctrl+C to skip)\n'));

  spans.finish('pair_start');
  spans.start('pair_complete', 'Pair: wait for mobile');

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

    const pairingTimeoutMs = options.pairingTimeout || 300000;
    const paired = await waitForMobile(relay, pairingTimeoutMs);

    if (paired) {
      await relay.sendCommand('ping');
      console.log(chalk.green('\n  Pair complete. Send your first message from the app'));
      console.log(chalk.dim("  Example: 'Hello, Claude.'\n"));
      spans.finish('pair_complete', true);

      // ESC-2: Live first-message watcher.
      // WHY: Up until now, "pair complete" only proved presence — it doesn't
      // prove the relay round-trips messages end-to-end. We now wait up to
      // 60s for the user's first inbound message from the phone, give them
      // a clear "sandbox is live" confirmation when it arrives, and exit
      // cleanly on timeout (NOT an error — the link is provably paired).
      await waitForFirstMessage(relay, options.firstMessageTimeout ?? 60000, spans);

      return true;
    } else {
      console.log(chalk.yellow('\n  Pairing skipped or timed out.\n'));
      spans.finish('pair_complete', false, 'timeout or skipped');
      return false;
    }
  } catch (error) {
    logger.debug('Pairing error', { error });
    console.log(chalk.yellow('\n  Could not complete pairing. You can pair later with: styrby pair\n'));
    spans.finish('pair_complete', false, error instanceof Error ? error.message : 'pairing error');
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
function waitForMobile(
  relay: import('styrby-shared').RelayClient,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, timeoutMs);

    if (relay.isDeviceTypeOnline('mobile')) {
      clearTimeout(timeout);
      resolve(true);
      return;
    }

    const onJoin = (presence: { device_type: string }) => {
      if (presence.device_type === 'mobile') {
        clearTimeout(timeout);
        relay.off('presence_join', onJoin);
        resolve(true);
      }
    };

    relay.on('presence_join', onJoin);

    const onInterrupt = () => {
      clearTimeout(timeout);
      relay.off('presence_join', onJoin);
      process.off('SIGINT', onInterrupt);
      resolve(false);
    };

    process.on('SIGINT', onInterrupt);
  });
}

/**
 * Truncate a string for terminal display, adding an ellipsis when shortened.
 *
 * @param input - Raw string from the relay payload
 * @param max - Maximum characters to show
 * @returns A safely truncated, single-line string
 */
function truncateForDisplay(input: string, max: number): string {
  // WHY single-line: relay payloads can contain newlines that would scramble
  // the terminal status output. We collapse whitespace before truncating.
  const oneLine = input.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Extract a human-readable preview from the first inbound relay message.
 *
 * Different message types carry text in different payload fields. This
 * function inspects the message shape and returns the most-useful preview
 * string, or a generic placeholder if nothing displayable is found.
 *
 * @param msg - The relay message envelope (already validated by the relay
 *   client's Zod schema before being emitted on `'message'`)
 * @returns A short preview string suitable for the "Sandbox is live" line
 */
function previewFirstMessage(msg: unknown): string {
  const obj = msg as { type?: string; payload?: Record<string, unknown> };
  const payload = obj?.payload ?? {};
  const candidate =
    (payload as { content?: string }).content ??
    (payload as { description?: string }).description ??
    (payload as { command?: string }).command ??
    obj?.type ??
    'message received';
  return truncateForDisplay(String(candidate), 80);
}

/**
 * Wait for the first inbound message after pairing, then exit cleanly (ESC-2).
 *
 * Resolution paths:
 *  - Inbound message within `timeoutMs` → print success line + return true
 *  - Timer expires → print "exiting; send anytime" + return false (NOT error)
 *  - SIGINT (Ctrl+C) → print "pair complete; send anytime" + return false
 *
 * The function never throws and never exits the process itself — it just
 * resolves cleanly so the outer onboarding flow can complete normally.
 *
 * @param relay - Already-connected relay client (kept open for the watcher)
 * @param timeoutMs - How long to wait for the first message
 * @param spans - Span recorder
 * @returns true if a message arrived, false on timeout / interrupt
 */
async function waitForFirstMessage(
  relay: import('styrby-shared').RelayClient,
  timeoutMs: number,
  spans: SpanRecorder
): Promise<boolean> {
  // Allow the watcher to be skipped entirely (tests, CI, --skip variants).
  if (timeoutMs <= 0) return false;

  const chalk = (await import('chalk')).default;
  spans.start('first_message', 'Wait for first inbound message');

  console.log(chalk.dim('  Waiting for first message from your phone…'));
  console.log(chalk.dim("  Open the app, tap your machine, send anything to test the link.\n"));

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const cleanup = () => {
      relay.off('message', onMessage);
      process.off('SIGINT', onInterrupt);
      clearTimeout(timer);
    };

    const onMessage = (msg: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      const preview = previewFirstMessage(msg);
      console.log(chalk.green('  ✅ First message received! Sandbox is live.'));
      console.log(chalk.dim(`  ${preview}\n`));
      spans.finish('first_message', true);
      resolve(true);
    };

    const onInterrupt = () => {
      if (settled) return;
      settled = true;
      cleanup();
      console.log(
        chalk.dim(
          '\n  Pair complete; you can send messages from your phone anytime.\n'
        )
      );
      spans.finish('first_message', false, 'sigint');
      resolve(false);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      console.log(
        chalk.dim(
          '  Wizard exiting. Send a message from your phone whenever you’re ready.\n'
        )
      );
      spans.finish('first_message', false, 'timeout');
      resolve(false);
    }, timeoutMs);

    relay.on('message', onMessage);
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
 * const result = await runOnboard({ measure: true });
 * if (result.success) {
 *   console.log('Welcome,', result.userEmail);
 * }
 */
export async function runOnboard(options: OnboardOptions = {}): Promise<OnboardResult> {
  // Create a no-op Logger for span recording (write to /dev/null unless debug).
  // WHY not reuse @/ui/logger: that logger pretty-prints to console.
  // SpanRecorder needs structured JSON for the log aggregator; we direct it
  // to a null write unless STYRBY_LOG_LEVEL=debug to avoid polluting stdout.
  const structuredLog = new Logger({
    minLevel: process.env.STYRBY_LOG_LEVEL === 'debug' ? 'debug' : 'info',
    writeFn: process.env.STYRBY_LOG_LEVEL === 'debug'
      ? (line) => process.stderr.write(line)
      : () => { /* structured spans go to log aggregator in prod */ },
  });

  const spans = new SpanRecorder(structuredLog);

  const chalk = (await import('chalk')).default;

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

  // ── Step 1: Pre-flight checks ─────────────────────────────────────────────
  if (!options.skipDoctor) {
    const checks = await runPreflightChecks(spans);
    const allPassed = await displayPreflightChecks(checks);

    if (!allPassed) {
      console.log(chalk.red('\n  Pre-flight checks failed. Please fix the issues above.\n'));
      return {
        success: false,
        error: 'Pre-flight checks failed',
        ...(options.measure ? { timeline: spans.getTimeline() } : {}),
      };
    }
  }

  // ── Step 2: Inline OTP Authentication ────────────────────────────────────
  let authData: AuthOutcome;
  try {
    authData = await runAuthentication(options, spans);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Authentication failed';
    console.log(chalk.red(`\n  ${message}\n`));
    return {
      success: false,
      error: message,
      ...(options.measure ? { timeline: spans.getTimeline() } : {}),
    };
  }

  // ── Step 3: Auth complete ─────────────────────────────────────────────────
  spans.start('auth_complete', 'Auth: complete');
  console.log(chalk.bold('\n  [3/6] Authentication complete!'));
  console.log(`        Welcome, ${authData.userEmail}`);

  // WHY also mint a styrby_* API key (H41 Phase 5):
  // The CLI's Supabase JWT (authData.accessToken) authenticates Realtime
  // subscriptions via supabase-js. Strategy C requires every /api/v1/* call
  // to use a per-user styrby_* key instead of the Supabase JWT. We exchange
  // the JWT here — single-shot, server-side validated — and persist both
  // credentials. Subsequent Phase 4 callsite swaps consume styrbyApiKey via
  // the typed StyrbyApiClient. The Supabase JWT remains the auth surface for
  // Realtime until Phase 5b replaces that.
  //
  // WHY non-fatal: an exchange failure here doesn't break onboarding —
  // pre-Phase-4, every CLI codepath still uses the Supabase JWT. The styrby
  // key is purely additive; we surface a warning + Sentry breadcrumb but let
  // the user keep onboarding. Phase 4 swaps will start failing if the key
  // is missing; we'll harden this gate then.
  let mintedStyrbyKey: { styrbyApiKey?: string; expiresAt?: string } = {};
  try {
    const { StyrbyApiClient } = await import('@/api/styrbyApiClient');
    const client = new StyrbyApiClient();
    const exchanged = await client.exchangeSupabaseJwt(authData.accessToken);
    mintedStyrbyKey = {
      styrbyApiKey: exchanged.styrby_api_key,
      expiresAt: exchanged.expires_at,
    };
    logger.debug('Minted styrby_* key', {
      // WHY only the key prefix in logs: GDPR Art 5(1)(c) data minimisation.
      // The first 11 chars are public (styrby_xxxx_) per generateApiKey().
      keyPrefix: exchanged.styrby_api_key.slice(0, 11) + '…',
    });
  } catch (exchangeErr) {
    logger.debug('styrby_* key exchange failed (non-fatal pre-Phase-4)', {
      error: exchangeErr instanceof Error ? exchangeErr.message : 'unknown',
    });
  }

  savePersistedData({
    userId: authData.userId,
    accessToken: authData.accessToken,
    refreshToken: authData.refreshToken,
    authenticatedAt: new Date().toISOString(),
    // WHY undefined-safe: if the exchange failed, we leave styrbyApiKey unset.
    // savePersistedData merges with existing data, so an undefined value here
    // does NOT clobber a previously-stored key.
    ...(mintedStyrbyKey.styrbyApiKey ? { styrbyApiKey: mintedStyrbyKey.styrbyApiKey } : {}),
    ...(mintedStyrbyKey.expiresAt ? { styrbyKeyExpiresAt: mintedStyrbyKey.expiresAt } : {}),
  });

  setConfigValue('userId', authData.userId);
  setConfigValue('authToken', authData.accessToken);

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${authData.accessToken}` },
    },
  });

  spans.finish('auth_complete');

  // ── Step 4: Machine registration ──────────────────────────────────────────
  let machineId: string;
  try {
    machineId = await runMachineRegistration(supabase, authData.userId, spans);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Machine registration failed';
    console.log(chalk.red(`\n  ${message}\n`));
    return {
      success: false,
      userId: authData.userId,
      userEmail: authData.userEmail,
      error: message,
      ...(options.measure ? { timeline: spans.getTimeline() } : {}),
    };
  }

  savePersistedData({ machineId, machineName: getMachineName() });
  setConfigValue('machineId', machineId);

  // ── Step 5: Smart agent detection + selection ─────────────────────────────
  let defaultAgentId: string;
  try {
    defaultAgentId = await runAgentDetection(spans);
    setConfigValue('defaultAgent', defaultAgentId as SupportedAgentType);
  } catch (error) {
    // Non-fatal: user can set agent later. Don't abort onboarding.
    logger.debug('Agent detection error', { error });
    defaultAgentId = 'claude';
  }

  // ── Step 6: Mobile pairing (optional) ────────────────────────────────────
  let mobilePaired = false;
  if (!options.skipPairing) {
    try {
      mobilePaired = await runMobilePairing(supabase, authData.userId, machineId, options, spans);
    } catch (error) {
      logger.debug('Pairing error', { error });
      // Don't fail onboarding if pairing fails
    }

    if (mobilePaired) {
      savePersistedData({ pairedAt: new Date().toISOString() });
    }
  }

  // ── Success ───────────────────────────────────────────────────────────────
  console.log(chalk.green("  You're all set!"));
  console.log('');
  console.log('  Try these commands:');
  console.log(chalk.cyan('    styrby              ') + chalk.dim('Start a coding session'));
  console.log(chalk.cyan('    styrby costs        ') + chalk.dim('See token spend'));
  console.log(chalk.cyan('    styrby doctor       ') + chalk.dim('Check system health'));
  console.log('');

  const timeline = spans.getTimeline();

  // ── Optional --measure timeline ───────────────────────────────────────────
  if (options.measure) {
    SpanRecorder.printTimeline(timeline);
  }

  return {
    success: true,
    userId: authData.userId,
    userEmail: authData.userEmail,
    machineId,
    mobilePaired,
    ...(options.measure ? { timeline } : {}),
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
      case '--measure':
        options.measure = true;
        break;
      case '--email':
        options.email = args[++i];
        break;
      case '--browser':
        // ESC-1: opt into PKCE browser auth instead of email OTP.
        options.browser = true;
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
