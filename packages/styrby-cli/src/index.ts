#!/usr/bin/env node
/**
 * Styrby CLI
 *
 * Mobile remote control for AI coding agents.
 * Connects Claude Code, Codex, and Gemini CLI to the Styrby mobile app.
 *
 * @module styrby-cli
 *
 * @example
 * # Complete setup wizard
 * styrby onboard
 *
 * # Start a session with Claude Code
 * styrby start --agent claude
 *
 * # Show status
 * styrby status
 */

import { logger } from '@/ui/logger';
import { isAuthenticated } from '@/configuration';

// Re-export core types for library usage
export type {
  AgentBackend,
  AgentId,
  AgentTransport,
  AgentBackendConfig,
  SessionId,
  ToolCallId,
  AgentMessage,
  AgentMessageHandler,
  StartSessionResult,
} from './agent/core/AgentBackend';

export { AgentRegistry } from './agent/core/AgentRegistry';

/**
 * CLI version
 */
export const VERSION = '0.1.0';

/**
 * Main CLI entry point.
 *
 * Parses command line arguments and dispatches to appropriate handlers.
 * If no command is given, launches interactive mode.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Interactive mode if no command given
  if (!command || command === undefined) {
    const { runInteractive } = await import('@/commands/interactive');
    await runInteractive();
    return;
  }

  // Only show version header for non-interactive commands
  logger.info(`Styrby CLI v${VERSION}`);

  switch (command) {
    case 'onboard':
      await handleOnboard(args.slice(1));
      break;

    case 'install':
      await handleInstall(args.slice(1));
      break;

    case 'auth':
      await handleAuth();
      break;

    case 'pair':
      await handlePair();
      break;

    case 'start':
      await handleStart(args.slice(1));
      break;

    case 'status':
      await handleStatus();
      break;

    case 'doctor':
      await handleDoctor();
      break;

    case 'costs':
      await handleCosts(args.slice(1));
      break;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;

    default:
      logger.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

/**
 * Handle the 'onboard' command.
 * Complete setup wizard: auth + machine registration + mobile pairing.
 *
 * @param args - Command arguments
 */
async function handleOnboard(args: string[]): Promise<void> {
  const { runOnboard, parseOnboardArgs } = await import('@/commands/onboard');
  const options = parseOnboardArgs(args);
  const result = await runOnboard(options);

  if (!result.success) {
    process.exit(1);
  }
}

/**
 * Handle the 'install' command.
 * Install AI coding agents (Claude Code, Codex, Gemini CLI).
 *
 * @param args - Command arguments
 */
async function handleInstall(args: string[]): Promise<void> {
  const { handleInstallCommand } = await import('@/commands/install-agent');
  await handleInstallCommand(args);
}

/**
 * Handle the 'auth' command.
 * Authenticates with Styrby (without mobile pairing).
 */
async function handleAuth(): Promise<void> {
  const { runOnboard } = await import('@/commands/onboard');

  // Run onboard with pairing skipped
  const result = await runOnboard({ skipPairing: true });

  if (!result.success) {
    process.exit(1);
  }
}

/**
 * Handle the 'pair' command.
 * Generates a QR code for mobile app pairing and waits for connection.
 */
