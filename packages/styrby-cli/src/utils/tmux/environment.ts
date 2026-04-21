/**
 * Pure helpers for parsing tmux environment context.
 *
 * WHY: The `TMUX` env var has a specific `<socket>,<pid>,<pane>` format. Parsing
 * it lives here as a pure function so it is testable without spawning tmux,
 * mocking process.env, or pulling in the heavy `TmuxUtilities` class.
 */

import type { TmuxEnvironment } from './types';

/**
 * Parse the raw value of `process.env.TMUX` into a structured environment.
 *
 * The TMUX env var looks like: `/tmp/tmux-1000/default,4219,0`
 * (socket path, server PID/session ref, pane index).
 *
 * WHY: tmux only exports this when running inside a tmux client. We use it to
 * detect whether the host process is itself attached, and to recover the
 * socket path so subsequent commands hit the right server.
 *
 * @param tmuxEnv - Raw value of the TMUX environment variable, or undefined
 * @returns Parsed environment, or null if the value is missing/malformed
 *
 * @example
 * parseTmuxEnvVar('/tmp/tmux-1000/default,4219,0')
 *   // => { session: 'default', window: '0', pane: '0', socket_path: '/tmp/tmux-1000/default' }
 */
export function parseTmuxEnvVar(tmuxEnv: string | undefined): TmuxEnvironment | null {
    if (!tmuxEnv) {
        return null;
    }

    try {
        const parts = tmuxEnv.split(',');
        if (parts.length < 3) {
            return null;
        }

        const socketPath = parts[0];
        // Extract last component from path (JavaScript doesn't support negative array indexing).
        const pathParts = parts[1].split('/');
        const sessionAndWindow = pathParts[pathParts.length - 1] || parts[1];
        const pane = parts[2];

        // WHY: Some tmux versions emit `session.window`, others just `session`.
        // Default the window to "0" so downstream code never deals with undefined.
        let session: string;
        let window: string;
        if (sessionAndWindow.includes('.')) {
            const split = sessionAndWindow.split('.', 2);
            session = split[0];
            window = split[1] || "0";
        } else {
            session = sessionAndWindow;
            window = "0";
        }

        return {
            session,
            window,
            pane,
            socket_path: socketPath
        };
    } catch {
        return null;
    }
}
