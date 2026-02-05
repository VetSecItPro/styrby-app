/**
 * Interactive Mode
 *
 * The main interactive experience when running `styrby` with no arguments.
 * Provides a menu-driven interface for all CLI functionality.
 *
 * @module commands/interactive
 */

import chalk from 'chalk';
import { createClient } from '@supabase/supabase-js';
import {
  displayWelcome,
  displayFirstTimeWelcome,
  displayMenu,
  displayControls,
  displaySessionHeader,
  displayWaitingForMobile,
  displaySessionStats,
  clearScreen,
  getUserState,
  colors,
  type UserState,
} from '@/ui/welcome';
import { showMenu, type MenuOption } from '@/ui/interactive';
import { isAuthenticated } from '@/configuration';
import { loadPersistedData } from '@/persistence';
import {
  getAllAgentStatus,
  type AgentType,
  type AgentStatus,
} from '@/auth/agent-credentials';
import { AgentSession, createAgentSession } from '@/session/agent-session';
import {
  runInstallWithUI,
  runBatchInstallWithUI,
  type InstallResult,
} from '@/commands/install-agent';

// ============================================================================
// Types
// ============================================================================

/**
 * Main menu options
 */
type MainMenuOption =
  | 'start'
  | 'recent'
  | 'costs'
  | 'install'
  | 'pair'
  | 'settings'
  | 'help'
  | 'quit';

// ============================================================================
// Constants
// ============================================================================

import { config } from '@/env';
const SUPABASE_URL = config.supabaseUrl;
const SUPABASE_ANON_KEY = config.supabaseAnonKey;

// ============================================================================
// Agent Display
// ============================================================================

/**
 * Display agent selection list with status indicators.
 */
function displayAgentSelection(
  agents: AgentStatus[],
  selectedIndex: number,
  projectPath: string
): void {
  console.log(`  ${colors.muted('Select an agent:')}`);
  console.log('');

  agents.forEach((agent, index) => {
    const isSelected = index === selectedIndex;
    const prefix = isSelected ? colors.brand('›') : ' ';

    // Agent name with color
    const agentColor = chalk.hex(agent.color);
    const name = agentColor(agent.name.padEnd(14));

    // Provider
    const provider = colors.muted(agent.provider.padEnd(12));

    // Status
    let status: string;
    if (!agent.installed) {
      status = colors.muted('○ not installed');
    } else if (agent.configured) {
      status = colors.success('✓ ready');
    } else {
      status = colors.warning('○ needs setup');
    }

    console.log(`  ${prefix} ${name} ${provider} ${status}`);
  });

  console.log('');

  // Show project path
  const shortPath = projectPath.replace(process.env.HOME || '', '~');
  console.log(`  ${colors.muted('Project:')} ${shortPath}`);
  console.log('');
}

// ============================================================================
// Menu Screens
// ============================================================================

/**
 * Show the main menu.
 */
async function showMainMenu(state: UserState): Promise<MainMenuOption> {
  // Check how many agents are not installed
  const agentStatuses = await getAllAgentStatus();
  const notInstalled = Object.values(agentStatuses).filter((a) => !a.installed);
  const hasUninstalledAgents = notInstalled.length > 0;

  const options: MenuOption<MainMenuOption>[] = [
    { value: 'start', label: 'Start session' },
    { value: 'recent', label: 'Recent sessions', hint: '(coming soon)', disabled: true },
    { value: 'costs', label: 'Costs & usage' },
  ];

  // Add install option if agents are missing
  if (hasUninstalledAgents) {
    options.push({
      value: 'install',
      label: 'Install agents',
      hint: `(${notInstalled.length} available)`,
    });
  }

  // Add pair option if not paired
  if (!state.isPaired) {
    options.push({ value: 'pair', label: 'Pair mobile app' });
  }

  options.push(
    { value: 'settings', label: 'Settings', hint: '(coming soon)', disabled: true },
    { value: 'help', label: 'Help' },
    { value: 'quit', label: 'Quit' }
  );

  const result = await showMenu({
    options,
    render: (selectedIndex) => {
      displayWelcome(state);
      displayMenu(
        options.map((o) => ({ label: o.label, hint: o.hint, disabled: o.disabled })),
        selectedIndex
      );
      displayControls([
        ['↑↓', 'Navigate'],
        ['Enter', 'Select'],
        ['q', 'Quit'],
      ]);
    },
  });

  if (result.cancelled) {
    return 'quit';
  }

  return result.value;
}

