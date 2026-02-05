/**
 * Agent Installation
 *
 * Handles installation of AI coding agents (Claude Code, Codex, Gemini CLI,
 * OpenCode). Makes it easy for vibe-coders to get started without
 * knowing npm commands.
 *
 * Note: Aider support deferred to post-MVP due to estimate-only cost tracking.
 * See docs/planning/post-mvp-roadmap.md for details.
 *
 * @module commands/install-agent
 */

import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { logger } from '@/ui/logger';
import {
  type AgentType,
  AGENT_CONFIGS,
  getAgentStatus,
} from '@/auth/agent-credentials';

// ============================================================================
// Types
// ============================================================================

/**
 * Package manager type
 */
type PackageManager = 'npm' | 'curl';

/**
 * Agent package information for installation
 */
interface AgentPackageInfo {
  /** Package manager to use */
  packageManager: PackageManager;
  /** Package name (npm package, or curl URL) */
  packageName: string;
  /** Description for users */
  description: string;
  /** Post-install instructions */
  postInstall: string;
  /** Login/setup command (if any) */
  loginCommand?: string;
}

/**
 * Installation result
 */
export interface InstallResult {
  /** Whether installation succeeded */
  success: boolean;
  /** Agent that was installed */
  agent: AgentType;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Package Information
// ============================================================================

/**
 * Package information for each agent
 *
 * Note: These package names should be verified against actual published packages.
 * Update as needed when packages are officially released.
 */
export const AGENT_PACKAGES: Record<AgentType, AgentPackageInfo> = {
  claude: {
    packageManager: 'npm',
    packageName: '@anthropic-ai/claude-code',
    description: "Anthropic's AI coding assistant with agentic capabilities.",
    postInstall: "Run 'claude' to start, or 'claude login' if prompted.",
    loginCommand: 'claude',
  },
  codex: {
    packageManager: 'npm',
    packageName: '@openai/codex',
    description: "OpenAI's coding assistant powered by GPT models.",
    postInstall: "Run 'codex' to start and log in with your OpenAI account.",
    loginCommand: 'codex',
  },
  gemini: {
    packageManager: 'npm',
    packageName: '@google/gemini-cli',
    description: "Google's Gemini AI coding assistant.",
    postInstall: "Run 'gemini' to start and authenticate with Google.",
    loginCommand: 'gemini',
  },
  opencode: {
    packageManager: 'npm',
    packageName: 'opencode',
    description: 'Open-source AI coding agent. Works with 75+ LLM providers.',
    postInstall: "Run 'opencode' to start. Supports GitHub Copilot, ChatGPT Plus, Claude, and more.",
    loginCommand: 'opencode',
  },
};

// ============================================================================
// Installation Functions
// ============================================================================

/**
 * Install an agent package using the appropriate package manager.
 *
 * @param agent - Agent to install
 * @param onProgress - Progress callback
 * @returns Installation result
 */
export async function installAgent(
  agent: AgentType,
  onProgress?: (message: string) => void
): Promise<InstallResult> {
  const config = AGENT_CONFIGS[agent];
  const packageInfo = AGENT_PACKAGES[agent];

  // Check if already installed
  const status = await getAgentStatus(agent);
  if (status.installed) {
    return {
      success: true,
      agent,
      error: `${config.name} is already installed`,
    };
  }

  const log = onProgress || ((msg: string) => logger.debug(msg));

  log(`Installing ${config.name}...`);

  // Install using npm (all supported agents use npm)
  return installWithNpm(agent, packageInfo, log);
}

/**
 * Install using npm.
 */
function installWithNpm(
  agent: AgentType,
  packageInfo: AgentPackageInfo,
  log: (msg: string) => void
): Promise<InstallResult> {
  return new Promise((resolve) => {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['install', '-g', packageInfo.packageName];

    log(`Running: npm install -g ${packageInfo.packageName}`);

    const proc = spawn(npmCommand, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let stderr = '';

    proc.stdout?.on('data', () => {
      log('.');
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      resolve({
        success: false,
        agent,
        error: `Failed to run npm: ${error.message}`,
      });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, agent });
      } else {
        let errorMsg = `Installation failed with exit code ${code}`;

        if (stderr.includes('EACCES')) {
          errorMsg = 'Permission denied. Try running with sudo or fix npm permissions.';
        } else if (stderr.includes('404')) {
          errorMsg = `Package ${packageInfo.packageName} not found. It may not be published yet.`;
        } else if (stderr.includes('ENOTFOUND')) {
          errorMsg = 'Network error. Check your internet connection.';
        }

        resolve({
          success: false,
          agent,
          error: errorMsg,
        });
      }
    });
  });
}

