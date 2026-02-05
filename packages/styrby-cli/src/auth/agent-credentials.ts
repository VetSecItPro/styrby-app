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
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@/ui/logger';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

/**
 * Supported agent types
 *
 * Note: Aider is deferred to post-MVP due to estimate-only cost tracking.
 * See docs/planning/post-mvp-roadmap.md for details.
 */
export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode';

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
  // Note: Aider deferred to post-MVP due to estimate-only cost tracking.
  // See docs/planning/post-mvp-roadmap.md
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
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    await execAsync(`${whichCmd} ${command}`);
    return true;
  } catch {
    return false;
  }
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
  const [claude, codex, gemini, opencode] = await Promise.all([
    getAgentStatus('claude'),
    getAgentStatus('codex'),
    getAgentStatus('gemini'),
    getAgentStatus('opencode'),
  ]);

  return { claude, codex, gemini, opencode };
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

  // Prefer Claude, then Codex, then Gemini, then OpenCode
  if (all.claude.installed) return all.claude;
  if (all.codex.installed) return all.codex;
  if (all.gemini.installed) return all.gemini;
  if (all.opencode.installed) return all.opencode;

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
