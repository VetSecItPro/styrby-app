/**
 * Budget Alerts Hook
 *
 * Fetches, creates, updates, and deletes budget alerts from Supabase.
 * Calculates current spend and percentage used for each alert by querying
 * cost_records for the relevant time period.
 *
 * Supports three alert types (migration 023):
 *   cost_usd:           sum(cost_usd) for billing_model = 'api-key' rows
 *   subscription_quota: MAX(subscription_fraction_used) for billing_model = 'subscription'
 *   credits:            sum(credits_consumed) for billing_model = 'credit'
 *
 * Also fetches the user's subscription tier to enforce alert count limits:
 * - Free: 0 budget alerts (feature locked)
 * - Pro: 3 budget alerts
 * - Power: 5 budget alerts
 */

import { useState, useEffect, useCallback } from 'react';
import { z } from 'zod';
import { supabase } from '../lib/supabase';
import {
  BudgetAlertSchema,
  SubscriptionTierRowSchema,
  safeParseArray,
  safeParseSingle,
} from '../lib/schemas';
import type { AgentType, SubscriptionTier } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Budget alert period for spend aggregation.
 * Determines the time window over which spend is measured against the threshold.
 */
export type BudgetAlertPeriod = 'daily' | 'weekly' | 'monthly';

/**
 * Alert type controlling which cost_records aggregation is used.
 * Added in migration 023 (PR-E: quota-aware budget alerts).
 *
 * WHY: Subscription users have cost_usd = $0 so a cost_usd alert never fires.
 * quota and credits types use billing-model-specific columns instead.
 */
export type BudgetAlertType = 'cost_usd' | 'subscription_quota' | 'credits';

/**
 * Action to take when a budget alert threshold is reached.
 *
 * WHY: The database stores action values as 'notify', 'warn_and_slowdown', 'hard_stop'
 * but the UI presents them as 'notify', 'slowdown', 'stop' for simplicity.
 * We map between these in the toDbAction/fromDbAction helpers.
 */
export type BudgetAlertAction = 'notify' | 'slowdown' | 'stop';

/**
 * Maps UI-friendly action names to database column values.
 * The database schema uses CHECK constraint: action IN ('notify', 'warn_and_slowdown', 'hard_stop').
 */
const ACTION_TO_DB: Record<BudgetAlertAction, string> = {
  notify: 'notify',
  slowdown: 'warn_and_slowdown',
  stop: 'hard_stop',
};

/**
 * Maps database action values back to UI-friendly names.
 */
const DB_TO_ACTION: Record<string, BudgetAlertAction> = {
  notify: 'notify',
  warn_and_slowdown: 'slowdown',
  hard_stop: 'stop',
};

/**
 * Represents a budget alert with computed spend data.
 */
export interface BudgetAlert {
  /** Unique alert identifier from Supabase */
  id: string;
  /** User who owns the alert */
  userId: string;
  /** Human-readable alert name (e.g., "Daily Limit") */
  name: string;
  /** USD threshold that triggers the alert (used for cost_usd type) */
  threshold: number;
  /** Time period for spend aggregation */
  period: BudgetAlertPeriod;
  /**
   * Optional agent type scope. When set, only costs from this agent
   * are counted against the threshold. When null, all agents are included.
   */
  agentType: AgentType | null;
  /** What happens when the threshold is reached */
  action: BudgetAlertAction;
  /** Whether the alert is currently active */
  enabled: boolean;
  /**
   * Calculated current spend (or fraction / credits) for the alert's period.
   * For subscription_quota: fraction (0–1). For credits: integer credit count.
   */
  currentSpend: number;
  /** Calculated percentage of threshold used (currentSpend / threshold * 100) */
  percentUsed: number;
  /** ISO timestamp when the alert was last triggered, or null */
  triggeredAt: string | null;
  /** ISO timestamp when the alert was created */
  createdAt: string;
  /**
   * Alert type (migration 023). Defaults to 'cost_usd' for legacy rows.
   * Controls which cost_records column is aggregated.
   */
  alertType: BudgetAlertType;
  /**
   * Quota fraction threshold (0–1). Set when alertType = 'subscription_quota'.
   * NULL for other types.
   */
  thresholdQuotaFraction: number | null;
  /**
   * Credit count threshold. Set when alertType = 'credits'. NULL for other types.
   */
  thresholdCredits: number | null;
}

