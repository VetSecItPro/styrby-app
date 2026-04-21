/**
 * Shared prop types + domain types for SettingsClient sub-components.
 *
 * WHY: Hoisting to a single module prevents drift across the 10+ sub-components
 * and matches the co-location pattern used in webhooks/_components/ and
 * budget-alerts/_components/. Importing sub-components never import from
 * settings-client.tsx, only from this file — keeping the orchestrator as the
 * one-way owner of state.
 */

/** User profile row from the profiles table (wide row, only known keys typed). */
export interface Profile {
  id: string;
  display_name: string | null;
  [key: string]: unknown;
}

/** Active subscription snapshot pulled from the subscriptions table (synced from Polar). */
export interface Subscription {
  tier: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  [key: string]: unknown;
}

/** notification_preferences row — governs push/email/quiet-hours/priority filter. */
export interface NotificationPrefs {
  push_enabled: boolean;
  email_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  priority_threshold?: number;
  [key: string]: unknown;
}

/** Per-agent configuration row from agent_configs. */
export interface AgentConfig {
  agent_type: string;
  auto_approve_low_risk: boolean;
  [key: string]: unknown;
}

/** Minimal authenticated user information threaded in from the server component. */
export interface UserData {
  email: string;
  provider: string | undefined;
}

/** Uniform inline-form feedback message (success or error banner). */
export type InlineMessage = { type: 'success' | 'error'; text: string } | null;

/** Props accepted by the top-level SettingsClient orchestrator. */
export interface SettingsClientProps {
  /** Authenticated user data (email, provider) */
  user: UserData;
  /** User profile row from the profiles table */
  profile: Profile | null;
  /** Active subscription, if any */
  subscription: Subscription | null;
  /** Notification preferences for the user */
  notificationPrefs: NotificationPrefs | null;
  /** Per-agent configuration rows */
  agentConfigs: AgentConfig[] | null;
}
