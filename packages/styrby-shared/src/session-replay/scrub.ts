/**
 * Session Replay — Server-Side Scrub Engine
 *
 * Redacts sensitive content from session messages before they are sent to
 * replay viewers. Scrubbing is ALWAYS performed server-side; raw message
 * content never crosses the network when a scrub mask is active.
 *
 * WHY server-side only: E2E-encrypted session messages are decrypted with the
 * service-role key during replay. Sending raw decrypted content to untrusted
 * viewers would defeat E2E encryption. Server-side scrubbing ensures the
 * viewer receives only what the token creator authorized.
 *
 * GDPR Art. 5(1)(c) / Data minimisation: The scrub mask lets token creators
 * grant the minimum necessary data access for the viewer's purpose.
 *
 * SOC2 CC6.1: Scrubbed output is generated on each request and never stored —
 * there is no cached plaintext that could be exfiltrated later.
 *
 * @module session-replay/scrub
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Controls which categories of sensitive data are redacted.
 *
 * All fields default to false (no redaction) so the mask is additive —
 * callers opt IN to scrubbing rather than opting out.
 */
export interface ScrubMask {
  /**
   * Redact secret-looking tokens: API keys (sk_live_*, AKIA*), PEM private
   * keys, JWT-shaped strings, and .env file assignments.
   *
   * Enabled by default in the create-replay UI because leaking a key in a
   * replay link is a high-severity security incident.
   */
  secrets: boolean;

  /**
   * Replace absolute filesystem paths with [PATH].
   * Basenames are preserved so the viewer understands context:
   *   /Users/alice/projects/secret-app/src/auth.ts → [PATH]/auth.ts
   *
   * WHY keep basename: stripping paths entirely makes tool outputs
   * (file reads, writes, edits) unreadable. The sensitive part is the
   * directory tree, not the filename.
   */
  file_paths: boolean;

  /**
   * Replace shell commands with [COMMAND_REDACTED].
   * The leading $ prompt character and trailing context are preserved:
   *   $ rm -rf /sensitive/dir  →  $ [COMMAND_REDACTED]
   *
   * WHY keep structure: the viewer can see that a command ran and roughly
   * when, without seeing what it was — useful for "the agent ran N commands"
   * audit summaries.
   */
  commands: boolean;
}

/**
 * A session message as stored in session_messages.
 * Only the fields relevant to scrubbing are required here; callers may
 * pass richer objects and they will pass through unchanged.
 */
export interface ReplayMessage {
  /** Message role — determines which redaction rules apply. */
  role: 'user' | 'assistant' | 'tool' | 'tool_result' | string;

  /** Message content — the string to scrub. */
  content: string;

  /** All other message fields pass through unchanged. */
  [key: string]: unknown;
}

/**
 * A scrubbed message — identical shape to ReplayMessage but with sensitive
 * content replaced by placeholder strings. The `_scrubbed` flag lets callers
 * verify that scrubbing was applied (useful in tests).
 */
export interface ScrubbedMessage extends ReplayMessage {
  /** True when at least one scrub rule was active. */
  _scrubbed: boolean;
}

// ============================================================================
// Redaction patterns
// ============================================================================

