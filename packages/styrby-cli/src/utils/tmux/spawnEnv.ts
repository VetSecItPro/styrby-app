/**
 * Pure helpers for translating a JS env object into safe `tmux new-window -e`
 * argv entries.
 *
 * WHY: Shell-escaping is the kind of code that breeds subtle injection bugs if
 * inlined. A standalone helper lets us unit-test every escape rule (backslash,
 * double-quote, dollar, backtick) without spinning up tmux.
 */

import { logger } from '@/ui/logger';

/**
 * Validate that an env var name matches POSIX rules tmux accepts:
 * leading letter or underscore, then alphanumerics or underscore.
 */
const ENV_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/i;

/**
 * Escape an env var value so it can safely sit inside double quotes in the
 * `KEY="VALUE"` argument we hand to `tmux new-window -e`.
 *
 * Order matters: backslash MUST be escaped first, otherwise we double-escape
 * the slashes we just added for the other rules.
 */
export function escapeEnvValue(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');
}

/**
 * Build the `-e KEY="VALUE"` argv entries for a `tmux new-window` invocation.
 *
 * Skips entries with invalid names or null/undefined values, logging a warning
 * so misconfigured callers see the issue without crashing the spawn.
 *
 * @returns Flat array of argv tokens to splice into the new-window command.
 */
export function buildEnvFlags(env: Record<string, string> | undefined): string[] {
    if (!env || Object.keys(env).length === 0) {
        return [];
    }

    const flags: string[] = [];
    let validCount = 0;

    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || value === null) {
            logger.warn(`[TMUX] Skipping undefined/null environment variable: ${key}`);
            continue;
        }
        if (!ENV_NAME_REGEX.test(key)) {
            logger.warn(`[TMUX] Skipping invalid environment variable name: ${key}`);
            continue;
        }

        flags.push('-e', `${key}="${escapeEnvValue(value)}"`);
        validCount++;
    }

    if (validCount > 0) {
        logger.debug(`[TMUX] Setting ${validCount} environment variables in tmux window`);
    }

    return flags;
}
