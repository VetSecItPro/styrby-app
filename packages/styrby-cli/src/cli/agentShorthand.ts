/**
 * Agent-shorthand detection for the Styrby CLI.
 *
 * WHY: Typing `styrby codex` is faster than `styrby start --agent codex`.
 * Every AI coding agent CLI follows this pattern — `claude`, `codex`,
 * `gemini`, `aider` all start a session when you type the bare command.
 * Users expect `styrby` (and `styrby <agent>`) to do something immediately,
 * not show a menu.
 *
 * This module is intentionally pure and dependency-free so it can be
 * unit-tested without booting the rest of the CLI runtime.
 *
 * @module cli/agentShorthand
 */

/**
 * Complete list of supported agent shorthands.
 *
 * WHY this is the source-of-truth list: the CLI router uses it to decide
 * whether an argv[0] like `codex` should be treated as "start the codex
 * agent" rather than "unknown command". Keep it in sync with the agents
 * registered in `agent/index.ts` and the `VALID_AGENTS` gate in
 * `handlers/start.ts`.
 */
export const KNOWN_AGENTS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'aider',
  'goose',
  'amp',
  'crush',
  'kilo',
  'kiro',
  'droid',
] as const;

/**
 * Type of a recognised agent shorthand command.
 */
export type KnownAgent = (typeof KNOWN_AGENTS)[number];

/**
 * Whether `argv[0]` is an agent-shorthand command.
 *
 * @param command - The first positional argument (or undefined if none).
 * @returns `true` if `command` is one of KNOWN_AGENTS.
 *
 * @example
 * isAgentShorthand('codex');   // true
 * isAgentShorthand('start');   // false
 * isAgentShorthand(undefined); // false
 */
export function isAgentShorthand(command: string | undefined): command is KnownAgent {
  return !!command && (KNOWN_AGENTS as readonly string[]).includes(command);
}

/**
 * Whether the invocation is a bare `styrby` with no command.
 *
 * WHY a dedicated helper: the main() entry point branches on both
 * "bare" and "agent shorthand" but we want a single canonical predicate
 * to keep the two sites in sync.
 *
 * @param command - The first positional argument (or undefined if none).
 */
export function isBareCommand(command: string | undefined): boolean {
  return !command || command === undefined;
}

/**
 * Build the argv passed to `handleStart` when the user invoked either
 * a bare `styrby` or an agent-shorthand like `styrby codex`.
 *
 * Precedence for the selected agent:
 *   1. Shorthand command (`styrby codex` => codex)
 *   2. Explicit `--agent` in args (left untouched if shorthand is absent)
 *   3. Config-file default (`defaultAgent`)
 *   4. `claude` (the downstream default inside handleStart)
 *
 * @param args - The raw process argv after `slice(2)`.
 * @param shorthand - The agent shorthand if argv[0] matched KNOWN_AGENTS.
 * @param configDefaultAgent - The `defaultAgent` configuration value, if any.
 * @returns The argv to forward to `handleStart`.
 *
 * @example
 * buildStartArgs(['codex', '--project', '.'], 'codex', null);
 * // => ['--agent', 'codex', '--project', '.']
 *
 * buildStartArgs(['codex', '--agent', 'gemini'], 'codex', null);
 * // => ['--agent', 'codex']   (shorthand wins; the redundant pair is stripped)
 *
 * buildStartArgs([], undefined, 'gemini');
 * // => ['--agent', 'gemini']
 *
 * buildStartArgs(['--project', '.'], undefined, null);
 * // => ['--project', '.']
 */
export function buildStartArgs(
  args: string[],
  shorthand: string | null,
  configDefaultAgent: string | null | undefined,
): string[] {
  if (shorthand) {
    // WHY (audit 2026-06-09 fix #40): `styrby codex --agent gemini` previously
    // emitted ['--agent', 'codex', '--agent', 'gemini'] — TWO --agent flags.
    // Which one wins then depends entirely on handleStart's parser semantics
    // (first-wins vs last-wins). If last-wins, the user gets gemini despite
    // typing the `codex` shorthand — a silent wrong-agent launch (wrong model,
    // wrong billing). Strip any existing --agent pair from the trailing args so
    // exactly one --agent is present and shorthand precedence is deterministic.
    return ['--agent', shorthand, ...stripAgentFlag(args.slice(1))];
  }
  if (configDefaultAgent) {
    return ['--agent', configDefaultAgent, ...stripAgentFlag(args)];
  }
  return args;
}

/**
 * Remove every `--agent <value>` pair (and the `--agent=<value>` inline form)
 * from an argv slice.
 *
 * WHY: when a higher-precedence source (an agent shorthand or a config default)
 * already supplies `--agent`, leaving a second `--agent` in the user-provided
 * args produces a duplicate flag whose resolution is parser-dependent. Stripping
 * the lower-precedence pair guarantees a single, deterministic `--agent`.
 *
 * @param args - The argv slice to sanitize.
 * @returns A copy of `args` with all `--agent` flags (and their values) removed.
 */
function stripAgentFlag(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--agent') {
      // Skip the flag and its space-separated value (if any).
      if (i + 1 < args.length) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--agent=')) {
      // Inline form: skip the single token.
      continue;
    }
    result.push(arg);
  }
  return result;
}
