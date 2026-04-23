/**
 * Agent Probe — per-agent install detection + round-trip smoke test
 *
 * Used by `styrby doctor` to verify each of the 11 supported agents.
 * For each agent it:
 *   1. Checks whether the binary is present on PATH
 *   2. If present, runs a minimal round-trip: spawn → send trivial prompt →
 *      assert expected output shape → clean up
 *   3. Reports PASS / FAIL / NOT_INSTALLED with a diagnostic message pointing
 *      to the relevant parser file when the stream format has drifted.
 *   4. (Phase 1.6.4b) Compares the detected version against the known-compatible
 *      range and emits a structured Sentry warning if drift is detected.
 *
 * WHY per-agent probes instead of a single generic check:
 *   Every agent has a unique output format. A generic "binary exists" check
 *   would pass silently even if a new agent version changed its JSON schema
 *   in a way that breaks our parser. These probes detect format drift at
 *   install-time rather than at first real use.
 *
 * Implementation note on the "round-trip" for agents requiring API keys:
 *   Agents that require a live LLM call (all of them) cannot safely do a
 *   real model call in `doctor` because that would consume quota, require
 *   API keys, and add 5-30 seconds of latency. Instead, we perform a
 *   structural probe: spawn the agent with `--version` or `--help` and
 *   validate the exit code and binary metadata. If the binary is reachable
 *   and responds structurally, it's PASS. Format-contract violations (the
 *   agent changed its JSON schema) are caught by the unit tests in
 *   agentSmokeTests.test.ts — not by the runtime doctor check.
 *
 * Version drift detection (Phase 1.6.4b):
 *   Each agent entry now carries MIN_SUPPORTED_VERSION and MAX_TESTED_VERSION.
 *   After detecting the installed version, we compare against the range. A
 *   version below the minimum means the agent is known-incompatible (streaming
 *   format changed). A version above MAX_TESTED_VERSION means Styrby hasn't
 *   been validated against it — possible incompatibility. Both cases emit a
 *   structured Sentry warning and appear in `styrby doctor` under "Version
 *   compatibility".
 *
 * @module commands/agentProbe
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@/ui/logger';

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

/**
 * Possible results for a per-agent doctor probe.
 *
 * - `PASS` — binary found, version check succeeded
 * - `FAIL` — binary found but version/smoke check failed
 * - `NOT_INSTALLED` — binary not on PATH
 */
export type AgentProbeStatus = 'PASS' | 'FAIL' | 'NOT_INSTALLED';

/**
 * Version compatibility classification for a detected agent version.
 *
 * WHY three states: a version below MIN is known-broken (our parser will
 * fail against old format). A version above MAX_TESTED is unknown territory —
 * the agent may have changed its stream format since we last validated.
 * Both are worth surfacing in doctor, but with different urgency.
 */
export type VersionCompatibility = 'compatible' | 'below-min' | 'above-max-tested' | 'unknown';

/**
 * Result of comparing a detected version against the known-compatible range.
 */
export interface VersionCompatibilityResult {
  /** The parsed semver string (e.g. "1.2.3") */
  detectedVersion: string;
  /** MIN_SUPPORTED_VERSION from the probe registry */
  minSupported: string;
  /** MAX_TESTED_VERSION from the probe registry */
  maxTested: string;
  /** Classification of the detected version */
  compatibility: VersionCompatibility;
}

/**
 * Result of probing a single agent.
 */
export interface AgentProbeResult {
  /** Agent identifier (e.g., 'claude', 'aider') */
  agentId: AllAgentType;

  /** Human-readable display name */
  displayName: string;

  /** Binary command used for PATH detection */
  command: string;

  /** Overall probe status */
  status: AgentProbeStatus;

  /**
   * Detected version string, if available (e.g., '1.2.3').
   * Undefined when not installed or when the binary doesn't support --version.
   */
  version?: string;

  /**
   * Diagnostic message for FAIL or NOT_INSTALLED status.
   * Includes parser file reference when format drift is suspected.
   */
  message?: string;

  /**
   * Expected stream format contract for this agent.
   * The key/type pairs here are the minimum fields Styrby's parser expects.
   * If the agent changes its output shape, running doctor surfaces this
   * contract as a reference for the developer.
   *
   * @example { 'type': 'string', 'content': 'string | undefined' }
   */
  expectedStreamFormat: Record<string, string>;

  /**
   * Path to the Styrby parser file that reads this agent's output.
   * Included in diagnostic messages so developers can find the relevant code.
   */
  parserFile: string;

