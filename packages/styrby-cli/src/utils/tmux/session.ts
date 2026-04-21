/**
 * Top-level session lifecycle helpers and the shared `TmuxUtilities` singleton.
 *
 * WHY: These are the entry points that callers reach for ("is tmux available?",
 * "create me a session", "give me the global utility"). Keeping them outside the
 * class keeps the class focused on per-instance behavior, and lets callers use
 * the helpers without bothering to construct anything.
 */

import { formatTmuxSessionIdentifier } from './identifiers';
import {
    TmuxSessionIdentifierError,
    type TmuxSessionIdentifier,
} from './types';
import { TmuxUtilities } from './utilities';

/**
 * Module-level singleton, lazily initialized on first call to
 * `getTmuxUtilities`. Replaced if the requested session name differs.
 *
 * WHY: A singleton avoids constructing fresh `TmuxUtilities` for every call
 * site while still allowing distinct test/dev sessions to swap it out.
 */
let _tmuxUtils: TmuxUtilities | null = null;

/**
 * Get the shared TmuxUtilities instance, recreating it if a different
 * session name is requested.
 */
export function getTmuxUtilities(sessionName?: string): TmuxUtilities {
    if (!_tmuxUtils || (sessionName && sessionName !== _tmuxUtils.sessionName)) {
        _tmuxUtils = new TmuxUtilities(sessionName);
    }
    return _tmuxUtils;
}

/**
 * Probe whether the tmux binary is installed and reachable.
 *
 * WHY: Used as a feature gate so the daemon can transparently fall back to
 * non-tmux process management when tmux is missing.
 */
export async function isTmuxAvailable(): Promise<boolean> {
    try {
        const utils = new TmuxUtilities();
        const result = await utils.executeTmuxCommand(['list-sessions']);
        return result !== null;
    } catch {
        return false;
    }
}

/**
 * Create a brand-new tmux session with validation.
 *
 * @param sessionName - Must match `[a-zA-Z0-9._-]+`
 * @param options.detached - Default true; pass false to attach immediately
 * @param options.windowName - Initial window name, defaults to "main"
 * @returns Success result with the formatted identifier, or structured error.
 */
export async function createTmuxSession(
    sessionName: string,
    options?: {
        windowName?: string;
        detached?: boolean;
        attach?: boolean;
    }
): Promise<{ success: boolean; sessionIdentifier?: string; error?: string }> {
    try {
        if (!sessionName || !/^[a-zA-Z0-9._-]+$/.test(sessionName)) {
            throw new TmuxSessionIdentifierError(`Invalid session name: "${sessionName}"`);
        }

        const utils = new TmuxUtilities(sessionName);
        const windowName = options?.windowName || 'main';

        const cmd = ['new-session'];
        if (options?.detached !== false) {
            cmd.push('-d');
        }
        cmd.push('-s', sessionName);
        cmd.push('-n', windowName);

        const result = await utils.executeTmuxCommand(cmd);
        if (result && result.returncode === 0) {
            const sessionIdentifier: TmuxSessionIdentifier = {
                session: sessionName,
                window: windowName
            };
            return {
                success: true,
                sessionIdentifier: formatTmuxSessionIdentifier(sessionIdentifier)
            };
        } else {
            return {
                success: false,
                error: result?.stderr || 'Failed to create tmux session'
            };
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
