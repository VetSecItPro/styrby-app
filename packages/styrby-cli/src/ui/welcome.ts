/**
 * Welcome Screen
 *
 * Displays the branded welcome screen with status information.
 * Adapts display based on authentication and pairing state.
 *
 * @module ui/welcome
 */

import chalk from 'chalk';
import { VERSION } from '@/index';
import { isAuthenticated, loadConfig } from '@/configuration';
import { loadPersistedData } from '@/persistence';

// ============================================================================
// Types
// ============================================================================

/**
 * User state for display
 */
export interface UserState {
  isAuthenticated: boolean;
  userId?: string;
  userEmail?: string;
  machineName?: string;
  machineId?: string;
  isPaired: boolean;
  pairedAt?: string;
}

/**
 * Agent availability info
 */
export interface AgentInfo {
  id: 'claude' | 'codex' | 'gemini';
  name: string;
  provider: string;
  installed: boolean;
  todayCost?: number;
}

// ============================================================================
// Colors & Styling
// ============================================================================

/**
 * Styrby brand colors
 */
export const colors = {
  // Primary brand - cyan/teal gradient feel
  brand: chalk.cyan,
  brandBold: chalk.bold.cyan,

  // Accent bar
  accent: chalk.cyan('┃'),

  // Status colors
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  muted: chalk.gray,

  // Agent colors
  claude: chalk.hex('#F97316'),  // Orange
  codex: chalk.hex('#22C55E'),   // Green
  gemini: chalk.hex('#3B82F6'),  // Blue
};

// ============================================================================
// Display Functions
// ============================================================================

/**
 * Get the current user state.
 *
 * @returns User state object
 */
export function getUserState(): UserState {
  const config = loadConfig();
  const data = loadPersistedData();

  return {
    isAuthenticated: isAuthenticated(),
    userId: config.userId || data?.userId,
    userEmail: data?.userId, // We store email in userId field after auth
    machineName: data?.machineName,
    machineId: config.machineId || data?.machineId,
    isPaired: !!data?.pairedAt,
    pairedAt: data?.pairedAt,
  };
}

/**
 * Display the branded header.
 */
export function displayHeader(): void {
  console.log('');
  console.log(`  ${colors.accent} ${colors.brandBold('Styrby')} ${colors.muted(`v${VERSION}`)}`);
  console.log(`  ${colors.accent} ${colors.muted('Mobile remote for AI coding agents')}`);
  console.log('');
}

/**
 * Display the status bar showing auth/machine/mobile status.
 *
 * @param state - User state
 */
export function displayStatusBar(state: UserState): void {
  const parts: string[] = [];

  if (state.isAuthenticated) {
    // Show email or user ID
    const userDisplay = state.userEmail || state.userId?.slice(0, 8) + '...';
    parts.push(userDisplay || 'Authenticated');

    // Show machine name
    if (state.machineName) {
      parts.push(state.machineName);
    }

    // Show mobile status
    if (state.isPaired) {
      parts.push(colors.success('Mobile ✓'));
    } else {
      parts.push(colors.warning('Mobile ○'));
    }

    console.log(`  ${parts.join(colors.muted(' • '))}`);
  } else {
    console.log(`  ${colors.muted('Not signed in')}`);
  }

  console.log('');
}

/**
 * Display a welcome message for first-time users.
 */
export function displayFirstTimeWelcome(): void {
  displayHeader();

  console.log(`  ${colors.muted('Welcome! Let\'s get you set up in under 60 seconds.')}`);
  console.log('');
}

/**
 * Display the full welcome screen for returning users.
 *
 * @param state - User state
 */
export function displayWelcome(state?: UserState): void {
  const userState = state || getUserState();

  displayHeader();
  displayStatusBar(userState);
}

/**
 * Display agent selection list.
 *
 * @param agents - List of agents with their status
 * @param selectedIndex - Currently selected index (for highlighting)
 * @param projectPath - Current project path
 */
export function displayAgentList(
  agents: AgentInfo[],
  selectedIndex: number = 0,
  projectPath?: string
): void {
  console.log(`  ${colors.muted('Select an agent:')}`);
  console.log('');

  agents.forEach((agent, index) => {
    const isSelected = index === selectedIndex;
    const prefix = isSelected ? colors.brand('›') : ' ';

    // Agent name with provider color
    const agentColor = colors[agent.id as keyof typeof colors] || chalk.white;
    const name = (agentColor as typeof chalk)(agent.name.padEnd(14));

    // Provider
    const provider = colors.muted(agent.provider.padEnd(12));

    // Status
    const status = agent.installed
      ? colors.success('✓ ready'.padEnd(12))
      : colors.muted('○ install'.padEnd(12));

    // Cost (if available and installed)
    const cost = agent.installed && agent.todayCost !== undefined
      ? colors.muted(`$${agent.todayCost.toFixed(2)} today`)
      : '';

    console.log(`  ${prefix} ${name} ${provider} ${status} ${cost}`);
  });

  console.log('');

  if (projectPath) {
    // Shorten path for display
    const shortPath = projectPath.replace(process.env.HOME || '', '~');
    console.log(`  ${colors.muted('Project:')} ${shortPath}`);
    console.log('');
  }
}