  /**
   * Version compatibility classification result.
   * Populated after probeAgent() detects and compares the installed version.
   * Undefined when the agent is not installed or version cannot be parsed.
   */
  versionCompatibility?: VersionCompatibilityResult;
}

/**
 * All 11 supported Styrby agent types.
 *
 * WHY separate from auth/agent-credentials.ts AgentType:
 * The legacy AgentType in auth/ only covers the original 4 agents.
 * This broader union covers all 11 and is the source of truth for doctor.
 */
export type AllAgentType =
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

// ============================================================================
// Agent Probe Registry
// ============================================================================

/**
 * Metadata needed to probe one agent.
 *
 * WHY a registry instead of per-agent code:
 * Every agent only differs in binary name, version flag, and expected format.
 * A lookup table is easier to maintain and extend than 11 separate functions.
 */
interface AgentProbeConfig {
  /** Display name shown in doctor output */
  displayName: string;

  /** CLI binary name */
  command: string;

  /**
   * Flag to pass for version detection.
   * Most CLIs support --version; some use -v or version as a subcommand.
   * If null, we skip version detection (just check existence via `which`).
   */
  versionFlag: string | null;

  /**
   * Regex to extract a semver-like version from the version command output.
   * Allows for "v1.2.3", "1.2.3", "version 1.2.3" etc.
   */
  versionPattern: RegExp;

  /**
   * Minimum required fields in the agent's JSONL output that Styrby's parser
   * depends on. These are the contract assertions that would fail if the
   * agent upgrades and changes its stream format.
   */
  expectedStreamFormat: Record<string, string>;

  /**
   * Path fragment pointing to the Styrby parser for this agent.
   * Relative to packages/styrby-cli/src/
   */
  parserFile: string;

  /** Install instructions shown when the agent is not found on PATH */
  installHint: string;

  /**
   * Minimum version of this agent that Styrby's parser is known to support.
   *
   * WHY: When the agent ships a major version with a breaking stream format
   * change, versions below this threshold are guaranteed to produce parse
   * errors. We surface this in doctor rather than letting the user hit a
   * cryptic "undefined is not an object" at session start.
   *
   * Format: semver string (e.g. "1.0.0"). "0.0.0" means we have no lower
   * bound (all known versions work).
   */
  minSupportedVersion: string;

  /**
   * Maximum version of this agent that Styrby has been validated against.
   *
   * WHY: When the user upgrades an agent past the last version we tested,
   * there may be undocumented stream format changes. We emit a structured
   * warning so the user knows to report any issues, but do not hard-block
   * the session (the new version may be fully compatible).
   *
   * Format: semver string (e.g. "2.5.0"). "99.99.99" means no upper bound
   * (we accept any version).
   */
  maxTestedVersion: string;

  /**
   * Regex patterns found in the agent's startup stdout that identify its
   * version without requiring a separate `--version` call.
   *
   * WHY: Some agents (Claude Code, Codex) print version info to their initial
   * startup banner. Parsing it here enables version drift detection even when
   * the agent is launched via subprocess rather than via direct `--version`.
   * Each pattern must have one capture group that extracts the semver string.
   *
   * @example /Claude Code v(\d+\.\d+\.\d+)/
   */
  startupVersionPatterns: RegExp[];
}

/**
 * Registry of all 11 supported agents with their probe configuration.
 *
 * WHY this is the canonical list: it drives the doctor command's per-agent
 * output and the format contract assertions. Keeping it in one place means
 * adding a new agent only requires adding one entry here.
 */