/**
 * Install multiple agents.
 *
 * @param agents - Agents to install
 * @param onProgress - Progress callback
 * @returns Array of installation results
 */
export async function installAgents(
  agents: AgentType[],
  onProgress?: (agent: AgentType, message: string) => void
): Promise<InstallResult[]> {
  const results: InstallResult[] = [];

  for (const agent of agents) {
    const result = await installAgent(agent, (msg) => {
      onProgress?.(agent, msg);
    });
    results.push(result);
  }

  return results;
}

// ============================================================================
// UI Functions
// ============================================================================

/**
 * Get the install command string for display.
 */
function getInstallCommandString(packageInfo: AgentPackageInfo): string {
  return `npm install -g ${packageInfo.packageName}`;
}

/**
 * Display installation prompt for an agent.
 *
 * @param agent - Agent to potentially install
 * @returns True if user wants to install
 */
export async function promptInstallAgent(agent: AgentType): Promise<boolean> {
  const config = AGENT_CONFIGS[agent];
  const packageInfo = AGENT_PACKAGES[agent];
  const installCmd = getInstallCommandString(packageInfo);

  console.log('');
  console.log(`  ${chalk.bold(`Install ${config.name}`)}`);
  console.log('');
  console.log(`  ${chalk.dim(packageInfo.description)}`);
  console.log('');
  console.log(`  ${chalk.dim('This will run:')}`);
  console.log(`  ${chalk.cyan(installCmd)}`);
  console.log('');

  // Simple y/n prompt
  return new Promise((resolve) => {
    process.stdout.write(`  Install? ${chalk.dim('[Y/n]')} `);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();

      const key = data.toString().toLowerCase();
      console.log(key === '\r' || key === '\n' ? 'y' : key);

      resolve(key === 'y' || key === '\r' || key === '\n');
    });
  });
}

/**
 * Run installation with UI feedback.
 *
 * @param agent - Agent to install
 * @returns Installation result
 */
export async function runInstallWithUI(agent: AgentType): Promise<InstallResult> {
  const config = AGENT_CONFIGS[agent];
  const packageInfo = AGENT_PACKAGES[agent];

  console.log('');

  // Spinner frames
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;
  let currentMessage = `Installing ${config.name}...`;

  // Start spinner
  const spinner = setInterval(() => {
    process.stdout.write(`\r  ${chalk.cyan(frames[frameIndex])} ${currentMessage}`);
    frameIndex = (frameIndex + 1) % frames.length;
  }, 80);

  const result = await installAgent(agent, (msg) => {
    if (msg !== '.') {
      currentMessage = msg;
    }
  });

  // Stop spinner
  clearInterval(spinner);
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  const installCmd = getInstallCommandString(packageInfo);

  if (result.success) {
    console.log(`  ${chalk.green('✓')} ${config.name} installed successfully!`);
    console.log('');
    console.log(`  ${chalk.dim('Next step:')} ${packageInfo.postInstall}`);
  } else {
    console.log(`  ${chalk.red('✗')} Installation failed`);
    console.log(`  ${chalk.dim(result.error || 'Unknown error')}`);
    console.log('');
    console.log(`  ${chalk.dim('Try running manually:')}`);
    console.log(`  ${chalk.cyan(installCmd)}`);
  }

  console.log('');

  return result;
}

/**
 * Interactive agent installation for multiple agents.
 *
 * @param agents - Agents that need installation
 * @returns Results
 */
