/**
 * `TmuxUtilities` class - the stateful runtime facade over tmux.
 *
 * WHY: We keep one class (instead of free functions) because the control-state
 * parser is genuinely stateful across calls and the consistent `sessionName`
 * default belongs with the instance. All pure helpers (parsing, escaping,
 * argv building) have been extracted to sibling modules.
 */

import { logger } from '@/ui/logger';

import { buildTmuxArgv, executeCommand } from './command';
import { CONTROL_SEQUENCES, WIN_OPS } from './constants';
import { parseTmuxEnvVar } from './environment';
import { parseTmuxSessionIdentifier } from './identifiers';
import { spawnInTmuxStandalone as spawnInTmuxImpl, type TmuxSpawnResult } from './spawn';
import {
    TmuxControlState,
    TmuxSessionIdentifierError,
    type TmuxCommandResult,
    type TmuxControlSequence,
    type TmuxEnvironment,
    type TmuxSessionInfo,
    type TmuxSpawnOptions,
    type TmuxWindowOperation,
} from './types';

/**
 * Centralized tmux runtime utility with control-sequence parsing and session
 * management. Construct with a session name (defaults to "happy") and reuse
 * for the lifetime of the daemon.
 */
export class TmuxUtilities {
    /** Default session name to prevent interference with the user's own sessions. */
    public static readonly DEFAULT_SESSION_NAME = "happy";

    private controlState: TmuxControlState = TmuxControlState.NORMAL;
    public readonly sessionName: string;

    constructor(sessionName?: string) {
        this.sessionName = sessionName || TmuxUtilities.DEFAULT_SESSION_NAME;
    }

    /**
     * Detect tmux environment from the `TMUX` environment variable.
     *
     * @returns Parsed environment, or null if not running inside tmux.
     */
    detectTmuxEnvironment(): TmuxEnvironment | null {
        const parsed = parseTmuxEnvVar(process.env.TMUX);
        if (parsed === null && process.env.TMUX) {
            logger.debug('[TMUX] Failed to parse TMUX environment variable');
        }
        return parsed;
    }

    /**
     * Execute a tmux command with proper session targeting and socket handling.
     *
     * @returns Command result, or null if the spawn failed entirely.
     */
    async executeTmuxCommand(
        cmd: string[],
        session?: string,
        window?: string,
        pane?: string,
        socketPath?: string
    ): Promise<TmuxCommandResult | null> {
        const targetSession = session || this.sessionName;
        const fullCmd = buildTmuxArgv(cmd, targetSession, window, pane, socketPath);
        return executeCommand(fullCmd);
    }

    /**
     * Parse control sequences in text (`^` for escape, `^^` for literal `^`).
     *
     * WHY: This is a streaming parser - we keep `controlState` across calls so
     * a `^` at the end of one chunk correctly escapes the first char of the
     * next chunk, matching how the upstream Python reference behaves.
     *
     * @returns Tuple of [parsed text, resulting control state].
     */
    parseControlSequences(text: string): [string, TmuxControlState] {
        const result: string[] = [];
        let i = 0;
        let localState = this.controlState;

        while (i < text.length) {
            const char = text[i];

            if (localState === TmuxControlState.NORMAL) {
                if (char === '^') {
                    if (i + 1 < text.length && text[i + 1] === '^') {
                        // Literal ^
                        result.push('^');
                        i += 2;
                    } else {
                        // Escape to normal tmux
                        localState = TmuxControlState.ESCAPE;
                        i += 1;
                    }
                } else {
                    result.push(char);
                    i += 1;
                }
            } else if (localState === TmuxControlState.ESCAPE) {
                // In escape mode - pass through to tmux directly
                result.push(char);
                i += 1;
                localState = TmuxControlState.NORMAL;
            } else {
                result.push(char);
                i += 1;
            }
        }

        this.controlState = localState;
        return [result.join(''), localState];
    }

    /**
     * Execute a window operation by alias using the WIN_OPS dispatch table.
     *
     * @returns true on tmux exit code 0, false otherwise.
     */
    async executeWinOp(
        operation: TmuxWindowOperation,
        args: string[] = [],
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        const tmuxCmd = WIN_OPS[operation];
        if (!tmuxCmd) {
            logger.debug(`[TMUX] Unknown operation: ${operation}`);
            return false;
        }

        const cmdParts = tmuxCmd.split(' ');
        cmdParts.push(...args);

        const result = await this.executeTmuxCommand(cmdParts, session, window, pane);
        return result !== null && result.returncode === 0;
    }

    /**
     * Ensure the named session exists, creating it (detached) if not.
     */
    async ensureSessionExists(sessionName?: string): Promise<boolean> {
        const targetSession = sessionName || this.sessionName;

        const result = await this.executeTmuxCommand(['has-session', '-t', targetSession]);
        if (result && result.returncode === 0) {
            return true;
        }

        const createResult = await this.executeTmuxCommand(['new-session', '-d', '-s', targetSession]);
        return createResult !== null && createResult.returncode === 0;
    }

    /**
     * Capture the current input line from a tmux pane.
     *
     * @returns The last visible line in the pane, or empty string on failure.
     */
    async captureCurrentInput(
        session?: string,
        window?: string,
        pane?: string
    ): Promise<string> {
        const result = await this.executeTmuxCommand(['capture-pane', '-p'], session, window, pane);
        if (result && result.returncode === 0) {
            const lines = result.stdout.trim().split('\n');
            return lines[lines.length - 1] || '';
        }
        return '';
    }