/**
 * Show the agent selection menu.
 */
async function showAgentMenu(
  projectPath: string
): Promise<{ agent: AgentType; status: AgentStatus } | null> {
  const statuses = await getAllAgentStatus();
  const agents = Object.values(statuses);

  // Build options - only installed agents are selectable
  const options: MenuOption<AgentType | 'back'>[] = agents.map((agent) => ({
    value: agent.agent,
    label: agent.name,
    disabled: !agent.installed,
  }));

  const result = await showMenu({
    options,
    render: (selectedIndex) => {
      clearScreen();
      displayAgentSelection(agents, selectedIndex, projectPath);
      displayControls([
        ['↑↓', 'Navigate'],
        ['Enter', 'Select'],
        ['Esc', 'Back'],
      ]);
    },
  });

  if (result.cancelled) {
    return null;
  }

  const selectedAgent = result.value as AgentType;
  return {
    agent: selectedAgent,
    status: statuses[selectedAgent],
  };
}

/**
 * Show agent not installed message with install option.
 *
 * @param agent - The agent status
 * @returns 'installed' if user installed, 'back' otherwise
 */
async function showAgentNotInstalled(agent: AgentStatus): Promise<'installed' | 'back'> {
  clearScreen();
  console.log('');
  console.log(`  ${chalk.hex(agent.color).bold(agent.name)} is not installed.`);
  console.log('');

  const options: MenuOption<'install' | 'manual' | 'back'>[] = [
    { value: 'install', label: 'Install now', hint: '(recommended)' },
    { value: 'manual', label: 'Manual setup', hint: `(${agent.setupUrl})` },
    { value: 'back', label: 'Go back' },
  ];

  const result = await showMenu({
    options,
    clearOnRender: false,
    render: (selectedIndex) => {
      displayMenu(
        options.map((o) => ({ label: o.label, hint: o.hint })),
        selectedIndex
      );
      displayControls([
        ['↑↓', 'Navigate'],
        ['Enter', 'Select'],
        ['Esc', 'Back'],
      ]);
    },
  });

  if (result.cancelled || result.value === 'back') {
    return 'back';
  }

  if (result.value === 'manual') {
    const open = (await import('open')).default;
    await open(agent.setupUrl);
    console.log('');
    console.log(`  ${colors.muted('Opened setup page in browser.')}`);
    console.log(`  ${colors.muted('Press any key when ready...')}`);
    await waitForKey();
    return 'back';
  }

  // Install the agent
  clearScreen();
  const installResult = await runInstallWithUI(agent.agent);

  if (installResult.success) {
    return 'installed';
  }

  console.log(`  ${colors.muted('Press any key to continue...')}`);
  await waitForKey();
  return 'back';
}

/**
 * Show agent needs setup message.
 */
