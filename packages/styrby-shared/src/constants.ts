/**
 * Shared constants for Styrby
 */

/** Agent display names and colors */
export const AGENT_CONFIG = {
  claude: {
    name: 'Claude Code',
    color: '#F97316', // Orange
    provider: 'Anthropic',
  },
  codex: {
    name: 'Codex',
    color: '#22C55E', // Green
    provider: 'OpenAI',
  },
  gemini: {
    name: 'Gemini CLI',
    color: '#3B82F6', // Blue
    provider: 'Google',
  },
} as const;

/** Error source colors for UI */
export const ERROR_COLORS = {
  styrby: '#F97316',     // Orange
  agent: '#EF4444',      // Red
  api: '#EF4444',        // Red
  network: '#EAB308',    // Yellow
  build: '#3B82F6',      // Blue
  permission: '#A855F7', // Purple
} as const;

/** WebSocket heartbeat configuration */
export const HEARTBEAT_CONFIG = {
  intervalMs: 15000,      // 15 seconds
  timeoutMs: 45000,       // 45 seconds
  maxReconnectDelayMs: 30000, // 30 seconds max backoff
} as const;

/** Subscription tier limits */
export const TIER_LIMITS = {
  free: {
    maxAgents: 1,
    maxSessionsPerDay: 5,
    costDashboard: 'basic',
    budgetAlerts: false,
  },
  pro: {
    maxAgents: 3,
    maxSessionsPerDay: Infinity,
    costDashboard: 'full',
    budgetAlerts: true,
  },
  power: {
    maxAgents: 3,
    maxSessionsPerDay: Infinity,
    costDashboard: 'full',
    budgetAlerts: true,
    apiAccess: true,
  },
  team: {
    maxAgents: 3,
    maxSessionsPerDay: Infinity,
    costDashboard: 'full',
    budgetAlerts: true,
    apiAccess: true,
    teamFeatures: true,
  },
} as const;
