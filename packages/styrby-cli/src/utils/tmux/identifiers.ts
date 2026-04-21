/**
 * Pure helpers for parsing, formatting, validating, and building tmux session
 * identifiers (`session[:window[.pane]]`).
 *
 * WHY: Identifier parsing has no I/O dependency on tmux itself, so isolating it
 * here keeps it 100% unit-testable and reusable from places (e.g. config
 * validators, CLI flag parsers) that have no business pulling in `child_process`.
 */

import { TmuxSessionIdentifierError, type TmuxSessionIdentifier } from './types';

/**
 * Tmux session/window names accept alphanumerics plus `.`, `_`, `-`.
 *
 * WHY: tmux itself silently misbehaves on names with spaces, colons, or shell
 * metacharacters. We pre-validate so failures are reported with a descriptive
 * error instead of a cryptic tmux usage message.
 */
const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const PANE_REGEX = /^[0-9]+$/;

/**
 * Parse a tmux session identifier string into its components.
 *
 * @param identifier - Format: `session`, `session:window`, or `session:window.pane`
 * @returns Parsed identifier with optional window/pane fields
 * @throws {TmuxSessionIdentifierError} On empty input or invalid characters
 *
 * @example
 * parseTmuxSessionIdentifier('happy:agent.0')
 *   // => { session: 'happy', window: 'agent', pane: '0' }
 */
export function parseTmuxSessionIdentifier(identifier: string): TmuxSessionIdentifier {
    if (!identifier || typeof identifier !== 'string') {
        throw new TmuxSessionIdentifierError('Session identifier must be a non-empty string');
    }

    // Format: session:window or session:window.pane or just session
    const parts = identifier.split(':');
    if (parts.length === 0 || !parts[0]) {
        throw new TmuxSessionIdentifierError('Invalid session identifier: missing session name');
    }

    const result: TmuxSessionIdentifier = {
        session: parts[0].trim()
    };

    if (!NAME_REGEX.test(result.session)) {
        throw new TmuxSessionIdentifierError(`Invalid session name: "${result.session}". Only alphanumeric characters, dots, hyphens, and underscores are allowed.`);
    }

    if (parts.length > 1) {
        const windowAndPane = parts[1].split('.');
        result.window = windowAndPane[0]?.trim();

        if (result.window && !NAME_REGEX.test(result.window)) {
            throw new TmuxSessionIdentifierError(`Invalid window name: "${result.window}". Only alphanumeric characters, dots, hyphens, and underscores are allowed.`);
        }

        if (windowAndPane.length > 1) {
            result.pane = windowAndPane[1]?.trim();
            if (result.pane && !PANE_REGEX.test(result.pane)) {
                throw new TmuxSessionIdentifierError(`Invalid pane identifier: "${result.pane}". Only numeric values are allowed.`);
            }
        }
    }

    return result;
}

/**
 * Format a structured identifier back into a string.
 *
 * @param identifier - Identifier to render. Must have `session` set.
 * @returns Canonical `session[:window[.pane]]` string
 * @throws {TmuxSessionIdentifierError} If `session` is missing
 */
export function formatTmuxSessionIdentifier(identifier: TmuxSessionIdentifier): string {
    if (!identifier.session) {
        throw new TmuxSessionIdentifierError('Session identifier must have a session name');
    }

    let result = identifier.session;
    if (identifier.window) {
        result += `:${identifier.window}`;
        if (identifier.pane) {
            result += `.${identifier.pane}`;
        }
    }
    return result;
}

/**
 * Extract session/window from raw tmux output (e.g. `list-windows`).
 *
 * WHY: Some tmux subcommands prefix lines with `session:window` even when we
 * only requested window info. This helper grabs the first such match without
 * forcing callers to write the regex inline.
 *
 * @returns Match object or null if no recognizable line was found
 */
export function extractSessionAndWindow(tmuxOutput: string): { session: string; window: string } | null {
    if (!tmuxOutput || typeof tmuxOutput !== 'string') {
        return null;
    }

    const lines = tmuxOutput.split('\n');
    for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+)(?:\.([0-9]+))?/);
        if (match) {
            return {
                session: match[1],
                window: match[2]
            };
        }
    }

    return null;
}

/**
 * Non-throwing wrapper around `parseTmuxSessionIdentifier`.
 *
 * @returns `{ valid: true }` on success, `{ valid: false, error }` otherwise.
 */
export function validateTmuxSessionIdentifier(identifier: string): { valid: boolean; error?: string } {
    try {
        parseTmuxSessionIdentifier(identifier);
        return { valid: true };
    } catch (error) {
        return {
            valid: false,
            error: error instanceof Error ? error.message : 'Unknown validation error'
        };
    }
}

/**
 * Build and validate a tmux session identifier from raw fields.
 *
 * WHY: Often we already have the session/window/pane as separate values (e.g.
 * after spawning a window). This helper validates each field independently and
 * returns either a built string or a structured error - never throws.
 */
export function buildTmuxSessionIdentifier(params: {
    session: string;
    window?: string;
    pane?: string;
}): { success: boolean; identifier?: string; error?: string } {
    try {
        if (!params.session || !NAME_REGEX.test(params.session)) {
            throw new TmuxSessionIdentifierError(`Invalid session name: "${params.session}"`);
        }

        if (params.window && !NAME_REGEX.test(params.window)) {
            throw new TmuxSessionIdentifierError(`Invalid window name: "${params.window}"`);
        }

        if (params.pane && !PANE_REGEX.test(params.pane)) {
            throw new TmuxSessionIdentifierError(`Invalid pane identifier: "${params.pane}"`);
        }

        const identifier: TmuxSessionIdentifier = params;
        return {
            success: true,
            identifier: formatTmuxSessionIdentifier(identifier)
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}