async function showAgentNeedsSetup(agent: AgentStatus): Promise<'configure' | 'continue' | 'back'> {
  clearScreen();
  console.log('');
  console.log(`  ${chalk.hex(agent.color).bold(agent.name)}`);
  console.log('');
  console.log(`  ${colors.warning('⚠')} This agent doesn't appear to be configured yet.`);
  console.log('');
  console.log(`  ${colors.muted('You can:')}`);
  console.log('');

  const options: MenuOption<'configure' | 'continue' | 'back'>[] = [
    {
      value: 'configure',
      label: 'Configure now',
      hint: `(opens ${agent.provider} in browser)`,
    },
    {
      value: 'continue',
      label: 'Start anyway',
      hint: '(agent will prompt for login)',
    },
    { value: 'back', label: 'Go back' },
  ];

  const result = await showMenu({
    options,
    clearOnRender: false,
    render: (selectedIndex) => {
      // Re-render just the menu part
      process.stdout.write('\x1B[6A'); // Move up 6 lines
      process.stdout.write('\x1B[0J'); // Clear from cursor down
      displayMenu(
        options.map((o) => ({ label: o.label, hint: o.hint })),
        selectedIndex
      );
    },
  });

  return result.cancelled ? 'back' : result.value;
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Run an agent session with full UI.
 */
async function runAgentSession(
  agent: AgentStatus,
  projectPath: string,
  state: UserState
): Promise<void> {
  const data = loadPersistedData();

  if (!data?.userId || !data?.accessToken || !data?.machineId) {
    console.log(chalk.red('  Not fully authenticated. Run styrby onboard first.'));
    await waitForKey();
    return;
  }

  // Create Supabase client
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    },
  });

  clearScreen();
  displaySessionHeader(agent.name, projectPath);

  let session: AgentSession | null = null;
  let mobileConnected = false;
  let stats = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  // Set up cleanup
  const cleanup = async (): Promise<void> => {
    if (session) {
      await session.stop();
      session = null;
    }
  };

  // Handle Ctrl+C
  const onInterrupt = async (): Promise<void> => {
    process.off('SIGINT', onInterrupt);
    console.log('');
    console.log(colors.muted('  Ending session...'));
    await cleanup();
  };
  process.on('SIGINT', onInterrupt);

  try {
    // Create and start session
    session = new AgentSession({
      agent: agent.agent,
      cwd: projectPath,
      userId: data.userId,
      machineId: data.machineId,
      machineName: data.machineName || 'CLI',
      supabase,
      debug: process.env.STYRBY_LOG_LEVEL === 'debug',
    });

    // Handle session events
    session.on('output', ({ data: output }) => {
      process.stdout.write(output);
    });

    session.on('mobileConnected', ({ deviceName }) => {
      mobileConnected = true;
      console.log('');
      console.log(colors.success(`  ✓ Mobile connected${deviceName ? `: ${deviceName}` : ''}`));
      console.log('');
    });

    session.on('mobileDisconnected', () => {
      mobileConnected = false;
      console.log('');
      console.log(colors.warning('  ○ Mobile disconnected'));
      console.log('');
    });

    session.on('error', ({ message }) => {
      console.log('');
      console.log(colors.error(`  Error: ${message}`));
    });

    session.on('exit', ({ code }) => {
      console.log('');
      console.log(colors.muted(`  Agent exited with code ${code}`));
    });

    // Start the session
    await session.start();

    // Show waiting for mobile message
    if (!session.isMobileConnected()) {
      displayWaitingForMobile();
    }

    // Wait for session to end (exit event or manual stop)
    await new Promise<void>((resolve) => {
      session!.on('exit', () => resolve());
      session!.on('error', () => resolve());
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.log('');
    console.log(colors.error(`  Failed to start session: ${message}`));
  } finally {
    process.off('SIGINT', onInterrupt);
    await cleanup();
  }

  console.log('');
  console.log(colors.muted('  Press any key to continue...'));
  await waitForKey();
}

// ============================================================================
// Other Screens
// ============================================================================

/**
 * Show the costs screen.
 */
async function showCostsScreen(): Promise<void> {
  clearScreen();

  try {
    const { aggregateCosts } = await import('@/costs/index');
    const summary = await aggregateCosts();

    console.log('');
    console.log(`  ${colors.brandBold('Costs & Usage')}`);
    console.log('');

    if (summary.sessionCount === 0) {
      console.log(`  ${colors.muted('No usage data found.')}`);
      console.log(`  ${colors.muted('Session files are stored in ~/.claude/projects/')}`);
    } else {
      const formatTokens = (n: number): string => {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return n.toString();
      };

      console.log(`  ${colors.muted('Sessions:')}       ${summary.sessionCount}`);
      console.log(`  ${colors.muted('Input tokens:')}   ${formatTokens(summary.totalInputTokens)}`);
      console.log(`  ${colors.muted('Output tokens:')}  ${formatTokens(summary.totalOutputTokens)}`);
      console.log('');
      console.log(`  ${colors.muted('Total cost:')}     ${colors.success(`$${summary.totalCostUsd.toFixed(4)}`)}`);

      const models = Object.entries(summary.byModel);
      if (models.length > 0) {
        console.log('');
        console.log(`  ${colors.muted('By Model:')}`);
        for (const [model, modelData] of models) {
          const data = modelData as { costUsd: number };
          console.log(`    ${model}: $${data.costUsd.toFixed(4)}`);
        }
      }
    }
  } catch {
    console.log('');
    console.log(`  ${colors.muted('Could not load cost data.')}`);
  }

  console.log('');
  console.log(`  ${colors.muted('Press any key to go back...')}`);
  await waitForKey();
}

/**
 * Show the help screen.
 */
async function showHelpScreen(): Promise<void> {
  clearScreen();

  console.log('');
  console.log(`  ${colors.brandBold('Styrby CLI Help')}`);
  console.log('');
  console.log(`  ${colors.muted('Commands:')}`);
  console.log('');
  console.log('    styrby                  Interactive mode (this menu)');
  console.log('    styrby start            Quick start default agent');
  console.log('    styrby start -a claude  Start specific agent');
  console.log('    styrby onboard          Setup wizard');
  console.log('    styrby install claude   Install an AI agent');
  console.log('    styrby install --all    Install all agents');
  console.log('    styrby auth             Authenticate only');
  console.log('    styrby pair             Pair mobile app');
  console.log('    styrby status           Show status');
  console.log('    styrby doctor           Health checks');
  console.log('    styrby costs            Token usage & costs');
  console.log('');
  console.log(`  ${colors.muted('Navigation:')}`);
  console.log('');
  console.log('    ↑/↓ or j/k    Move selection');
  console.log('    Enter         Select option');
  console.log('    Esc or q      Go back / Quit');
  console.log('    Ctrl+C        Exit');
  console.log('');
  console.log(`  ${colors.muted('More info:')} https://styrbyapp.com/docs`);
  console.log('');
  console.log(`  ${colors.muted('Press any key to go back...')}`);

  await waitForKey();
}

/**
 * Show pairing instructions.
 */
async function showPairingScreen(): Promise<void> {
  clearScreen();
  console.log('');
  console.log(`  ${colors.brandBold('Pair Mobile App')}`);
  console.log('');
  console.log(`  To pair your mobile app, run:`);
  console.log(`  ${chalk.cyan('styrby pair')}`);
  console.log('');
  console.log(`  This will display a QR code to scan with the Styrby app.`);
  console.log('');
  console.log(`  ${colors.muted('Press any key to continue...')}`);

  await waitForKey();
}

/**
 * Show the install agents screen.
 *
 * Allows users to install AI coding agents (Claude Code, Codex, Gemini CLI).
 */
async function showInstallAgentsScreen(): Promise<void> {
  // Get all agent statuses
  const statuses = await getAllAgentStatus();
  const notInstalled = Object.values(statuses).filter((a) => !a.installed);

  if (notInstalled.length === 0) {
    clearScreen();
    console.log('');
    console.log(`  ${colors.brandBold('Install Agents')}`);
    console.log('');
    console.log(`  ${colors.success('✓')} All agents are already installed!`);
    console.log('');
    console.log(`  ${colors.muted('Press any key to go back...')}`);
    await waitForKey();
    return;
  }

  // Build options for selection
  const options: MenuOption<AgentType | 'all' | 'back'>[] = [];

  // Add individual agents
  for (const agent of notInstalled) {
    options.push({
      value: agent.agent,
      label: agent.name,
      hint: `(${agent.provider})`,
    });
  }

  // Add "Install all" option if multiple agents
  if (notInstalled.length > 1) {
    options.push({
      value: 'all',
      label: 'Install all',
      hint: `(${notInstalled.length} agents)`,
    });
  }

  options.push({ value: 'back', label: 'Back' });

  clearScreen();
  console.log('');
  console.log(`  ${colors.brandBold('Install Agents')}`);
  console.log('');
  console.log(`  ${colors.muted('Select an agent to install:')}`);
  console.log('');

  const result = await showMenu({
    options,
    clearOnRender: false,
    render: (selectedIndex) => {
      displayMenu(
        options.map((o) => ({ label: o.label, hint: o.hint })),
        selectedIndex
      );
      displayControls([
        ['↑↓', 'Navigate'],
        ['Enter', 'Select'],
        ['Esc', 'Back'],
      ]);
    },
  });

  if (result.cancelled || result.value === 'back') {
    return;
  }

  clearScreen();

  if (result.value === 'all') {
    // Install all agents
    await runBatchInstallWithUI(notInstalled.map((a) => a.agent));
  } else {
    // Install single agent
    await runInstallWithUI(result.value as AgentType);
  }

  console.log(`  ${colors.muted('Press any key to continue...')}`);
  await waitForKey();
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Wait for any key press.
 */
function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.once('data', () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      resolve();
    });
  });
}

