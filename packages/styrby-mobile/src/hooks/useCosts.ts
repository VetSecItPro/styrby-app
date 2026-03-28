/**
 * Cost Data Hook
 *
 * Fetches and manages cost data from Supabase for the mobile cost dashboard.
 * Handles loading states, error handling, and pull-to-refresh functionality.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { CostRecordSchema, safeParseArray, safeParseSingle } from '../lib/schemas';
import type { RealtimeChannel } from '@supabase/supabase-js';
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
 * Cost breakdown by model name.
 *
 * WHY: Users run multiple models (e.g., claude-sonnet-4, gpt-4o) and need
 * to see which model is driving their costs. The web dashboard already shows
 * this; mobile needs parity.
 */
export interface ModelCostBreakdown {
  /** Model identifier (e.g., 'claude-sonnet-4', 'gpt-4o') */
  model: string;
  /** Total cost in USD for this model */
  cost: number;
  /** Input tokens for this model */
  inputTokens: number;
  /** Output tokens for this model */
  outputTokens: number;
  /** Number of requests */
  requestCount: number;
}

/**
 * Cost breakdown by session tag.
 *
 * WHY: Users tag sessions from the CLI (e.g., 'project-x', 'refactor')
 * to track spending per project or task. The web dashboard shows cost-by-tag;
 * mobile needs parity so users can audit per-project spend on the go.
 */
export interface TagCostBreakdown {
  /** Tag string */
  tag: string;
  /** Total cost in USD for sessions with this tag */
  cost: number;
  /** Number of sessions with this tag */
  sessionCount: number;
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
  /** Cost from Aider */
  aider: number;
  /** Cost from Goose (Block/Square) */
  goose: number;
  /** Cost from Amp (Sourcegraph) */
  amp: number;
  /** Cost from Crush (Charmbracelet) */
  crush: number;
  /** Cost from Kilo (Community, Memory Bank) */
  kilo: number;
  /** Cost from Kiro (AWS, per-prompt credits) */
  kiro: number;
  /** Cost from Droid (BYOK, multi-backend via LiteLLM) */
  droid: number;
}

/** Valid time range options in days for the cost dashboard. */
export type CostTimeRange = 7 | 30 | 90;

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
  /** Cost summary for last 90 days */
  quarter: CostSummary;
  /** Cost breakdown by agent for the selected time range */
  byAgent: AgentCostBreakdown[];
  /** Cost breakdown by model for the selected time range */
  byModel: ModelCostBreakdown[];
  /** Cost breakdown by session tag for the selected time range */
  byTag: TagCostBreakdown[];
  /** Daily costs for the mini chart (for the selected time range) */
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
  /** Currently selected time range in days */
  timeRange: CostTimeRange;
  /** Change the selected time range */
  setTimeRange: (range: CostTimeRange) => void;
  /** Whether the realtime subscription is connected */
  isRealtimeConnected: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the start date for a time period.
 *
 * @param period - Time period ('today', 'week', 'month', 'quarter')
 * @returns Date object for the start of the period
 */