/**
 * Input for creating a new budget alert.
 * Excludes server-generated and computed fields.
 */
export interface CreateBudgetAlertInput {
  /** Human-readable alert name */
  name: string;
  /** USD threshold amount (used when alertType = 'cost_usd') */
  threshold: number;
  /** Time period for spend aggregation */
  period: BudgetAlertPeriod;
  /** Action to take when threshold is reached */
  action: BudgetAlertAction;
  /** Optional agent type scope (null = all agents) */
  agentType?: AgentType | null;
  /** Whether the alert starts enabled (defaults to true) */
  enabled?: boolean;
  /**
   * Alert type (migration 023). Defaults to 'cost_usd' for backward compatibility.
   * Controls which cost_records column is aggregated.
   */
  alertType?: BudgetAlertType;
  /**
   * Quota fraction threshold (0–1). Required when alertType = 'subscription_quota'.
   */
  thresholdQuotaFraction?: number | null;
  /**
   * Credit count threshold (positive integer). Required when alertType = 'credits'.
   */
  thresholdCredits?: number | null;
}

/**
 * Result from the atomic budget hard-stop check RPC.
 * Returned by the check_budget_hard_stop database function.
 */
export interface BudgetHardStopResult {
  /** Whether the user's spending has exceeded a hard-stop threshold */
  is_blocked: boolean;
  /** UUID of the triggered alert, or null if not blocked */
  alert_id: string | null;
  /** The alert's USD threshold, or null if not blocked */
  threshold_usd: number | null;
  /** The user's current total spend for the period, or null if not blocked */
  total_spend: number | null;
  /** The alert's period ('daily', 'weekly', 'monthly'), or null if not blocked */
  period: string | null;
}

/**
 * Return type for the useBudgetAlerts hook.
 */
