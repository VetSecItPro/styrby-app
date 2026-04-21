/**
 * Agent Configuration — Constants
 *
 * Static metadata, defaults, and pattern tokens used across the Agent
 * Configuration screen and its sub-components.
 *
 * WHY: Defined separately from the orchestrator so sub-components can import
 * just the constants they need without pulling the entire screen file.
 */

import type { AgentConfigState, AgentMeta, AgentType, RiskBadge } from '@/types/agent-config';

/**
 * All supported agent identifiers, in display order.
 * Drives both AGENT_META lookups and the route-param validation guard in the orchestrator.
 *
 * WHY: Defined as a const array so we can use `.includes()` for runtime
 * validation of the untrusted `agent` URL param without duplicating the union.
 */
export const ALL_AGENT_IDS: AgentType[] = [
  'claude', 'codex', 'gemini', 'opencode', 'aider',
  'goose', 'amp', 'crush', 'kilo', 'kiro', 'droid',
];

/**
 * WHY: We define agent metadata statically because the list of supported agents
 * and their models is fixed at build time. This avoids a network round-trip and
 * ensures the UI renders immediately while the config loads from Supabase.
 *
 * Model lists reflect each agent's current default/supported models as of the
 * Styrby 1.0 launch. Update when providers release new models.
 */
export const AGENT_META: Record<AgentType, AgentMeta> = {
  claude: {
    displayName: 'Claude Code',
    color: '#f97316',
    icon: 'terminal',
    models: ['claude-sonnet-4', 'claude-opus-4', 'claude-haiku-3.5'],
  },
  codex: {
    displayName: 'Codex',
    color: '#22c55e',
    icon: 'terminal',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  },
  gemini: {
    displayName: 'Gemini CLI',
    color: '#3b82f6',
    icon: 'terminal',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  opencode: {
    displayName: 'OpenCode',
    color: '#8b5cf6',
    icon: 'code-working',
    models: ['gpt-4o', 'claude-sonnet-4', 'gemini-2.5-pro'],
  },
  aider: {
    displayName: 'Aider',
    color: '#ec4899',
    icon: 'people',
    // WHY: Aider supports any OpenAI-compatible or Anthropic model via --model flag.
    // We list the most commonly-used defaults to cover 90% of user setups.
    models: ['claude-sonnet-4', 'gpt-4o', 'gemini-2.5-pro'],
  },
  goose: {
    displayName: 'Goose',
    color: '#14b8a6',
    icon: 'git-network',
    models: ['claude-sonnet-4', 'gpt-4o', 'gemini-2.5-pro'],
  },
  amp: {
    displayName: 'Amp',
    color: '#f59e0b',
    icon: 'layers',
    models: ['claude-sonnet-4', 'claude-opus-4', 'gpt-4o'],
  },
  crush: {
    displayName: 'Crush',
    color: '#f43f5e',
    icon: 'terminal',
    // WHY: Crush is Charmbracelet's ACP-compatible CLI agent — supports the same
    // Anthropic model IDs as Claude Code since it routes through the Anthropic API.
    models: ['claude-sonnet-4', 'claude-opus-4', 'claude-haiku-3.5'],
  },
  kilo: {
    displayName: 'Kilo',
    color: '#0ea5e9',
    icon: 'server',
    // WHY: Kilo supports 500+ models. We list the most popular defaults; users
    // can type a custom model ID if their preferred model isn't listed.
    models: ['claude-sonnet-4', 'gpt-4o', 'gemini-2.5-pro', 'o3-mini'],
  },
  kiro: {
    displayName: 'Kiro',
    color: '#f97316',
    icon: 'cloud',
    // WHY: Kiro is an AWS-backed agent using per-prompt credits. Model choice
    // affects credit cost, so we list all available tiers.
    models: ['claude-sonnet-4', 'claude-haiku-3.5'],
  },
  droid: {
    displayName: 'Droid',
    color: '#64748b',
    icon: 'swap-horizontal',
    // WHY: Droid is a BYOK (bring-your-own-key) multi-backend agent. The models
    // listed are common starting points; the user configures their actual backend
    // in Droid's own settings.
    models: ['gpt-4o', 'claude-sonnet-4', 'gemini-2.5-pro', 'gpt-4o-mini'],
  },
};

/**
 * Default config values used when no existing config row is found in Supabase.
 *
 * WHY: Defaults are conservative — all auto-approve toggles are off and no cost
 * limit is set. This ensures new users don't accidentally grant broad permissions
 * to agents before understanding what each toggle does.
 */
export const DEFAULT_CONFIG: AgentConfigState = {
  model: '',
  autoApproveReads: false,
  autoApproveWrites: false,
  autoApproveCommands: false,
  autoApproveWeb: false,
  blockedTools: [],
  maxCostPerSession: '',
  customSystemPrompt: '',
};

/**
 * Auto-approve pattern tokens stored in the `auto_approve_patterns` TEXT[] column.
 * Each toggle maps to one of these tokens.
 */
export const APPROVE_PATTERN_FILE_READ = 'file_read';
export const APPROVE_PATTERN_FILE_WRITE = 'file_write';
export const APPROVE_PATTERN_TERMINAL = 'terminal_command';
export const APPROVE_PATTERN_WEB = 'web_search';

/** Low-risk badge styling (file reads, web searches). */
export const RISK_LOW: RiskBadge = {
  label: 'Low',
  textColor: '#22c55e',
  bgColor: 'rgba(34, 197, 94, 0.15)',
};

/** Medium-risk badge styling (file writes). */
export const RISK_MEDIUM: RiskBadge = {
  label: 'Medium',
  textColor: '#eab308',
  bgColor: 'rgba(234, 179, 8, 0.15)',
};

/** High-risk badge styling (terminal commands). */
export const RISK_HIGH: RiskBadge = {
  label: 'High',
  textColor: '#ef4444',
  bgColor: 'rgba(239, 68, 68, 0.15)',
};
