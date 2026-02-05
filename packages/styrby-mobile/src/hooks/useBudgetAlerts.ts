/**
 * Budget Alerts Hook
 *
 * Fetches, creates, updates, and deletes budget alerts from Supabase.
 * Calculates current spend and percentage used for each alert by querying
 * cost_records for the relevant time period.
 *
 * Also fetches the user's subscription tier to enforce alert count limits:
 * - Free: 0 budget alerts (feature locked)
 * - Pro: 3 budget alerts
 * - Power: 10 budget alerts
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { SubscriptionTier } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Budget alert period for spend aggregation.
 * Determines the time window over which spend is measured against the threshold.
 */
export type BudgetAlertPeriod = 'daily' | 'weekly' | 'monthly';

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
  /** USD threshold that triggers the alert */
  threshold: number;
  /** Time period for spend aggregation */
  period: BudgetAlertPeriod;
  /** What happens when the threshold is reached */
  action: BudgetAlertAction;
  /** Whether the alert is currently active */
  enabled: boolean;
  /** Calculated current spend in USD for the alert's period */
  currentSpend: number;
  /** Calculated percentage of threshold used (currentSpend / threshold * 100) */
  percentUsed: number;
  /** ISO timestamp when the alert was last triggered, or null */
  triggeredAt: string | null;
  /** ISO timestamp when the alert was created */
  createdAt: string;
}

/**
 * Input for creating a new budget alert.
 * Excludes server-generated and computed fields.
 */
export interface CreateBudgetAlertInput {
  /** Human-readable alert name */
  name: string;
  /** USD threshold amount */
  threshold: number;
  /** Time period for spend aggregation */
  period: BudgetAlertPeriod;
  /** Action to take when threshold is reached */
  action: BudgetAlertAction;
  /** Whether the alert starts enabled (defaults to true) */
  enabled?: boolean;
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
  power: 10,
  team: 10,
};

// ============================================================================
// Supabase Row Types
// ============================================================================

/**
 * Raw row shape from the budget_alerts table.
 */
interface BudgetAlertRow {
  id: string;
  user_id: string;
  name: string;
  threshold_usd: number;
  period: string;
  action: string;
  is_enabled: boolean;
  last_triggered_at: string | null;
  created_at: string;
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
 * Fetch the current user's spend for a given period from cost_records.
 *
 * @param userId - The user's UUID
 * @param period - Budget alert period to aggregate
 * @returns Total spend in USD for the period
 */
async function fetchPeriodSpend(userId: string, period: BudgetAlertPeriod): Promise<number> {
  const startDate = getPeriodStartDate(period);

  const { data, error } = await supabase
    .from('cost_records')
    .select('cost_usd')
    .eq('user_id', userId)
    .gte('record_date', startDate);

  if (error) {
    if (__DEV__) console.error(`[BudgetAlerts] Failed to fetch ${period} spend:`, error.message);
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

  return (data.tier as SubscriptionTier) || 'free';
}

/**
 * Map a database row to a BudgetAlert with computed spend data.
 *
 * @param row - Raw database row
 * @param periodSpends - Pre-fetched spend totals keyed by period
 * @returns A fully hydrated BudgetAlert object
 */
function mapRowToAlert(
  row: BudgetAlertRow,
  periodSpends: Record<BudgetAlertPeriod, number>
): BudgetAlert {
  const threshold = Number(row.threshold_usd) || 0;
  const period = row.period as BudgetAlertPeriod;
  const currentSpend = periodSpends[period] || 0;

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    threshold,
    period,
    action: DB_TO_ACTION[row.action] || 'notify',
    enabled: row.is_enabled,
    currentSpend,
    percentUsed: threshold > 0 ? (currentSpend / threshold) * 100 : 0,
    triggeredAt: row.last_triggered_at,
    createdAt: row.created_at,
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

      // Fetch alerts and tier in parallel
      const [alertsResult, userTier] = await Promise.all([
        supabase
          .from('budget_alerts')
          .select('id, user_id, name, threshold_usd, period, action, is_enabled, last_triggered_at, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        fetchUserTier(),
      ]);

      setTier(userTier);

      if (alertsResult.error) {
        throw new Error(alertsResult.error.message);
      }

      const rows = (alertsResult.data || []) as BudgetAlertRow[];

      if (rows.length === 0) {
        setAlerts([]);
        return;
      }

      // WHY: Determine which periods we need spend data for, then fetch only
      // the distinct periods. This avoids fetching the same period's spend
      // multiple times when multiple alerts share the same period.
      const periodsNeeded = new Set<BudgetAlertPeriod>(
        rows.map((r) => r.period as BudgetAlertPeriod)
      );

      const periodSpends: Record<BudgetAlertPeriod, number> = {
        daily: 0,
        weekly: 0,
        monthly: 0,
      };

      const spendPromises = Array.from(periodsNeeded).map(async (period) => {
        periodSpends[period] = await fetchPeriodSpend(user.id, period);
      });

      await Promise.all(spendPromises);

      const mappedAlerts = rows.map((row) => mapRowToAlert(row, periodSpends));
      setAlerts(mappedAlerts);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load budget alerts';
      setError(message);
      if (__DEV__) console.error('[BudgetAlerts] Fetch failed:', err);
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
          action: ACTION_TO_DB[input.action],
          is_enabled: input.enabled !== false,
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

      // Build the database update object, mapping field names and values
      const dbUpdates: Record<string, unknown> = {};
      if (updates.name !== undefined) dbUpdates.name = updates.name;
      if (updates.threshold !== undefined) dbUpdates.threshold_usd = updates.threshold;
      if (updates.period !== undefined) dbUpdates.period = updates.period;
      if (updates.action !== undefined) dbUpdates.action = ACTION_TO_DB[updates.action];
      if (updates.enabled !== undefined) dbUpdates.is_enabled = updates.enabled;

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