export interface UseBudgetAlertsReturn {
  /** List of budget alerts with computed spend data */
  alerts: BudgetAlert[];
  /** Whether data is currently loading */
  isLoading: boolean;
  /** Error message if an operation failed */
  error: string | null;
  /** Create a new budget alert */
  createAlert: (input: CreateBudgetAlertInput) => Promise<void>;
  /** Update fields on an existing budget alert */
  updateAlert: (id: string, updates: Partial<CreateBudgetAlertInput>) => Promise<void>;
  /** Delete a budget alert by ID */
  deleteAlert: (id: string) => Promise<void>;
  /** Trigger a data refresh */
  refresh: () => void;
  /** User's subscription tier (determines alert limits) */
  tier: SubscriptionTier;
  /** Maximum number of alerts allowed for the current tier */
  alertLimit: number;
  /**
   * Check whether the user is blocked by a hard-stop budget alert.
   * Uses the atomic check_budget_hard_stop RPC to avoid race conditions.
   */
  checkHardStop: () => Promise<BudgetHardStopResult | null>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum budget alerts allowed per subscription tier.
 *
 * WHY: These limits match the TIERS config in packages/styrby-web/src/lib/polar.ts.
 * We duplicate them here instead of importing from the web package because the
 * web package has server-side dependencies (Polar SDK, env vars) that cannot
 * be resolved in the Expo build.
 */
const TIER_ALERT_LIMITS: Record<SubscriptionTier, number> = {
  free: 0,
  pro: 3,
  power: 5,
  team: 5,
};

// ============================================================================
// Supabase Row Types
// ============================================================================

/**
 * Raw row shape from the budget_alerts table.
 * Includes migration 023 columns: alert_type, threshold_quota_fraction, threshold_credits.
 */
interface BudgetAlertRow {
  id: string;
  user_id: string;
  name: string;
  threshold_usd: number;
  period: string;
  /** Optional agent type scope. NULL means all agents. */
  agent_type: string | null;
  action: string;
  is_enabled: boolean;
  last_triggered_at: string | null;
  created_at: string;
  /** Migration 023: alert type controlling aggregation logic. */
  alert_type?: string | null;
  /** Migration 023: quota fraction threshold. */
  threshold_quota_fraction?: number | null;
  /** Migration 023: credit count threshold. */
  threshold_credits?: number | null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the start date for a budget alert period.
 *
 * WHY: We calculate the period start date on the client to query cost_records
 * with a simple >= filter. This aligns with how the costs hook calculates
 * period boundaries (daily = start of today, weekly = 7 days ago, monthly = 30 days ago).
 *
 * @param period - Budget alert period
 * @returns ISO date string for the start of the period
 */
function getPeriodStartDate(period: BudgetAlertPeriod): string {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'daily':
      return startOfDay.toISOString().split('T')[0];
    case 'weekly': {
      const weekAgo = new Date(startOfDay);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return weekAgo.toISOString().split('T')[0];
    }
    case 'monthly': {
      const monthAgo = new Date(startOfDay);
      monthAgo.setDate(monthAgo.getDate() - 30);
      return monthAgo.toISOString().split('T')[0];
    }
  }
}

/**
 * Fetch the current user's spend (or quota fraction / credit count) for a
 * given period from cost_records, branching on alert type.
 *
 * WHY per-type fetching:
 *   cost_usd:           SUM(cost_usd) WHERE billing_model = 'api-key'
 *                       Subscription rows have cost_usd = $0 (migration 022
 *                       constraint) so filtering to api-key is belt-and-suspenders
 *                       correctness and avoids diluting the sum.
 *   subscription_quota: MAX(subscription_fraction_used) WHERE billing_model = 'subscription'
 *                       The fraction is cumulative within an agent session, so MAX
 *                       gives the high-water mark for the period.
 *   credits:            SUM(credits_consumed) WHERE billing_model = 'credit'
 *                       Credits are independently consumed per session — sum them.
 *
 * @param userId - The user's UUID
 * @param period - Budget alert period to aggregate
 * @param alertType - Which aggregation to use (migration 023)
 * @param agentType - Optional agent type to filter by (null = all agents)
 * @returns Aggregated value: USD spend, quota fraction (0–1), or credit count
 */
async function fetchPeriodMetric(
  userId: string,
  period: BudgetAlertPeriod,
  alertType: BudgetAlertType,
  agentType?: string | null,
): Promise<number> {
  const startDate = getPeriodStartDate(period);

  if (alertType === 'subscription_quota') {
    let query = supabase
      .from('cost_records')
      .select('subscription_fraction_used')
      .eq('user_id', userId)
      .eq('billing_model', 'subscription')
      .gte('record_date', startDate)
      .not('subscription_fraction_used', 'is', null);
    if (agentType) query = query.eq('agent_type', agentType);
    const { data, error } = await query;
    if (error) {
      console.error('[BudgetAlerts] Failed to fetch subscription fraction:', __DEV__ ? error : (error instanceof Error ? error.message : 'Unknown error'));
      return 0;
    }
    if (!data || data.length === 0) return 0;
    return Math.max(...data.map((r) => Number(r.subscription_fraction_used) || 0));
  }

  if (alertType === 'credits') {
    let query = supabase
      .from('cost_records')
      .select('credits_consumed')
      .eq('user_id', userId)
      .eq('billing_model', 'credit')
      .gte('record_date', startDate)
      .not('credits_consumed', 'is', null);
    if (agentType) query = query.eq('agent_type', agentType);
    const { data, error } = await query;
    if (error) {
      console.error('[BudgetAlerts] Failed to fetch credits consumed:', __DEV__ ? error : (error instanceof Error ? error.message : 'Unknown error'));
      return 0;
    }
    return (data || []).reduce((sum, r) => sum + (Number(r.credits_consumed) || 0), 0);
  }

  // cost_usd (default): filter to api-key rows only.
  // WHY: subscription rows have cost_usd = $0 (migration 022 constraint).
  // Filtering prevents accidental dilution if that constraint is ever relaxed.
  let query = supabase
    .from('cost_records')
    .select('cost_usd')
    .eq('user_id', userId)
    .eq('billing_model', 'api-key')
    .gte('record_date', startDate);
  if (agentType) query = query.eq('agent_type', agentType);
  const { data, error } = await query;
  if (error) {
    console.error(`[BudgetAlerts] Failed to fetch ${period} spend:`, __DEV__ ? error : (error instanceof Error ? error.message : 'Unknown error'));
    return 0;
  }
  return (data || []).reduce((sum, record) => sum + (Number(record.cost_usd) || 0), 0);
}

/**
 * Fetch the current user's subscription tier from the subscriptions table.
 *
 * WHY: We need the tier to enforce budget alert count limits. The subscriptions
 * table is synced from Polar via webhooks and is the source of truth for billing.
 * If no subscription record exists, the user is on the free tier.
 *
 * @returns The user's current subscription tier
 */
async function fetchUserTier(): Promise<SubscriptionTier> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 'free';

