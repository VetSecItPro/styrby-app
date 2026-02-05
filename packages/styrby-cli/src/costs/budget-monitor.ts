/**
 * Budget Monitor
 *
 * Monitors user spending against budget alerts configured in Supabase.
 * Loads budget configurations and checks current spending against thresholds.
 *
 * Budget alerts are stored in the `budget_alerts` table and support:
 * - Daily, weekly, or monthly periods
 * - Optional agent-specific filtering
 * - Actions: notify, warn_and_slowdown, hard_stop
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentType } from 'styrby-shared';
import { getCostsForDateRange, type CostSummary } from './jsonl-parser.js';

// ============================================================================
// Validation Helpers
// ============================================================================

/** UUID v4 format regex for input validation */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates that a string is a properly formatted UUID v4.
 * WHY: Prevents injection attacks if service role key bypasses RLS.
 *
 * @param value - String to validate
 * @returns True if the string is a valid UUID v4 format
 */
function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

// ============================================================================
// Types
// ============================================================================

/**
 * Alert action types from the database
 */
export type BudgetAlertAction = 'notify' | 'warn_and_slowdown' | 'hard_stop';

/**
 * Alert period types from the database
 */
export type BudgetAlertPeriod = 'daily' | 'weekly' | 'monthly';

/**
 * Alert level returned by budget checks
 */
export type AlertLevel = 'ok' | 'warning' | 'critical' | 'exceeded';

/**
 * Budget alert configuration from Supabase
 */
export interface BudgetAlert {
  /** Unique alert ID */
  id: string;
  /** User ID */
  user_id: string;
  /** Human-readable alert name */
  name: string;
  /** Spending threshold in USD */
  threshold_usd: number;
  /** Time period for the budget */
  period: BudgetAlertPeriod;
  /** Optional: limit to specific agent type */
  agent_type: AgentType | null;
  /** Action to take when threshold is reached */
  action: BudgetAlertAction;
  /** Notification channels */
  notification_channels: string[];
  /** Whether alert is enabled */
  is_enabled: boolean;
  /** Last time alert was triggered */
  last_triggered_at: string | null;
  /** Created timestamp */
  created_at: string;
  /** Updated timestamp */
  updated_at: string;
}

/**
 * Result of a budget check
 */
export interface BudgetCheckResult {
  /** Alert level based on spending vs threshold */
  level: AlertLevel;
  /** The budget alert that was checked */
  alert: BudgetAlert;
  /** Current spending in USD for the period */
  currentSpendUsd: number;
  /** Percentage of budget used (0-100+) */
  percentUsed: number;
  /** Amount remaining before threshold */
  remainingUsd: number;
  /** Whether the threshold has been exceeded */
  exceeded: boolean;
  /** Whether this is a new trigger (wasn't triggered before) */
  isNewTrigger: boolean;
}

/**
 * Configuration for the budget monitor
 */
export interface BudgetMonitorConfig {
  /** Supabase client instance */
  supabase: SupabaseClient;
  /** User ID to monitor */
  userId: string;
  /** Warning threshold percentage (default: 80%) */
  warningThreshold?: number;
  /** Critical threshold percentage (default: 95%) */
  criticalThreshold?: number;
  /** Enable debug logging */
  debug?: boolean;
}

// ============================================================================
// Budget Monitor Class
// ============================================================================

/**
 * Budget monitor for checking spending against user-configured thresholds.
 *
 * @example
 * const monitor = new BudgetMonitor({
 *   supabase,
 *   userId: user.id,
 * });
 *
 * const results = await monitor.checkAllAlerts();
 * for (const result of results) {
 *   if (result.exceeded) {
 *     console.log(`Budget exceeded: ${result.alert.name}`);
 *   }
 * }
 */
export class BudgetMonitor {
  private config: Required<BudgetMonitorConfig>;
  private alertsCache: BudgetAlert[] | null = null;
  private alertsCacheTime: number = 0;
  private readonly CACHE_TTL_MS = 60_000; // 1 minute cache

