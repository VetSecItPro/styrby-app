/**
 * `styrby start` command handler.
 *
 * Creates a full agent session that bridges the AI coding agent (Claude,
 * Codex, Gemini, etc.) to the Styrby mobile app via Supabase Realtime.
 *
 * Flow:
 *   1. Parse argv and validate the requested agent
 *   2. Load persisted credentials and verify authentication
 *   3. Create an authenticated Supabase client with the stored access token
 *   4. Connect the StyrbyApi relay to the user's Realtime channel
 *   5. Look up the requested agent in the AgentRegistry and create a backend
 *   6. Start a managed session (ApiSessionManager bridges agent <-> relay)
 *   7. Wait for the session to end (Ctrl+C, mobile end_session, or SIGTERM)
 *   8. Clean up: dispose agent, disconnect relay, update session status
 *
 * @module cli/handlers/start
 */

import { logger } from '@/ui/logger';

/**
 * Handle the `styrby start` command.
 *
 * @param args - Raw CLI arguments after the `start` keyword. Supports
 *               `--agent <name>` / `-a <name>` and `--project <path>` / `-p <path>`.
 * @returns Promise that resolves when the session fully ends (or the process exits).
 */
export async function handleStart(args: string[]): Promise<void> {
  const chalk = (await import('chalk')).default;
  const os = await import('os');
  const path = await import('path');
  const { createClient } = await import('@supabase/supabase-js');

  // ── Parse CLI arguments ──────────────────────────────────────────────
  let agentType = 'claude';
  let projectPath = process.cwd();

  // WHY: Validate agent type early to prevent unvalidated strings from
  // reaching the logger and Supabase session records. Without this gate,
  // `styrby start --agent "$(malicious)"` would pass through to DB insert.
  const VALID_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'aider'];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' || args[i] === '-a') {
      agentType = args[++i] || 'claude';
    } else if (args[i] === '--project' || args[i] === '-p') {
      projectPath = args[++i] || process.cwd();
    }
  }

  if (!VALID_AGENTS.includes(agentType)) {
    console.log(chalk.red(`\nUnknown agent: ${agentType}`));
    console.log(`Supported agents: ${VALID_AGENTS.join(', ')}\n`);
    process.exit(2);
  }

  // Resolve relative paths to absolute so the agent runs in the right directory
  projectPath = path.resolve(projectPath);

  logger.info(`Starting ${agentType} session in ${projectPath}`);

  // ── 1. Check authentication ──────────────────────────────────────────
  const { loadPersistedData } = await import('@/persistence');
  const data = loadPersistedData();

  if (!data?.userId || !data?.accessToken) {
    console.log(chalk.red('\nNot authenticated.'));
    console.log('Run ' + chalk.cyan('styrby onboard') + ' to set up authentication.\n');
    process.exit(1);
  }

  const machineId = data.machineId || `machine_${crypto.randomUUID()}`;
  const deviceName = os.hostname();

  logger.debug('Credentials loaded', {
    userId: data.userId.slice(0, 8) + '...',
    machineId: machineId.slice(0, 8) + '...',
  });

  // ── 2. Create authenticated Supabase client ──────────────────────────
  const { config: envConfig } = await import('@/env');

  if (!envConfig.supabaseAnonKey) {
    console.log(chalk.red('\nSupabase anonymous key not configured.'));
    console.log('Set the SUPABASE_ANON_KEY environment variable.\n');
    process.exit(1);
  }

  const supabase = createClient(envConfig.supabaseUrl, envConfig.supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    },
  });

  // ── 3. Connect to Supabase Realtime relay ────────────────────────────
  const { StyrbyApi } = await import('@/api/api');
  const apiClient = new StyrbyApi();

  apiClient.configure({
    supabase,
    userId: data.userId,
    machineId,
    machineName: deviceName,
    debug: process.env.STYRBY_LOG_LEVEL === 'debug',
  });

  console.log(chalk.gray('Connecting to relay...'));

  try {
    await apiClient.connect();
  } catch (error) {
    console.log(chalk.red('\nFailed to connect to the relay.'));
    console.log('Check your internet connection and try again.');
    if (error instanceof Error) {
      logger.debug('Relay connection error', { message: error.message });
    }
    process.exit(1);
  }

  console.log(chalk.green('Connected to relay.'));

  // Check if mobile is online (informational, not blocking)
  if (apiClient.isMobileOnline()) {
    console.log(chalk.green('Mobile app is online.'));
  } else {
    console.log(chalk.yellow('Mobile app is not yet connected. Open the Styrby app to control this session.'));
  }

  // ── 4. Initialize agent registry and create backend ──────────────────
  // WHY: We initialize agents here (not at module load) because the agent
  // factories have heavy imports (@agentclientprotocol/sdk, transport handlers)
  // that would slow down CLI startup for every command, not just 'start'.
  const { initializeAgents, agentRegistry } = await import('@/agent/index');
  initializeAgents();

  // Validate the requested agent is available
  const validAgentId = agentType as import('@/agent/core/AgentBackend').AgentId;
  if (!agentRegistry.has(validAgentId)) {
    const available = agentRegistry.list().join(', ') || 'none registered';
    console.log(chalk.red(`\nAgent "${agentType}" is not available.`));
    console.log(`Registered agents: ${available}`);
    console.log(`\nInstall with: ${chalk.cyan(`styrby install ${agentType}`)}\n`);
    await apiClient.disconnect();
    process.exit(1);
  }

  console.log(chalk.gray(`Creating ${agentType} backend...`));

  const agent = agentRegistry.create(validAgentId, {
    cwd: projectPath,
  });

  // ── 5. Start managed session (agent <-> relay bridge) ────────────────
  const { ApiSessionManager } = await import('@/api/apiSession');
  const sessionManager = new ApiSessionManager();

  let activeSession: import('@/api/apiSession').ActiveSession;

  try {
    activeSession = await sessionManager.startManagedSession({
      supabase,
      api: apiClient,
      agent,
      agentType: agentType as import('styrby-shared').AgentType,
      userId: data.userId,
      machineId,
      projectPath,
    });
  } catch (error) {
    console.log(chalk.red('\nFailed to start agent session.'));
    if (error instanceof Error) {
      console.log(chalk.red(error.message));
    }
    await apiClient.disconnect();
    process.exit(1);
  }

  console.log('');
  console.log(chalk.green.bold(`Session started.`));
  console.log(chalk.gray(`  Session:  ${activeSession.sessionId.slice(0, 8)}...`));
  console.log(chalk.gray(`  Agent:    ${agentType}`));
  console.log(chalk.gray(`  Project:  ${projectPath}`));
  console.log('');
  console.log('Send messages from the Styrby mobile app.');
  console.log('Press ' + chalk.cyan('Ctrl+C') + ' to end the session.\n');

  // Save session locally for 'styrby status' to find
  const { saveSession } = await import('@/persistence');
  saveSession({
    sessionId: activeSession.sessionId,
    agentType: agentType as 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'goose' | 'amp' | 'crush' | 'kilo' | 'kiro' | 'droid',
    projectPath,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'running',
  });

  // ── 6. Wait for session to end ───────────────────────────────────────

  // WHY: We use a Promise that resolves when:
  // (a) User presses Ctrl+C
  // (b) Mobile sends an 'end_session' command
  // (c) The process receives SIGTERM (e.g., from a service manager)
  // This keeps the CLI alive while the relay bridge handles all communication.
  const sessionDone = new Promise<string>((resolve) => {
    // Handle Ctrl+C (SIGINT)
    const onSigint = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve('user_interrupt');
    };

    // Handle SIGTERM (graceful shutdown)
    const onSigterm = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve('sigterm');
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    // Listen for 'end_session' command from mobile
    sessionManager.onSessionUpdate(activeSession.sessionId, (update) => {
      if (update.type === 'end_session_requested') {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        resolve('mobile_end_session');
      }
    });
  });

  const endReason = await sessionDone;
  logger.debug('Session ending', { reason: endReason });

  // ── 7. Clean up ──────────────────────────────────────────────────────
  console.log(chalk.gray('\nEnding session...'));

  await activeSession.stop();
  await apiClient.disconnect();

  // Update local session record
  saveSession({
    sessionId: activeSession.sessionId,
    agentType: agentType as 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'goose' | 'amp' | 'crush' | 'kilo' | 'kiro' | 'droid',
    projectPath,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'stopped',
  });

  const reasonLabels: Record<string, string> = {
    user_interrupt: 'User pressed Ctrl+C',
    sigterm: 'Process terminated',
    mobile_end_session: 'Ended from mobile app',
  };

  console.log(chalk.green('\nSession ended.'));
  console.log(chalk.gray(`Reason: ${reasonLabels[endReason] || endReason}\n`));
}