function getPeriodStartDate(period: 'today' | 'week' | 'month' | 'quarter'): Date {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'today':
      return startOfDay;
    case 'week': {
      const weekAgo = new Date(startOfDay);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return weekAgo;
    }
    case 'month': {
      const monthAgo = new Date(startOfDay);
      monthAgo.setDate(monthAgo.getDate() - 30);
      return monthAgo;
    }
    case 'quarter': {
      const quarterAgo = new Date(startOfDay);
      quarterAgo.setDate(quarterAgo.getDate() - 90);
      return quarterAgo;
    }
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

// WHY: Raw record shape returned by the single 90-day Supabase fetch.
// Selecting all columns needed by every downstream aggregation avoids
// additional round-trips for agent breakdown, model breakdown, and daily chart data.
interface RawCostRecord {
  record_date: string;
  agent_type: string | null;
  /** Model identifier (e.g., 'claude-sonnet-4'). Added for cost-by-model breakdown. */
  model: string | null;
  cost_usd: string | number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * Raw session row shape returned by the tag cost query.
 * Only includes fields needed for per-tag cost aggregation.
 */
interface RawTaggedSession {
  tags: string[];
  total_cost_usd: number;
  /** ISO 8601 timestamp when the session started. Used to filter by time range. */
  started_at: string;
}

/**
 * Aggregate a filtered set of raw records into a CostSummary.
 *
 * @param records - Pre-filtered subset of raw cost records
 * @returns Aggregated cost summary for the period
 */
function aggregateSummary(records: RawCostRecord[]): CostSummary {
  return records.reduce(
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
 * Derive agent cost breakdown from raw 30-day records.
 *
 * @param records - Full 30-day raw records
 * @returns Array of agent cost breakdowns sorted by cost descending
 */
function deriveAgentBreakdown(records: RawCostRecord[]): AgentCostBreakdown[] {
  const agentMap = new Map<string, Omit<AgentCostBreakdown, 'percentage'>>();

  for (const record of records) {
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

  const totalCost = Array.from(agentMap.values()).reduce((sum, a) => sum + a.cost, 0);
  return Array.from(agentMap.values())
    .map((a) => ({
      ...a,
      percentage: totalCost > 0 ? (a.cost / totalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * Derive cost breakdown by model from raw cost records.
 *
 * @param records - Pre-filtered raw cost records for the desired time range
 * @returns Array of model cost breakdowns sorted by cost descending
 */
function deriveModelBreakdown(records: RawCostRecord[]): ModelCostBreakdown[] {
  const modelMap = new Map<string, ModelCostBreakdown>();

  for (const record of records) {
    const model = record.model || 'unknown';
    const existing = modelMap.get(model) || {
      model,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
    };

    modelMap.set(model, {
      model,
      cost: existing.cost + (Number(record.cost_usd) || 0),
      inputTokens: existing.inputTokens + (record.input_tokens || 0),
      outputTokens: existing.outputTokens + (record.output_tokens || 0),
      requestCount: existing.requestCount + 1,
    });
  }

  return Array.from(modelMap.values()).sort((a, b) => b.cost - a.cost);
}

/**
 * Derive cost breakdown by session tag from raw tagged session rows.
 *
 * WHY: Tags are stored as arrays on sessions (not cost_records), so we need
 * a separate query to the sessions table. A single session can have multiple
 * tags, so its cost is attributed to every tag it carries.
 *
 * WHY rangeStartStr: The tag sessions query always fetches 90 days so the
 * full dataset is cached. We filter down to the selected time range client-side
 * so the tag breakdown reflects the same window as agent/model breakdowns.
 *
 * @param sessions - Raw tagged session rows with cost, tags, and started_at
 * @param rangeStartStr - Optional YYYY-MM-DD cutoff; sessions before this date are excluded
 * @returns Array of tag cost breakdowns sorted by cost descending
 */
function deriveTagBreakdown(sessions: RawTaggedSession[], rangeStartStr?: string): TagCostBreakdown[] {
  const tagMap = new Map<string, { cost: number; sessionCount: number }>();

  for (const session of sessions) {
    // Filter by time range if a cutoff was provided
    if (rangeStartStr && session.started_at.slice(0, 10) < rangeStartStr) continue;
    if (!session.tags || session.tags.length === 0) continue;
    const cost = Number(session.total_cost_usd) || 0;

    for (const tag of session.tags) {
      const existing = tagMap.get(tag) || { cost: 0, sessionCount: 0 };
      tagMap.set(tag, {
        cost: existing.cost + cost,
        sessionCount: existing.sessionCount + 1,
      });
    }
  }

  return Array.from(tagMap.entries())
    .map(([tag, data]) => ({ tag, ...data }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * Derive daily cost chart data from raw records for a given number of days.
 *
 * @param records - Full 90-day raw records (superset)
 * @param days - Number of days to show in the chart
 * @returns Array of daily cost data points sorted by date ascending
 */
function deriveDailyCosts(records: RawCostRecord[], days: number = 7): DailyCostDataPoint[] {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = formatDateString(startDate);

  // Pre-populate all days with zeros for consistent chart display
  const dateMap = new Map<string, DailyCostDataPoint>();
  for (let i = days - 1; i >= 0; i--) {
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
      aider: 0,
      goose: 0,
      amp: 0,
      crush: 0,
      kilo: 0,
      kiro: 0,
      droid: 0,
    });
  }

  // Aggregate actual data — filter to selected range from the already-fetched 90-day set
  for (const record of records) {
    if (record.record_date < startDateStr) continue;
    const existing = dateMap.get(record.record_date);
    if (!existing) continue;

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
      case 'opencode':
        existing.opencode += cost;
        break;
      case 'aider':
        existing.aider += cost;
        break;
      case 'goose':
        existing.goose += cost;
        break;
      case 'amp':
        existing.amp += cost;
        break;
      case 'crush':
        existing.crush += cost;
        break;
      case 'kilo':
        existing.kilo += cost;
        break;
      case 'kiro':
        existing.kiro += cost;
        break;
      case 'droid':
        existing.droid += cost;
        break;
      default:
        // WHY: Unknown agent types are bucketed into opencode as a catch-all.
        // This should rarely happen since agent_type is an enum, but handles
        // forward-compatibility if a new agent is added before this code updates.
        existing.opencode += cost;
    }

    dateMap.set(record.record_date, existing);
  }

  return Array.from(dateMap.values()).sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

/**
 * Fetch all cost_records for the last 90 days in a single query.
 *
 * WHY: The 90-day window is a superset of the 30-day, 7-day, and 1-day windows.
 * Fetching once and aggregating client-side eliminates redundant Supabase
 * round-trips on every load and refresh cycle (PERF-008).
 *
 * @returns Raw cost records for the last 90 days, or empty array on error
 */
async function fetchQuarterRecords(): Promise<RawCostRecord[]> {
  const startDate = getPeriodStartDate('quarter');

  const { data, error } = await supabase
    .from('cost_records')
    .select('record_date, agent_type, model, cost_usd, input_tokens, output_tokens')
    .gte('record_date', formatDateString(startDate))
    .order('record_date', { ascending: true });

  if (error) {
    // WHY: Raw error objects can leak stack traces, file paths, and internal state
    // in production. We log full details only in __DEV__ for debugging.
    console.error('Error fetching 90-day cost records:', __DEV__ ? error : error.message);
    return [];
  }

  // WHY: Validate each record with Zod before downstream aggregation.
  // Invalid records are dropped so cost calculations are never corrupted
  // by unexpected data shapes from the database.
  const validated = safeParseArray(CostRecordSchema, data, 'cost_records');

  // WHY: Map from Zod validated records to RawCostRecord shape. model is now
  // `.default('unknown')` in the schema so it is always a string; no nullish
  // coalescing needed. RawCostRecord still uses string | null to accept records
  // fetched from realtime events that may predate the schema change.
  return validated.map((r) => ({
    record_date: r.record_date,
    agent_type: r.agent_type,
    model: r.model,
    cost_usd: r.cost_usd,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
  }));
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
  const [timeRange, setTimeRange] = useState<CostTimeRange>(30);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState(false);

  // WHY: Keep a ref to the Realtime channel so we can clean it up on unmount
  // without leaking WebSocket connections.
  const realtimeChannelRef = useRef<RealtimeChannel | null>(null);

  // WHY: Keep a ref to the latest raw records so the Realtime handler can
  // append new records and re-derive all summaries without a full re-fetch.
  const recordsRef = useRef<RawCostRecord[]>([]);

  // WHY: Keep a ref to tagged sessions so we can re-derive tag breakdown
  // without re-fetching when realtime records arrive.
  const taggedSessionsRef = useRef<RawTaggedSession[]>([]);

  // WHY: Store timeRange in a ref so the deriveAndSetData callback can read
  // the latest value without being recreated on every timeRange change.
  const timeRangeRef = useRef<CostTimeRange>(timeRange);
  timeRangeRef.current = timeRange;

  /**
   * Derives all cost summaries from a set of raw records and updates state.
   *
   * WHY: Extracted into a helper so both the initial fetch and Realtime
   * INSERT handler can re-derive summaries from the same logic without
   * duplicating the filtering and aggregation code.
   *
   * @param records - The full set of raw cost records (up to 90 days)
   * @param taggedSessions - Tagged sessions for cost-by-tag breakdown
   */
  const deriveAndSetData = useCallback((records: RawCostRecord[], taggedSessions?: RawTaggedSession[]) => {
    const todayStart = formatDateString(getPeriodStartDate('today'));
    const weekStart = formatDateString(getPeriodStartDate('week'));
    const monthStart = formatDateString(getPeriodStartDate('month'));

    const today = aggregateSummary(records.filter((r) => r.record_date >= todayStart));
    const week = aggregateSummary(records.filter((r) => r.record_date >= weekStart));
    const monthRecords = records.filter((r) => r.record_date >= monthStart);
    const month = aggregateSummary(monthRecords);
    const quarter = aggregateSummary(records);

    // WHY: The time range selector controls which slice of the 90-day data
    // is used for agent breakdown, model breakdown, tag breakdown, and chart.
    // The summary cards always show fixed periods (today/week/month/quarter).
    const currentRange = timeRangeRef.current;
    const rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - currentRange);
    const rangeStartStr = formatDateString(rangeStart);
    const rangeRecords = records.filter((r) => r.record_date >= rangeStartStr);

    const byAgent = deriveAgentBreakdown(rangeRecords);
    const byModel = deriveModelBreakdown(rangeRecords);
    // WHY: Pass rangeStartStr so the tag breakdown matches the selected time range.
    // Previously it always showed 90-day data regardless of the time range selector.
    const byTag = deriveTagBreakdown(taggedSessions ?? taggedSessionsRef.current, rangeStartStr);
    const dailyCosts = deriveDailyCosts(records, currentRange);

    setData({ today, week, month, quarter, byAgent, byModel, byTag, dailyCosts });
  }, []);

  /**
   * Fetch tagged sessions for cost-by-tag breakdown.
   *
   * WHY: Tags live on the sessions table, not cost_records. We need a separate
   * query to get sessions with tags and their total_cost_usd for the selected
   * period. Limited to 200 rows to avoid fetching excessive data.
   *
   * @param periodStart - ISO date string for the start of the period
   * @returns Array of tagged session rows
   */
  const fetchTaggedSessions = useCallback(async (periodStart: string): Promise<RawTaggedSession[]> => {
    const { data: sessions, error: sessionsError } = await supabase
      .from('sessions')
      .select('tags, total_cost_usd, started_at')
      .gte('started_at', periodStart)
      .not('tags', 'eq', '{}')
      .limit(200);

    if (sessionsError) {
      console.error('Error fetching tagged sessions:', __DEV__ ? sessionsError : sessionsError.message);
      return [];
    }

    return (sessions || []) as RawTaggedSession[];
  }, []);

  /**
   * Fetch all cost data with a single Supabase query, then derive all
   * summaries and chart data client-side.
   *
   * WHY: The 90-day window is a superset of the 30-day, 7-day, and 1-day windows.
   * One query replaces four, cutting network round-trips per refresh cycle.
   * Client-side filtering of an already-fetched array is O(n) and negligible
   * compared to the eliminated network latency.
   */
  const fetchAllData = useCallback(async () => {
    try {
      // WHY: Fetch cost records and tagged sessions in parallel to minimize
      // total load time. Both are independent queries.
      const quarterStart = formatDateString(getPeriodStartDate('quarter'));
      const [records, taggedSessions] = await Promise.all([
        fetchQuarterRecords(),
        fetchTaggedSessions(quarterStart),
      ]);

      recordsRef.current = records;
      taggedSessionsRef.current = taggedSessions;
      deriveAndSetData(records, taggedSessions);
      setError(null);
    } catch (err) {
      // WHY: Raw error objects can leak stack traces and internal state in production.
      console.error('Error fetching cost data:', __DEV__ ? err : (err instanceof Error ? err.message : 'Unknown error'));
      setError(err instanceof Error ? err.message : 'Failed to load cost data');
    }
  }, [deriveAndSetData, fetchTaggedSessions]);

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
   * Re-derive data when time range changes.
   *
   * WHY: The 90-day dataset is already cached in recordsRef. Changing the time
   * range only requires re-filtering and re-aggregating the cached data, not
   * a new network request. This makes time range switching feel instant.
   */
  useEffect(() => {
    if (recordsRef.current.length > 0) {
      deriveAndSetData(recordsRef.current, taggedSessionsRef.current);
    }
  }, [timeRange, deriveAndSetData]);

  /**
   * Subscribe to real-time INSERT events on the cost_records table.
   *
   * WHY: When a new cost record is inserted (e.g., from an active coding
   * session), the dashboard updates immediately without requiring a manual
   * refresh. This gives users a live cost ticker experience. The subscription
   * is filtered by the user's auth to respect RLS.
   */
  useEffect(() => {
    /**
     * Set up the Realtime subscription after initial data load completes.
     */
    const setupRealtime = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) return;

      const channel = supabase
        .channel('cost-records-realtime')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'cost_records',
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            // Validate the incoming record with Zod
            const validated = safeParseSingle(CostRecordSchema, payload.new, 'realtime_cost_record');
            if (!validated) return;

            // Convert to the RawCostRecord shape used by aggregation functions
            const newRecord: RawCostRecord = {
              record_date: validated.record_date,
              agent_type: validated.agent_type,
              model: validated.model ?? null,
              cost_usd: validated.cost_usd,
              input_tokens: validated.input_tokens,
              output_tokens: validated.output_tokens,
            };

            // Append to the cached records, prune records older than 90 days,
            // and re-derive all summaries.
            // WHY: Without pruning, the Realtime handler accumulates records
            // indefinitely across long-running sessions, leading to unbounded
            // memory growth and increasingly slow re-aggregation.
            const cutoff = formatDateString(getPeriodStartDate('quarter'));
            recordsRef.current = [...recordsRef.current, newRecord]
              .filter((r) => r.record_date >= cutoff);

            // KNOWN LIMITATION: tag breakdown uses taggedSessionsRef.current which
            // was fetched at initial load. New session tags added after mount will not
            // appear in the tag breakdown until the user manually pulls to refresh.
            // Fixing this would require an additional Supabase round-trip per INSERT
            // event, which is not worth the cost for a non-real-time metric.
            deriveAndSetData(recordsRef.current);
          },
        )
        .subscribe((status) => {
          // WHY: Track subscription status so the UI can show a live/offline
          // indicator. 'SUBSCRIBED' means the WebSocket is connected and
          // receiving events; any other status means we're not live.
          setIsRealtimeConnected(status === 'SUBSCRIBED');
        });

      realtimeChannelRef.current = channel;
    };

    setupRealtime();

    // Cleanup on unmount
    return () => {
      if (realtimeChannelRef.current) {
        supabase.removeChannel(realtimeChannelRef.current);
        realtimeChannelRef.current = null;
        setIsRealtimeConnected(false);
      }
    };
  }, [deriveAndSetData]);

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
    timeRange,
    setTimeRange,
    isRealtimeConnected,
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
    case 'goose':
      return '#14b8a6'; // teal-500
    case 'amp':
      return '#f59e0b'; // amber-500
    case 'crush':
      return '#f43f5e'; // rose-500
    case 'kilo':
      return '#0ea5e9'; // sky-500
    case 'kiro':
      return '#f97316'; // orange-500
    case 'droid':
      return '#64748b'; // slate-500
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
    case 'goose':
      return 'Goose';
    case 'amp':
      return 'Amp';
    case 'crush':
      return 'Crush';
    case 'kilo':
      return 'Kilo';
    case 'kiro':
      return 'Kiro';
    case 'droid':
      return 'Droid';
    default:
      return agent;
  }
}
