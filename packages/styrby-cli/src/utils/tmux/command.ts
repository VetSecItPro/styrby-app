/**
 * Subprocess helpers for invoking the `tmux` binary.
 *
 * WHY: Centralizing the spawn/parse plumbing here means TmuxUtilities can stay
 * focused on tmux semantics, and we get a single chokepoint to change timeouts,
 * stdio handling, or shell escaping in the future.
 */

import { spawn, type SpawnOptions } from 'child_process';
import { logger } from '@/ui/logger';

import { COMMANDS_SUPPORTING_TARGET } from './constants';
import type { TmuxCommandResult } from './types';

/**
 * Internal raw-result shape returned by the spawn wrapper.
 * Exposed only via `executeCommand` below.
 */
interface SpawnResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * Run a command via `child_process.spawn` and collect stdout/stderr.
 *
 * WHY: We use `spawn` (not `exec`) so we never invoke a shell - tmux args go
 * through verbatim, eliminating an entire class of injection bugs from
 * unescaped input. A 5s timeout prevents stuck `tmux` processes from leaking.
 */
export function runCommand(args: string[], options: SpawnOptions = {}): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(args[0], args.slice(1), {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
            shell: false,
            ...options
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data) => { stdout += data.toString(); });
        child.stderr?.on('data', (data) => { stderr += data.toString(); });

        child.on('close', (code) => {
            resolve({ exitCode: code || 0, stdout, stderr });
        });

        child.on('error', (error) => {
            reject(error);
        });
    });
}

/**
 * Execute a tmux command array and return a normalized result object.
 *
 * @returns The command result, or null if spawn itself failed (e.g. tmux missing).
 */
export async function executeCommand(cmd: string[]): Promise<TmuxCommandResult | null> {
    try {
        const result = await runCommand(cmd);
        return {
            returncode: result.exitCode,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            command: cmd
        };
    } catch (error) {
        logger.debug('[TMUX] Command execution failed:', error);
        return null;
    }
}

/**
 * Build the full argv vector for a tmux invocation, applying socket flags and
 * `-t` target injection where appropriate.
 *
 * WHY: The original code duplicated this construction in two branches (send-keys
 * vs other). Pulling it into one pure function makes the routing rule explicit
 * and removes the duplication. The send-keys branch keeps its special handling
 * because tmux requires `-t` to appear before the keys, not after.
 */
export function buildTmuxArgv(
    cmd: string[],
    targetSession: string,
    window: string | undefined,
    pane: string | undefined,
    socketPath: string | undefined
): string[] {
    const baseCmd = socketPath ? ['tmux', '-S', socketPath] : ['tmux'];

    if (cmd.length === 0) {
        return baseCmd;
    }

    // send-keys requires `-t target` immediately after the subcommand,
    // before the keys payload. Other commands accept `-t` at the end.
    if (cmd[0] === 'send-keys') {
        const fullCmd = [...baseCmd, cmd[0]];
        let target = targetSession;
        if (window) target += `:${window}`;
        if (pane) target += `.${pane}`;
        fullCmd.push('-t', target);
        fullCmd.push(...cmd.slice(1));
        return fullCmd;
    }

    const fullCmd = [...baseCmd, ...cmd];
    if (COMMANDS_SUPPORTING_TARGET.has(cmd[0])) {
        let target = targetSession;
        if (window) target += `:${window}`;
        if (pane) target += `.${pane}`;
        fullCmd.push('-t', target);
    }
    return fullCmd;
}
