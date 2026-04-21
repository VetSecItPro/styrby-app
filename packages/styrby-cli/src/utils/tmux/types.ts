/**
 * Tmux core types, enums, and error classes.
 *
 * WHY: Centralizing types prevents drift between sub-modules (identifiers, command,
 * utilities) that all need to agree on the shape of a session, environment, or
 * control sequence. Keeping types in a leaf module avoids circular imports.
 *
 * Originally part of utils/tmux.ts (1,050 LOC). Extracted for the
 * Component-First Architecture rule (every file < 400 LOC).
 *
 * Adapted from Python reference, Apache 2.0 (c) 2025 Andrew Hundt.
 */

import type { SpawnOptions } from 'child_process';

/**
 * Control state for the streaming text-to-tmux parser.
 *
 * WHY: tmux send-keys distinguishes literal text vs. escape sequences vs. control
 * shortcuts. We model the parser as a tiny state machine so we can stream tokens
 * without re-scanning the whole buffer.
 */
export enum TmuxControlState {
    /** Normal text processing mode */
    NORMAL = "normal",
    /** Escape to tmux control mode */
    ESCAPE = "escape",
    /** Literal character mode */
    LITERAL = "literal"
}

/**
 * Union type of valid tmux control sequences.
 *
 * WHY: Typing as a literal union (instead of `string`) lets the compiler catch
 * typos like `'C-X'` (uppercase) at the call site, before they reach tmux and
 * fail silently.
 */
export type TmuxControlSequence =
    | 'C-m' | 'C-c' | 'C-l' | 'C-u' | 'C-w' | 'C-a' | 'C-b' | 'C-d' | 'C-e' | 'C-f'
    | 'C-g' | 'C-h' | 'C-i' | 'C-j' | 'C-k' | 'C-n' | 'C-o' | 'C-p' | 'C-q' | 'C-r'
    | 'C-s' | 'C-t' | 'C-v' | 'C-x' | 'C-y' | 'C-z' | 'C-\\' | 'C-]' | 'C-[' | 'C-]';

/** Union type of valid tmux window operations for better type safety. */
export type TmuxWindowOperation =
    // Navigation and window management
    | 'new-window' | 'new' | 'nw'
    | 'select-window' | 'sw' | 'window' | 'w'
    | 'next-window' | 'n' | 'prev-window' | 'p' | 'pw'
    // Pane management
    | 'split-window' | 'split' | 'sp' | 'vsplit' | 'vsp'
    | 'select-pane' | 'pane'
    | 'next-pane' | 'np' | 'prev-pane' | 'pp'
    // Session management
    | 'new-session' | 'ns' | 'new-sess'
    | 'attach-session' | 'attach' | 'as'
    | 'detach-client' | 'detach' | 'dc'
    // Layout and display
    | 'select-layout' | 'layout' | 'sl'
    | 'clock-mode' | 'clock'
    | 'copy-mode' | 'copy'
    | 'search-forward' | 'search-backward'
    // Misc operations
    | 'list-windows' | 'lw' | 'list-sessions' | 'ls' | 'list-panes' | 'lp'
    | 'rename-window' | 'rename' | 'kill-window' | 'kw'
    | 'kill-pane' | 'kp' | 'kill-session' | 'ks'
    // Display and info
    | 'display-message' | 'display' | 'dm'
    | 'show-options' | 'show' | 'so'
    // Control and scripting
    | 'send-keys' | 'send' | 'sk'
    | 'capture-pane' | 'capture' | 'cp'
    | 'pipe-pane' | 'pipe'
    // Buffer operations
    | 'list-buffers' | 'lb' | 'save-buffer' | 'sb'
    | 'delete-buffer' | 'db'
    // Advanced operations
    | 'resize-pane' | 'resize' | 'rp'
    | 'swap-pane' | 'swap'
    | 'join-pane' | 'join' | 'break-pane' | 'break';

/** Snapshot of an active tmux environment, parsed from `process.env.TMUX`. */
export interface TmuxEnvironment {
    session: string;
    window: string;
    pane: string;
    socket_path?: string;
}

/** Result of a single tmux subprocess invocation. */
export interface TmuxCommandResult {
    returncode: number;
    stdout: string;
    stderr: string;
    command: string[];
}

/** Comprehensive tmux session information returned to consumers. */
export interface TmuxSessionInfo {
    target_session: string;
    session: string;
    window: string;
    pane: string;
    socket_path?: string;
    tmux_active: boolean;
    current_session?: string;
    env_session?: string;
    env_window?: string;
    env_pane?: string;
    available_sessions: string[];
}

/** Strongly typed tmux session identifier (session[:window[.pane]]). */
export interface TmuxSessionIdentifier {
    session: string;
    window?: string;
    pane?: string;
}

/**
 * Validation error for tmux session identifiers.
 *
 * WHY: A dedicated subclass lets callers `instanceof` check and downgrade to
 * debug-level logging instead of crashing on user-supplied identifiers.
 */
export class TmuxSessionIdentifierError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TmuxSessionIdentifierError';
    }
}

/**
 * Spawn options for `spawnInTmux`.
 *
 * WHY: `env` is intentionally excluded - tmux windows inherit the server's
 * environment, so we only forward variables that genuinely differ via -e flags.
 * Bundling them into SpawnOptions would imply 50+ -e flags per spawn.
 */
export interface TmuxSpawnOptions extends Omit<SpawnOptions, 'env'> {
    /** Target tmux session name */
    sessionName?: string;
    /** Custom tmux socket path */
    socketPath?: string;
    /** Create new window in existing session */
    createWindow?: boolean;
    /** Window name for new windows */
    windowName?: string;
}
