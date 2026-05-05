/**
 * Agent Credentials Detection
 *
 * Detects whether AI coding agents (Claude, Codex, Gemini) are
 * installed and configured on the user's system.
 *
 * ## Philosophy
 *
 * Styrby is a relay/wrapper. We don't handle agent authentication ourselves.
 * Instead, we:
 *
 * 1. **Detect** if the agent CLI is installed
 * 2. **Detect** if the agent appears to be configured (env vars, config files)
 * 3. **Spawn** the agent and let it handle its own auth flow
 * 4. **Relay** all agent output to the mobile app
 *
 * If the agent needs the user to log in (Claude Max, ChatGPT Plus, etc.),
 * the user will see that prompt on their phone and can respond accordingly.
 *
 * @module auth/agent-credentials
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';


// ============================================================================
// Types
// ============================================================================

/**
 * Supported agent types — all 11 product-tier agents.
 *
 * WHY (audit 2026-05-05): Detection previously enumerated only 4 agents
 * (claude/codex/gemini/opencode). The other 7 were silently treated as
 * "not installed" by `getAllAgentStatus`/`getInstalledAgents`/
 * `getDefaultAgent`, so onboarding under-reported the user's actual
 * tooling. This union must mirror `SupportedAgentType` in persistence.ts.
 */
export type AgentType =
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
 * Agent configuration metadata
 */
export interface AgentConfig {
  /** Agent identifier */
  id: AgentType;
  /** Display name */
  name: string;
  /** Provider company name */
  provider: string;
  /** CLI command to run */
  command: string;
  /** Environment variables that indicate configuration */
  envVars: string[];
  /** Config file paths to check (relative to home directory) */
  configPaths: string[];
  /** URL to get started with this agent */
  setupUrl: string;
  /** Brand color (hex) */
  color: string;
}

/**
 * Agent status on the system
 */
export interface AgentStatus {
  /** Agent type */
  agent: AgentType;
  /** Agent display name */
  name: string;
  /** Provider name */
  provider: string;
  /** Whether the CLI is installed and in PATH */
  installed: boolean;
  /** Whether the agent appears configured (has env var or config file) */
  configured: boolean;
  /** How it's configured (if known) */
  configSource?: 'env' | 'config-file' | 'unknown';
  /** Which env var or config path was found */
  configDetail?: string;
  /** CLI command */
  command: string;
  /** Setup URL */
  setupUrl: string;
  /** Brand color */
  color: string;
}

// ============================================================================
// Agent Configurations
// ============================================================================

/**
 * Configuration for each supported agent
 */
