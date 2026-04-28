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
 * - Alert types (added in migration 023):
 *   - cost_usd: sum cost_usd for billing_model = 'api-key' rows
 *   - subscription_quota: MAX(subscription_fraction_used) for billing_model = 'subscription'
 *   - credits: sum credits_consumed for billing_model = 'credit'
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
 * Alert type determining which cost_records aggregation to use.
 * Added in migration 023 (PR-E: quota-aware budget alerts).
 *
 * WHY: Different billing models need different aggregation logic:
 *   cost_usd           → sum cost_usd for api-key rows (legacy, default)
 *   subscription_quota → MAX(subscription_fraction_used) for subscription rows
 *   credits            → sum credits_consumed for credit rows
 */
export type BudgetAlertType = 'cost_usd' | 'subscription_quota' | 'credits';

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
  /** Spending threshold in USD (used for cost_usd alerts) */
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
  /**
   * Alert type controlling which aggregation is used.
   * Defaults to 'cost_usd' so pre-023 rows are handled identically to before.
   * Added in migration 023.
   */
  alert_type?: BudgetAlertType;
  /**
   * Subscription quota fraction threshold (0 < x <= 1).
   * Required when alert_type = 'subscription_quota'. NULL otherwise.
   * Example: 0.80 = alert when 80% of subscription quota is consumed.
   */
  threshold_quota_fraction?: number | null;
  /**
   * Credit count threshold (positive integer).
   * Required when alert_type = 'credits'. NULL otherwise.
   */
  threshold_credits?: number | null;
}

/**
 * Result of a budget check
 */
