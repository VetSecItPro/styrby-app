'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRealtimeSubscription } from '@/hooks/useRealtimeSubscription';
import { ConnectionStatus } from '@/components/connection-status';
import { CostTicker } from '@/components/cost-ticker';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Represents a cost record from the database.
 * Used for real-time aggregation of spending data.
 */
interface CostRecord {
  /** Unique cost record identifier */
  id: string;
  /** Which AI agent incurred the cost */
  agent_type: 'claude' | 'codex' | 'gemini';
  /** The model used for this request */
  model: string;
  /** Cost in USD for this record */
  cost_usd: number;
  /** Number of input tokens */
  input_tokens: number;
  /** Number of output tokens */
  output_tokens: number;
  /** When this record was created */
  created_at: string;
  /** The date portion for grouping */
  record_date: string;
}

/**
 * Aggregated totals by agent type.
 */
interface AgentTotals {
  [agent: string]: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Props for the CostsRealtime component.
 */
interface CostsRealtimeProps {
  /**
   * Initial aggregated costs by agent from SSR.
   */
  initialAgentTotals: AgentTotals;

  /**
   * The authenticated user's ID for filtering real-time updates.
   */
  userId: string;

  /**
   * Children to render (the cost summary cards).
   */
  children?: React.ReactNode;
}

/* ──────────────────────────── Component ──────────────────────────── */

/**
 * Client component wrapper that adds real-time cost tracking.
 *
 * WHY: Users want to see their spending update in real-time as they use
 * AI agents. This component subscribes to cost_records inserts and
 * incrementally updates the displayed totals without requiring refresh.
 *
 * Note: This component only handles new cost records (INSERTs). Updates and
 * deletes to cost records are extremely rare and not worth the complexity.
 *
 * @param props - Component props including initial totals and user ID
 * @returns Summary cards with real-time updates and connection indicator
 */
export function CostsRealtime({
  initialAgentTotals,
  userId,
  children,
}: CostsRealtimeProps) {
  const [agentTotals, setAgentTotals] = useState<AgentTotals>(initialAgentTotals);

  /**
   * Handles new cost record insertions by incrementing the appropriate totals.
   *
   * WHY: We only care about INSERTs because cost records are immutable
   * after creation. This keeps the real-time logic simple and efficient.
   */
  const handleInsert = useCallback((newRecord: CostRecord) => {
    const agent = newRecord.agent_type || 'unknown';
    const cost = Number(newRecord.cost_usd) || 0;
    const inputTokens = newRecord.input_tokens || 0;
    const outputTokens = newRecord.output_tokens || 0;

    // Update agent-specific totals (monthly total is computed from this)
    setAgentTotals((prev) => ({
      ...prev,
      [agent]: {
        cost: (prev[agent]?.cost || 0) + cost,
        inputTokens: (prev[agent]?.inputTokens || 0) + inputTokens,
        outputTokens: (prev[agent]?.outputTokens || 0) + outputTokens,
      },
    }));
  }, []);

  const { isConnected } = useRealtimeSubscription<CostRecord>({
    table: 'cost_records',
    filter: `user_id=eq.${userId}`,
    onInsert: handleInsert,
  });

  /**
   * Calculate the current monthly total from agent totals.
   * This ensures consistency even if direct state updates have slight timing issues.
   */
  const currentMonthlyTotal = useMemo(() => {
    return Object.values(agentTotals).reduce((sum, a) => sum + a.cost, 0);
  }, [agentTotals]);

  return (
    <div>
      {/* Connection status */}
      <div className="flex items-center justify-end mb-4">
        <ConnectionStatus isConnected={isConnected} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        {/* Monthly total - with real-time ticker */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <p className="text-sm text-zinc-500 mb-1">Monthly Total</p>
          <CostTicker
            userId={userId}
            initialTotal={currentMonthlyTotal}
            dateFilter={new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()}
            className="text-zinc-100"
          />
        </div>

        {/* Per-agent cards */}
        {(['claude', 'codex', 'gemini'] as const).map((agent) => {
          const data = agentTotals[agent] || { cost: 0, inputTokens: 0, outputTokens: 0 };
          return (
            <div
              key={agent}
              className="rounded-xl bg-zinc-900 border border-zinc-800 p-4"
            >
              <div className="flex items-center gap-2">
                <div
                  className={`h-3 w-3 rounded-full ${
                    agent === 'claude'
                      ? 'bg-orange-500'
                      : agent === 'codex'
                        ? 'bg-green-500'
                        : 'bg-blue-500'
                  }`}
                />
                <p className="text-sm text-zinc-500 capitalize">{agent}</p>
              </div>
              <p className="text-2xl font-bold text-zinc-100 mt-1">
                ${data.cost.toFixed(2)}
              </p>
              <p className="text-xs text-zinc-600 mt-1">
                {((data.inputTokens + data.outputTokens) / 1000).toFixed(1)}K tokens
              </p>
            </div>
          );
        })}
      </div>

      {/* Render any children (e.g., budget alerts, charts) */}
      {children}
    </div>
  );
}