export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    provider: 'Anthropic',
    command: 'claude',
    envVars: ['ANTHROPIC_API_KEY'],
    configPaths: [
      // WHY (audit 2026-05-05 LOW fix): factories/claude.ts reads
      // ~/.claude/auth.json for the subscription token. Detection used
      // to only check legacy paths, so the cost-classifier and detector
      // disagreed on whether Claude was configured.
      '.claude/auth.json',
      '.claude.json',
      '.config/claude/config.json',
      '.anthropic/credentials',
    ],
    setupUrl: 'https://claude.ai/download',
    color: '#F97316',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    command: 'codex',
    envVars: ['OPENAI_API_KEY'],
    configPaths: [
      '.config/openai/credentials',
      '.openai/credentials',
    ],
    setupUrl: 'https://platform.openai.com/docs/quickstart',
    color: '#10A37F',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    provider: 'Google',
    command: 'gemini',
    envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    configPaths: [
      '.config/gemini/config.json',
      '.config/gcloud/application_default_credentials.json',
    ],
    setupUrl: 'https://ai.google.dev/gemini-api/docs/quickstart',
    color: '#4285F4',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    provider: 'Open Source',
    command: 'opencode',
    envVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], // Works with multiple providers
    configPaths: [
      '.config/opencode/config.json',
      '.opencode/config.json',
    ],
    setupUrl: 'https://opencode.ai',
    color: '#8B5CF6', // Purple
  },
  // ------------------------------------------------------------------
  // Tier 2 + Tier 3 agents (added 2026-05-05 — audit fix CRITICAL).
  // Env vars + config paths derived from each agent's factory file.
  // ------------------------------------------------------------------
  aider: {
    id: 'aider',
    name: 'Aider',
    provider: 'Open Source',
    command: 'aider',
    // Aider auto-detects from environment; supports many providers.
    envVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'],
    configPaths: [
      '.aider.conf.yml',
      '.aider.conf',
      '.config/aider/config.yml',
    ],
    setupUrl: 'https://aider.chat',
    color: '#EAB308', // Amber — distinct from existing palette
  },
  goose: {
    id: 'goose',
    name: 'Goose',
    provider: 'aaif',
    command: 'goose',
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'],
    configPaths: [
      '.config/goose/config.yaml',
      '.config/goose/config.yml',
      '.goose/config.yaml',
    ],
    setupUrl: 'https://github.com/aaif-goose/goose',
    color: '#22C55E', // Green — open-source signal
  },
  amp: {
    id: 'amp',
    name: 'Amp',
    provider: 'Sourcegraph',
    command: 'amp',
    envVars: ['ANTHROPIC_API_KEY', 'AMP_API_KEY'],
    configPaths: [
      '.config/amp/config.json',
      '.amp/config.json',
    ],
    setupUrl: 'https://ampcode.com',
    color: '#EC4899', // Pink — distinguishes enterprise wedge tier
  },
  crush: {
    id: 'crush',
    name: 'Crush',
    provider: 'Charm',
    command: 'crush',
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    configPaths: [
      '.config/crush/crush.json',
      '.crush/config.json',
    ],
    setupUrl: 'https://github.com/charmbracelet/crush',
    color: '#A855F7', // Violet — Charm brand-adjacent
  },
  kilo: {
    id: 'kilo',
    name: 'Kilo',
    provider: 'Kilo-Org',
    command: 'kilo',
    envVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'KILO_API_KEY'],
    configPaths: [
      '.config/kilo/config.json',
      '.kilo/config.json',
    ],
    setupUrl: 'https://github.com/Kilo-Org/kilocode',
    color: '#06B6D4', // Cyan
  },
  kiro: {
    id: 'kiro',
    name: 'Kiro',
    provider: 'AWS',
    command: 'kiro',
    // Kiro authenticates via AWS credentials, not LLM API keys.
    envVars: ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN'],
    configPaths: [
      '.aws/credentials',
      '.aws/config',
      '.config/kiro/config.json',
    ],
    setupUrl: 'https://kiro.dev',
    color: '#F59E0B', // AWS-orange-adjacent
  },
  droid: {
    id: 'droid',
    name: 'Droid',
    provider: 'Factory',
    command: 'droid',
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY'],
    configPaths: [
      '.config/droid/config.json',
      '.factory/config.json',
    ],
    setupUrl: 'https://github.com/Factory-AI/factory',
    color: '#0EA5E9', // Sky blue
  },
};

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Check if a CLI command exists in PATH.
 *
 * @param command - Command to check
 * @returns True if command is available
 */
