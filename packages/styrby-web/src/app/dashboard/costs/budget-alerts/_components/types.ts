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
 * Budget alert from the database, enriched with computed spend data.
 *
 * The server calculates `current_spend_usd` and `percentage_used` by
 * querying the cost_records table for the alert's period and agent scope.
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
  current_spend_usd: number;
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
  threshold_usd: number;
  period: AlertPeriod;
  agent_type: AgentType | null;
  action: AlertAction;
  notification_channels: NotificationChannel[];
}
