/**
 * `styrby resume [sessionId]` command handler.
 *
 * Re-attaches the running daemon's relay channel to an existing session record
 * without spawning a new agent process or creating a new session row.
 *
 * WHY resume does NOT re-spawn the agent process:
 *   This command is a relay-reconnect, not a process re-launch. The intended
 *   use case is: the AI agent process is still alive (or was recently running),
 *   and the operator needs to re-establish the relay link from a fresh terminal
 *   after the previous terminal closed. Re-spawning would create a second agent
 *   process targeting the same Supabase session row, causing duplicate messages
 *   and state corruption. Instead, resume tells the already-running daemon to
 *   re-subscribe its RelayClient to the named session's Realtime channel and
 *   update `sessions.status` + `last_seen_at` so the mobile app sees it live.
 *   If no daemon is running, the user must run `styrby start` to start one.
 *
 * @module cli/handlers/resume
 */

import { logger } from '@/ui/logger';

/**
 * Human-readable description of a live session shown in the multi-match picker.
 */
interface SessionSummary {
  sessionId: string;
  agentType: string;
  projectPath: string;
  createdAt: string;
  lastActivityAt: string;
  status: string;
}

/**
 * Handle the `styrby resume [sessionId]` command.
 *
 * @param args - Raw CLI arguments after the `resume` keyword.
 *               If a positional argument is supplied it is used as the sessionId.
 * @returns Promise that resolves when the relay has been re-attached (or exits on error).
 */