async function isCommandInstalled(command: string): Promise<boolean> {
  // OWASP ASVS V5.3.5 / CWE-78: use spawn with shell:false + arg array,
  // never template-string shell exec. Even though `command` is internal-call
  // only today, the residual class is closed by construction here. Mirrors
  // doctor.ts:50 refactor done in the same hardening PR.
  return new Promise((resolve) => {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(whichCmd, [command], { shell: false, stdio: 'ignore' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Check if any of the given environment variables are set.
 *
 * @param envVars - Environment variable names to check
 * @returns The first set env var name, or null
 */
function findSetEnvVar(envVars: string[]): string | null {
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (value && value.trim().length > 0) {
      return envVar;
    }
  }
  return null;
}

/**
 * Check if any of the given config files exist.
 *
 * @param configPaths - Config file paths relative to home directory
 * @returns The first existing path, or null
 */
function findExistingConfigFile(configPaths: string[]): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || '';

  for (const configPath of configPaths) {
    const fullPath = path.join(home, configPath);
    if (fs.existsSync(fullPath)) {
      return configPath;
    }
  }
  return null;
}

/**
 * Get the status of a specific agent.
 *
 * @param agent - Agent type to check
 * @returns Agent status
 */
export async function getAgentStatus(agent: AgentType): Promise<AgentStatus> {
  const config = AGENT_CONFIGS[agent];

  const installed = await isCommandInstalled(config.command);

  let configured = false;
  let configSource: 'env' | 'config-file' | 'unknown' | undefined;
  let configDetail: string | undefined;

  // Check environment variables first
  const envVar = findSetEnvVar(config.envVars);
  if (envVar) {
    configured = true;
    configSource = 'env';
    configDetail = envVar;
  }

  // Check config files if no env var found
  if (!configured) {
    const configFile = findExistingConfigFile(config.configPaths);
    if (configFile) {
      configured = true;
      configSource = 'config-file';
      configDetail = configFile;
    }
  }

  // If installed but we couldn't detect config, it might still be configured
  // (e.g., via OAuth/subscription that we can't detect)
  if (installed && !configured) {
    configSource = 'unknown';
  }

  return {
    agent,
    name: config.name,
    provider: config.provider,
    installed,
    configured,
    configSource,
    configDetail,
    command: config.command,
    setupUrl: config.setupUrl,
    color: config.color,
  };
}

/**
 * Get the status of all agents.
 *
 * @returns Map of agent type to status
 */
export async function getAllAgentStatus(): Promise<Record<AgentType, AgentStatus>> {
  // WHY (audit 2026-05-05): Iterate over AGENT_CONFIGS keys instead of a
  // hard-coded list so adding a new agent only requires touching the
  // config map — no second place to forget.
  const agents = Object.keys(AGENT_CONFIGS) as AgentType[];
  const statuses = await Promise.all(agents.map((a) => getAgentStatus(a)));

  const result = {} as Record<AgentType, AgentStatus>;
  agents.forEach((a, i) => {
    result[a] = statuses[i];
  });
  return result;
}

/**
 * Get list of installed agents.
 *
 * @returns Array of installed agent statuses
 */
export async function getInstalledAgents(): Promise<AgentStatus[]> {
  const all = await getAllAgentStatus();
  return Object.values(all).filter((status) => status.installed);
}

/**
 * Get the default agent (first installed one, preferring Claude).
 *
 * @returns Default agent status, or null if none installed
 */
export async function getDefaultAgent(): Promise<AgentStatus | null> {
  const all = await getAllAgentStatus();

  // Priority order: Tier 1 first (volume agents), then Tier 2 (niche),
  // then Tier 3 (enterprise wedge). Claude wins ties for backward compat.
  const priority: AgentType[] = [
    'claude', 'codex', 'gemini', 'opencode', 'kilo',  // Tier 1
    'aider', 'goose',                                  // Tier 2
    'crush', 'amp', 'kiro', 'droid',                   // Tier 3
  ];

  for (const agent of priority) {
    if (all[agent]?.installed) return all[agent];
  }

  return null;
}

// ============================================================================
// Agent Spawning Helpers
// ============================================================================

/**
 * Get the command and args to spawn an agent.
 *
 * @param agent - Agent type
 * @param options - Spawn options
 * @returns Command and arguments
 */
export function getAgentSpawnCommand(
  agent: AgentType,
  options: {
    /** Working directory for the agent */
    cwd?: string;
    /** Whether to run in interactive mode */
    interactive?: boolean;
    /** Initial prompt to send */
    prompt?: string;
  } = {}
): { command: string; args: string[] } {
  const config = AGENT_CONFIGS[agent];

  const args: string[] = [];

  // Agent-specific arguments
  switch (agent) {
    case 'claude':
      // Claude Code flags
      if (options.cwd) {
        args.push('--cwd', options.cwd);
      }
      if (options.prompt) {
        args.push('--prompt', options.prompt);
      }
      break;

    case 'codex':
      // Codex flags
      if (options.cwd) {
        args.push('--working-dir', options.cwd);
      }
      break;

    case 'gemini':
      // Gemini CLI flags
      if (options.cwd) {
        args.push('--project-dir', options.cwd);
      }
      break;

    case 'opencode':
      // OpenCode flags
      // OpenCode uses current directory by default, no --cwd flag needed
      if (options.prompt) {
        args.push('--message', options.prompt);
      }
      break;
  }

  return {
    command: config.command,
    args,
  };
}

/**
 * Log agent detection results for debugging.
 */
export async function logAgentDetection(): Promise<void> {
  const statuses = await getAllAgentStatus();

  for (const status of Object.values(statuses)) {
    logger.debug(`Agent: ${status.name}`, {
      installed: status.installed,
      configured: status.configured,
      configSource: status.configSource,
      configDetail: status.configDetail,
    });
  }
}

/**
 * Default export
 */
export default {
  AGENT_CONFIGS,
  getAgentStatus,
  getAllAgentStatus,
  getInstalledAgents,
  getDefaultAgent,
  getAgentSpawnCommand,
  logAgentDetection,
};