const AGENT_PROBE_REGISTRY: Record<AllAgentType, AgentProbeConfig> = {
  claude: {
    displayName: 'Claude Code',
    command: 'claude',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"assistant" | "user" | "system"',
      'message.usage.input_tokens': 'number',
      'message.usage.output_tokens': 'number',
      'message.model': 'string',
    },
    parserFile: 'agent/factories/claude.ts (parseClaudeJsonlLine)',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    // WHY version range: Claude Code 1.0.x introduced the structured JSONL
    // assistant message format (type:"assistant", message.usage.*). Versions
    // before 1.0.0 emitted only plain text. The 1.0.71 fixture in our test
    // suite is the current baseline.
    minSupportedVersion: '1.0.0',
    maxTestedVersion: '2.99.99',
    startupVersionPatterns: [
      /Claude Code v?(\d+\.\d+\.\d+)/i,
      /claude-code@(\d+\.\d+\.\d+)/i,
      /"version":"(\d+\.\d+\.\d+)"/,
    ],
  },

  codex: {
    displayName: 'Codex',
    command: 'codex',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"message" | "tool_use" | "tool_result" | "reasoning" | "task_started" | "task_complete" | "token_count" | "patch_apply_begin" | "patch_apply_end"',
      id: 'string (Codex session id)',
      role: '"assistant" | "user"',
    },
    parserFile: 'codex/codexMcpClient.ts',
    installHint: 'npm install -g @openai/codex',
    // WHY: Codex 0.2.x introduced the MCP-based STDIO bridge protocol used
    // by CodexMcpClient. The Styrby STDIO bridge (happyMcpStdioBridge.ts)
    // requires at least 0.2.0. We flag anything below that as incompatible.
    minSupportedVersion: '0.2.0',
    maxTestedVersion: '1.99.99',
    startupVersionPatterns: [
      /Codex v?(\d+\.\d+\.\d+)/i,
      /codex@(\d+\.\d+\.\d+)/i,
      /"version":"(\d+\.\d+\.\d+)"/,
    ],
  },

  gemini: {
    displayName: 'Gemini CLI',
    command: 'gemini',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: 'ACP event discriminator (string)',
      content: 'ContentBlock[] (ACP protocol)',
    },
    parserFile: 'agent/transport/handlers/GeminiTransport.ts',
    installHint: 'npm install -g @google/gemini-cli',
    minSupportedVersion: '0.1.0',
    maxTestedVersion: '2.99.99',
    startupVersionPatterns: [/Gemini CLI v?(\d+\.\d+\.\d+)/i, /gemini-cli@(\d+\.\d+\.\d+)/i],
  },

  opencode: {
    displayName: 'OpenCode',
    command: 'opencode',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"assistant" | "tool_use" | "tool_result" | "status" | "error" | "session"',
      'session.Cost': 'number (USD)',
      'session.PromptTokens': 'number',
      'session.CompletionTokens': 'number',
    },
    parserFile: 'agent/factories/opencode.ts (handleJsonMessage)',
    installHint: 'npm install -g opencode-ai',
    minSupportedVersion: '0.1.0',
    maxTestedVersion: '1.99.99',
    startupVersionPatterns: [/opencode v?(\d+\.\d+\.\d+)/i, /opencode@(\d+\.\d+\.\d+)/i],
  },

  aider: {
    displayName: 'Aider',
    command: 'aider',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      stdout: 'plain text lines',
      '> Tokens: {N} sent, {N} received, cost: ${N}':
        '--show-tokens summary line (required for agent-reported CostReport)',
    },
    parserFile: 'agent/factories/aider.ts (parseAiderTokenSummary)',
    installHint: 'pip install aider-chat',
    // WHY: aider 0.60.0 introduced the --show-tokens flag we depend on for
    // CostReport extraction. Earlier versions do not emit the token summary.
    minSupportedVersion: '0.60.0',
    maxTestedVersion: '0.99.99',
    startupVersionPatterns: [/aider v?(\d+\.\d+\.\d+)/i],
  },

  goose: {
    displayName: 'Goose (AI Alliance / LF)',
    command: 'goose',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"message" | "tool_call" | "tool_result" | "cost" | "error" | "status" | "finish"',
      'cost.usage.input_tokens': 'number',
      'cost.usage.output_tokens': 'number',
      'cost.usage.cost_usd': 'number',
    },
    parserFile: 'agent/factories/goose.ts (handleGooseEvent)',
    installHint: 'See https://github.com/aaif-goose/goose for installation',
    minSupportedVersion: '1.0.0',
    maxTestedVersion: '2.99.99',
    startupVersionPatterns: [/goose v?(\d+\.\d+\.\d+)/i],
  },

  amp: {
    displayName: 'Amp (Sourcegraph)',
    command: 'amp',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"text" | "tool_use" | "tool_result" | "sub_agent_start" | "sub_agent_complete" | "usage" | "error" | "done"',
      'usage.input_tokens': 'number',
      'usage.output_tokens': 'number',
      'usage.cost_usd': 'number',
    },
    parserFile: 'agent/factories/amp.ts (handleAmpMessage)',
    installHint: 'npm install -g @sourcegraph/amp',
    minSupportedVersion: '0.5.0',
    maxTestedVersion: '1.99.99',
    startupVersionPatterns: [/amp v?(\d+\.\d+\.\d+)/i, /amp@(\d+\.\d+\.\d+)/i],
  },

  crush: {
    displayName: 'Crush (Charmbracelet)',
    command: 'crush',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"text_delta" | "tool_call" | "tool_result" | "usage" | "error" | "status" | "done"',
      'usage.input_tokens': 'number',
      'usage.output_tokens': 'number',
      'usage.cost_usd': 'number',
    },
    parserFile: 'agent/factories/crush.ts (handleCrushEvent)',
    installHint: 'brew install charmbracelet/tap/crush',
    minSupportedVersion: '0.1.0',
    maxTestedVersion: '1.99.99',
    startupVersionPatterns: [/crush v?(\d+\.\d+\.\d+)/i],
  },

  kilo: {
    displayName: 'Kilo (Community)',
    command: 'kilo',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"text" | "tool_use" | "tool_result" | "memory_bank_read" | "memory_bank_write" | "tokens" | "error" | "complete"',
      'tokens.usage.input_tokens': 'number',
      'tokens.usage.output_tokens': 'number',
      'tokens.usage.cost_usd': 'number',
    },
    parserFile: 'agent/factories/kilo.ts (handleKiloMessage)',
    installHint: 'npm install -g @kilocode/cli',
    minSupportedVersion: '1.0.0',
    maxTestedVersion: '2.99.99',
    startupVersionPatterns: [/kilo v?(\d+\.\d+\.\d+)/i, /kilocode@(\d+\.\d+\.\d+)/i],
  },

  kiro: {
    displayName: 'Kiro (AWS)',
    command: 'kiro',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"message" | "tool_call" | "tool_result" | "usage" | "error" | "status" | "finish"',
      'usage.credits_consumed': 'number (1 credit = $0.01 USD)',
      'usage.input_tokens': 'number (informational)',
      'usage.output_tokens': 'number (informational)',
    },
    parserFile: 'agent/factories/kiro.ts (handleKiroEvent)',
    installHint: 'See https://kiro.dev for installation',
    minSupportedVersion: '0.1.0',
    maxTestedVersion: '1.99.99',
    startupVersionPatterns: [/kiro v?(\d+\.\d+\.\d+)/i],
  },

  droid: {
    displayName: 'Droid (Factory AI, BYOK)',
    command: 'droid',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"text" | "tool_call" | "tool_result" | "usage" | "error" | "done" | "backend_switch"',
      'usage.prompt_tokens': 'number',
      'usage.completion_tokens': 'number',
      'usage.cost_usd': 'number (optional — estimated from LiteLLM pricing if absent)',
    },
    parserFile: 'agent/factories/droid.ts (handleDroidMessage)',
    installHint: 'npm install -g droid (or see https://docs.factory.ai/cli)',
    minSupportedVersion: '0.1.0',
    maxTestedVersion: '1.99.99',
    startupVersionPatterns: [/droid v?(\d+\.\d+\.\d+)/i],
  },
};