async function handlePair(): Promise<void> {
  const qrcode = await import('qrcode-terminal');
  const os = await import('os');
  const crypto = await import('crypto');
  const { createClient } = await import('@supabase/supabase-js');
  const chalk = (await import('chalk')).default;

  // Import pairing utilities from shared package
  const { encodePairingUrl, generatePairingToken, PAIRING_EXPIRY_MINUTES, createRelayClient } = await import('styrby-shared');

  // Load stored credentials
  const { loadPersistedData, savePersistedData } = await import('@/persistence');
  const data = loadPersistedData();

  if (!data?.userId || !data?.accessToken) {
    logger.error('Not authenticated. Please run "styrby onboard" first.');
    process.exit(1);
  }

  // Generate pairing payload
  const machineId = data.machineId || `machine_${crypto.randomUUID()}`;
  const deviceName = os.hostname();
  const token = generatePairingToken();

  const { config } = await import('@/env');
  const supabaseUrl = config.supabaseUrl;
  const supabaseAnonKey = config.supabaseAnonKey;

  const payload = {
    version: 1 as const,
    token,
    userId: data.userId,
    machineId,
    deviceName,
    supabaseUrl,
    expiresAt: new Date(Date.now() + PAIRING_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  };

  const pairingUrl = encodePairingUrl(payload);

  // Display QR code
  console.log('\n');
  logger.info('Scan this QR code with the Styrby mobile app:\n');

  qrcode.generate(pairingUrl, { small: true }, (qr: string) => {
    console.log(qr);
  });

  console.log('\n');
  console.log(`Machine: ${deviceName}`);
  console.log(`Expires: ${PAIRING_EXPIRY_MINUTES} minutes`);
  console.log('\nWaiting for mobile app to connect...');
  console.log('(Press Ctrl+C to cancel)\n');

  // Create authenticated Supabase client
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    },
  });

  // Create relay client and wait for mobile presence
  const relay = createRelayClient({
    supabase,
    userId: data.userId,
    deviceId: machineId,
    deviceType: 'cli',
    deviceName,
    platform: process.platform,
    debug: process.env.STYRBY_LOG_LEVEL === 'debug',
  });

  try {
    await relay.connect();

    // Wait for mobile device to join (5 minute timeout)
    const timeoutMs = PAIRING_EXPIRY_MINUTES * 60 * 1000;
    const paired = await new Promise<boolean>((resolve) => {
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

    if (paired) {
      // Send test ping
      await relay.sendCommand('ping');
      console.log(chalk.green('\nSUCCESS! Mobile paired successfully.\n'));

      // Save pairing timestamp
      savePersistedData({
        pairedAt: new Date().toISOString(),
      });
    } else {
      console.log(chalk.yellow('\nPairing timed out or cancelled.\n'));
      console.log('You can try again with: styrby pair\n');
    }
  } catch (error) {
    logger.debug('Pairing error', { error });
    console.log(chalk.red('\nPairing failed. Please try again.\n'));
  } finally {
    await relay.disconnect();
  }
}

/**
 * Handle the 'start' command.
 * Starts an agent session.
 *
 * @param args - Command arguments (--agent, --project, etc.)
 */
async function handleStart(args: string[]): Promise<void> {
  // Parse arguments
  let agentType = 'claude';
  let projectPath = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' || args[i] === '-a') {
      agentType = args[++i] || 'claude';
    } else if (args[i] === '--project' || args[i] === '-p') {
      projectPath = args[++i] || process.cwd();
    }
  }

  logger.info(`Starting ${agentType} session in ${projectPath}`);
  // TODO: Implement
  // 1. Check authentication
  // 2. Connect to Supabase Realtime
  // 3. Start agent via AgentBackend
  // 4. Relay messages to mobile
  logger.warn('Start not yet implemented');
}

/**
 * Handle the 'status' command.
 * Shows current connection and session status.
 */
async function handleStatus(): Promise<void> {
  logger.info('Checking status...');
  // TODO: Implement
  // 1. Check if daemon is running
  // 2. Check connection to Supabase
  // 3. List active sessions
  logger.warn('Status not yet implemented');
}

/**
 * Handle the 'doctor' command.
 * Runs diagnostic checks.
 */
async function handleDoctor(): Promise<void> {
  const { runDoctor } = await import('@/ui/doctor');
  const success = await runDoctor();
  process.exit(success ? 0 : 1);
}

/**
 * Handle the 'costs' command.
 * Shows token usage and cost breakdown from Claude Code JSONL files.
 *
 * @param args - Command arguments (--today, --month, --all)
 */
async function handleCosts(args: string[]): Promise<void> {
  const { aggregateCosts, getTodayCosts, getMonthCosts, MODEL_PRICING } = await import('@/costs/index');

  let summary;
  let periodLabel = 'All time';

  if (args.includes('--today') || args.includes('-t')) {
    summary = await getTodayCosts();
    periodLabel = 'Today';
  } else if (args.includes('--month') || args.includes('-m')) {
    summary = await getMonthCosts();
    periodLabel = 'This month';
  } else {
    summary = await aggregateCosts();
  }

  // Format numbers
  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  };

  const formatCost = (n: number): string => `$${n.toFixed(4)}`;

  // Print summary
  console.log(`\n📊 Cost Summary (${periodLabel})`);
  console.log('─'.repeat(50));

  if (summary.sessionCount === 0) {
    console.log('\nNo session data found.');
    console.log('Session files are stored in ~/.claude/projects/');
    return;
  }

  console.log(`\n  Sessions:       ${summary.sessionCount}`);
  console.log(`  Input tokens:   ${formatTokens(summary.totalInputTokens)}`);
  console.log(`  Output tokens:  ${formatTokens(summary.totalOutputTokens)}`);
  if (summary.totalCacheReadTokens > 0) {
    console.log(`  Cache read:     ${formatTokens(summary.totalCacheReadTokens)}`);
  }
  if (summary.totalCacheWriteTokens > 0) {
    console.log(`  Cache write:    ${formatTokens(summary.totalCacheWriteTokens)}`);
  }
  console.log(`\n  Total cost:     ${formatCost(summary.totalCostUsd)}`);

  // Print by model breakdown
  const models = Object.entries(summary.byModel);
  if (models.length > 0) {
    console.log('\n📈 By Model');
    console.log('─'.repeat(50));

    for (const [model, modelData] of models) {
      const data = modelData as {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        costUsd: number;
      };
      const pricing = MODEL_PRICING[model];
      const priceInfo = pricing
        ? `($${pricing.input}/$${pricing.output} per 1M)`
        : '(unknown pricing)';

      console.log(`\n  ${model}`);
      console.log(`    ${priceInfo}`);
      console.log(`    Input: ${formatTokens(data.inputTokens)} | Output: ${formatTokens(data.outputTokens)}`);
      console.log(`    Cost: ${formatCost(data.costUsd)}`);
    }
  }

  // Print date range
  if (summary.firstTimestamp && summary.lastTimestamp) {
    console.log('\n📅 Date Range');
    console.log('─'.repeat(50));
    console.log(`  From: ${summary.firstTimestamp.toLocaleString()}`);
    console.log(`  To:   ${summary.lastTimestamp.toLocaleString()}`);
  }

  console.log('\n');
}

