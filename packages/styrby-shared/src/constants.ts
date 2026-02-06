/**
 * Shared constants for Styrby
 */

/**
 * Agent display names, colors, icons, and metadata.
 *
 * Each agent entry includes:
 * - name: Human-readable display name
 * - id: Agent identifier (matches AgentId type)
 * - description: Brief description of the agent
 * - color: Hex color for UI theming (badges, borders, etc.)
 * - icon: Icon name for UI (use with icon library like Lucide)
 * - provider: Company or project providing the agent
 */
export const AGENT_CONFIG = {
  claude: {
    name: 'Claude Code',
    id: 'claude',
    description: 'AI coding assistant by Anthropic with deep code understanding',
    color: '#F97316', // Orange
    icon: 'sparkles',
    provider: 'Anthropic',
  },
  codex: {
    name: 'Codex',
    id: 'codex',
    description: 'OpenAI Codex for code generation and understanding',
    color: '#22C55E', // Green
    icon: 'code',
    provider: 'OpenAI',
  },
  gemini: {
    name: 'Gemini CLI',
    id: 'gemini',
    description: 'Google Gemini for multimodal AI coding assistance',
    color: '#3B82F6', // Blue
    icon: 'gem',
    provider: 'Google',
  },
  opencode: {
    name: 'OpenCode',
    id: 'opencode',
    description: 'Terminal-based AI coding assistant with JSON output and session persistence',
    color: '#8B5CF6', // Violet
    icon: 'terminal',
    provider: 'Open Source',
  },
  aider: {
    name: 'Aider',
    id: 'aider',
    description: 'AI pair programming in your terminal - works with multiple LLM providers',
    color: '#EC4899', // Pink
    icon: 'users',
    provider: 'Open Source',
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
