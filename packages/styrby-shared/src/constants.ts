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
  goose: {
    name: 'Goose',
    id: 'goose',
    description: 'Block/Square open-source AI agent with MCP-native architecture',
    color: '#EAB308', // Yellow
    icon: 'feather',
    provider: 'Block',
  },
  amp: {
    name: 'Amp',
    id: 'amp',
    description: 'Sourcegraph deep-mode coding agent with sub-agent orchestration',
    color: '#0EA5E9', // Sky blue
    icon: 'zap',
    provider: 'Sourcegraph',
  },
  crush: {
    name: 'Crush',
    id: 'crush',
    description: 'Charmbracelet ACP-compatible terminal coding agent',
    color: '#A855F7', // Purple
    icon: 'sparkle',
    provider: 'Charmbracelet',
  },
  kilo: {
    name: 'Kilo',
    id: 'kilo',
    description: 'Community-built coding agent supporting 500+ models with Memory Bank',
    color: '#14B8A6', // Teal
    icon: 'brain',
    provider: 'Kilo',
  },
  kiro: {
    name: 'Kiro',
    id: 'kiro',
    description: 'AWS-backed coding agent with per-prompt credit billing',
    color: '#F59E0B', // Amber
    icon: 'cloud',
    provider: 'AWS',
  },
  droid: {
    name: 'Droid',
    id: 'droid',
    description: 'BYOK multi-backend coding agent powered by LiteLLM',
    color: '#6366F1', // Indigo
    icon: 'bot',
    provider: 'Droid',
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

/**
 * Subscription tier limits — runtime gating table.
 *
 * 2026-04-27 — Tier reconciliation refactor (Phase 5).
 *
 * Canonical tiers are now `free | pro | growth`:
 *   - Free  — non-paid fallback for un-trialed / lapsed users
 *   - Pro   — $39/mo individual paid plan; full single-user feature set
 *   - Growth — $99/mo + $19/seat team plan; adds team features
 *
 * Legacy enum values (`power`, `team`, `business`, `enterprise`) are
 * defensive aliases for any pre-existing `subscriptions.tier` rows that
 * were written under the old naming. Migration 060 ADD VALUEs `growth` to
 * the enum but does NOT drop legacy values — Postgres enums cannot drop
 * values, and any historical row must still resolve to a sensible cap.
 *
 * Legacy → canonical mapping (matches `LEGACY_TIER_ALIASES` in
 * `packages/styrby-web/src/lib/tier-enforcement.ts`):
 *   - power      → pro    (legacy individual paid; same single-user shape)
 *   - team       → growth (legacy team paid)
 *   - business   → growth (legacy team paid; superset capabilities)
 *   - enterprise → growth (legacy team paid; superset capabilities)
 *
 * WHY map `power → pro` here (not `power → growth`): the `power` enum value
 * was previously the "solo user" paid tier — it had no team features.
 * Mapping a historical `power` row to `growth` would silently grant team
 * privileges to a single-user account. Pro is the single-user equivalent in
 * the new model. Note: `tier-enforcement.ts` maps `power → growth` because
 * its `EffectiveTierId` uses the cross-read resolver where the higher-rank
 * tier always wins; mapping there is for the gating-rank semantics, not
 * feature-set equivalence. This file is the feature-set table; we map by
 * feature equivalence.
 *
 * SOC2 CC6.1 (logical access): every legacy tier has an entry so that
 * `TIER_LIMITS[tier]` never returns undefined and crashes the enforcement
 * check. Fail-closed defaults still apply at the resolver layer.
 */
export const TIER_LIMITS = {
  free: {
    maxAgents: 3,
    maxSessionsPerDay: 5,
    costDashboard: 'basic',
    budgetAlerts: false,
    apiAccess: false,
    teamFeatures: false,
  },
  pro: {
    maxAgents: 11,
    maxSessionsPerDay: Infinity,
    costDashboard: 'full',
    budgetAlerts: true,
    apiAccess: true,
    teamFeatures: false,
  },
  growth: {
    maxAgents: 11,
    maxSessionsPerDay: Infinity,
    costDashboard: 'full',
    budgetAlerts: true,
    apiAccess: true,
    teamFeatures: true,
  },
  // ----- Legacy enum aliases (read-only — never written by new code) -----
  // WHY duplicated entries (not a getter): TIER_LIMITS is widely consumed as
  // a literal `as const` object — TypeScript autocomplete and the `keyof`
  // inference both depend on the keys being statically present. A getter
  // would erase the literal types and break the cross-package contract.
  power: {
    maxAgents: 11,
    maxSessionsPerDay: Infinity,
    costDashboard: 'full',
    budgetAlerts: true,
    apiAccess: true,
    teamFeatures: false,
  },
  team: {
    maxAgents: 11,
    maxSessionsPerDay: Infinity,
    costDashboard: 'full',
    budgetAlerts: true,
    apiAccess: true,
    teamFeatures: true,
  },
  business: {
    maxAgents: 11,
    maxSessionsPerDay: Infinity,
    costDashboard: 'full',
    budgetAlerts: true,
    apiAccess: true,
    teamFeatures: true,
  },
  enterprise: {
    maxAgents: 11,
    maxSessionsPerDay: Infinity,
    costDashboard: 'full',
    budgetAlerts: true,
    apiAccess: true,
    teamFeatures: true,
  },
} as const;
