/**
 * Safe Environment Variable Filtering for Subprocess Spawning
 *
 * WHY: When spawning AI agent subprocesses (goose, amp, aider, opencode, gemini),
 * we must NOT leak the full parent process environment. Secrets like SUPABASE_SERVICE_ROLE_KEY,
 * database URLs, Vercel tokens, and other internal credentials should never be
 * accessible to external CLI tools. This module provides a curated allowlist of
 * safe environment variables to forward.
 *
 * SECURITY: This is a defense-in-depth measure. Even if an agent subprocess is
 * compromised, it cannot exfiltrate secrets it never received.
 *
 * @module utils/safeEnv
 */

/**
 * Environment variables that are safe to forward to agent subprocesses.
 *
 * Categories:
 * - System: PATH, HOME, SHELL, TERM, LANG, etc. (required for process execution)
 * - Node.js: NODE_ENV, NODE_PATH (runtime configuration)
 * - Editor: EDITOR, VISUAL (used by some agents for file editing)
 * - Proxy: HTTP_PROXY, HTTPS_PROXY, NO_PROXY (network configuration)
 * - Display: DISPLAY, WAYLAND_DISPLAY (Linux GUI detection)
 * - XDG: XDG_* (standard directory paths)
 * - Temp: TMPDIR, TEMP, TMP (temp directory resolution)
 * - Git: GIT_* (git configuration needed by agents that run git commands)
 *
 * EXPLICITLY EXCLUDED (never forwarded):
 * - SUPABASE_* (database credentials)
 * - VERCEL_* (deployment tokens)
 * - STYRBY_* (internal app secrets)
 * - DATABASE_URL, POSTGRES_* (database connections)
 * - AWS_*, AZURE_*, GCP_* (cloud provider credentials)
 * - SECRET_*, TOKEN_*, PASSWORD_* (generic secret patterns)
 * - GITHUB_TOKEN (CI/deployment tokens)
 * - NPM_TOKEN (package registry auth)
 *
 * Agent-specific API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) are injected
 * explicitly by each factory — never forwarded from the parent environment.
 */
const SAFE_ENV_PREFIXES = [
  // System essentials
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TERM_PROGRAM',
  'COLORTERM',
  'LANG',
  'LC_',
  'LANGUAGE',
  // Node.js
  'NODE_ENV',
  'NODE_PATH',
  'NODE_OPTIONS',
  // Editor
  'EDITOR',
  'VISUAL',
  // Proxy
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  // Display (Linux)
  'DISPLAY',
  'WAYLAND_DISPLAY',
  // XDG standard directories
  'XDG_',
  // Temp directories
  'TMPDIR',
  'TEMP',
  'TMP',
  // Git
  'GIT_',
  // macOS
  'APPLE_',
  '__CF_',
  // SSH (for git operations through agents)
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  // Windows
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'WINDIR',
  // Misc runtime
  'HOSTNAME',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'ZDOTDIR',
  'DEBUG',
] as const;

/**
 * Environment variable names/prefixes that must NEVER be forwarded.
 * These take precedence over the allowlist (belt-and-suspenders).
 */
const BLOCKED_ENV_PATTERNS = [
  'SUPABASE_',
  'VERCEL_',
  'STYRBY_SECRET',
  'STYRBY_SERVICE',
  'DATABASE_URL',
  'POSTGRES_',
  'AWS_SECRET',
  'AWS_SESSION_TOKEN',
  'AZURE_',
  'GCP_',
  'SECRET_',
  'TOKEN_',
  'PASSWORD',
  'NPM_TOKEN',
  'GITHUB_TOKEN',
  'POLAR_',
  'STRIPE_',
  '_KEY', // catches *_KEY patterns but we re-allow specific ones below
] as const;

/**
 * Specific keys that are blocked even though they might match safe prefixes.
 * The _KEY blocker above is aggressive by design; agent-specific API keys
 * are injected explicitly by factories, never forwarded from parent env.
 */

