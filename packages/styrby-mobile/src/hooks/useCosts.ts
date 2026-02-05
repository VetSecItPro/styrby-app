/**
 * Cost Data Hook
 *
 * Fetches and manages cost data from Supabase for the mobile cost dashboard.
 * Handles loading states, error handling, and pull-to-refresh functionality.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { AgentType } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Cost summary for a time period (today, week, month).
 */
export interface CostSummary {
  /** Total cost in USD */
  totalCost: number;
  /** Total input tokens */
  inputTokens: number;
  /** Total output tokens */
  outputTokens: number;
  /** Number of requests/records */
  requestCount: number;
}

/**
 * Cost breakdown by agent with percentage of total.
 */
export interface AgentCostBreakdown {
  /** Agent type identifier */
  agent: AgentType;
  /** Total cost in USD for this agent */
  cost: number;
  /** Input tokens for this agent */
  inputTokens: number;
  /** Output tokens for this agent */
  outputTokens: number;
  /** Number of requests */
  requestCount: number;
  /** Percentage of total cost (0-100) */
  percentage: number;
}

/**
 * Daily cost data point for the mini chart.
 */
export interface DailyCostDataPoint {
  /** Date string (YYYY-MM-DD) */
  date: string;
  /** Total cost for the day */
  total: number;
  /** Cost breakdown by agent */
  claude: number;
  codex: number;
  gemini: number;
  opencode: number;
}

/**
 * Complete cost data for the dashboard.
 */
export interface CostData {
  /** Cost summary for today */
  today: CostSummary;
  /** Cost summary for last 7 days */
  week: CostSummary;
  /** Cost summary for last 30 days */
  month: CostSummary;
  /** Cost breakdown by agent (last 30 days) */
  byAgent: AgentCostBreakdown[];
  /** Daily costs for the mini chart (last 7 days) */
  dailyCosts: DailyCostDataPoint[];
}

/**
 * Return type for the useCosts hook.
 */
export interface UseCostsReturn {
  /** Cost data (null if loading or error) */
  data: CostData | null;
  /** Whether data is currently loading */
  isLoading: boolean;
  /** Whether data is refreshing (pull-to-refresh) */
  isRefreshing: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Trigger a refresh */
  refresh: () => Promise<void>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the start date for a time period.
 *
 * @param period - Time period ('today', 'week', 'month')
 * @returns Date object for the start of the period
 */
function getPeriodStartDate(period: 'today' | 'week' | 'month'): Date {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'today':
      return startOfDay;
    case 'week':
      const weekAgo = new Date(startOfDay);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return weekAgo;
    case 'month':
      const monthAgo = new Date(startOfDay);
      monthAgo.setDate(monthAgo.getDate() - 30);
      return monthAgo;
  }
}

/**
 * Format a date as YYYY-MM-DD string.
 *
 * @param date - Date to format
 * @returns Formatted date string
 */
function formatDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Fetch cost summary for a specific time period.
 *
 * @param period - Time period to fetch
 * @returns Cost summary for the period
 */
async function fetchCostSummary(period: 'today' | 'week' | 'month'): Promise<CostSummary> {
  const startDate = getPeriodStartDate(period);

  const { data, error } = await supabase
    .from('cost_records')
    .select('cost_usd, input_tokens, output_tokens')
    .gte('record_date', formatDateString(startDate));

  if (error) {
    console.error(`Error fetching ${period} cost summary:`, error);
    return { totalCost: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 };
  }

  return (data || []).reduce(
    (acc, record) => ({
      totalCost: acc.totalCost + (Number(record.cost_usd) || 0),
      inputTokens: acc.inputTokens + (record.input_tokens || 0),
      outputTokens: acc.outputTokens + (record.output_tokens || 0),
      requestCount: acc.requestCount + 1,
    }),
    { totalCost: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 }
  );
}

/**
 * Fetch cost breakdown by agent for the last 30 days.
 *
 * @returns Array of agent cost breakdowns sorted by cost descending
 */
