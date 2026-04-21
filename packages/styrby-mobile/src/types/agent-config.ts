/**
 * Agent Configuration — Domain Types
 *
 * Shared type definitions for the Agent Configuration screen and its
 * sub-components. Mirrors the shape of the Supabase `agent_configs` row
 * with UI-friendly field names.
 *
 * WHY: Hoisted out of `app/agent-config.tsx` during the orchestrator refactor
 * so every sub-component (ToggleRow, ModelSection, BlockedToolsSection, etc.)
 * imports from one stable location instead of from a screen file.
 */

import type { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';

/**
 * Metadata for each agent type: display name, brand color, Ionicons icon name,
 * and the list of models available for selection.
 */
export interface AgentMeta {
  /** Human-readable label for the agent */
  displayName: string;
  /** Brand hex color used for the header icon and accents */
  color: string;
  /** Ionicons icon name */
  icon: keyof typeof Ionicons.glyphMap;
  /** Available model identifiers the user can choose from */
  models: string[];
}

/**
 * Represents the local form state for an agent config.
 * Mapped from the Supabase `agent_configs` row but with UI-friendly field names.
 */
export interface AgentConfigState {
  /** Selected model string from the agent's model list */
  model: string;
  /** Auto-approve file reads (low risk) — stored in auto_approve_patterns as 'file_read' */
  autoApproveReads: boolean;
  /** Auto-approve file writes (medium risk) — stored as 'file_write' */
  autoApproveWrites: boolean;
  /** Auto-approve terminal commands (high risk) — stored as 'terminal_command' */
  autoApproveCommands: boolean;
  /** Auto-approve web searches (low risk) — stored as 'web_search' */
  autoApproveWeb: boolean;
  /** Tool names the agent is never allowed to use */
  blockedTools: string[];
  /** Maximum cost in USD before the agent pauses; null means unlimited */
  maxCostPerSession: string;
  /** Additional system prompt text appended to agent instructions */
  customSystemPrompt: string;
}

/**
 * Risk level metadata for the auto-approve toggles.
 * Displayed as colored badges next to each toggle.
 */
export interface RiskBadge {
  /** Risk level label */
  label: string;
  /** Badge text color */
  textColor: string;
  /** Badge background color (with opacity) */
  bgColor: string;
}

export type { AgentType };