  const { data, error } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return 'free';
  }

  // WHY: Validate the tier value with Zod to catch unexpected enum values
  // from the database. Falls back to 'free' if the tier is invalid.
  // Cast is safe: we fall back to 'free' for any unrecognized tier value.
  const validated = safeParseSingle(SubscriptionTierRowSchema, data, 'subscription_tier');
  return (validated?.tier as SubscriptionTier) || 'free';
}

/**
 * Metric cache key combining alert type, period, and agent type for lookup.
 *
 * WHY: Alerts with the same alertType, period, and agentType can share one
 * Supabase query. Adding alertType to the key prevents a subscription_quota
 * alert from reusing the cache entry of a cost_usd alert with the same period
 * (they query different columns from cost_records).
 *
 * @param alertType - Alert aggregation type (migration 023)
 * @param period - Budget alert period
 * @param agentType - Agent type scope (null = all agents)
 * @returns Cache key string
 */
function metricCacheKey(alertType: BudgetAlertType, period: BudgetAlertPeriod, agentType: string | null): string {
  return `${alertType}:${period}:${agentType || 'all'}`;
}

/**
 * Map a database row to a BudgetAlert with computed spend/metric data.
 *
 * @param row - Raw database row (including migration 023 columns)
 * @param metricCache - Pre-fetched metric totals keyed by (alertType:period:agentType)
 * @returns A fully hydrated BudgetAlert object
 */
function mapRowToAlert(
  row: BudgetAlertRow,
  metricCache: Map<string, number>,
): BudgetAlert {
  const period = row.period as BudgetAlertPeriod;
  const alertType = (row.alert_type as BudgetAlertType) || 'cost_usd';
  const thresholdQuotaFraction = row.threshold_quota_fraction ?? null;
  const thresholdCredits = row.threshold_credits ?? null;

  // WHY per-type threshold: each alert type uses a different threshold column.
  let threshold: number;
  if (alertType === 'subscription_quota') {
    threshold = thresholdQuotaFraction ?? 0;
  } else if (alertType === 'credits') {
    threshold = thresholdCredits ?? 0;
  } else {
    threshold = Number(row.threshold_usd) || 0;
  }

  const key = metricCacheKey(alertType, period, row.agent_type);
  const currentSpend = metricCache.get(key) || 0;

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    threshold,
    period,
    agentType: (row.agent_type as AgentType) || null,
    action: DB_TO_ACTION[row.action] || 'notify',
    enabled: row.is_enabled,
    currentSpend,
    percentUsed: threshold > 0 ? (currentSpend / threshold) * 100 : 0,
    triggeredAt: row.last_triggered_at,
    createdAt: row.created_at,
    alertType,
    thresholdQuotaFraction,
    thresholdCredits,
  };
}

// ============================================================================
// Hook
// ============================================================================

/**
 * React hook for managing budget alerts.
 *
 * Fetches budget alerts from Supabase, calculates current spend for each
 * alert's period, and provides CRUD operations. Enforces tier-based limits
 * on the number of alerts a user can create.
 *
 * @returns Budget alerts data, CRUD functions, tier info, and loading state
 *
 * @example
 * const { alerts, createAlert, deleteAlert, tier, alertLimit, isLoading } = useBudgetAlerts();
 *
 * if (tier === 'free') return <UpgradePrompt />;
 *
 * return (
 *   <FlatList
 *     data={alerts}
 *     renderItem={({ item }) => <AlertCard alert={item} />}
 *   />
 * );
 */