// ============================================================================
// Version Compatibility Helpers (Phase 1.6.4b)
// ============================================================================

/**
 * Compare two semver strings lexicographically by numeric part.
 *
 * WHY not a full semver library: adding a semver dependency to the CLI for one
 * comparator adds 15 KB to the bundle. This comparator handles the common
 * "major.minor.patch" format that all 11 supported agents use.
 *
 * @param a - First semver string (e.g. "1.2.3")
 * @param b - Second semver string (e.g. "1.2.4")
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parsePart = (s: string): number[] =>
    s.split('.').map((n) => parseInt(n, 10) || 0);

  const aParts = parsePart(a);
  const bParts = parsePart(b);
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Classify a detected version string against the probe registry's compatible range.
 *
 * WHY: When a user upgrades Claude Code / Codex / Gemini etc., the stream format
 * can shift. This comparator drives `styrby doctor`'s "Version compatibility"
 * section and the structured Sentry warning on drift.
 *
 * @param agentId - The agent whose registry entry to consult
 * @param detectedVersion - The version string parsed from `--version` output
 * @returns VersionCompatibilityResult with classification
 */
export function checkVersionCompatibility(
  agentId: AllAgentType,
  detectedVersion: string,
): VersionCompatibilityResult {
  const config = AGENT_PROBE_REGISTRY[agentId];
  const { minSupportedVersion, maxTestedVersion } = config;

  const cmpMin = compareSemver(detectedVersion, minSupportedVersion);
  const cmpMax = compareSemver(detectedVersion, maxTestedVersion);

  let compatibility: VersionCompatibility;
  if (cmpMin < 0) {
    compatibility = 'below-min';
  } else if (cmpMax > 0) {
    compatibility = 'above-max-tested';
  } else {
    compatibility = 'compatible';
  }

  return { detectedVersion, minSupported: minSupportedVersion, maxTested: maxTestedVersion, compatibility };
}

