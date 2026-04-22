/**
 * Smart Agent Detection
 *
 * Scans PATH and common install locations to detect which of the 11 supported
 * AI coding agents are installed. Returns a structured decision that the
 * bootstrap flow uses to either auto-select, prompt for a choice, or redirect
 * to `styrby install --interactive`.
 *
 * WHY this is its own module (not inlined in onboard.ts):
 * The detection logic is independently testable via `which` mocks. Keeping it
 * isolated prevents onboard.ts from growing into a god-function and makes
 * future changes to detection heuristics surgical.
 *
 * @module onboarding/agentDetect
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

/** All 11 agents supported by Styrby. */
export type SupportedAgent =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'aider'
  | 'goose'
  | 'amp'
  | 'crush'
  | 'kilo'
  | 'kiro'
  | 'droid';

/**
 * Detected agent entry: the CLI command name plus display info.
 */
export interface DetectedAgent {
  /** Agent identifier used by Styrby internals. */
  id: SupportedAgent;
  /** Human-readable display name. */
  name: string;
  /** Path to the binary (if found via which/where). */
  binPath: string;
}

/**
 * Result of the smart detection pass.
 *
 * WHY three branches (zero / one / many):
 * Each branch maps to a distinct UX action in the bootstrap flow — install
 * prompt, auto-select, or numbered picker. Encoding the decision here
 * (instead of in the UI) keeps the UI dumb and the logic testable.
 */
export type AgentDetectResult =
  | { kind: 'none' }
  | { kind: 'single'; agent: DetectedAgent }
  | { kind: 'multiple'; agents: DetectedAgent[] };

// ============================================================================
// Agent Registry
// ============================================================================

/**
 * Ordered list of all 11 agents with detection metadata.
 *
 * WHY ordered: we try PATH first; extra paths are fallbacks for agents that
 * install outside the user's PATH (e.g. npm global under non-standard prefix).
 */
const AGENT_REGISTRY: Array<{
  id: SupportedAgent;
  name: string;
  /** Primary binary name (checked via which/where). */
  command: string;
  /** Additional absolute paths to check if `which` misses them. */
  extraPaths?: string[];
}> = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/claude'),
      '/usr/local/bin/claude',
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/codex'),
      '/usr/local/bin/codex',
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/gemini'),
      '/usr/local/bin/gemini',
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/opencode'),
    ],
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/aider'),
      path.join(process.env.HOME ?? '', '.local/lib/python3.11/bin/aider'),
    ],
  },
  {
    id: 'goose',
    name: 'Goose',
    command: 'goose',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/goose'),
      path.join(process.env.HOME ?? '', 'go/bin/goose'),
    ],
  },
  {
    id: 'amp',
    name: 'Amp',
    command: 'amp',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/amp'),
      '/usr/local/bin/amp',
    ],
  },
  {
    id: 'crush',
    name: 'Crush',
    command: 'crush',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/crush'),
      '/usr/local/bin/crush',
    ],
  },
  {
    id: 'kilo',
    name: 'Kilo',
    command: 'kilo',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/kilo'),
    ],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    command: 'kiro',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/kiro'),
    ],
  },
  {
    id: 'droid',
    name: 'Droid',
    command: 'droid',
    extraPaths: [
      path.join(process.env.HOME ?? '', '.local/bin/droid'),
    ],
  },
];

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if a command exists in PATH using `which` (POSIX) or `where` (Windows).
 *
 * WHY sync exec: this runs once during onboarding, not in a hot path. The
 * sync approach avoids 11 concurrent child_process.exec calls whose combined
 * promise overhead could actually be slower due to event-loop thrash on cold
 * Node startup.
 *
 * @param command - Binary name to look up
 * @returns Resolved path string, or null if not found
 */
export function whichSync(command: string): string | null {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execSync(`${whichCmd} ${command}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if an absolute path exists and is executable.
 *
 * @param filePath - Absolute path to check
 * @returns true if the file exists and has execute permission
 */
export function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect a single agent.
 *
 * Tries `which <command>` first, then falls back to checking each extraPath.
 * Returns a DetectedAgent if found, null otherwise.
 *
 * @param entry - Agent registry entry
 * @returns Detected agent or null
 */
export function detectSingleAgent(entry: (typeof AGENT_REGISTRY)[number]): DetectedAgent | null {
  // 1. Try PATH via which/where
  const pathResult = whichSync(entry.command);
  if (pathResult) {
    return { id: entry.id, name: entry.name, binPath: pathResult };
  }

  // 2. Try extra paths (outside PATH, e.g. pip install --user on Linux)
  if (entry.extraPaths) {
    for (const extra of entry.extraPaths) {
      if (isExecutable(extra)) {
        return { id: entry.id, name: entry.name, binPath: extra };
      }
    }
  }

  return null;
}

/**
 * Scan PATH and common install locations for all 11 supported agents.
 *
 * Returns an `AgentDetectResult` with the branch (`none`, `single`, or
 * `multiple`) already resolved, so the caller makes zero detection decisions.
 *
 * WHY none/single/multiple instead of a raw array:
 * Each branch maps 1:1 to a distinct UI action in the bootstrap flow. A raw
 * array forces the caller to re-implement the same branching logic, which
 * diverges across call sites over time.
 *
 * @returns Detection result with resolved branch
 */
export function detectAgents(): AgentDetectResult {
  const found: DetectedAgent[] = [];

  for (const entry of AGENT_REGISTRY) {
    const detected = detectSingleAgent(entry);
    if (detected) {
      found.push(detected);
    }
  }

  // WHY three branches:
  // - none (0 found): redirect user to `styrby install --interactive` before
  //   continuing onboarding. No agent = no product.
  // - single (1 found): auto-select silently. Saves a prompt, keeps the
  //   "under 60 seconds" budget intact.
  // - multiple (2+ found): show a numbered picker so the user consciously
  //   chooses their default. Auto-picking one of several agents would silently
  //   ignore agents the user prefers.
  if (found.length === 0) return { kind: 'none' };
  if (found.length === 1) return { kind: 'single', agent: found[0] };
  return { kind: 'multiple', agents: found };
}