/**
 * Patterns that detect secret-looking strings.
 *
 * WHY regex not ML: Regex patterns are deterministic, auditable, and have no
 * false-negative rate that could be gamed. The patterns are conservative —
 * they bias toward redacting edge cases rather than leaking secrets.
 *
 * Pattern design notes (CI rule: no-useless-escape — do NOT escape `-` inside
 * character classes when it is already at start/end position):
 *
 *   - SK_LIVE / SK_TEST: Stripe-style keys (sk_live_..., sk_test_...)
 *   - GENERIC_SK: any `sk_` prefix with 20+ word chars (covers OpenAI, Anthropic, etc.)
 *   - AWS_ACCESS_KEY: AKIA + 16 uppercase alphanumeric chars
 *   - PEM_PRIVATE_KEY: PEM header line (the body is implicitly included by the
 *     lookahead that captures until the matching footer)
 *   - JWT: three base64url-encoded segments separated by dots (loose shape match)
 *   - DOTENV_SECRET: KEY=value lines where the value looks secret (quoted or long)
 *
 * The `g` flag on all patterns enables replaceAll()-style replacement without
 * constructing a new RegExp on every call.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Stripe / Anthropic / OpenAI style sk_live_ / sk_test_ keys
  {
    pattern: /sk_live_[A-Za-z0-9]{20,}/g,
    description: 'sk_live_ API key',
  },
  {
    pattern: /sk_test_[A-Za-z0-9]{20,}/g,
    description: 'sk_test_ API key',
  },
  // Generic sk_ prefix (min 20 word chars after the prefix to avoid false
  // positives on short identifiers like `sk_count` or `sk_map`)
  {
    pattern: /\bsk_[A-Za-z0-9_]{20,}\b/g,
    description: 'generic sk_ API key',
  },
  // AWS Access Key ID
  {
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
    description: 'AWS access key ID',
  },
  // PEM private key block (the header line is sufficient to identify the block)
  {
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g,
    description: 'PEM private key',
  },
  // JWT shape: three base64url segments, each 10+ chars (avoids false-positive
  // on short dotted identifiers like "1.2.3")
  {
    pattern: /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    description: 'JWT token',
  },
  // .env file secret assignment: KEY="long-value" or KEY=long-value-without-spaces
  // WHY: AI agents often read .env files during debugging. The pattern matches
  // lines where the value looks like a secret (quoted string or 20+ non-space chars).
  {
    pattern: /^([A-Z][A-Z0-9_]{2,})=(?:"[^"]{8,}"|'[^']{8,}'|[^\s]{20,})$/gm,
    description: '.env secret assignment',
  },
];

/**
 * Pattern for absolute filesystem paths.
 *
 * Matches Unix-style absolute paths (/Users/..., /home/..., /root/..., /var/...,
 * /tmp/..., etc.) and common macOS home paths. Captures the basename separately
 * so it can be preserved in the replacement.
 *
 * WHY Unix only: The CLI runs on macOS/Linux; Windows paths are not in scope.
 *
 * WHY word boundary at end: Avoids false-positive on URL paths like
 * /api/sessions/[id] which are not filesystem paths. We require the path
 * to end at a word boundary or non-alphanumeric character.
 */
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|root|var|tmp|etc|opt|usr|srv)[^\s"'`]*\/([^/\s"'`]+))/g;

/**
 * Pattern for shell command lines.
 *
 * Matches lines that begin with a `$` prompt (with optional leading whitespace),
 * capturing the prompt character so it can be preserved in the replacement.
 *
 * WHY capture the $: Stripping the prompt entirely would remove context that
 * tells the viewer "this was a shell command invocation".
 */
// WHY [ \t] instead of \s: Using \s here would create a ReDoS vulnerability
// (CWE-1333). The \s class matches newlines, so in multiline (/m) mode the
// engine can explore exponentially many ways to split horizontal-whitespace
// sequences across alternations. Restricting to [ \t] (horizontal whitespace
// only) eliminates the catastrophic-backtracking vector while still matching
// every realistic shell-prompt format. (CodeQL: js/redos)
const SHELL_COMMAND_PATTERN = /^([ \t]*\$[ \t]+).+$/gm;

// ============================================================================
// Core scrub function
// ============================================================================

/**
 * Scrubs a single message according to the provided mask.
 *
 * The function is PURE — it does not mutate the input and does not perform
 * any I/O. This makes it safe to call in hot paths and easy to test.
 *
 * Redaction is IRREVERSIBLE in the output. The raw content is never placed
 * in any returned field, log entry, or error message.
 *
 * @param message - The raw session message to scrub.
 * @param mask - Which categories of content to redact.
 * @returns A new message object with sensitive fields replaced by placeholders.
 *
 * @example
 * ```ts
 * const msg = { role: 'assistant', content: 'Found key: sk_live_ABC123XYZ789DEF456GHI' };
 * const scrubbed = scrubMessage(msg, { secrets: true, file_paths: false, commands: false });
 * // scrubbed.content === 'Found key: [REDACTED_SECRET]'
 * // scrubbed._scrubbed === true
 * ```
 */
export function scrubMessage(message: ReplayMessage, mask: ScrubMask): ScrubbedMessage {
  // Fast path: if no mask flags are enabled, return a copy with _scrubbed = false.
  // Avoids running regex engines on every message when the creator opted out of scrubbing.
  if (!mask.secrets && !mask.file_paths && !mask.commands) {
    return { ...message, _scrubbed: false };
  }

  let content = message.content ?? '';

  // ── Secrets ────────────────────────────────────────────────────────────────
  if (mask.secrets) {
    for (const { pattern } of SECRET_PATTERNS) {
      // Reset lastIndex between calls since patterns use the `g` flag.
      // WHY: Without resetting, the RegExp stateful lastIndex causes alternating
      // matches to be skipped when the same pattern instance is reused.
      pattern.lastIndex = 0;
      content = content.replace(pattern, '[REDACTED_SECRET]');
    }
  }

  // ── File paths ─────────────────────────────────────────────────────────────
  if (mask.file_paths) {
    // Reset lastIndex for the same reason as above.
    ABSOLUTE_PATH_PATTERN.lastIndex = 0;
    // Replace: keep basename (capture group 1), redact directory prefix.
    content = content.replace(ABSOLUTE_PATH_PATTERN, '[PATH]/$1');
  }

  // ── Shell commands ─────────────────────────────────────────────────────────
  if (mask.commands) {
    SHELL_COMMAND_PATTERN.lastIndex = 0;
    // Replace: keep the `$ ` prompt prefix, redact the command itself.
    content = content.replace(SHELL_COMMAND_PATTERN, '$1[COMMAND_REDACTED]');
  }

  return { ...message, content, _scrubbed: true };
}

/**
 * Scrubs all messages in a session according to the provided mask.
 *
 * Maps over the message array calling `scrubMessage` for each item.
 * The original array is not mutated.
 *
 * @param messages - Array of raw session messages to scrub.
 * @param mask - Which categories of content to redact.
 * @returns New array of scrubbed messages in the same order.
 *
 * @example
 * ```ts
 * const scrubbed = scrubSession(session.messages, {
 *   secrets: true,
 *   file_paths: true,
 *   commands: false,
 * });
 * ```
 */
export function scrubSession(messages: ReplayMessage[], mask: ScrubMask): ScrubbedMessage[] {
  return messages.map((msg) => scrubMessage(msg, mask));
}