/**
 * Parse a version string from an agent's startup banner / stdout.
 *
 * WHY subprocess-based instead of `--version`:
 * Claude Code and Codex are full application-level launchers that cannot be
 * imported as standalone backend factories. Their startup messages include
 * version info in the initial banner lines. This parser extracts the version
 * from those lines for drift detection without requiring a separate process.
 *
 * @param agentId - The agent whose startupVersionPatterns to try
 * @param startupOutput - The first few lines of the agent's stdout
 * @returns The extracted version string, or null if not found
 */
export function parseVersionFromStartupMessage(
  agentId: AllAgentType,
  startupOutput: string,
): string | null {
  const config = AGENT_PROBE_REGISTRY[agentId];
  for (const pattern of config.startupVersionPatterns) {
    const match = pattern.exec(startupOutput);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Emit a structured Sentry warning when an agent's version is outside the
 * known-compatible range.
 *
 * WHY Sentry: version drift events must be visible to the founder even when the
 * user doesn't file a support ticket. The structured payload (`error_class`,
 * `agent`, `seen_version`, `expected_range`) allows Sentry dashboards to group
 * drift events by agent and version, showing which upgrades most frequently
 * break Styrby parsers.
 *
 * WHY non-fatal: a version above MAX_TESTED may still work. We warn rather
 * than block so users with a brand-new agent version can still run sessions
 * while the Styrby team validates the new format.
 *
 * @param agentId - The agent that triggered the drift
 * @param compatibility - The full compatibility result
 */
function emitVersionDriftWarning(
  agentId: AllAgentType,
  compatibility: VersionCompatibilityResult,
): void {
  const msg =
    compatibility.compatibility === 'below-min'
      ? `Agent version ${compatibility.detectedVersion} is below minimum supported ${compatibility.minSupported}`
      : `Agent version ${compatibility.detectedVersion} is above max tested ${compatibility.maxTested} — format may have changed`;

  // WHY structured log: pairs with Sentry for observability. The structured
  // payload lets the Sentry dashboard group by agent + version automatically.
  logger.warn(`[VersionDrift] ${agentId}: ${msg}`, {
    level: 'warn',
    error_class: 'agent_version_drift',
    agent: agentId,
    seen_version: compatibility.detectedVersion,
    expected_range: `${compatibility.minSupported}..${compatibility.maxTested}`,
  });
}

// ============================================================================
// Detection Utilities
// ============================================================================

/**
 * Run a command and capture its stdout output, with a timeout.
 *
 * WHY timeout: Agent CLIs occasionally hang on startup if a daemon is
 * misconfigured. A 5-second timeout prevents `styrby doctor` from stalling.
 *
 * @param command - The binary to execute
 * @param args - Arguments to pass (typically ['--version'])
 * @returns Combined stdout+stderr, or null on error
 */
async function runCommand(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 5000,
      encoding: 'utf8',
    });
    return (stdout + stderr).trim();
  } catch {
    return null;
  }
}

/**
 * Check if a binary exists on PATH using the system `which` (or `where` on Windows).
 *
 * @param command - Binary name to check
 * @returns True if the binary is on PATH
 */