export async function runBatchInstallWithUI(
  agents: AgentType[]
): Promise<InstallResult[]> {
  const results: InstallResult[] = [];

  console.log('');
  console.log(`  ${chalk.bold('Installing AI Coding Agents')}`);
  console.log(`  ${chalk.dim(`${agents.length} agent${agents.length > 1 ? 's' : ''} to install`)}`);
  console.log('');

  for (const agent of agents) {
    const config = AGENT_CONFIGS[agent];

    // Spinner
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIndex = 0;

    const spinner = setInterval(() => {
      process.stdout.write(`\r  ${chalk.cyan(frames[frameIndex])} Installing ${config.name}...`);
      frameIndex = (frameIndex + 1) % frames.length;
    }, 80);

    const result = await installAgent(agent);
    results.push(result);

    clearInterval(spinner);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

    if (result.success) {
      console.log(`  ${chalk.green('✓')} ${config.name}`);
    } else {
      console.log(`  ${chalk.red('✗')} ${config.name} - ${result.error}`);
    }
  }

  console.log('');

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (successful.length > 0) {
    console.log(`  ${chalk.green(`✓ ${successful.length} installed successfully`)}`);
  }
  if (failed.length > 0) {
    console.log(`  ${chalk.red(`✗ ${failed.length} failed`)}`);
  }

  console.log('');

  return results;
}

// ============================================================================
// CLI Command Handler
// ============================================================================

/**
 * All valid agent names for validation.
 */
const VALID_AGENTS: AgentType[] = ['claude', 'codex', 'gemini', 'opencode'];

/**
 * Handle the 'install' command.
 *
 * Usage:
 *   styrby install claude
 *   styrby install codex
 *   styrby install gemini
 *   styrby install opencode
 *   styrby install --all
 *
 * @param args - Command arguments
 */
export async function handleInstallCommand(args: string[]): Promise<void> {
  // Parse arguments
  const installAll = args.includes('--all') || args.includes('-a');
  const agentArg = args.find((a) => !a.startsWith('-'));

  if (!installAll && !agentArg) {
    console.log('');
    console.log('  Usage: styrby install <agent>');
    console.log('');
    console.log('  Agents:');
    console.log('    claude    Install Claude Code (Anthropic)');
    console.log('    codex     Install Codex (OpenAI)');
    console.log('    gemini    Install Gemini CLI (Google)');
    console.log('    opencode  Install OpenCode (Open Source)');
    console.log('');
    console.log('  Options:');
    console.log('    --all     Install all agents');
    console.log('');
    return;
  }

  if (installAll) {
    // Get agents that aren't installed
    const { getAllAgentStatus } = await import('@/auth/agent-credentials');
    const statuses = await getAllAgentStatus();
    const notInstalled = Object.values(statuses)
      .filter((s) => !s.installed)
      .map((s) => s.agent);

    if (notInstalled.length === 0) {
      console.log('');
      console.log('  All agents are already installed!');
      console.log('');
      return;
    }

    await runBatchInstallWithUI(notInstalled);
    return;
  }

  // Single agent install
  const agent = agentArg?.toLowerCase() as AgentType;

  if (!VALID_AGENTS.includes(agent)) {
    console.log('');
    console.log(`  Unknown agent: ${agentArg}`);
    console.log('');
    console.log(`  Valid agents: ${VALID_AGENTS.join(', ')}`);
    console.log('');
    return;
  }

  const status = await getAgentStatus(agent);

  if (status.installed) {
    console.log('');
    console.log(`  ${status.name} is already installed!`);
    console.log('');
    if (!status.configured) {
      console.log(`  ${chalk.dim('To configure, run:')} ${status.command}`);
      console.log('');
    }
    return;
  }

  const confirmed = await promptInstallAgent(agent);

  if (confirmed) {
    await runInstallWithUI(agent);
  } else {
    console.log('');
    console.log('  Installation cancelled.');
    console.log('');
  }
}

/**
 * Default export
 */
export default {
  AGENT_PACKAGES,
  installAgent,
  installAgents,
  promptInstallAgent,
  runInstallWithUI,
  runBatchInstallWithUI,
  handleInstallCommand,
};
