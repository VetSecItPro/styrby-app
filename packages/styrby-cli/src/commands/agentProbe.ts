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
  },

  codex: {
    displayName: 'Codex',
    command: 'codex',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    expectedStreamFormat: {
      type: '"message" | "tool_use" | "tool_result" | "reasoning"',
      id: 'string',
      role: '"assistant" | "user"',
    },
    parserFile: 'codex/codexMcpClient.ts',
    installHint: 'npm install -g @openai/codex',
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
  },
};

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

    return {
      ...base,
      status: 'PASS',
      version,
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
    return `  ${icon} [${statusLabel}] ${r.displayName} (${r.command})${versionStr}${detail}`;
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