export function useBudgetAlerts(): UseBudgetAlertsReturn {
  const [alerts, setAlerts] = useState<BudgetAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState<SubscriptionTier>('free');
  const [refreshKey, setRefreshKey] = useState(0);

  const alertLimit = TIER_ALERT_LIMITS[tier];

  /**
   * Fetch all budget alerts and compute their current spend.
   *
   * WHY: We fetch alerts and spend data in parallel. Spend is aggregated
   * per-period (daily/weekly/monthly) once, then shared across all alerts
   * with the same period to avoid redundant queries.
   */
  const fetchAlerts = useCallback(async () => {
    try {
      setError(null);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setAlerts([]);
        setIsLoading(false);
        return;
      }

      // Fetch alerts and tier in parallel.
      // WHY explicit column list: mirrors the web route convention and makes
      // migration 023 columns explicit for reviewers.
      const [alertsResult, userTier] = await Promise.all([
        supabase
          .from('budget_alerts')
          .select('id, user_id, name, threshold_usd, period, agent_type, action, is_enabled, last_triggered_at, created_at, alert_type, threshold_quota_fraction, threshold_credits')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        fetchUserTier(),
      ]);

      setTier(userTier);

      if (alertsResult.error) {
        throw new Error(alertsResult.error.message);
      }

      // WHY: Validate each alert row with Zod before mapping to the UI type.
      // Invalid rows are dropped so the UI never shows corrupted alert data.
      const rows = safeParseArray(
        BudgetAlertSchema,
        alertsResult.data,
        'budget_alerts',
      ) as BudgetAlertRow[];

      if (rows.length === 0) {
        setAlerts([]);
        return;
      }

      // WHY: Determine which unique (alertType, period, agentType) combinations
      // we need metric data for. Adding alertType to the key means a cost_usd
      // alert and a subscription_quota alert with the same period never share
      // a cache entry — they query different columns from cost_records.
      const metricKeysNeeded = new Set<string>(
        rows.map((r) =>
          metricCacheKey(
            ((r.alert_type as BudgetAlertType) || 'cost_usd'),
            r.period as BudgetAlertPeriod,
            r.agent_type
          )
        )
      );

      const metricCache = new Map<string, number>();

      const metricPromises = Array.from(metricKeysNeeded).map(async (key) => {
        // Key format: "alertType:period:agentType|all"
        const parts = key.split(':') as [BudgetAlertType, BudgetAlertPeriod, string];
        const [alertType, period, agentPart] = parts;
        const agentType = agentPart === 'all' ? null : agentPart;
        const metric = await fetchPeriodMetric(user.id, period, alertType, agentType);
        metricCache.set(key, metric);
      });

      await Promise.all(metricPromises);

      const mappedAlerts = rows.map((row) => mapRowToAlert(row, metricCache));
      setAlerts(mappedAlerts);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load budget alerts';
      setError(message);
      // WHY: Raw error objects can leak stack traces and internal state in production.
      console.error('[BudgetAlerts] Fetch failed:', __DEV__ ? err : (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Initial load and refresh trigger.
   */
  useEffect(() => {
    setIsLoading(true);
    fetchAlerts();
  }, [fetchAlerts, refreshKey]);

  /**
   * Create a new budget alert.
   *
   * Validates the user hasn't exceeded their tier's alert limit before inserting.
   * Maps UI action names to database-compatible values.
   *
   * @param input - Alert configuration (name, threshold, period, action)
   * @throws {Error} When the user has reached their tier's alert limit
   * @throws {Error} When the Supabase insert fails
   */
  const createAlert = useCallback(async (input: CreateBudgetAlertInput): Promise<void> => {
    try {
      setError(null);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        throw new Error('You must be signed in to create budget alerts');
      }

      // WHY: Check tier limits client-side for immediate feedback. Server-side
      // RLS policies also enforce this, but checking here avoids a round-trip
      // for a clearly invalid operation.
      if (alerts.length >= alertLimit) {
        throw new Error(
          alertLimit === 0
            ? 'Budget alerts require a Pro or Power subscription'
            : `You've reached the maximum of ${alertLimit} alerts for your plan`
        );
      }

      const { error: insertError } = await supabase
        .from('budget_alerts')
        .insert({
          user_id: user.id,
          name: input.name,
          threshold_usd: input.threshold,
          period: input.period,
          agent_type: input.agentType || null,
          action: ACTION_TO_DB[input.action],
          is_enabled: input.enabled !== false,
          // Migration 023 fields — default to cost_usd / null when not supplied.
          alert_type: input.alertType ?? 'cost_usd',
          threshold_quota_fraction: input.thresholdQuotaFraction ?? null,
          threshold_credits: input.thresholdCredits ?? null,
        });

      if (insertError) {
        throw new Error(insertError.message);
      }

      // Refresh the alerts list to include the new alert with computed spend
      setRefreshKey((k) => k + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create alert';
      setError(message);
      throw err;
    }
  }, [alerts.length, alertLimit]);

  /**
   * Update an existing budget alert.
   *
   * Accepts partial updates and maps UI action names to database values.
   * Only sends changed fields to minimize the update payload.
   *
   * @param id - Alert UUID to update
   * @param updates - Partial alert fields to update
   * @throws {Error} When the Supabase update fails
   */
  const updateAlert = useCallback(async (
    id: string,
    updates: Partial<CreateBudgetAlertInput>
  ): Promise<void> => {
    try {
      setError(null);

      // Build the database update object, mapping field names and values.
      // WHY: Only include fields that were actually provided in the input.
      const dbUpdates: Record<string, unknown> = {};
      if (updates.name !== undefined) dbUpdates.name = updates.name;
      if (updates.threshold !== undefined) dbUpdates.threshold_usd = updates.threshold;
      if (updates.period !== undefined) dbUpdates.period = updates.period;
      if (updates.agentType !== undefined) dbUpdates.agent_type = updates.agentType || null;
      if (updates.action !== undefined) dbUpdates.action = ACTION_TO_DB[updates.action];
      if (updates.enabled !== undefined) dbUpdates.is_enabled = updates.enabled;
      // Migration 023 fields
      if (updates.alertType !== undefined) dbUpdates.alert_type = updates.alertType;
      if (updates.thresholdQuotaFraction !== undefined) dbUpdates.threshold_quota_fraction = updates.thresholdQuotaFraction;
      if (updates.thresholdCredits !== undefined) dbUpdates.threshold_credits = updates.thresholdCredits;

      const { error: updateError } = await supabase
        .from('budget_alerts')
        .update(dbUpdates)
        .eq('id', id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      // Refresh to get updated computed values
      setRefreshKey((k) => k + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update alert';
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Delete a budget alert.
   *
   * @param id - Alert UUID to delete
   * @throws {Error} When the Supabase delete fails
   */
  const deleteAlert = useCallback(async (id: string): Promise<void> => {
    try {
      setError(null);

      const { error: deleteError } = await supabase
        .from('budget_alerts')
        .delete()
        .eq('id', id);

      if (deleteError) {
        throw new Error(deleteError.message);
      }

      // WHY: Optimistic removal from local state for instant UI feedback.
      // The refreshKey increment below re-fetches from DB to ensure consistency.
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      setRefreshKey((k) => k + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete alert';
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Trigger a manual refresh of all alert data.
   */
  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  /**
   * Atomically check whether the user is blocked by a hard-stop budget alert.
   *
   * WHY: The inline approach (SELECT cost_records, sum in JS, compare threshold)
   * is vulnerable to race conditions. Two concurrent requests could both read the
   * same spend total, both pass the check, and both proceed. The database RPC
   * uses an advisory lock to serialize budget checks per user, eliminating the
   * concurrent-bypass window.
   *
   * @returns The hard-stop result, or null if the check could not be performed
   */
  const checkHardStop = useCallback(async (): Promise<BudgetHardStopResult | null> => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      const { data, error: rpcError } = await supabase
        .rpc('check_budget_hard_stop', { p_user_id: user.id });

      if (rpcError) {
        console.error(
          '[BudgetAlerts] Hard-stop check failed:',
          __DEV__ ? rpcError : (rpcError instanceof Error ? rpcError.message : 'Unknown error')
        );
        return null;
      }

      // WHY: The RPC returns a table (array of rows). If no hard-stop alert is
      // triggered, the result is an empty array. If one is triggered, it returns
      // a single row with the blocking alert's details.
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return {
          is_blocked: false,
          alert_id: null,
          threshold_usd: null,
          total_spend: null,
          period: null,
        };
      }

      // WHY: Validate the RPC response with Zod to catch unexpected shapes.
      // The RPC returns numeric fields that Postgres may serialize as strings,
      // so we use z.coerce.number() to handle both formats safely.
      const BudgetHardStopResponseSchema = z.object({
        is_blocked: z.boolean(),
        alert_id: z.string().nullable().optional(),
        threshold_usd: z.coerce.number().nullable().optional(),
        total_spend: z.coerce.number().nullable().optional(),
        period: z.string().nullable().optional(),
      });

      const raw = Array.isArray(data) ? data[0] : data;
      const validated = safeParseSingle(BudgetHardStopResponseSchema, raw, 'budget_hard_stop_rpc');

      if (!validated) {
        return null;
      }

      return {
        is_blocked: validated.is_blocked,
        alert_id: validated.alert_id ?? null,
        threshold_usd: validated.threshold_usd ?? null,
        total_spend: validated.total_spend ?? null,
        period: validated.period ?? null,
      };
    } catch (err) {
      console.error(
        '[BudgetAlerts] Hard-stop check error:',
        __DEV__ ? err : (err instanceof Error ? err.message : 'Unknown error')
      );
      return null;
    }
  }, []);

  return {
    alerts,
    isLoading,
    error,
    createAlert,
    updateAlert,
    deleteAlert,
    refresh,
    tier,
    alertLimit,
    checkHardStop,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the display label for a budget alert period.
 *
 * @param period - Budget alert period
 * @returns Human-readable period label (e.g., "per day")
 */
export function getPeriodLabel(period: BudgetAlertPeriod): string {
  switch (period) {
    case 'daily':
      return 'per day';
    case 'weekly':
      return 'per week';
    case 'monthly':
      return 'per month';
  }
}

/**
 * Get the display label for a budget alert action.
 *
 * @param action - Budget alert action
 * @returns Human-readable action label
 */
export function getActionLabel(action: BudgetAlertAction): string {
  switch (action) {
    case 'notify':
      return 'Notify';
    case 'slowdown':
      return 'Slowdown';
    case 'stop':
      return 'Stop';
  }
}

/**
 * Get the description for a budget alert action.
 *
 * @param action - Budget alert action
 * @returns Detailed description of what the action does
 */
export function getActionDescription(action: BudgetAlertAction): string {
  switch (action) {
    case 'notify':
      return 'Send push notification when threshold is reached';
    case 'slowdown':
      return 'Add confirmation step before expensive operations';
    case 'stop':
      return 'Pause agent sessions when threshold is exceeded';
  }
}

/**
 * Get the color for a budget alert progress bar based on percentage used.
 *
 * @param percentUsed - Percentage of threshold consumed (0-100+)
 * @returns Hex color code for the progress bar
 */
export function getAlertProgressColor(percentUsed: number): string {
  if (percentUsed > 100) return '#ef4444';  // Red - exceeded
  if (percentUsed >= 80) return '#f97316';  // Orange - approaching
  if (percentUsed >= 50) return '#eab308';  // Yellow - halfway
  return '#22c55e';                          // Green - under control
}

/**
 * Get the display label for a budget alert's agent scope.
 *
 * @param agentType - Agent type scope (null = all agents)
 * @returns Human-readable agent scope label
 */
export function getAgentScopeLabel(agentType: string | null): string {
  if (!agentType) return 'All Agents';
  switch (agentType) {
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
      return agentType;
  }
}

/**
 * Get the background opacity color for a budget alert action badge.
 *
 * @param action - Budget alert action
 * @returns Tailwind-compatible background color class suffix
 */
export function getActionBadgeColor(action: BudgetAlertAction): {
  bg: string;
  text: string;
} {
  switch (action) {
    case 'notify':
      return { bg: '#3b82f620', text: '#3b82f6' }; // Blue
    case 'slowdown':
      return { bg: '#eab30820', text: '#eab308' }; // Yellow
    case 'stop':
      return { bg: '#ef444420', text: '#ef4444' }; // Red
  }
}