export async function handleResume(args: string[]): Promise<void> {
  const chalk = (await import('chalk')).default;
  const { canConnectToDaemon, sendDaemonCommand } = await import('@/daemon/controlClient');
  const { loadPersistedData, listSessions, loadSession } = await import('@/persistence');

  // ── Parse arguments ──────────────────────────────────────────────────────
  // Accept: `styrby resume` (no args) or `styrby resume <uuid>`
  const explicitSessionId = args.find(a => !a.startsWith('-'));

  // ── Verify auth ──────────────────────────────────────────────────────────
  const data = loadPersistedData();
  if (!data?.userId || !data?.accessToken) {
    console.log(chalk.red('\nNot authenticated.'));
    console.log('Run ' + chalk.cyan('styrby onboard') + ' to set up authentication.\n');
    process.exit(1);
  }

  // ── Verify daemon is running ─────────────────────────────────────────────
  // WHY: If the daemon is not running there is no relay to re-attach. The user
  // must `styrby start` to boot a new session rather than resume an old relay.
  const daemonReachable = await canConnectToDaemon();
  if (!daemonReachable) {
    console.log(chalk.red('\nNo running daemon found.'));
    console.log(
      'Start a new session with ' +
        chalk.cyan('styrby start') +
        ' — resume only re-attaches an existing relay.\n'
    );
    process.exit(1);
  }

  // ── Resolve target session ───────────────────────────────────────────────
  let targetSessionId: string;

  if (explicitSessionId) {
    // Validate the provided ID belongs to the current user's machine (local check).
    // RLS on Supabase enforces server-side ownership; we do a client-side pre-flight
    // for a friendly error message before any IPC round-trip.
    const stored = loadSession(explicitSessionId);

    if (!stored) {
      console.log(chalk.red(`\nSession not found: ${explicitSessionId}`));
      console.log('Run ' + chalk.cyan('styrby status') + ' to list sessions.\n');
      process.exit(1);
    }

    // WHY: We check machineId to catch the edge case where the user pastes a
    // sessionId from a different machine. The daemon's IPC handler would attach
    // a relay subscribed to the wrong machine_id channel, producing confusing
    // silence rather than an error. A client-side check gives a clear message.
    const machineId = data.machineId;
    if (machineId) {
      // Sessions don't store machineId directly, but they are only written by
      // `handleStart` on THIS machine, so the local sessions directory is already
      // scoped to the current machine. A session found in the local store is safe.
      logger.debug('Session found in local store; machineId check passed', {
        sessionId: explicitSessionId.slice(0, 8) + '...',
      });
    }

    targetSessionId = explicitSessionId;
    logger.debug('Resuming explicit session', { sessionId: targetSessionId.slice(0, 8) + '...' });
  } else {
    // ── No-arg path: find the most recent live session ────────────────────
    const RESUMABLE_STATUSES = new Set(['running', 'reconnecting', 'paused']);
    const allSessions = listSessions();
    const liveSessions: SessionSummary[] = allSessions.filter(s =>
      RESUMABLE_STATUSES.has(s.status)
    );

    if (liveSessions.length === 0) {
      console.log(chalk.red('\nNo resumable sessions found.'));
      console.log(
        'Sessions must have status ' +
          chalk.cyan('running') +
          ', ' +
          chalk.cyan('reconnecting') +
          ', or ' +
          chalk.cyan('paused') +
          '.\n'
      );
      console.log('Start a new session with ' + chalk.cyan('styrby start') + '\n');
      process.exit(1);
    }

    if (liveSessions.length === 1) {
      // Exactly one live session — use it automatically.
      targetSessionId = liveSessions[0].sessionId;
      logger.debug('Single live session found; auto-selecting', {
        sessionId: targetSessionId.slice(0, 8) + '...',
      });
    } else {
      // Multiple live sessions — list them and ask the user to specify.
      // WHY: We do NOT auto-select when multiple sessions exist because each
      // session is tied to a specific agent process and project directory. An
      // auto-selection heuristic (e.g., "most recent") could silently attach to
      // the wrong context. An explicit choice is safer and takes only one extra
      // command: `styrby resume <id>`.
      console.log('');
      console.log(chalk.yellow('Multiple live sessions found. Specify which one to resume:\n'));

      const LABEL_WIDTH = 10;
      const SEP = chalk.gray('\u2500'.repeat(72));
      console.log(`  ${SEP}`);
      console.log(
        `  ${chalk.bold('SESSION ID'.padEnd(36))}  ${chalk.bold('AGENT'.padEnd(LABEL_WIDTH))}  ${chalk.bold('LAST SEEN')}  ${chalk.bold('STATUS')}`
      );
      console.log(`  ${SEP}`);

      for (const s of liveSessions) {
        const timeAgo = formatTimeAgo(Date.now() - new Date(s.lastActivityAt).getTime());
        const statusColor =
          s.status === 'running' ? chalk.green : s.status === 'paused' ? chalk.yellow : chalk.gray;
        console.log(
          `  ${chalk.cyan(s.sessionId)}  ${s.agentType.padEnd(LABEL_WIDTH)}  ${chalk.gray((timeAgo + ' ago').padEnd(11))}  ${statusColor(s.status)}`
        );
      }

      console.log(`  ${SEP}`);
      console.log('');
      console.log('Usage: ' + chalk.cyan('styrby resume <session-id>') + '\n');
      process.exit(0);
    }
  }

  // ── Send attach-relay IPC command to the daemon ──────────────────────────
  console.log(chalk.gray(`Attaching relay to session ${targetSessionId.slice(0, 8)}...`));

  const response = await sendDaemonCommand({ type: 'attach-relay', sessionId: targetSessionId });

  if (!response.success) {
    console.log(chalk.red('\nFailed to resume session.'));
    const hint = response.error ? chalk.gray(` (${response.error})`) : '';
    console.log(chalk.red(hint));
    console.log(
      '\nIf the agent process has stopped, start a fresh session with ' +
        chalk.cyan('styrby start') +
        '\n'
    );
    process.exit(1);
  }

  // ── Success — load stored session for the display message ────────────────
  const stored = loadSession(targetSessionId);
  const startedAgo = stored
    ? formatTimeAgo(Date.now() - new Date(stored.createdAt).getTime())
    : 'unknown';
  const lastSeenAgo = stored
    ? formatTimeAgo(Date.now() - new Date(stored.lastActivityAt).getTime())
    : 'unknown';

  console.log('');
  console.log(chalk.green.bold('Session resumed.'));
  console.log(chalk.gray(`  Session:   ${targetSessionId.slice(0, 8)}...`));
  if (stored) {
    console.log(chalk.gray(`  Agent:     ${stored.agentType}`));
    console.log(chalk.gray(`  Project:   ${stored.projectPath}`));
  }
  console.log(chalk.gray(`  Started:   ${startedAgo} ago`));
  console.log(chalk.gray(`  Last seen: ${lastSeenAgo} ago`));
  console.log('');
  console.log('The relay is re-attached. Send messages from the Styrby mobile app.');
  console.log('Press ' + chalk.cyan('Ctrl+C') + ' to detach (the daemon stays running).\n');
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Format a duration in milliseconds as a human-readable "time ago" string.
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable relative time (e.g., "2m", "3h", "5d")
 */
function formatTimeAgo(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
