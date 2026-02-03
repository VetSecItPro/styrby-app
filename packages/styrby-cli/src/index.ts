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
 * # Authenticate with Styrby
 * styrby auth
 *
 * # Start a session with Claude Code
 * styrby start --agent claude
 *
 * # Show status
 * styrby status
 */

import { logger } from '@/ui/logger';

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
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  logger.info(`Styrby CLI v${VERSION}`);

  switch (command) {
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
    case undefined:
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
 * Handle the 'auth' command.
 * Authenticates with Styrby and pairs with mobile app.
 */
async function handleAuth(): Promise<void> {
  logger.info('Authentication flow starting...');
  // TODO: Implement full auth flow
  // 1. Open browser for Supabase auth
  // 2. Wait for callback
  // 3. Store credentials
  logger.warn('Auth not yet implemented. Use "styrby pair" after authenticating via web.');
}

/**
 * Handle the 'pair' command.
 * Generates a QR code for mobile app pairing.
 */
async function handlePair(): Promise<void> {
  const qrcode = await import('qrcode-terminal');
  const os = await import('os');
  const crypto = await import('crypto');

  // Import pairing utilities from shared package
  const { encodePairingUrl, generatePairingToken, PAIRING_EXPIRY_MINUTES } = await import('styrby-shared');

  // Load stored credentials
  const { loadPersistedData } = await import('@/persistence');
  const data = loadPersistedData();

  if (!data?.userId) {
    logger.error('Not authenticated. Please run "styrby auth" first.');
    process.exit(1);
  }

  // Generate pairing payload
  const machineId = data.machineId || `machine_${crypto.randomUUID()}`;
  const deviceName = os.hostname();
  const token = generatePairingToken();

  const payload = {
    version: 1 as const,
    token,
    userId: data.userId,
    machineId,
    deviceName,
    supabaseUrl: process.env.SUPABASE_URL || 'https://akmtmxunjhsgldjztdtt.supabase.co',
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

  // TODO: Wait for mobile app to scan and connect via Supabase Realtime
  // For now, just wait and let the user manually proceed
  await new Promise(() => {
    // Keep process alive
  });
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
Styrby CLI v${VERSION}
Mobile remote control for AI coding agents.

USAGE
  styrby <command> [options]

COMMANDS
  auth          Authenticate with Styrby (opens browser)
  pair          Generate QR code to pair with mobile app
  start         Start an agent session
  status        Show connection and session status
  costs         Show token usage and cost breakdown
  doctor        Run diagnostic checks
  help          Show this help message
  version       Show version

OPTIONS
  --agent, -a   Agent type: claude, codex, gemini (default: claude)
  --project, -p Project directory (default: current directory)
  --today, -t   Show only today's costs (with 'costs' command)
  --month, -m   Show only this month's costs (with 'costs' command)

EXAMPLES
  # Authenticate with Styrby
  styrby auth

  # Pair with mobile app (scan QR code)
  styrby pair

  # Start Claude Code session
  styrby start --agent claude

  # Start Codex session in specific directory
  styrby start --agent codex --project /path/to/project

  # Check CLI health
  styrby doctor

  # Show all-time token costs
  styrby costs

  # Show today's costs only
  styrby costs --today

For more info, visit: https://styrbyapp.com/docs
`);
}

// Run main
main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});
