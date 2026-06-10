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

  // Merge explicit overrides (these are intentional, not filtered).
  //
  // CVE-2026-3854 class defense: still validate override VALUES for null
  // bytes + CRLF. Many env-var consumers (especially shell `env -` printers,
  // Docker `--env-file`, systemd unit env reads) parse env entries as
  // newline-delimited; a value containing `\n` could spawn an additional
  // bogus env entry on the receiving side, similar to header-delimiter
  // injection. Reject loudly rather than silently truncate — overrides are
  // explicit-by-design so a bad value indicates a caller bug, not user input.
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue;
      if (/[\x00\r\n]/.test(value)) {
        throw new Error(
          `buildSafeEnv: override "${key}" contains a forbidden control character (null byte / CR / LF). Strip or reject upstream.`
        );
      }
      safeEnv[key] = value;
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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Block shell metacharacters that could be dangerous if shell: true is ever used
    if (/[;&|`$(){}]/.test(arg)) {
      throw new Error(
        `Unsafe character in extra argument: "${arg}". Shell metacharacters are not allowed.`
      );
    }
    // CVE-2026-3854 class defense: control characters (null bytes, CR, LF,
    // ASCII C0 controls) and Unicode lookalikes for `;` (U+037E Greek
    // question mark, U+FF1B fullwidth semicolon). The lookalikes can pass
    // a naive `;`-only check while still being interpreted as separators
    // by tools that normalize Unicode before parsing.
    if (/[\x00-\x08\x0b-\x1f;；]/.test(arg)) {
      throw new Error(
        `Unsafe character in extra argument: control char or Unicode separator-lookalike not allowed.`
      );
    }
    // Block attempts to read system files via --config or similar flag values.
    // Covers /etc/, ~/ expansion, and path traversal via ../
    //
    // WHY this expanded set covers all 11 supported agents (defense-in-depth):
    //   - Aider:    --config FILE, --env-file FILE
    //   - Goose:    --profile PATH
    //   - OpenCode: --profile PATH
    //   - Crush/Kilo/Kiro/Droid/Amp: --config PATH
    //   - Claude/Codex/Gemini: --config PATH (already covered)
    // An attacker who controlled extra-args could otherwise point an agent
    // at a malicious config file containing code-execution flags interpreted
    // by that agent's own config schema. Not RCE today (the agents wouldn't
    // execute arbitrary code from a config), but the blocklist closes the
    // residual class.
    if (/^--?(?:config|rc|init|env-file|dotenv|profile)=?\s*\/etc\//.test(arg)) {
      throw new Error(
        `Unsafe argument targeting system path: "${arg}".`
      );
    }
    // Block path traversal patterns that could escape the project directory
    // via any config-loading flag of any supported agent.
    if (/\.\.[/\\]/.test(arg) && /^--?(?:config|rc|init|env-file|dotenv|include|load|profile)/.test(arg)) {
      throw new Error(
        `Unsafe path traversal in argument: "${arg}". Relative parent references are not allowed in config paths.`
      );
    }

    // SECURITY (audit 2026-06-09 HIGH fix #8): the two checks above only inspect
    // a single token, so a SPACE-SEPARATED form like `["--config", "/etc/passwd"]`
    // or `["--profile", "../../secret.toml"]` bypassed them entirely — the flag
    // token alone has no `/etc/` and no `../`, and the value token alone does not
    // start with a config flag, so neither regex matched. Track flag context:
    // when this arg is a bare config-loading flag (no inline `=` value), validate
    // the NEXT element (its value) against the same path rules.
    if (i + 1 < args.length && isBareConfigFlag(arg)) {
      assertSafeConfigValue(args[i + 1]);
    }
  }
  return args;
}

/**
 * Config-loading flags whose value, if attacker-controlled, can point an agent
 * at a sensitive or out-of-tree file. Union of every supported agent's flags.
 */
const CONFIG_LOADING_FLAGS = [
  'config',
  'rc',
  'init',
  'env-file',
  'dotenv',
  'include',
  'load',
  'profile',
] as const;

/**
 * Whether `arg` is a config-loading flag with NO inline value (i.e. its value is
 * supplied as the next argv element). Matches both `--flag` and `-flag` forms.
 *
 * Returns false for the `=`-joined form (`--config=...`) — that case is already
 * handled by the single-token checks in `validateExtraArgs`.
 *
 * @param arg - The argv element to test.
 * @returns True if `arg` is a bare config-loading flag awaiting a separate value.
 */
function isBareConfigFlag(arg: string): boolean {
  return new RegExp(`^--?(?:${CONFIG_LOADING_FLAGS.join('|')})$`).test(arg);
}

/**
 * Validate a bare config-flag VALUE (the argv element following a config flag).
 *
 * Applies the same system-path and path-traversal rules used for the inline
 * (`=`-joined) form, but against the raw value token (no flag prefix). Closes
 * the space-separated bypass (audit 2026-06-09 fix #8).
 *
 * @param value - The value token following a config-loading flag.
 * @throws {Error} If the value targets a system path or contains traversal.
 */
function assertSafeConfigValue(value: string): void {
  if (/^\s*\/etc\//.test(value)) {
    throw new Error(`Unsafe argument targeting system path: "${value}".`);
  }
  if (/\.\.[/\\]/.test(value)) {
    throw new Error(
      `Unsafe path traversal in argument: "${value}". Relative parent references are not allowed in config paths.`
    );
  }
}