    /**
     * Heuristic: detect if the user is actively typing in the pane by sampling
     * the input line over `maxChecks` iterations spaced `checkInterval` ms apart.
     *
     * WHY: Used to avoid sending automated keys while a human is mid-keystroke,
     * which would interleave with their input.
     */
    async isUserTyping(
        checkInterval: number = 500,
        maxChecks: number = 3,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        const initialInput = await this.captureCurrentInput(session, window, pane);

        for (let i = 0; i < maxChecks - 1; i++) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            const currentInput = await this.captureCurrentInput(session, window, pane);
            if (currentInput !== initialInput) {
                return true;
            }
        }

        return false;
    }

    /**
     * Send a single key payload (text or control sequence) to a pane.
     */
    async sendKeys(
        keys: string | TmuxControlSequence,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        if (!keys || typeof keys !== 'string') {
            logger.debug('[TMUX] Invalid keys provided to sendKeys');
            return false;
        }

        // WHY: control sequences and regular text both go through the same
        // `send-keys` argv path. The CONTROL_SEQUENCES check is retained for
        // future extension (e.g. to add `-l` for literal mode if desired) and
        // matches the original implementation's branching shape.
        if (CONTROL_SEQUENCES.has(keys as TmuxControlSequence)) {
            const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
            return result !== null && result.returncode === 0;
        } else {
            const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
            return result !== null && result.returncode === 0;
        }
    }

    /**
     * Send a sequence of keys, aborting on the first failure.
     */
    async sendMultipleKeys(
        keys: Array<string | TmuxControlSequence>,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        if (!Array.isArray(keys) || keys.length === 0) {
            logger.debug('[TMUX] Invalid keys array provided to sendMultipleKeys');
            return false;
        }

        for (const key of keys) {
            const success = await this.sendKeys(key, session, window, pane);
            if (!success) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get comprehensive session information, merging env detection with the
     * live tmux server's session list.
     */
    async getSessionInfo(sessionName?: string): Promise<TmuxSessionInfo> {
        const targetSession = sessionName || this.sessionName;
        const envInfo = this.detectTmuxEnvironment();

        const info: TmuxSessionInfo = {
            target_session: targetSession,
            session: targetSession,
            window: "unknown",
            pane: "unknown",
            socket_path: undefined,
            tmux_active: envInfo !== null,
            current_session: envInfo?.session,
            available_sessions: []
        };

        if (envInfo && envInfo.session === targetSession) {
            info.window = envInfo.window;
            info.pane = envInfo.pane;
            info.socket_path = envInfo.socket_path;
        } else if (envInfo) {
            info.env_session = envInfo.session;
            info.env_window = envInfo.window;
            info.env_pane = envInfo.pane;
        }

        const result = await this.executeTmuxCommand(['list-sessions']);
        if (result && result.returncode === 0) {
            info.available_sessions = result.stdout
                .trim()
                .split('\n')
                .filter(line => line.trim())
                .map(line => line.split(':')[0]);
        }

        return info;
    }

    /**
     * Spawn a process in a tmux window with optional environment variables.
     *
     * Thin delegating wrapper - the real logic lives in `./spawn.ts` so this
     * class stays focused on tmux command execution and session bookkeeping.
     */
    async spawnInTmux(
        args: string[],
        options: TmuxSpawnOptions = {},
        env?: Record<string, string>
    ): Promise<TmuxSpawnResult> {
        return spawnInTmuxImpl(this, args, options, env);
    }

    /**
     * Convenience: get session info from a string identifier (with parsing).
     */
    async getSessionInfoFromString(sessionIdentifier: string): Promise<TmuxSessionInfo | null> {
        try {
            const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
            const info = await this.getSessionInfo(parsed.session);
            return info;
        } catch (error) {
            if (error instanceof TmuxSessionIdentifierError) {
                logger.debug(`[TMUX] Invalid session identifier: ${error.message}`);
            } else {
                logger.debug('[TMUX] Error getting session info:', error);
            }
            return null;
        }
    }

    /**
     * Kill a tmux window safely (requires `session:window` form).
     */
    async killWindow(sessionIdentifier: string): Promise<boolean> {
        try {
            const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
            if (!parsed.window) {
                throw new TmuxSessionIdentifierError(`Window identifier required: ${sessionIdentifier}`);
            }

            const result = await this.executeWinOp('kill-window', [parsed.window], parsed.session);
            return result;
        } catch (error) {
            if (error instanceof TmuxSessionIdentifierError) {
                logger.debug(`[TMUX] Invalid window identifier: ${error.message}`);
            } else {
                logger.debug('[TMUX] Error killing window:', error);
            }
            return false;
        }
    }

    /**
     * List window names in a session.
     */
    async listWindows(sessionName?: string): Promise<string[]> {
        const targetSession = sessionName || this.sessionName;
        const result = await this.executeTmuxCommand(['list-windows', '-t', targetSession]);

        if (!result || result.returncode !== 0) {
            return [];
        }

        const windows: string[] = [];
        const lines = result.stdout.trim().split('\n');

        for (const line of lines) {
            const match = line.match(/^\d+:\s+(\w+)/);
            if (match) {
                windows.push(match[1]);
            }
        }

        return windows;
    }
}