/**
 * Display session header while a session is active.
 *
 * @param agentName - Name of the active agent
 * @param projectPath - Project path
 */
export function displaySessionHeader(agentName: string, projectPath: string): void {
  const shortPath = projectPath.replace(process.env.HOME || '', '~');

  console.log('');
  console.log(`  ${colors.accent} ${colors.brandBold(agentName)} ${colors.muted('•')} ${shortPath}`);
  console.log(`  ${colors.accent} ${colors.success('Session active')}`);
  console.log('');
}

/**
 * Display the waiting for mobile input box.
 */
export function displayWaitingForMobile(): void {
  const boxWidth = 55;
  const topBorder = '╭' + '─'.repeat(boxWidth) + '╮';
  const bottomBorder = '╰' + '─'.repeat(boxWidth) + '╯';
  const emptyLine = '│' + ' '.repeat(boxWidth) + '│';

  const centerText = (text: string, width: number): string => {
    const visibleLength = text.replace(/\x1B\[[0-9;]*m/g, '').length;
    const padding = Math.max(0, width - visibleLength);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return '│' + ' '.repeat(leftPad) + text + ' '.repeat(rightPad) + '│';
  };

  console.log(`  ${colors.muted(topBorder)}`);
  console.log(`  ${colors.muted(emptyLine)}`);
  console.log(`  ${colors.muted(centerText('Waiting for input from Styrby mobile app...', boxWidth))}`);
  console.log(`  ${colors.muted(emptyLine)}`);
  console.log(`  ${colors.muted(centerText('Open the app on your phone to start chatting.', boxWidth))}`);
  console.log(`  ${colors.muted(emptyLine)}`);
  console.log(`  ${colors.muted(bottomBorder)}`);
  console.log('');
}

/**
 * Display session statistics.
 *
 * @param stats - Session statistics
 */
export function displaySessionStats(stats: {
  mobileConnected: boolean;
  mobileDevice?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): void {
  // Mobile status
  const mobileStatus = stats.mobileConnected
    ? colors.success(`✓ ${stats.mobileDevice || 'Connected'}`)
    : colors.warning('○ Waiting for connection');
  console.log(`  ${colors.muted('Mobile:')} ${mobileStatus}`);

  // Token counts
  const formatTokens = (n: number): string => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };
  console.log(`  ${colors.muted('Tokens:')} ${formatTokens(stats.inputTokens)} in / ${formatTokens(stats.outputTokens)} out`);

  // Cost
  console.log(`  ${colors.muted('Cost:')} $${stats.costUsd.toFixed(4)}`);
  console.log('');

  // Controls hint
  console.log(`  ${colors.muted('[Ctrl+C] End session')}`);
  console.log('');
}

/**
 * Display a menu with options.
 *
 * @param options - Menu options
 * @param selectedIndex - Currently selected index
 */
export function displayMenu(
  options: Array<{ label: string; hint?: string; disabled?: boolean }>,
  selectedIndex: number = 0
): void {
  options.forEach((option, index) => {
    const isSelected = index === selectedIndex;
    const prefix = isSelected ? colors.brand('›') : ' ';

    let label = option.label;
    if (option.disabled) {
      label = colors.muted(label);
    } else if (isSelected) {
      label = chalk.white(label);
    }

    const hint = option.hint ? colors.muted(` ${option.hint}`) : '';

    console.log(`  ${prefix} ${label}${hint}`);
  });

  console.log('');
}

/**
 * Display keyboard controls hint.
 *
 * @param controls - Array of [key, action] pairs
 */
export function displayControls(controls: Array<[string, string]>): void {
  const formatted = controls
    .map(([key, action]) => `${colors.muted('[')}${key}${colors.muted(']')} ${colors.muted(action)}`)
    .join('  ');

  console.log(`  ${formatted}`);
  console.log('');
}

/**
 * Clear the screen and move cursor to top.
 */
export function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[0f');
}

/**
 * Default export for module
 */
export default {
  getUserState,
  displayHeader,
  displayStatusBar,
  displayFirstTimeWelcome,
  displayWelcome,
  displayAgentList,
  displaySessionHeader,
  displayWaitingForMobile,
  displaySessionStats,
  displayMenu,
  displayControls,
  clearScreen,
  colors,
};