/**
 * Build a filtered environment object safe for subprocess spawning.
 *
 * Starts with the current process.env, filters to the allowlist, then
 * removes anything matching the blocklist. Finally merges any explicit
 * overrides (which are NOT filtered — the caller is responsible for
 * only passing intentional values like API keys).
 *
 * @param overrides - Explicit env vars to set (e.g., API keys). These bypass filtering.
 * @returns Environment object safe to pass to child_process.spawn()
 *
 * @example
 * ```ts
 * const env = buildSafeEnv({
 *   ANTHROPIC_API_KEY: userApiKey,
 *   OPENAI_API_KEY: userApiKey,
 * });
 * spawn('goose', args, { env });
 * ```
 */
export function buildSafeEnv(overrides?: Record<string, string | undefined>): Record<string, string | undefined> {
  const safeEnv: Record<string, string | undefined> = {};
  const parentEnv = process.env;

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;

    // Check blocklist first (takes precedence)
    const isBlocked = BLOCKED_ENV_PATTERNS.some((pattern) =>
      key.toUpperCase().includes(pattern)
    );
    if (isBlocked) continue;

    // Check allowlist
    const isAllowed = SAFE_ENV_PREFIXES.some((prefix) =>
      key.startsWith(prefix) || key.toUpperCase().startsWith(prefix)
    );

    if (isAllowed) {
      safeEnv[key] = value;
    }
  }

  // Merge explicit overrides (these are intentional, not filtered)
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        safeEnv[key] = value;
      }
    }
  }

  return safeEnv;
}

/**
 * Maximum allowed size for a line buffer before truncation.
 *
 * WHY: Agent subprocesses output JSONL lines. If a malicious or buggy agent
 * sends continuous data without newlines, the line buffer grows unboundedly.
 * This constant caps the buffer to prevent memory exhaustion.
 *
 * 10 MB is generous — the largest legitimate JSONL line we've seen is ~500KB
 * (a large tool result with file contents).
 */
export const MAX_LINE_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Safely append to a line buffer with size limit.
 *
 * If the buffer would exceed MAX_LINE_BUFFER_SIZE after appending, the
 * oldest data is discarded (buffer is reset to just the new data, which
 * may itself be truncated).
 *
 * @param currentBuffer - The current line buffer contents
 * @param newData - New data to append
 * @returns The updated buffer, possibly truncated
 */
export function safeBufferAppend(currentBuffer: string, newData: string): string {
  const combined = currentBuffer + newData;
  if (combined.length > MAX_LINE_BUFFER_SIZE) {
    // Discard old data; keep only the tail that fits
    // WHY: The most recent data is more likely to contain a complete JSON line
    return combined.slice(combined.length - MAX_LINE_BUFFER_SIZE);
  }
  return combined;
}

/**
 * Validate that a set of extra CLI arguments don't contain dangerous patterns.
 *
 * WHY: The `extraArgs` option on agent factories is spread directly into
 * spawn argument arrays. While `shell: false` prevents shell injection,
 * malicious arguments could still alter agent behavior (e.g., --config pointing
 * to a sensitive file). This provides a basic safety check.
 *
 * @param args - The extra arguments to validate
 * @returns The validated arguments (throws if invalid)
 * @throws {Error} If arguments contain suspicious patterns
 */
export function validateExtraArgs(args: string[]): string[] {
  for (const arg of args) {
    // Block shell metacharacters that could be dangerous if shell: true is ever used
    if (/[;&|`$(){}]/.test(arg)) {
      throw new Error(
        `Unsafe character in extra argument: "${arg}". Shell metacharacters are not allowed.`
      );
    }
    // Block attempts to read system files via --config or similar flag values.
    // Covers /etc/, ~/ expansion, and path traversal via ../
    if (/^--?(?:config|rc|init|env-file|dotenv)=?\s*\/etc\//.test(arg)) {
      throw new Error(
        `Unsafe argument targeting system path: "${arg}".`
      );
    }
    // Block path traversal patterns that could escape the project directory
    if (/\.\.[/\\]/.test(arg) && /^--?(?:config|rc|init|env-file|dotenv|include|load)/.test(arg)) {
      throw new Error(
        `Unsafe path traversal in argument: "${arg}". Relative parent references are not allowed in config paths.`
      );
    }
  }
  return args;
}