// ============================================================================
// Main Interactive Flow
// ============================================================================

/**
 * Run the interactive mode.
 *
 * This is the main entry point when running `styrby` with no arguments.
 */
export async function runInteractive(): Promise<void> {
  // Check authentication state
  if (!isAuthenticated()) {
    // First time user - run onboard
    clearScreen();
    displayFirstTimeWelcome();

    const options: MenuOption<'onboard' | 'help' | 'quit'>[] = [
      { value: 'onboard', label: 'Start setup', hint: '(~60 seconds)' },
      { value: 'help', label: 'Learn more' },
      { value: 'quit', label: 'Quit' },
    ];

    const result = await showMenu({
      options,
      clearOnRender: false,
      render: (selectedIndex) => {
        displayMenu(
          options.map((o) => ({ label: o.label, hint: o.hint })),
          selectedIndex
        );
        displayControls([
          ['↑↓', 'Navigate'],
          ['Enter', 'Select'],
        ]);
      },
    });

    if (result.cancelled || result.value === 'quit') {
      console.log('');
      return;
    }

    if (result.value === 'help') {
      await showHelpScreen();
      return runInteractive(); // Restart
    }

    if (result.value === 'onboard') {
      const { runOnboard } = await import('@/commands/onboard');
      clearScreen();
      await runOnboard();
    }
  }

  // Get user state
  const state = getUserState();

  // Main menu loop
  const projectPath = process.cwd();

  while (true) {
    clearScreen();
    const menuChoice = await showMainMenu(state);

    switch (menuChoice) {
      case 'start': {
        const selection = await showAgentMenu(projectPath);

        if (!selection) {
          continue; // User pressed back
        }

        let { agent, status } = selection;

        if (!status.installed) {
          const installResult = await showAgentNotInstalled(status);

          if (installResult === 'installed') {
            // Re-check status after installation
            const updatedStatuses = await getAllAgentStatus();
            status = updatedStatuses[agent];

            if (!status.installed) {
              // Installation failed
              continue;
            }
            // Fall through to start session
          } else {
            continue;
          }
        }

        if (!status.configured) {
          const setupChoice = await showAgentNeedsSetup(status);

          if (setupChoice === 'back') {
            continue;
          }

          if (setupChoice === 'configure') {
            // Open setup URL and let user configure
            const open = (await import('open')).default;
            await open(status.setupUrl);
            console.log('');
            console.log(`  Opened ${status.provider} setup page in browser.`);
            console.log(`  ${colors.muted('Press any key when ready...')}`);
            await waitForKey();
            continue;
          }

          // 'continue' - start anyway, agent will prompt for login
        }

        // Start the session
        await runAgentSession(status, projectPath, state);
        break;
      }

      case 'install': {
        await showInstallAgentsScreen();
        break;
      }

      case 'costs': {
        await showCostsScreen();
        break;
      }

      case 'pair': {
        await showPairingScreen();
        break;
      }

      case 'help': {
        await showHelpScreen();
        break;
      }

      case 'quit': {
        console.log('');
        return;
      }

      default:
        continue;
    }
  }
}

/**
 * Default export
 */
export default {
  runInteractive,
};