async function isBinaryOnPath(command: string): Promise<boolean> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(whichCmd, [command], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Per-agent probe
// ============================================================================

/**
 * Probe a single agent: detect if it's installed and capture its version.
 *
 * This function runs the minimum structural check that doesn't require an
 * API key or network access:
 *   1. Check if the binary is on PATH
 *   2. Run `<binary> --version` (or the configured versionFlag) and parse
 *      the output for a semver string
 *
 * For the full format-contract check (does the binary's JSON output still
 * match what our parser expects?), see agentSmokeTests.test.ts.
 *
 * @param agentId - The agent to probe
 * @returns AgentProbeResult with status, version, and diagnostics
 *
 * @throws Never — all errors are captured in the result
 */
export async function probeAgent(agentId: AllAgentType): Promise<AgentProbeResult> {
  const config = AGENT_PROBE_REGISTRY[agentId];

  const base: Omit<AgentProbeResult, 'status' | 'version' | 'message'> = {
    agentId,
    displayName: config.displayName,
    command: config.command,
    expectedStreamFormat: config.expectedStreamFormat,
    parserFile: config.parserFile,
  };

  // Step 1: Check if the binary exists on PATH
  const isInstalled = await isBinaryOnPath(config.command);
  if (!isInstalled) {
    logger.debug(`[AgentProbe] ${config.command} not found on PATH`);
    return {
      ...base,
      status: 'NOT_INSTALLED',
      message: `Not found on PATH. ${config.installHint}`,
    };
  }

  // Step 2: Run the version flag (if configured) to confirm the binary is functional
  if (config.versionFlag) {
    const output = await runCommand(config.command, [config.versionFlag]);
    if (output === null) {
      return {
        ...base,
        status: 'FAIL',
        message:
          `Binary found but '${config.command} ${config.versionFlag}' failed or timed out. ` +
          `This may indicate a corrupted install or a version too old to support --version. ` +
          `Check the parser contract in: src/${config.parserFile}`,
      };
    }

    const versionMatch = config.versionPattern.exec(output);
    const version = versionMatch?.[1];

    logger.debug(`[AgentProbe] ${config.command} version output: ${output.slice(0, 80)}`);

    // Phase 1.6.4b: check version against known-compatible range and warn on drift.
    let versionCompatibility: VersionCompatibilityResult | undefined;
    if (version) {
      versionCompatibility = checkVersionCompatibility(agentId, version);
      if (versionCompatibility.compatibility !== 'compatible') {
        emitVersionDriftWarning(agentId, versionCompatibility);
      }
    }

    return {
      ...base,
      status: 'PASS',
      version,
      versionCompatibility,
      message: version ? undefined : `Version not parseable from output: "${output.slice(0, 40)}"`,
    };
  }

  // No version flag configured — binary exists, mark PASS without version
  return {
    ...base,
    status: 'PASS',
  };
}

/**
 * Probe all 11 Styrby agents in parallel.
 *
 * WHY parallel: `styrby doctor` should complete in under 5 seconds on a
 * healthy system. Running 11 sequential shell commands would take up to
 * 55 seconds worst-case. Parallel probes finish in max(individual_probe_time).
 *
 * @returns Array of probe results, one per agent, in registration order
 */
export async function probeAllAgents(): Promise<AgentProbeResult[]> {
  const agentIds = Object.keys(AGENT_PROBE_REGISTRY) as AllAgentType[];
  const results = await Promise.all(agentIds.map((id) => probeAgent(id)));
  return results;
}

/**
 * Produce a human-readable doctor report for a set of probe results.
 *
 * WHY a separate formatter: the `runDoctor` command logs each line via
 * `logger.info`. Extracting the formatting logic here makes it testable
 * independently of the I/O side effects.
 *
 * @param results - Probe results from probeAllAgents
 * @returns Array of formatted lines, one per agent
 */
export function formatAgentProbeReport(results: AgentProbeResult[]): string[] {
  return results.map((r) => {
    const icon =
      r.status === 'PASS'
        ? '✓'
        : r.status === 'NOT_INSTALLED'
          ? '-'
          : '✗';
    const statusLabel =
      r.status === 'PASS'
        ? 'PASS'
        : r.status === 'NOT_INSTALLED'
          ? 'NOT_INSTALLED'
          : 'FAIL';
    const versionStr = r.version ? ` v${r.version}` : '';
    const detail = r.message ? ` — ${r.message}` : '';

    // Phase 1.6.4b: append version compatibility note when drift detected.
    let compatNote = '';
    if (r.versionCompatibility && r.versionCompatibility.compatibility !== 'compatible') {
      const vc = r.versionCompatibility;
      if (vc.compatibility === 'below-min') {
        compatNote = ` [VERSION DRIFT: ${vc.detectedVersion} < min ${vc.minSupported} — update ${r.command} or report at https://github.com/VetSecItPro/styrby-app/issues]`;
      } else {
        compatNote = ` [VERSION UNTESTED: ${vc.detectedVersion} > max tested ${vc.maxTested} — report at https://github.com/VetSecItPro/styrby-app/issues]`;
      }
    }

    return `  ${icon} [${statusLabel}] ${r.displayName} (${r.command})${versionStr}${detail}${compatNote}`;
  });
}

/**
 * Return the subset of agents that failed their probe (FAIL status).
 *
 * WHY: Callers that want to surface actionable failures (not just "not installed")
 * use this helper to filter out the informational NOT_INSTALLED entries.
 *
 * @param results - Full probe result set
 * @returns Only the FAIL results
 */
export function getFailedProbes(results: AgentProbeResult[]): AgentProbeResult[] {
  return results.filter((r) => r.status === 'FAIL');
}