async function fetchCostsByAgent(): Promise<AgentCostBreakdown[]> {
  const startDate = getPeriodStartDate('month');

  const { data, error } = await supabase
    .from('cost_records')
    .select('agent_type, cost_usd, input_tokens, output_tokens')
    .gte('record_date', formatDateString(startDate));

  if (error) {
    console.error('Error fetching costs by agent:', error);
    return [];
  }

  // Aggregate by agent
  const agentMap = new Map<string, Omit<AgentCostBreakdown, 'percentage'>>();

  for (const record of data || []) {
    const agent = (record.agent_type || 'unknown') as AgentType;
    const existing = agentMap.get(agent) || {
      agent,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
    };

    agentMap.set(agent, {
      agent,
      cost: existing.cost + (Number(record.cost_usd) || 0),
      inputTokens: existing.inputTokens + (record.input_tokens || 0),
      outputTokens: existing.outputTokens + (record.output_tokens || 0),
      requestCount: existing.requestCount + 1,
    });
  }

  // Calculate percentages and sort by cost
  const totalCost = Array.from(agentMap.values()).reduce((sum, a) => sum + a.cost, 0);
  return Array.from(agentMap.values())
    .map((a) => ({
      ...a,
      percentage: totalCost > 0 ? (a.cost / totalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * Fetch daily cost data for the last 7 days.
 *
 * @returns Array of daily cost data points sorted by date ascending
 */
async function fetchDailyCosts(): Promise<DailyCostDataPoint[]> {
  const startDate = getPeriodStartDate('week');

  const { data, error } = await supabase
    .from('cost_records')
    .select('record_date, agent_type, cost_usd')
    .gte('record_date', formatDateString(startDate))
    .order('record_date', { ascending: true });

  if (error) {
    console.error('Error fetching daily costs:', error);
    return [];
  }

  // Aggregate by date and agent
  const dateMap = new Map<string, DailyCostDataPoint>();

  // Pre-populate all 7 days with zeros for consistent chart display
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = formatDateString(date);
    dateMap.set(dateStr, {
      date: dateStr,
      total: 0,
      claude: 0,
      codex: 0,
      gemini: 0,
      opencode: 0,
    });
  }

  // Aggregate actual data
  for (const record of data || []) {
    const date = record.record_date;
    const existing = dateMap.get(date);
    if (!existing) continue; // Skip dates outside our 7-day window

    const cost = Number(record.cost_usd) || 0;
    existing.total += cost;

    switch (record.agent_type) {
      case 'claude':
        existing.claude += cost;
        break;
      case 'codex':
        existing.codex += cost;
        break;
      case 'gemini':
        existing.gemini += cost;
        break;
      default:
        existing.opencode += cost;
    }

    dateMap.set(date, existing);
  }

  return Array.from(dateMap.values()).sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for fetching and managing cost data.
 *
 * Fetches cost summaries (today, week, month), agent breakdown, and daily costs
 * in parallel. Provides loading/error states and pull-to-refresh functionality.
 *
 * @returns Cost data, loading states, and refresh function
 *
 * @example
 * const { data, isLoading, error, refresh, isRefreshing } = useCosts();
 *
 * if (isLoading) return <LoadingSpinner />;
 * if (error) return <ErrorMessage message={error} />;
 *
 * return (
 *   <ScrollView refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={refresh} />}>
 *     <CostCard title="Today" amount={data.today.totalCost} />
 *   </ScrollView>
 * );
 */
export function useCosts(): UseCostsReturn {
  const [data, setData] = useState<CostData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch all cost data in parallel.
   */
  const fetchAllData = useCallback(async () => {
    try {
      const [today, week, month, byAgent, dailyCosts] = await Promise.all([
        fetchCostSummary('today'),
        fetchCostSummary('week'),
        fetchCostSummary('month'),
        fetchCostsByAgent(),
        fetchDailyCosts(),
      ]);

      setData({ today, week, month, byAgent, dailyCosts });
      setError(null);
    } catch (err) {
      console.error('Error fetching cost data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load cost data');
    }
  }, []);

  /**
   * Initial load on mount.
   */
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await fetchAllData();
      setIsLoading(false);
    };
    load();
  }, [fetchAllData]);

  /**
   * Pull-to-refresh handler.
   */
  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    await fetchAllData();
    setIsRefreshing(false);
  }, [fetchAllData]);

  return {
    data,
    isLoading,
    isRefreshing,
    error,
    refresh,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format a cost value as a USD currency string.
 *
 * @param cost - Cost value in USD
 * @param decimals - Number of decimal places (default 2)
 * @returns Formatted currency string (e.g., "$12.34")
 */
export function formatCost(cost: number, decimals: number = 2): string {
  return `$${cost.toFixed(decimals)}`;
}

/**
 * Format a token count with K/M suffix for readability.
 *
 * @param tokens - Number of tokens
 * @returns Formatted token string (e.g., "1.2M", "500K", "123")
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}

/**
 * Get the hex color for an agent type.
 *
 * @param agent - Agent type
 * @returns Hex color code for the agent
 */
export function getAgentHexColor(agent: AgentType): string {
  switch (agent) {
    case 'claude':
      return '#f97316'; // orange-500
    case 'codex':
      return '#22c55e'; // green-500
    case 'gemini':
      return '#3b82f6'; // blue-500
    case 'opencode':
      return '#a855f7'; // purple-500
    case 'aider':
      return '#ec4899'; // pink-500
    default:
      return '#71717a'; // zinc-500
  }
}

/**
 * Get the display name for an agent type.
 *
 * @param agent - Agent type
 * @returns Human-readable agent name
 */
export function getAgentDisplayName(agent: AgentType): string {
  switch (agent) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'opencode':
      return 'OpenCode';
    case 'aider':
      return 'Aider';
    default:
      return agent;
  }
}
