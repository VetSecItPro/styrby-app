/**
 * Agent Configuration — Pure Helpers
 *
 * Pure conversion functions between the local UI form state shape and the
 * Supabase `agent_configs` table row shape, plus a dirty-state checker.
 *
 * WHY: Kept side-effect free so they can be unit-tested in isolation and
 * reused by the orchestrator hook without coupling to Supabase or React.
 */

import type { AgentConfigState } from '@/types/agent-config';
import {
  APPROVE_PATTERN_FILE_READ,
  APPROVE_PATTERN_FILE_WRITE,
  APPROVE_PATTERN_TERMINAL,
  APPROVE_PATTERN_WEB,
} from './constants';

/**
 * Converts the Supabase `auto_approve_patterns` TEXT[] array into individual
 * boolean toggle values for the UI.
 *
 * @param patterns - The auto_approve_patterns array from the database row
 * @returns Object with boolean flags for each auto-approve category
 */
export function patternsToToggles(patterns: string[]): {
  autoApproveReads: boolean;
  autoApproveWrites: boolean;
  autoApproveCommands: boolean;
  autoApproveWeb: boolean;
} {
  return {
    autoApproveReads: patterns.includes(APPROVE_PATTERN_FILE_READ),
    autoApproveWrites: patterns.includes(APPROVE_PATTERN_FILE_WRITE),
    autoApproveCommands: patterns.includes(APPROVE_PATTERN_TERMINAL),
    autoApproveWeb: patterns.includes(APPROVE_PATTERN_WEB),
  };
}

/**
 * Converts the UI's boolean toggles back into the TEXT[] array format
 * expected by the Supabase `auto_approve_patterns` column.
 *
 * @param config - The local form state
 * @returns Array of pattern strings for the database
 */
export function togglesToPatterns(config: AgentConfigState): string[] {
  const patterns: string[] = [];
  if (config.autoApproveReads) patterns.push(APPROVE_PATTERN_FILE_READ);
  if (config.autoApproveWrites) patterns.push(APPROVE_PATTERN_FILE_WRITE);
  if (config.autoApproveCommands) patterns.push(APPROVE_PATTERN_TERMINAL);
  if (config.autoApproveWeb) patterns.push(APPROVE_PATTERN_WEB);
  return patterns;
}

/**
 * Checks whether the current config state differs from the last-saved state.
 *
 * @param current - The current form state
 * @param saved - The last saved or loaded state
 * @returns True if there are unsaved changes
 */
export function hasChanges(current: AgentConfigState, saved: AgentConfigState): boolean {
  return (
    current.model !== saved.model ||
    current.autoApproveReads !== saved.autoApproveReads ||
    current.autoApproveWrites !== saved.autoApproveWrites ||
    current.autoApproveCommands !== saved.autoApproveCommands ||
    current.autoApproveWeb !== saved.autoApproveWeb ||
    current.maxCostPerSession !== saved.maxCostPerSession ||
    current.customSystemPrompt !== saved.customSystemPrompt ||
    JSON.stringify(current.blockedTools) !== JSON.stringify(saved.blockedTools)
  );
}
