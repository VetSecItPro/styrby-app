/**
 * Agent Configuration — Supabase IO
 *
 * Thin wrappers over the `agent_configs` table: load by (user, agent),
 * insert a new row, and update an existing row by id. All return Supabase's
 * raw result so the caller can decide how to surface errors.
 *
 * WHY: Pulled out of the hook so the hook stays under the 400 LOC budget and
 * so these queries can be unit-tested against a mocked supabase client without
 * spinning up a React renderer.
 */

import { supabase } from '@/lib/supabase';
import type { AgentConfigState, AgentType } from '@/types/agent-config';
import { patternsToToggles, togglesToPatterns } from './utils';

/**
 * Database row shape returned by {@link fetchAgentConfig}.
 *
 * WHY: Mirrors the explicit `select(...)` column list one-to-one to keep the
 * mapping logic in {@link mapRowToState} type-safe.
 */
export interface AgentConfigRow {
  /** Primary key */
  id: string;
  /** Which agent this row configures */
  agent_type: string;
  /** Default model selection */
  default_model: string | null;
  /** Convenience boolean kept in sync with the patterns array */
  auto_approve_low_risk: boolean | null;
  /** Auto-approve pattern tokens */
  auto_approve_patterns: string[] | null;
  /** Tools the agent must never invoke */
  blocked_tools: string[] | null;
  /** Per-session spend cap in USD (null = unlimited) */
  max_cost_per_session_usd: number | null;
  /** User-supplied additional system prompt text */
  custom_system_prompt: string | null;
}

/** Columns selected when reading an existing config row. */
const SELECT_COLUMNS =
  'id, agent_type, default_model, auto_approve_low_risk, auto_approve_patterns, blocked_tools, max_cost_per_session_usd, custom_system_prompt';

/**
 * Reads the agent_configs row for a given user+agent, if any.
 *
 * @param userId - Authenticated Supabase user id.
 * @param agentType - Validated agent identifier.
 * @returns Supabase response (data may be null when no row exists).
 */
export async function fetchAgentConfig(userId: string, agentType: AgentType) {
  return supabase
    .from('agent_configs')
    .select(SELECT_COLUMNS)
    .eq('user_id', userId)
    .eq('agent_type', agentType)
    .single();
}

/**
 * Inserts a new agent_configs row.
 *
 * @param row - Fully populated row payload.
 * @returns Supabase response with the inserted id.
 */
export async function insertAgentConfig(row: BuildRowInput) {
  return supabase.from('agent_configs').insert(row).select('id').single();
}

/**
 * Updates an existing agent_configs row by primary key.
 *
 * @param configId - Existing row id.
 * @param row - Full row payload to write.
 * @returns Supabase response.
 */
export async function updateAgentConfig(configId: string, row: BuildRowInput) {
  return supabase.from('agent_configs').update(row).eq('id', configId);
}

/**
 * The row payload sent to insert/update. Centralized here so the hook
 * doesn't redefine the shape inline.
 */
export interface BuildRowInput {
  user_id: string;
  agent_type: AgentType;
  default_model: string;
  auto_approve_low_risk: boolean;
  auto_approve_patterns: string[];
  blocked_tools: string[];
  max_cost_per_session_usd: number | null;
  custom_system_prompt: string | null;
}

/**
 * Converts a UI form state into the row shape expected by Supabase.
 *
 * WHY: Centralizing this mapping (and the auto_approve_low_risk derivation)
 * keeps insert and update paths from drifting apart.
 *
 * @param userId - Authenticated user id.
 * @param agentType - Active agent.
 * @param config - Current form state.
 * @returns Row payload for insert/update.
 */
export function buildRow(
  userId: string,
  agentType: AgentType,
  config: AgentConfigState,
): BuildRowInput {
  /**
   * WHY: We set auto_approve_low_risk to true if either file_read or
   * web_search is enabled, since these are the "low risk" categories.
   * This keeps the boolean column in sync with the patterns array for
   * backward compatibility with any code that checks the boolean.
   */
  const autoApproveLowRisk = config.autoApproveReads || config.autoApproveWeb;

  return {
    user_id: userId,
    agent_type: agentType,
    default_model: config.model,
    auto_approve_low_risk: autoApproveLowRisk,
    auto_approve_patterns: togglesToPatterns(config),
    blocked_tools: config.blockedTools,
    max_cost_per_session_usd: config.maxCostPerSession
      ? parseFloat(config.maxCostPerSession)
      : null,
    custom_system_prompt: config.customSystemPrompt || null,
  };
}

/**
 * Maps a database row into the UI form state.
 *
 * @param row - Raw Supabase row.
 * @param fallbackModel - Default model id to use when the column is null.
 * @returns Form state populated from the row.
 */
export function mapRowToState(row: AgentConfigRow, fallbackModel: string): AgentConfigState {
  const patterns = (row.auto_approve_patterns as string[]) ?? [];
  const toggles = patternsToToggles(patterns);

  return {
    model: row.default_model ?? fallbackModel,
    autoApproveReads: toggles.autoApproveReads,
    autoApproveWrites: toggles.autoApproveWrites,
    autoApproveCommands: toggles.autoApproveCommands,
    autoApproveWeb: toggles.autoApproveWeb,
    blockedTools: (row.blocked_tools as string[]) ?? [],
    maxCostPerSession: row.max_cost_per_session_usd
      ? String(row.max_cost_per_session_usd)
      : '',
    customSystemPrompt: row.custom_system_prompt ?? '',
  };
}
