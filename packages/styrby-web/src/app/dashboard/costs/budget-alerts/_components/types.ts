/**
 * Shared types for the Budget Alerts feature.
 *
 * WHY co-located: These types are only consumed by files inside
 * `dashboard/costs/budget-alerts/**`. Keeping them next to the feature
 * avoids polluting a global `src/types` namespace with feature-specific
 * shapes and matches the file-collocation pattern used elsewhere
 * (e.g., `src/components/costs/`).
 */

/** Valid agent types matching the Postgres enum. */
export type AgentType =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'aider'
  | 'goose'
  | 'amp'
  | 'crush'
  | 'kilo'
  | 'kiro'
  | 'droid';

/** Valid alert periods matching the database CHECK constraint. */
export type AlertPeriod = 'daily' | 'weekly' | 'monthly';

/** Valid alert actions matching the database CHECK constraint. */
export type AlertAction = 'notify' | 'warn_and_slowdown' | 'hard_stop';

/** Valid notification channels. */
export type NotificationChannel = 'push' | 'in_app' | 'email';

/**
 * Alert type controlling which cost_records aggregation is used.
 * Added in migration 023 (PR-E: quota-aware budget alerts).
 *
 * WHY: Different billing models require different aggregation:
 *   cost_usd           → sum(cost_usd) for api-key rows (legacy default)
 *   subscription_quota → MAX(subscription_fraction_used) for subscription rows
 *   credits            → sum(credits_consumed) for credit rows
 */
export type BudgetAlertType = 'cost_usd' | 'subscription_quota' | 'credits';

/**
 * Budget alert from the database, enriched with computed spend data.
 *
 * The server calculates `current_spend_usd` and `percentage_used` by
 * querying the cost_records table for the alert's period, agent scope,
 * and alert_type (billing_model filter).
 */
export interface BudgetAlertWithSpend {
  id: string;
  user_id: string;
  name: string;
  threshold_usd: number;
  period: AlertPeriod;
  agent_type: AgentType | null;
  action: AlertAction;
  notification_channels: NotificationChannel[];
  is_enabled: boolean;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
  /** Alert type (migration 023). Defaults to 'cost_usd' for legacy rows. */
  alert_type: BudgetAlertType;
  /**
   * Fraction of subscription quota threshold (0 < x <= 1).
   * Only set when alert_type = 'subscription_quota'. NULL otherwise.
   */
  threshold_quota_fraction: number | null;
  /**
   * Credit count threshold. Only set when alert_type = 'credits'. NULL otherwise.
   */
  threshold_credits: number | null;
  /** Computed current spend (or fraction/credits) for the alert's period. */
  current_spend_usd: number;
  /** Computed percentage of threshold used (0-100+). */
  percentage_used: number;
}

/**
 * Form data for creating or editing a budget alert.
 *
 * Matches the shape expected by the POST/PATCH `/api/budget-alerts`
 * endpoints (minus the `id`, which is appended for PATCH).
 */
export interface AlertFormData {
  name: string;
  /** USD threshold. Only used when alert_type = 'cost_usd'. */
  threshold_usd: number;
  period: AlertPeriod;
  agent_type: AgentType | null;
  action: AlertAction;
  notification_channels: NotificationChannel[];
  /** Determines which aggregation the monitor uses. */
  alert_type: BudgetAlertType;
  /**
   * Quota fraction threshold (0–1). Required when alert_type = 'subscription_quota'.
   */
  threshold_quota_fraction: number | null;
  /**
   * Credit count threshold. Required when alert_type = 'credits'.
   */
  threshold_credits: number | null;
}
