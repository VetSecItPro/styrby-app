/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { join, resolve as pathResolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { logger } from '@/ui/logger'
import { isBun } from '@/utils/runtime'
import { buildSafeEnv } from '@/utils/safeEnv'

/**
 * Allowed root directories for HAPPY_CLAUDE_PATH (CLI-003).
 *
 * SECURITY (audit 2026-05-04): HAPPY_CLAUDE_PATH lets the operator override the
 * claude binary path, but if a process can set env vars it can also redirect
 * the spawn to an attacker-supplied executable. We restrict the override to
 * recognised package-manager install roots so an attacker who can poison env
 * vars (e.g. via a malicious .env file) still can't point us at /tmp/evil.
 *
 * Allowed roots cover the common install locations:
 *   ~/.npm/, /usr/local/, /opt/, ~/.local/, ~/.bun/, ~/.volta/
 */
function getHappyClaudePathAllowedRoots(): string[] {
    const home = homedir()
    return [
        pathResolve(home, '.npm'),
        '/usr/local',
        '/opt',
        pathResolve(home, '.local'),
        pathResolve(home, '.bun'),
        pathResolve(home, '.volta'),
    ]
}

/**
 * Validate a HAPPY_CLAUDE_PATH override.
 *
 * Returns the resolved absolute path if the override is safe to spawn, or
 * `null` if it must be rejected. Logs the resolved path on success and a
 * warning on rejection so operators can debug.
 *
 * Checks:
 *   1. No null bytes / CR / LF (header-injection-class defenses)
 *   2. No `..` after normalisation (path traversal)
 *   3. Must resolve under an allowed install root
 *   4. Must exist on disk
 *
 * @internal exported (was unexported) so the CLI-003 security hardening
 * can be unit-tested directly. Not part of the package's public API
 * surface — call sites outside utils.ts should not use it.
 */
export function validateHappyClaudePath(raw: string): string | null {
    // Reject control chars outright
    if (/[\x00\r\n]/.test(raw)) {
        logger.warn('[Claude SDK] HAPPY_CLAUDE_PATH contains control characters - ignoring')
        return null
    }

    const normalized = normalize(raw)
    if (normalized.includes('..')) {
        logger.warn(`[Claude SDK] HAPPY_CLAUDE_PATH contains ".." traversal: ${raw} - ignoring`)
        return null
    }

    let resolved: string
    try {
        resolved = pathResolve(normalized)
        // Resolve symlinks to defeat link-shenanigans pointing into allowed roots
        if (existsSync(resolved)) {
            try { resolved = realpathSync(resolved) } catch { /* keep resolved as-is */ }
        }
    } catch (e) {
        logger.warn(`[Claude SDK] HAPPY_CLAUDE_PATH could not be resolved: ${raw}`)
        return null
    }

    const allowedRoots = getHappyClaudePathAllowedRoots()
    const isUnderAllowed = allowedRoots.some(root => resolved === root || resolved.startsWith(root + '/'))
    if (!isUnderAllowed) {
        logger.warn(
            `[Claude SDK] HAPPY_CLAUDE_PATH rejected: ${resolved} is not under an allowed install root ` +
            `(${allowedRoots.join(', ')}). Falling back to PATH-resolved 'claude'.`
        )
        return null
    }

    if (!existsSync(resolved)) {
        logger.warn(`[Claude SDK] HAPPY_CLAUDE_PATH does not exist on disk: ${resolved} - ignoring`)
        return null
    }

    logger.debug(`[Claude SDK] HAPPY_CLAUDE_PATH validated: ${resolved}`)
    return resolved
}

/**
 * Get the directory path of the current module
 */
const __filename = fileURLToPath(import.meta.url)
const __dirname = join(__filename, '..')

/**
 * Get version of globally installed claude
 * Runs from home directory with clean PATH to avoid picking up local node_modules/.bin
 */
function getGlobalClaudeVersion(): string | null {
    try {
        const cleanEnv = getCleanEnv()
        const output = execSync('claude --version', { 
            encoding: 'utf8', 
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homedir(),
            env: cleanEnv
        }).trim()
        // Output format: "2.0.54 (Claude Code)" or similar
        const match = output.match(/(\d+\.\d+\.\d+)/)
        logger.debug(`[Claude SDK] Global claude --version output: ${output}`)
        return match ? match[1] : null
    } catch {
        return null
    }
}

/**
 * Create a clean, secret-free environment for spawning the global `claude`
 * binary (used for `claude --version` checks and PATH discovery).
 *
 * SECURITY (audit 2026-05-05 HIGH fix): Previously this function did
 * `{ ...process.env }` minus a tiny denylist, which still leaked
 * SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, Polar tokens, etc. to the
 * spawned claude process. Replaced with `buildSafeEnv()` (the global
 * allowlist) — same protection class as sdk/query.ts:354 already uses
 * for the spawnEnv branch. The `isCommandOnly` branch in query.ts that
 * still calls getCleanEnv() now also benefits.
 *
 * Additional behavior preserved from the legacy implementation:
 *   1. Strip CWD-relative entries from PATH so we find the GLOBAL
 *      `claude` binary, not the local node_modules/.bin shim.
 *   2. Drop `BUN_*` vars when running under Bun so the spawned Node
 *      process doesn't inherit Bun-specific runtime hints.
 *
 * `BUN_*` was already implicitly excluded by the allowlist (no
 * SAFE_ENV_PREFIXES entry matches it), but we keep an explicit
 * defense-in-depth pass for traceability.
 */
export function getCleanEnv(): NodeJS.ProcessEnv {
    // Start from the global safe-env (allowlist + blocklist applied).
    const env: Record<string, string | undefined> = buildSafeEnv()
    const cwd = process.cwd()
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'

    // Also check for PATH on Windows (case can vary)
    const actualPathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || pathKey

    if (env[actualPathKey]) {
        // Remove any path that contains the current working directory (local node_modules/.bin)
        const cleanPath = env[actualPathKey]!
            .split(pathSep)
            .filter(p => {
                const normalizedP = p.replace(/\\/g, '/').toLowerCase()
                const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase()
                return !normalizedP.startsWith(normalizedCwd)
            })
            .join(pathSep)
        env[actualPathKey] = cleanPath
        logger.debug(`[Claude SDK] Cleaned PATH, removed local paths from: ${cwd}`)
    }

    // Remove Bun-specific environment variables that can interfere with Node.js processes.
    // (The allowlist should already exclude these, but be explicit.)
    if (isBun()) {
        Object.keys(env).forEach(key => {
            if (key.startsWith('BUN_')) {
                delete env[key]
            }
        })
        logger.debug('[Claude SDK] Removed Bun-specific environment variables for Node.js compatibility')
    }

    return env as NodeJS.ProcessEnv
}

/**
 * Try to find globally installed Claude CLI
 * Returns 'claude' if the command works globally (preferred method for reliability)
 * Falls back to which/where to get actual path on Unix systems
 * Runs from home directory with clean PATH to avoid picking up local node_modules/.bin
 */
function findGlobalClaudePath(): string | null {
    const homeDir = homedir()
    const cleanEnv = getCleanEnv()
    
    // PRIMARY: Check if 'claude' command works directly from home dir with clean PATH
    try {
        execSync('claude --version', { 
            encoding: 'utf8', 
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir,
            env: cleanEnv
        })
        logger.debug('[Claude SDK] Global claude command available (checked with clean PATH)')
        return 'claude'
    } catch {
        // claude command not available globally
    }

    // FALLBACK for Unix: try which to get actual path
    if (process.platform !== 'win32') {
        try {
            const result = execSync('which claude', { 
                encoding: 'utf8', 
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: homeDir,
                env: cleanEnv
            }).trim()
            if (result && existsSync(result)) {
                logger.debug(`[Claude SDK] Found global claude path via which: ${result}`)
                return result
            }
        } catch {
            // which didn't find it
        }
    }
    
    return null
}

/**
 * Get default path to Claude Code executable
 * Compares global and bundled versions, uses the newer one
 * 
 * Environment variables:
 * - HAPPY_CLAUDE_PATH: Force a specific path to claude executable
 * - HAPPY_USE_BUNDLED_CLAUDE=1: Force use of node_modules version (skip global search)
 * - HAPPY_USE_GLOBAL_CLAUDE=1: Force use of global version (if available)
 */
export function getDefaultClaudeCodePath(): string {
    const nodeModulesPath = join(__dirname, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    
    /**
     * HAPPY_CLAUDE_PATH — Absolute path to the claude CLI executable to use.
     *
     * Source: Set manually in shell profile or .env when testing a non-standard
     *   claude build (e.g. a locally compiled version or a pinned version).
     * Format: Absolute path string, e.g. "/usr/local/bin/claude" or
     *   "/path/to/custom/build/claude"
     * Required in: optional — omit to use auto-detection logic below
     * Behavior when missing: falls through to HAPPY_USE_BUNDLED_CLAUDE check,
     *   then global path detection, then bundled fallback.
     * Rotation: not a secret — update whenever the override path changes.
     *
     * HAPPY_USE_BUNDLED_CLAUDE — Force use of the node_modules bundled claude binary.
     *
     * Source: Set to "1" in .env or shell to skip global claude search entirely.
     *   Useful in CI or restricted environments where global installs are unavailable.
     * Format: "1" to enable; any other value (or unset) disables.
     * Required in: optional — only needed in CI or tightly controlled environments
     * Behavior when missing: auto-detection compares global vs bundled versions.
     * Rotation: not a secret — toggle as needed.
     */
    // Allow explicit override via env var, but VALIDATE the path (CLI-003).
    // SECURITY (audit 2026-05-04): Untrusted env vars MUST NOT be able to
    // redirect the spawn to arbitrary executables. validateHappyClaudePath()
    // restricts the override to recognised package-manager install roots and
    // rejects path traversal / control chars. On rejection we fall through to
    // the auto-detection logic below with `claude` resolved via PATH.
    if (process.env.HAPPY_CLAUDE_PATH) {
        const validated = validateHappyClaudePath(process.env.HAPPY_CLAUDE_PATH)
        if (validated) {
            logger.debug(`[Claude SDK] Using HAPPY_CLAUDE_PATH (validated): ${validated}`)
            return validated
        }
        // Validation failed — log already happened in validator. Fall through.
    }

    // Force bundled version if requested
    if (process.env.HAPPY_USE_BUNDLED_CLAUDE === '1') {
        logger.debug(`[Claude SDK] Forced bundled version: ${nodeModulesPath}`)
        return nodeModulesPath
    }

    // Find global claude
    const globalPath = findGlobalClaudePath()
    


    // No global claude found - use bundled
    if (!globalPath) {
        logger.debug(`[Claude SDK] No global claude found, using bundled: ${nodeModulesPath}`)
        return nodeModulesPath
    }

    // Compare versions and use the newer one
    const globalVersion = getGlobalClaudeVersion()

    logger.debug(`[Claude SDK] Global version: ${globalVersion || 'unknown'}`)
    
    // If we can't determine versions, prefer global (user's choice to install it)
    if (!globalVersion) {
        logger.debug(`[Claude SDK] Cannot compare versions, using global: ${globalPath}`)
        return globalPath
    }
    
    return globalPath
}

/**
 * Log debug message
 */
export function logDebug(message: string): void {
    if (process.env.DEBUG) {
        logger.debug(message)
        console.log(message)
    }
}

/**
 * Stream async messages to stdin
 */
export async function streamToStdin(
    stream: AsyncIterable<unknown>,
    stdin: NodeJS.WritableStream,
    abort?: AbortSignal
): Promise<void> {
    for await (const message of stream) {
        if (abort?.aborted) break
        stdin.write(JSON.stringify(message) + '\n')
    }
    stdin.end()
}