/**
 * useSessionCosts — fetches sessions with per-session cost for the Costs screen.
 *
 * Returns the 20 most-recent sessions (scoped to the current user via RLS)
 * with cost, agent, billing-model, and token breakdown. Used to populate the
 * "RECENT SESSIONS" section of the mobile Costs tab.
 *
 * WHY a separate hook: The useSessions hook is designed for the Sessions tab
 * (filtering, infinite scroll, bookmark state). useSessionCosts is a lean,
 * read-only query that only needs cost-relevant columns for the Costs tab.
 * Coupling them would force the Costs tab to load bookmark state and filter
 * options it does not use.
 *
 * @module hooks/useSessionCosts
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { getAgentHexColor, getAgentDisplayName } from './useCosts';
import type { SessionCostData } from '../components/costs/SessionCostRow';
import type { AgentType, BillingModel } from 'styrby-shared';

// ============================================================================
// Return type
// ============================================================================

/**
 * Return value of {@link useSessionCosts}.
 */
export interface UseSessionCostsReturn {
  /** List of recent sessions sorted by start time descending. */
  sessions: SessionCostData[];
  /** True while the initial fetch is in progress. */
  isLoading: boolean;
  /** Error message, or null if no error. */
  error: string | null;
  /** Trigger a manual refresh. */
  refresh: () => void;
}

// ============================================================================
// Hook
// ============================================================================

/** Maximum number of sessions to return. */
const LIMIT = 20;

/**
 * Returns up to 20 recent sessions with per-session cost data.
 *
 * @returns {@link UseSessionCostsReturn}
 *
 * @example
 * const { sessions, isLoading } = useSessionCosts();
 */
export function useSessionCosts(): UseSessionCostsReturn {
  const [sessions, setSessions] = useState<SessionCostData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { data, error: queryError } = await supabase
        .from('sessions')
        .select(
          'id, title, agent_type, total_cost_usd, billing_model, started_at, total_input_tokens, total_output_tokens, cache_read_tokens'
        )
        .order('started_at', { ascending: false })
        .limit(LIMIT);

      if (queryError) throw new Error(queryError.message);

      const mapped: SessionCostData[] = (data ?? []).map((row) => {
        const agentType = (row.agent_type || 'claude') as AgentType;
        const billingModel = (row.billing_model || 'api-key') as BillingModel;

        return {
          id: row.id as string,
          title: row.title as string | null,
          agentType,
          agentLabel: getAgentDisplayName(agentType),
          agentColor: getAgentHexColor(agentType),
          totalCostUsd: Number(row.total_cost_usd) || 0,
          billingModel,
          startedAt: row.started_at as string,
          inputTokens: Number(row.total_input_tokens) || 0,
          outputTokens: Number(row.total_output_tokens) || 0,
          cacheReadTokens: Number(row.cache_read_tokens) || 0,
        };
      });

      setSessions(mapped);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load session costs';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  return { sessions, isLoading, error, refresh: fetchSessions };
}