  constructor(config: BudgetMonitorConfig) {
    if (!isValidUuid(config.userId)) {
      throw new Error('Invalid userId format: must be a valid UUID v4');
    }

    this.config = {
      warningThreshold: 80,
      criticalThreshold: 95,
      debug: false,
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * Load user's budget alerts from Supabase.
   * Results are cached for 1 minute to reduce database calls.
   *
   * @param forceRefresh - Force refresh from database, ignoring cache
   * @returns Array of budget alerts
   */
  async loadBudgetAlerts(forceRefresh = false): Promise<BudgetAlert[]> {
    // Check cache
    if (!forceRefresh && this.alertsCache && Date.now() - this.alertsCacheTime < this.CACHE_TTL_MS) {
      this.log('Using cached budget alerts');
      return this.alertsCache;
    }

    this.log('Loading budget alerts from Supabase');

    const { data, error } = await this.config.supabase
      .from('budget_alerts')
      .select('*')
      .eq('user_id', this.config.userId)
      .eq('is_enabled', true)
      .order('threshold_usd', { ascending: true });

    if (error) {
      this.log('Error loading budget alerts:', error.message);
      throw new Error(`Failed to load budget alerts: ${error.message}`);
    }

    this.alertsCache = data || [];
    this.alertsCacheTime = Date.now();
    this.log(`Loaded ${this.alertsCache.length} active budget alerts`);

    return this.alertsCache;
  }

  /**
   * Check spending against a single budget alert.
   *
   * When the alert has an `agent_type` set, costs are filtered to only include
   * usage from models belonging to that agent. When `agent_type` is null, costs
   * are aggregated across all agents.
   *
   * @param alert - Budget alert to check
   * @param currentCosts - Optional pre-fetched cost summary for the period.
   *                       NOTE: If the alert has an agent_type filter and you
   *                       pass pre-fetched costs, those costs should already be
   *                       filtered by the same agent type. If not provided, costs
   *                       are fetched with the correct agent filter automatically.
   * @returns Budget check result
   */
  async checkAlert(alert: BudgetAlert, currentCosts?: CostSummary): Promise<BudgetCheckResult> {
    // Get costs for the alert's period, filtered by agent type when applicable
    const costs = currentCosts || await this.getCostsForPeriod(alert.period, alert.agent_type ?? undefined);

    const spendingUsd = costs.totalCostUsd;

    const percentUsed = (spendingUsd / alert.threshold_usd) * 100;
    const exceeded = spendingUsd >= alert.threshold_usd;
    const remainingUsd = Math.max(0, alert.threshold_usd - spendingUsd);

    // Determine alert level
    let level: AlertLevel = 'ok';
    if (exceeded) {
      level = 'exceeded';
    } else if (percentUsed >= this.config.criticalThreshold) {
      level = 'critical';
    } else if (percentUsed >= this.config.warningThreshold) {
      level = 'warning';
    }

    // Check if this is a new trigger (alert wasn't triggered in current period)
    const isNewTrigger = exceeded && !this.wasTriggeredInPeriod(alert);

    this.log(
      `Alert "${alert.name}": $${spendingUsd.toFixed(2)}/$${alert.threshold_usd.toFixed(2)} (${percentUsed.toFixed(1)}%) - ${level}`
    );

    return {
      level,
      alert,
      currentSpendUsd: spendingUsd,
      percentUsed,
      remainingUsd,
      exceeded,
      isNewTrigger,
    };
  }

  /**
   * Check spending against all active budget alerts.
   *
   * @returns Array of budget check results, sorted by severity
   */
  async checkAllAlerts(): Promise<BudgetCheckResult[]> {
    const alerts = await this.loadBudgetAlerts();
    if (alerts.length === 0) {
      this.log('No active budget alerts configured');
      return [];
    }

    // Pre-fetch costs for each unique (period, agentType) combination to avoid
    // duplicate queries. The cache key encodes both dimensions.
    // WHY: Alerts can filter by agent type (e.g., "claude daily $10" vs "all agents
    // monthly $50"). We need separate cost queries for each agent filter.
    const costCache: Map<string, CostSummary> = new Map();

    const results: BudgetCheckResult[] = [];

    for (const alert of alerts) {
      const cacheKey = `${alert.period}:${alert.agent_type ?? 'all'}`;

      if (!costCache.has(cacheKey)) {
        costCache.set(
          cacheKey,
          await this.getCostsForPeriod(alert.period, alert.agent_type ?? undefined)
        );
      }

      const result = await this.checkAlert(alert, costCache.get(cacheKey)!);
      results.push(result);
    }

    // Sort by severity: exceeded > critical > warning > ok
    const levelOrder: Record<AlertLevel, number> = {
      exceeded: 0,
      critical: 1,
      warning: 2,
      ok: 3,
    };

    return results.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);
  }

  /**
   * Get the most severe alert result from all active alerts.
   *
   * @returns Most severe budget check result, or null if no alerts
   */
  async getMostSevereAlert(): Promise<BudgetCheckResult | null> {
    const results = await this.checkAllAlerts();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Check if any budget has been exceeded.
   *
   * @returns True if any budget is exceeded
   */
  async hasExceededBudget(): Promise<boolean> {
    const results = await this.checkAllAlerts();
    return results.some((r) => r.exceeded);
  }

  /**
   * Get all exceeded alerts.
   *
   * @returns Array of exceeded budget check results
   */
  async getExceededAlerts(): Promise<BudgetCheckResult[]> {
    const results = await this.checkAllAlerts();
    return results.filter((r) => r.exceeded);
  }

  /**
   * Get alerts requiring action (warning, critical, or exceeded).
   *
   * @returns Array of actionable budget check results
   */
  async getActionableAlerts(): Promise<BudgetCheckResult[]> {
    const results = await this.checkAllAlerts();
    return results.filter((r) => r.level !== 'ok');
  }

  /**
   * Mark an alert as triggered (update last_triggered_at in database).
   *
   * @param alertId - Alert ID to mark as triggered
   */
  async markAlertTriggered(alertId: string): Promise<void> {
    this.log(`Marking alert ${alertId} as triggered`);

    const { error } = await this.config.supabase
      .from('budget_alerts')
      .update({ last_triggered_at: new Date().toISOString() })
      .eq('id', alertId)
      .eq('user_id', this.config.userId);

    if (error) {
      this.log('Error marking alert triggered:', error.message);
      throw new Error(`Failed to mark alert triggered: ${error.message}`);
    }

    // Invalidate cache
    this.alertsCache = null;
  }

  /**
   * Clear the alerts cache, forcing a fresh load on next check.
   */
  clearCache(): void {
    this.alertsCache = null;
    this.alertsCacheTime = 0;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * Get costs for a specific period using local JSONL data, optionally
   * filtered by agent type.
   *
   * @param period - Budget period (daily, weekly, monthly)
   * @param agentType - Optional agent type to filter costs by. When provided,
   *                    only costs from models belonging to that agent are included.
   * @returns Aggregated cost summary for the period
   */
  private async getCostsForPeriod(period: BudgetAlertPeriod, agentType?: AgentType): Promise<CostSummary> {
    const now = new Date();
    let startDate: Date;

    switch (period) {
      case 'daily':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'weekly': {
        // Start of week (Sunday)
        const dayOfWeek = now.getDay();
        startDate = new Date(now);
        startDate.setDate(now.getDate() - dayOfWeek);
        startDate.setHours(0, 0, 0, 0);
        break;
      }
      case 'monthly':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
    }

    return getCostsForDateRange(startDate, now, undefined, agentType);
  }

  /**
   * Check if an alert was already triggered in the current period.
   */
  private wasTriggeredInPeriod(alert: BudgetAlert): boolean {
    if (!alert.last_triggered_at) {
      return false;
    }

    const lastTriggered = new Date(alert.last_triggered_at);
    const now = new Date();
    let periodStart: Date;

    switch (alert.period) {
      case 'daily':
        periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'weekly':
        const dayOfWeek = now.getDay();
        periodStart = new Date(now);
        periodStart.setDate(now.getDate() - dayOfWeek);
        periodStart.setHours(0, 0, 0, 0);
        break;
      case 'monthly':
        periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
    }

    return lastTriggered >= periodStart;
  }

  /**
   * Log a message if debug is enabled.
   */
  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[BudgetMonitor]', ...args);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a budget monitor instance.
 *
 * @param config - Budget monitor configuration
 * @returns Budget monitor instance
 */
export function createBudgetMonitor(config: BudgetMonitorConfig): BudgetMonitor {
  return new BudgetMonitor(config);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format a budget check result as a user-friendly message.
 *
 * @param result - Budget check result to format
 * @returns Formatted message string
 */
export function formatBudgetMessage(result: BudgetCheckResult): string {
  const { alert, currentSpendUsd, percentUsed, level } = result;
  const spent = currentSpendUsd.toFixed(2);
  const threshold = alert.threshold_usd.toFixed(2);
  const percent = percentUsed.toFixed(0);

  switch (level) {
    case 'exceeded':
      return `Budget exceeded: "${alert.name}" - $${spent}/$${threshold} (${percent}%)`;
    case 'critical':
      return `Budget critical: "${alert.name}" - $${spent}/$${threshold} (${percent}%)`;
    case 'warning':
      return `Budget warning: "${alert.name}" - $${spent}/$${threshold} (${percent}%)`;
    default:
      return `Budget OK: "${alert.name}" - $${spent}/$${threshold} (${percent}%)`;
  }
}

/**
 * Get the emoji indicator for an alert level.
 *
 * @param level - Alert level
 * @returns Emoji string
 */
export function getAlertLevelEmoji(level: AlertLevel): string {
  switch (level) {
    case 'exceeded':
      return '\u{1F6A8}'; // Police car light (red)
    case 'critical':
      return '\u{26A0}\u{FE0F}'; // Warning sign
    case 'warning':
      return '\u{1F7E1}'; // Yellow circle
    default:
      return '\u{2705}'; // Green check
  }
}
