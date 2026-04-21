/**
 * Chat Agent Configuration
 *
 * Static configuration shared across the chat screen and its sub-components:
 * the visual style for each supported agent, the list of agents shown in
 * the in-chat picker, and the placeholder used for undecryptable messages.
 *
 * WHY a dedicated module: These constants are referenced by the orchestrator,
 * the agent picker, and the message-loading helpers. Co-locating them here
 * keeps `chat.tsx` focused on lifecycle/state and prevents accidental drift
 * between the picker and the resume-session UI.
 */

import type { AgentType } from 'styrby-shared';

/**
 * Visual configuration for each supported agent type.
 *
 * @remarks
 * Color values must align with `AgentSelector.tsx` so both picker surfaces
 * stay in sync. Goose uses #14b8a6 (teal-500) — previously #06b6d4 was
 * an inconsistency.
 */
export const AGENT_CONFIG: Record<AgentType, { name: string; color: string; bgColor: string }> = {
  claude: { name: 'Claude', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.1)' },
  codex: { name: 'Codex', color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.1)' },
  gemini: { name: 'Gemini', color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.1)' },
  opencode: { name: 'OpenCode', color: '#8b5cf6', bgColor: 'rgba(139, 92, 246, 0.1)' },
  aider: { name: 'Aider', color: '#ec4899', bgColor: 'rgba(236, 72, 153, 0.1)' },
  // WHY goose/amp/crush/kilo/kiro/droid: AgentType was extended in styrby-shared to include these agents.
  goose: { name: 'Goose', color: '#14b8a6', bgColor: 'rgba(20, 184, 166, 0.1)' },
  amp: { name: 'Amp', color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.1)' },
  crush: { name: 'Crush', color: '#f43f5e', bgColor: 'rgba(244, 63, 94, 0.1)' },
  kilo: { name: 'Kilo', color: '#0ea5e9', bgColor: 'rgba(14, 165, 233, 0.1)' },
  kiro: { name: 'Kiro', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.1)' },
  droid: { name: 'Droid', color: '#64748b', bgColor: 'rgba(100, 116, 139, 0.1)' },
};

/**
 * All agents available for selection in the chat header picker.
 *
 * WHY: All 11 AgentType values are now fully supported by the CLI relay.
 * The list matches `AgentSelector.tsx`'s `ALL_AGENTS` constant so both
 * picker surfaces stay in sync.
 */
export const SELECTABLE_AGENTS: AgentType[] = [
  'claude', 'codex', 'gemini', 'opencode', 'aider',
  'goose', 'amp', 'crush', 'kilo', 'kiro', 'droid',
];

/**
 * Placeholder shown when a message cannot be decrypted.
 *
 * WHY: Graceful degradation — the user sees that a message exists but
 * cannot be read, rather than a crash or empty bubble. This can happen
 * if keys were rotated, the keypair was regenerated, or the message was
 * encrypted with a different device's key.
 */
export const DECRYPTION_FAILED_PLACEHOLDER = '[Unable to decrypt]';

/**
 * Development-only logger that suppresses output in production.
 *
 * WHY: Prevents session and message data from appearing in production logs.
 */
export const chatLogger = {
  log: (...args: unknown[]) => { if (__DEV__) console.log('[Chat]', ...args); },
  error: (...args: unknown[]) => { if (__DEV__) console.error('[Chat]', ...args); },
};
