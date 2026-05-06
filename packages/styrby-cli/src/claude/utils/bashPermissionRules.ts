/**
 * Pure helpers for parsing + matching Bash tool permission strings.
 *
 * SECURITY-CRITICAL: this module owns the logic that decides whether a
 * given `Bash(command)` invocation matches an existing allow-list entry.
 * Bugs here = either auto-approving commands the user didn't allow
 * (security incident) or blocking commands the user did allow (UX
 * broken). Extracted from `permissionHandler.ts` (PR #280) so the rules
 * can be unit-tested without standing up the full Session class.
 *
 * Permission string grammar (matches the Claude Code SDK):
 *   - "Bash"             → tracked but no specific allow (handled by caller)
 *   - "Bash(npm test)"   → exact-match literal
 *   - "Bash(git push:*)" → prefix-match (allow any command starting with "git push")
 *   - anything else      → invalid (caller silently ignores)
 *
 * @module claude/utils/bashPermissionRules
 */

/**
 * Parsed shape of a single Bash permission string.
 *
 * Discriminated union so callers can switch on `.kind` without re-parsing.
 * The `invalid` variant exists so the caller can log/skip without throwing
 * (the input is operator-controlled and forgiving parsing is preferred to
 * crashing the permission flow on a typo).
 */
export type BashPermission =
  | { kind: 'literal'; command: string }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'plain' }      // bare "Bash" — tracked elsewhere as wildcard
  | { kind: 'invalid' };   // unparseable

/**
 * Parse a single permission string into a structured BashPermission.
 *
 * @param permission - The raw permission string from the SDK response
 *                     (e.g. "Bash(npm test)", "Bash(git push:*)", "Bash").
 * @returns Discriminated union describing the parsed shape.
 *
 * @example
 * parseBashPermission('Bash');                  // { kind: 'plain' }
 * parseBashPermission('Bash(npm test)');         // { kind: 'literal', command: 'npm test' }
 * parseBashPermission('Bash(git push:*)');       // { kind: 'prefix', prefix: 'git push' }
 * parseBashPermission('Read(/etc/passwd)');      // { kind: 'invalid' }
 * parseBashPermission('');                       // { kind: 'invalid' }
 */
export function parseBashPermission(permission: string): BashPermission {
  if (permission === 'Bash') {
    return { kind: 'plain' };
  }

  // Match Bash(command) or Bash(command:*)
  const bashPattern = /^Bash\((.+?)\)$/;
  const match = permission.match(bashPattern);
  if (!match) {
    return { kind: 'invalid' };
  }

  const command = match[1];

  if (command.endsWith(':*')) {
    return { kind: 'prefix', prefix: command.slice(0, -2) };
  }
  return { kind: 'literal', command };
}

/**
 * Check whether a `Bash` tool invocation with the given command is allowed
 * by the current permission sets.
 *
 * Match precedence:
 *   1. Exact-match against `literals` (set membership, O(1))
 *   2. Prefix-match against any entry in `prefixes` (linear scan)
 *
 * @param command - The Bash command being invoked
 *                  (e.g. "npm test", "git push origin main").
 * @param literals - Set of exact-match commands (typically populated from
 *                   parseBashPermission(...).command of `kind: 'literal'`).
 * @param prefixes - Set of prefix-match strings (typically populated from
 *                   parseBashPermission(...).prefix of `kind: 'prefix'`).
 * @returns true if the command matches a literal OR a prefix; false otherwise.
 */
export function isBashCommandAllowed(
  command: string,
  literals: ReadonlySet<string>,
  prefixes: ReadonlySet<string>,
): boolean {
  if (literals.has(command)) {
    return true;
  }
  for (const prefix of prefixes) {
    if (command.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
