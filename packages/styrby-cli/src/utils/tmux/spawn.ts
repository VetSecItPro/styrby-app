/**
 * `spawnInTmux` - high-level helper that creates a tmux window running a
 * command, with optional env injection.
 *
 * WHY: This is the largest single concern in the tmux module (session
 * resolution, window creation, env propagation, PID extraction). Pulling it
 * out of `TmuxUtilities` keeps that class focused on basic tmux command
 * execution and lets us evolve spawn semantics independently.
 */

import { logger } from '@/ui/logger';

import { formatTmuxSessionIdentifier } from './identifiers';
import { buildEnvFlags } from './spawnEnv';
import {
    type TmuxSessionIdentifier,
    type TmuxSpawnOptions,
} from './types';
import type { TmuxUtilities } from './utilities';

/**
 * Result shape for a `spawnInTmux` call.
 */
export interface TmuxSpawnResult {
    success: boolean;
    sessionId?: string;
    pid?: number;
    error?: string;
}

/**
 * Spawn a process in a tmux window using the provided `TmuxUtilities`
 * instance for command execution.
 *
 * IMPORTANT: Unlike Node.js spawn(), env is a separate parameter.
 * - Tmux windows inherit environment from the tmux server.
 * - Only NEW or DIFFERENT variables need to be set via -e flag.
 * - Passing all of process.env would create 50+ unnecessary -e flags.
 *
 * Session name resolution:
 * - undefined / empty: use first existing session, or create "happy" if none.
 * - explicit name: use that session (creating it if missing).
 *
 * @param utils - TmuxUtilities used to actually run tmux commands
 * @param args - Command and arguments (joined with spaces into a shell string)
 * @param options - Tmux-specific spawn options (excludes env)
 * @param env - Variables to set in the new window (only pass deltas!)
 */
export async function spawnInTmuxStandalone(
    utils: TmuxUtilities,
    args: string[],
    options: TmuxSpawnOptions = {},
    env?: Record<string, string>
): Promise<TmuxSpawnResult> {
    try {
        // Verify tmux is available before doing anything else.
        const tmuxCheck = await utils.executeTmuxCommand(['list-sessions']);
        if (!tmuxCheck) {
            throw new Error('tmux not available');
        }

        let sessionName = options.sessionName !== undefined && options.sessionName !== ''
            ? options.sessionName
            : null;

        if (!sessionName) {
            const listResult = await utils.executeTmuxCommand(['list-sessions', '-F', '#{session_name}']);
            if (listResult && listResult.returncode === 0 && listResult.stdout.trim()) {
                sessionName = listResult.stdout.trim().split('\n')[0];
                logger.debug(`[TMUX] Using first existing session: ${sessionName}`);
            } else {
                sessionName = 'happy';
                logger.debug(`[TMUX] No existing sessions, using default: ${sessionName}`);
            }
        }

        const windowName = options.windowName || `happy-${Date.now()}`;

        await utils.ensureSessionExists(sessionName);

        const fullCommand = args.join(' ');

        // IMPORTANT: Don't manually add -t here - executeTmuxCommand handles
        // it via parameters, and double-targeting causes a tmux usage error.
        const createWindowArgs = ['new-window', '-n', windowName];

        if (options.cwd) {
            const cwdPath = typeof options.cwd === 'string' ? options.cwd : options.cwd.pathname;
            createWindowArgs.push('-c', cwdPath);
        }

        // Inject env via -e flags (windows otherwise inherit from tmux server).
        createWindowArgs.push(...buildEnvFlags(env));

        // Command to run in the new window (executes immediately on creation).
        createWindowArgs.push(fullCommand);

        // -P prints the pane PID immediately so we can adopt the process.
        createWindowArgs.push('-P');
        createWindowArgs.push('-F', '#{pane_pid}');

        const createResult = await utils.executeTmuxCommand(createWindowArgs, sessionName);

        if (!createResult || createResult.returncode !== 0) {
            throw new Error(`Failed to create tmux window: ${createResult?.stderr}`);
        }

        const panePid = parseInt(createResult.stdout.trim());
        if (isNaN(panePid)) {
            throw new Error(`Failed to extract PID from tmux output: ${createResult.stdout}`);
        }

        logger.debug(`[TMUX] Spawned command in tmux session ${sessionName}, window ${windowName}, PID ${panePid}`);

        const sessionIdentifier: TmuxSessionIdentifier = {
            session: sessionName,
            window: windowName
        };

        return {
            success: true,
            sessionId: formatTmuxSessionIdentifier(sessionIdentifier),
            pid: panePid
        };
    } catch (error) {
        logger.debug('[TMUX] Failed to spawn in tmux:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