export interface BudgetCheckResult {
  /** Alert level based on spending vs threshold */
  level: AlertLevel;
  /** The budget alert that was checked */
  alert: BudgetAlert;
  /**
   * Current spending in USD for the period.
   * For subscription_quota alerts this is 0 (quota fraction is used instead).
   * For credits alerts this is credits_consumed * credit_rate (informational only).
   */
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
 * Pre-resolved Supabase values for non-cost_usd alert types.
 *
 * Populated by `checkAllAlerts()` after its bulk pre-fetch step and injected
 * into `checkAlert()` so the per-alert call can skip the individual Supabase
 * round-trip that would otherwise be issued by the private helper methods.
 *
 * WHY both fields optional: a given alert is exactly one of the three types, so
 * only the field matching its `alert_type` will be populated on each invocation.
 */
export interface PreResolvedAlertValues {
  /**
   * Pre-fetched MAX(subscription_fraction_used) for subscription_quota alerts.
   * When present, `checkAlert()` uses this directly instead of querying Supabase.
   */
  fraction?: number;
  /**
   * Pre-fetched sum(credits_consumed) for credits alerts.
   * When present, `checkAlert()` uses this directly instead of querying Supabase.
   */
  credits?: number;
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
      // WHY explicit column list: avoids accidentally exposing future columns
      // and makes the migration 023 columns explicit at the query level.
      .select('id, user_id, name, threshold_usd, period, agent_type, action, notification_channels, is_enabled, last_triggered_at, created_at, updated_at, alert_type, threshold_quota_fraction, threshold_credits')
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
   * Branches on `alert.alert_type` to use the correct aggregation:
   *   - cost_usd:           sum cost_usd for api-key rows (legacy / default)
   *   - subscription_quota: MAX(subscription_fraction_used) for subscription rows
   *   - credits:            sum credits_consumed for credit rows
   *
   * When the alert has an `agent_type` set, costs are filtered to only include
   * usage from models belonging to that agent. When `agent_type` is null, costs
   * are aggregated across all agents.
   *
   * @param alert - Budget alert to check
   * @param currentCosts - Optional pre-fetched cost summary (cost_usd type only).
   *                       Ignored for subscription_quota and credits alert types.
   * @param preResolved - Optional pre-fetched values for subscription_quota and
   *                      credits alert types, populated by checkAllAlerts() to
   *                      avoid N Supabase round-trips when N alerts share the same
   *                      period+agentType key.
   * @returns Budget check result
   */
  async checkAlert(
    alert: BudgetAlert,
    currentCosts?: CostSummary,
    preResolved?: PreResolvedAlertValues
  ): Promise<BudgetCheckResult> {
    // Resolve the effective alert type, defaulting to 'cost_usd' for pre-023 rows.
    const alertType: BudgetAlertType = alert.alert_type ?? 'cost_usd';

    let spendingUsd: number;
    let threshold: number;

    if (alertType === 'subscription_quota') {
      // WHY: Subscription users have cost_usd = $0 in cost_records because Styrby
      // has no per-session billing visibility into third-party subscription plans.
      // The meaningful signal is subscription_fraction_used — the fraction of the
      // subscription's quota consumed this session (0–1). We take the MAX across
      // all subscription rows in the period, since consecutive sessions accumulate.
      // We then express it as a USD-equivalent percentage of the quota threshold
      // so the generic level-determination logic below works unchanged.
      //
      // WHY preResolved.fraction: checkAllAlerts() pre-fetches one Supabase query
      // per unique (period, agentType) key and injects the result here. Without
      // this, N subscription_quota alerts with the same key would each issue their
      // own Supabase round-trip (N queries instead of 1).
      const fraction =
        preResolved?.fraction !== undefined
          ? preResolved.fraction
          : await this.getSubscriptionFractionForPeriod(alert.period, alert.agent_type ?? undefined);
      const quotaThreshold = alert.threshold_quota_fraction ?? 0;

      // WHY: Represent the fraction as a pseudo-USD so the existing
      // percentUsed / exceeded / remainingUsd math applies identically.
      // threshold = 1.0 (full quota), current = fraction (0–1).
      // We scale both to the quota threshold value so level boundaries work.
      spendingUsd = fraction;
      threshold = quotaThreshold;

      this.log(
        `Alert "${alert.name}" [subscription_quota]: ${(fraction * 100).toFixed(1)}% of quota (threshold ${(quotaThreshold * 100).toFixed(0)}%)`
      );
    } else if (alertType === 'credits') {
      // WHY: Credit-billed agents (e.g., Kiro) track consumption in integer credits,
      // not USD. We sum credits_consumed for billing_model = 'credit' rows and
      // compare against the integer threshold_credits. We represent credits as
      // a pseudo-USD to reuse the percentUsed / exceeded / remainingUsd math.
      //
      // WHY preResolved.credits: same deduplication rationale as fraction above.
      const creditsConsumed =
        preResolved?.credits !== undefined
          ? preResolved.credits
          : await this.getCreditsConsumedForPeriod(alert.period, alert.agent_type ?? undefined);
      const creditsThreshold = alert.threshold_credits ?? 0;

      spendingUsd = creditsConsumed;
      threshold = creditsThreshold;

      this.log(
        `Alert "${alert.name}" [credits]: ${creditsConsumed} credits consumed (threshold ${creditsThreshold})`
      );
    } else {
      // cost_usd — legacy default behavior.
      // WHY: Filter on billing_model = 'api-key' so subscription rows ($0)
      // and credit rows don't dilute the sum. Pre-023 rows default to 'api-key'
      // so old data remains correctly accounted for.
      const costs = currentCosts || await this.getCostsForPeriod(alert.period, alert.agent_type ?? undefined);
      spendingUsd = costs.totalCostUsd;
      threshold = alert.threshold_usd;

      this.log(
        `Alert "${alert.name}" [cost_usd]: $${spendingUsd.toFixed(2)}/$${threshold.toFixed(2)}`
      );
    }

    // WHY: Guard against a zero threshold producing Infinity for percentUsed.
    // A threshold of 0 is invalid per DB CHECK constraints, but we defend here
    // for belt-and-suspenders safety.
    const percentUsed = threshold > 0 ? (spendingUsd / threshold) * 100 : 0;
    const exceeded = threshold > 0 && spendingUsd >= threshold;
    const remainingUsd = Math.max(0, threshold - spendingUsd);

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

    this.log(`  → level=${level} (${percentUsed.toFixed(1)}%)`);

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
   * Cost fetches are deduplicated by (alertType, period, agentType) so alerts
   * sharing the same combination reuse a single Supabase/JSONL query.
   *
   * WHY three separate caches (cost_usd, subscription_quota, credits):
   *   Each alert type reads different columns from cost_records. Mixing them
   *   into a single cache key would require knowing which type a given fetch
   *   represents and would complicate the type-safe lookup at call time.
   *   Keeping three small Maps is simpler and equally efficient.
   *
   * @returns Array of budget check results, sorted by severity
   */
  async checkAllAlerts(): Promise<BudgetCheckResult[]> {
    const alerts = await this.loadBudgetAlerts();
    if (alerts.length === 0) {
      this.log('No active budget alerts configured');
      return [];
    }

    // ---------------------------------------------------------------------------
    // Build per-type unique keys and pre-fetch in parallel.
    // ---------------------------------------------------------------------------

    // cost_usd alerts: keyed by "period:agentType"
    const costUsdAlerts = alerts.filter((a) => (a.alert_type ?? 'cost_usd') === 'cost_usd');
    const costUsdKeys = [...new Set(costUsdAlerts.map((a) => `${a.period}:${a.agent_type ?? 'all'}`))];

    // subscription_quota alerts: keyed by "period:agentType"
    const quotaAlerts = alerts.filter((a) => a.alert_type === 'subscription_quota');
    const quotaKeys = [...new Set(quotaAlerts.map((a) => `${a.period}:${a.agent_type ?? 'all'}`))];

    // credits alerts: keyed by "period:agentType"
    const creditAlerts = alerts.filter((a) => a.alert_type === 'credits');
    const creditKeys = [...new Set(creditAlerts.map((a) => `${a.period}:${a.agent_type ?? 'all'}`))];

    // WHY: Fetch all three sets concurrently to minimize total latency.
    const [costUsdEntries, quotaEntries, creditEntries] = await Promise.all([
      // cost_usd: JSONL-based cost summaries
      Promise.all(
        costUsdKeys.map(async (key) => {
          const [period, agentPart] = key.split(':') as [string, string];
          const cost = await this.getCostsForPeriod(
            period as BudgetAlertPeriod,
            agentPart === 'all' ? undefined : (agentPart as AgentType)
          );
          return [key, cost] as [string, CostSummary];
        })
      ),
      // subscription_quota: MAX(subscription_fraction_used) per key
      Promise.all(
        quotaKeys.map(async (key) => {
          const [period, agentPart] = key.split(':') as [string, string];
          const fraction = await this.getSubscriptionFractionForPeriod(
            period as BudgetAlertPeriod,
            agentPart === 'all' ? undefined : (agentPart as AgentType)
          );
          return [key, fraction] as [string, number];
        })
      ),
      // credits: sum(credits_consumed) per key
      Promise.all(
        creditKeys.map(async (key) => {
          const [period, agentPart] = key.split(':') as [string, string];
          const credits = await this.getCreditsConsumedForPeriod(
            period as BudgetAlertPeriod,
            agentPart === 'all' ? undefined : (agentPart as AgentType)
          );
          return [key, credits] as [string, number];
        })
      ),
    ]);

    const costUsdCache = new Map<string, CostSummary>(costUsdEntries);
    const quotaCache = new Map<string, number>(quotaEntries);
    const creditCache = new Map<string, number>(creditEntries);

    // WHY: checkAlert calls are independent once caches are populated.
    // Run them in parallel to avoid sequential latency.
    //
    // WHY preResolved injection: each alert receives the pre-fetched value for its
    // (period, agentType) key so checkAlert() uses the cached result directly
    // instead of issuing a fresh Supabase query per alert. Without this, N alerts
    // sharing the same key would produce N Supabase round-trips; with it, only
    // 1 query per unique key was issued in the parallel pre-fetch above.
    const results = await Promise.all(
      alerts.map((alert) => {
        const cacheKey = `${alert.period}:${alert.agent_type ?? 'all'}`;
        const alertType = alert.alert_type ?? 'cost_usd';

        if (alertType === 'subscription_quota') {
          // Pass the pre-fetched fraction so checkAlert skips the Supabase re-query.
          const preResolved: PreResolvedAlertValues = { fraction: quotaCache.get(cacheKey) ?? 0 };
          return this.checkAlert(alert, undefined, preResolved);
        }

        if (alertType === 'credits') {
          // Pass the pre-fetched credit total so checkAlert skips the Supabase re-query.
          const preResolved: PreResolvedAlertValues = { credits: creditCache.get(cacheKey) ?? 0 };
          return this.checkAlert(alert, undefined, preResolved);
        }

        // cost_usd: pass pre-fetched summary to avoid re-reading JSONL
        return this.checkAlert(alert, costUsdCache.get(cacheKey)!);
      })
    );

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
   * Fetch the MAX subscription_fraction_used for a period from Supabase.
   *
   * WHY MAX not SUM: subscription_fraction_used represents the current quota
   * consumption as a fraction (0–1). Consecutive sessions within a period
   * may each report the cumulative fraction, so MAX gives the high-water mark.
   * Summing would double-count if the agent reports a running total each session.
   *
   * WHY filter billing_model = 'subscription': Only subscription rows carry a
   * non-NULL subscription_fraction_used. Including api-key or credit rows would
   * always return NULL and break the aggregation.
   *
   * Returns 0 when no subscription rows exist for the period (user hasn't used
   * their subscription, or agent doesn't report quota data).
   *
   * @param period - Budget period (daily, weekly, monthly)
   * @param agentType - Optional agent type to filter by
   * @returns Highest fraction consumed in the period (0–1)
   */
  private async getSubscriptionFractionForPeriod(period: BudgetAlertPeriod, agentType?: AgentType): Promise<number> {
    const { startDate } = this.getPeriodDates(period);

    let query = this.config.supabase
      .from('cost_records')
      .select('subscription_fraction_used')
      .eq('user_id', this.config.userId)
      .eq('billing_model', 'subscription')
      .gte('record_date', startDate.toISOString().split('T')[0])
      .not('subscription_fraction_used', 'is', null)
      .limit(10_000);

    if (agentType) {
      query = query.eq('agent_type', agentType);
    }

    const { data, error } = await query;

    if (error) {
      this.log('Error fetching subscription fraction:', error.message);
      return 0;
    }

    if (!data || data.length === 0) {
      return 0;
    }

    // WHY: Take MAX; see docstring above.
    return Math.max(...data.map((r) => Number(r.subscription_fraction_used) || 0));
  }

  /**
   * Fetch the sum of credits_consumed for a period from Supabase.
   *
   * WHY SUM not MAX: credits are consumed additively within a period.
   * Each session consumes an independent number of credits, so the total
   * is the running sum of all sessions' credits_consumed values.
   *
   * WHY filter billing_model = 'credit': Only credit rows carry a non-NULL
   * credits_consumed. Including api-key or subscription rows would introduce
   * NULL coercion bugs (Number(null) = 0 silently).
   *
   * Returns 0 when no credit rows exist (user hasn't used a credit-billed agent,
   * or no sessions occurred in the period).
   *
   * @param period - Budget period (daily, weekly, monthly)
   * @param agentType - Optional agent type to filter by
   * @returns Total credits consumed in the period
   */
  private async getCreditsConsumedForPeriod(period: BudgetAlertPeriod, agentType?: AgentType): Promise<number> {
    const { startDate } = this.getPeriodDates(period);

    let query = this.config.supabase
      .from('cost_records')
      .select('credits_consumed')
      .eq('user_id', this.config.userId)
      .eq('billing_model', 'credit')
      .gte('record_date', startDate.toISOString().split('T')[0])
      .not('credits_consumed', 'is', null)
      .limit(10_000);

    if (agentType) {
      query = query.eq('agent_type', agentType);
    }

    const { data, error } = await query;

    if (error) {
      this.log('Error fetching credits consumed:', error.message);
      return 0;
    }

    return (data || []).reduce((sum, r) => sum + (Number(r.credits_consumed) || 0), 0);
  }

  /**
   * Get costs for a specific period using local JSONL data, optionally
   * filtered by agent type.
   *
   * WHY: Only used for cost_usd alert type. Reads local JSONL session files,
   * which only contain api-key billed sessions written by the CLI.
   *
   * @param period - Budget period (daily, weekly, monthly)
   * @param agentType - Optional agent type to filter costs by. When provided,
   *                    only costs from models belonging to that agent are included.
   * @returns Aggregated cost summary for the period
   */
  private async getCostsForPeriod(period: BudgetAlertPeriod, agentType?: AgentType): Promise<CostSummary> {
    const { startDate, now } = this.getPeriodDates(period);
    return getCostsForDateRange(startDate, now, undefined, agentType);
  }

  /**
   * Compute the [startDate, now] window for a given budget period.
   *
   * WHY extracted: Both getCostsForPeriod and the new Supabase helpers
   * (getSubscriptionFractionForPeriod, getCreditsConsumedForPeriod) need
   * identical period boundary logic. Centralising avoids drift between them.
   *
   * @param period - Budget period
   * @returns Start and end dates for the period window
   */
  private getPeriodDates(period: BudgetAlertPeriod): { startDate: Date; now: Date } {
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

    return { startDate, now };
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
 * Adapts the summary line to each alert type so users see meaningful units:
 *   cost_usd:           "$X.XX / $Y.YY (N%)"
 *   subscription_quota: "N% / M% of quota"
 *   credits:            "N credits / M credits (P%)"
 *
 * @param result - Budget check result to format
 * @returns Formatted message string
 */
export function formatBudgetMessage(result: BudgetCheckResult): string {
  const { alert, currentSpendUsd, percentUsed, level } = result;
  const percent = percentUsed.toFixed(0);
  const alertType: BudgetAlertType = alert.alert_type ?? 'cost_usd';

  let detail: string;
  if (alertType === 'subscription_quota') {
    const usedPct = (currentSpendUsd * 100).toFixed(1);
    const threshPct = ((alert.threshold_quota_fraction ?? 0) * 100).toFixed(0);
    detail = `${usedPct}% / ${threshPct}% of quota (${percent}%)`;
  } else if (alertType === 'credits') {
    const credits = Math.round(currentSpendUsd);
    const threshold = alert.threshold_credits ?? 0;
    detail = `${credits} / ${threshold} credits (${percent}%)`;
  } else {
    const spent = currentSpendUsd.toFixed(2);
    const threshold = alert.threshold_usd.toFixed(2);
    detail = `$${spent}/$${threshold} (${percent}%)`;
  }

  switch (level) {
    case 'exceeded':
      return `Budget exceeded: "${alert.name}" - ${detail}`;
    case 'critical':
      return `Budget critical: "${alert.name}" - ${detail}`;
    case 'warning':
      return `Budget warning: "${alert.name}" - ${detail}`;
    default:
      return `Budget OK: "${alert.name}" - ${detail}`;
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