/**
 * Print CLI help.
 */
function printHelp(): void {
  console.log(`
styrby v${VERSION}

Usage: styrby [command] [options]

Mobile relay for AI coding agents. Control Claude Code, Codex, Gemini CLI,
and OpenCode from your phone. Code stays local — only I/O is relayed.

Commands:

  Setup
    onboard                 First-time setup (auth + machine registration + pairing)
    auth                    Authenticate only (skip pairing)
    pair                    Generate QR code for mobile app pairing
    install <agent>         Install an AI agent (claude, codex, gemini, opencode)

  Session
    start                   Start a coding session
    status                  Show connection and session status
    costs                   Display token usage and cost breakdown

  Diagnostics
    doctor                  Run system health checks
    help                    Show this help message
    version                 Show version number

Options:

  -a, --agent <name>        Agent to use: claude (default), codex, gemini, opencode
  -p, --project <path>      Project directory (default: cwd)
  -f, --force               Force re-authentication
  --skip-pairing            Skip QR code step during onboard
  --skip-doctor             Skip health checks during onboard
  -t, --today               Filter costs to today
  -m, --month               Filter costs to current month
  -h, --help                Show help
  -v, --version             Show version

Environment Variables:

  STYRBY_LOG_LEVEL          Set to "debug" for verbose output
  ANTHROPIC_API_KEY         Required for Claude Code
  OPENAI_API_KEY            Required for Codex, optional for OpenCode
  GEMINI_API_KEY            Required for Gemini CLI
  GOOGLE_API_KEY            Alternative for Gemini CLI

Configuration:

  ~/.styrby/config.json     User configuration
  ~/.styrby/credentials     Authentication tokens (chmod 600)
  ~/.claude/projects/       Claude Code session data (used by 'costs' command)

Exit Codes:

  0    Success
  1    General error / command failed
  2    Invalid arguments or usage
  126  Permission denied
  127  Command not found (agent not installed)
  130  Interrupted (Ctrl+C)

Examples:

  Getting Started
    styrby onboard                      Complete setup (~60 seconds)
    styrby install claude               Install Claude Code agent
    styrby install opencode             Install OpenCode agent
    styrby doctor                       Verify everything is configured

  Starting Sessions
    styrby start                        Start with Claude (default agent)
    styrby start -a codex               Start with Codex
    styrby start -a gemini              Start with Gemini CLI
    styrby start -a opencode            Start with OpenCode
    styrby start -p ~/work/myproject    Start in specific directory
    styrby start -a codex -p ./backend  Combine agent + project path

  Cost Tracking
    styrby costs                        Show all-time usage and costs
    styrby costs --today                Show today's costs only
    styrby costs --month                Show current month's costs

  Status & Diagnostics
    styrby status                       Check connection and session state
    styrby doctor                       Run full health check
    STYRBY_LOG_LEVEL=debug styrby start Debug mode with verbose output

  Re-pairing & Re-auth
    styrby pair                         Generate new QR code (e.g., new phone)
    styrby auth --force                 Force re-authentication
    styrby onboard --force              Full re-setup

Troubleshooting:

  Error                           Fix
  ─────────────────────────────────────────────────────────────────────
  "Not authenticated"             styrby onboard (or styrby auth --force)
  "Agent not found"               styrby install <agent> && exec $SHELL
  "Claude: ANTHROPIC_API_KEY"     export ANTHROPIC_API_KEY=sk-ant-...
  "Codex: OPENAI_API_KEY"         export OPENAI_API_KEY=sk-...
  "Gemini: API key"               export GEMINI_API_KEY=... (or GOOGLE_API_KEY)
  "QR code expired"               styrby pair
  "Mobile not connecting"         Check same account on CLI and mobile app
  "Connection timeout"            Whitelist *.supabase.co in firewall/proxy
  "WebSocket blocked"             Some corporate networks block WSS; try hotspot
  "EACCES / permission denied"    mkdir -p ~/.styrby && chmod 700 ~/.styrby
  "Node.js version"               Requires Node.js 20+; check with: node -v
  "Agent crashes on start"        Check agent works standalone: claude --help

  For verbose output, prefix any command with: STYRBY_LOG_LEVEL=debug

Homepage:  https://styrbyapp.com
Source:    https://github.com/VetSecItPro/styrby-app
Issues:    https://github.com/VetSecItPro/styrby-app/issues
`);
}

// Run main
main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});
