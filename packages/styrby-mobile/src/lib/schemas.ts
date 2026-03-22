/**
 * Shared Zod Schemas for Mobile App
 *
 * Provides runtime validation schemas for all Supabase table data consumed by
 * the mobile hooks. Each schema mirrors the corresponding database table columns
 * and exports both the schema and the inferred TypeScript type.
 *
 * Also provides generic helper functions (safeParseArray, safeParseSingle) that
 * validate Supabase responses gracefully: invalid rows are logged in __DEV__
 * and silently dropped in production, so the app never crashes on unexpected data.
 *
 * WHY: Supabase JS returns `unknown`-shaped data that we previously cast with
 * `as unknown as Type`. This is unsafe because the database schema can drift
 * from the client types without any runtime error. Zod validation catches these
 * mismatches early and prevents corrupted data from reaching the UI.
 */

import { z } from 'zod';

// ============================================================================
// Shared Enums & Primitives
// ============================================================================

/**
 * Valid AI agent identifiers.
 * Matches the `agent_type` enum in the database and the AgentType union in styrby-shared.
 */
const AgentTypeSchema = z.enum(['claude', 'codex', 'gemini', 'opencode', 'aider']);

/**
 * Valid session lifecycle statuses.
 * Matches the `session_status` enum in the database.
 */
const SessionStatusSchema = z.enum(['starting', 'running', 'idle', 'paused', 'stopped', 'error', 'expired']);

/**
 * Valid subscription tiers.
 * Matches the `subscription_tier` enum in the database.
 */
const SubscriptionTierSchema = z.enum(['free', 'pro', 'power', 'team']);

// ============================================================================
// Profile Schema
// ============================================================================

/**
 * Validates a row from the Supabase `profiles` table.
 *
 * WHY: The profiles table has grown over multiple migrations. Columns like
 * `is_admin` (migration 013) and `onboarding_completed_at` (initial schema)
 * may be present in query results. Marking them as optional ensures the mobile
 * app handles their presence gracefully without crashing, even though mobile
 * does not use admin features.
 */
export const ProfileSchema = z.object({
  /** Primary key, matches auth.users.id */
  id: z.string(),
  /** Display name (may be null if never set) */
  display_name: z.string().nullable(),
  /** Avatar URL */
  avatar_url: z.string().nullable(),
  /** User timezone (defaults to 'UTC' in DB) */
  timezone: z.string().optional(),
  /** Theme preference */
  theme: z.string().optional(),
  /** Preferred language */
  preferred_language: z.string().optional(),
  /** User's unique referral code */
  referral_code: z.string().nullable(),
  /** Consent tracking */
  marketing_email_consent: z.boolean().optional(),
  /** When Terms of Service were accepted */
  tos_accepted_at: z.string().nullable(),
  /** When onboarding was completed (null if not yet completed) */
  onboarding_completed_at: z.string().nullable(),
  /** Current onboarding step */
  onboarding_step: z.number().optional(),
  /**
   * Server-set admin flag. Added in migration 013.
   * Cannot be modified by users via RLS (set by service role only).
   * Mobile does not use admin features, but this field may appear in
   * profile query results and must be handled gracefully.
   */
  is_admin: z.boolean().optional(),
  /** Last time the user was active */
  last_active_at: z.string().nullable(),
  /** Soft delete timestamp */
  deleted_at: z.string().nullable(),
  /** Record creation timestamp */
  created_at: z.string().optional(),
  /** Record update timestamp */
  updated_at: z.string().optional(),
});

/** Inferred TypeScript type for a validated profile row. */
export type ValidatedProfile = z.infer<typeof ProfileSchema>;

// ============================================================================
// Session Schema
// ============================================================================

/**
 * Validates a row from the Supabase `sessions` table.
 *
 * Covers all columns selected by the useSessions hook. Nullable fields use
 * `.nullable()` and date strings are kept as strings (not coerced) because the
 * hook formats them with formatRelativeTime() which expects ISO strings.
 */
export const SessionSchema = z.object({
  /** Primary key (UUID) */
  id: z.string(),
  /** Owner of the session (UUID) */
  user_id: z.string(),
  /** Machine that ran the session (UUID) */
  machine_id: z.string(),
  /** Which AI agent was used. Uses z.string() instead of AgentTypeSchema because the CLI supports more agents than the DB enum currently allows. */
  agent_type: z.string(),
  /** Session lifecycle status */
  status: SessionStatusSchema,
  /** Human-readable session title */
  title: z.string().nullable(),
  /** AI-generated summary */
  summary: z.string().nullable(),
  /** Total input tokens consumed */
  total_input_tokens: z.number(),
  /** Total output tokens consumed */
  total_output_tokens: z.number(),
  /** Total cost in USD */
  total_cost_usd: z.number(),
  /** When the session began (ISO 8601 string) */
  started_at: z.string(),
  /** When the session ended, or null if still active */
  ended_at: z.string().nullable(),
  /** User-defined tags */
  tags: z.array(z.string()),
  /** Last modification timestamp (ISO 8601 string) */
  updated_at: z.string(),
  /** Number of messages exchanged */
  message_count: z.number(),
  /** Team ID if this is a team session, null for personal */
  team_id: z.string().nullable().optional(),
});

/** Inferred TypeScript type for a validated session row. */
export type ValidatedSession = z.infer<typeof SessionSchema>;

// ============================================================================
// Cost Record Schema
// ============================================================================

/**
 * Validates a row from the Supabase `cost_records` table.
 *
 * WHY: cost_usd comes from the database as a numeric/decimal type which
 * Supabase JS may serialize as a string. We accept both string and number
 * via z.coerce.number() so downstream code always gets a number.
 */
export const CostRecordSchema = z.object({
  /** Date string (YYYY-MM-DD) for the cost record */
  record_date: z.string(),
  /** Which AI agent generated the cost (NOT NULL in DB) */
  agent_type: z.string(),
  /** Cost in USD. Coerced from string because Postgres numeric types serialize as strings. */
  cost_usd: z.coerce.number().nullable(),
  /** Input tokens consumed */
  input_tokens: z.number().nullable(),
  /** Output tokens consumed */
  output_tokens: z.number().nullable(),
  /**
   * Whether this cost record is still pending (agent is responding).
   * Added in migration 013. Optional for backwards compatibility with queries
   * that do not select this column.
   */
  is_pending: z.boolean().default(false),
});

/** Inferred TypeScript type for a validated cost record row. */
export type ValidatedCostRecord = z.infer<typeof CostRecordSchema>;

// ============================================================================
// Budget Alert Schema
// ============================================================================

/**
 * Valid budget alert periods.
 * Determines the time window over which spend is measured against the threshold.
 */
const BudgetAlertPeriodSchema = z.enum(['daily', 'weekly', 'monthly']);

/**
 * Valid budget alert actions as stored in the database.
 * The database uses CHECK constraint: action IN ('notify', 'warn_and_slowdown', 'hard_stop').
 */
const BudgetAlertDbActionSchema = z.enum(['notify', 'warn_and_slowdown', 'hard_stop']);

/**
 * Validates a row from the Supabase `budget_alerts` table.
 *
 * Uses the raw database column names and types. The hook's mapRowToAlert()
 * function handles mapping to the UI-friendly BudgetAlert interface.
 */
export const BudgetAlertSchema = z.object({
  /** Primary key (UUID) */
  id: z.string(),
  /** Owner of the alert (UUID) */
  user_id: z.string(),
  /** Human-readable alert name */
  name: z.string(),
  /** USD threshold that triggers the alert. Coerced because Postgres numeric may serialize as string. */
  threshold_usd: z.coerce.number(),
  /** Time period for spend aggregation */
  period: BudgetAlertPeriodSchema,
  /** Action to take when threshold is reached */
  action: BudgetAlertDbActionSchema,
  /** Whether the alert is currently active */
  is_enabled: z.boolean(),
  /** ISO timestamp when last triggered, or null */
  last_triggered_at: z.string().nullable(),
  /** ISO timestamp when the alert was created */
  created_at: z.string(),
});

/** Inferred TypeScript type for a validated budget alert row. */
export type ValidatedBudgetAlert = z.infer<typeof BudgetAlertSchema>;

// ============================================================================
// Notification Preferences Schema
// ============================================================================

/**
 * Validates a row from the Supabase `notification_preferences` table.
 *
 * Covers push/email toggles and quiet hours configuration. The quiet hours
 * fields use simple string format ("HH:MM") rather than full ISO timestamps
 * because they represent recurring daily times, not specific moments.
 */
export const NotificationPreferencesSchema = z.object({
  /** Primary key (UUID) */
  id: z.string(),
  /** Owner of the preferences (UUID) */
  user_id: z.string(),
  /** Whether push notifications are enabled */
  push_enabled: z.boolean(),
  /** Whether email notifications are enabled */
  email_enabled: z.boolean(),
  /** Whether quiet hours are enabled */
  quiet_hours_enabled: z.boolean(),
  /** Quiet hours start time (HH:MM format) */
  quiet_hours_start: z.string().nullable(),
  /** Quiet hours end time (HH:MM format) */
  quiet_hours_end: z.string().nullable(),
  /** Whether to push-notify on permission requests */
  push_permission_requests: z.boolean().optional(),
  /** Whether to push-notify on session errors */
  push_session_errors: z.boolean().optional(),
  /** Whether to push-notify on budget alerts */
  push_budget_alerts: z.boolean().optional(),
  /** Whether to push-notify on session completion */
  push_session_complete: z.boolean().optional(),
  /** Whether to email a weekly summary */
  email_weekly_summary: z.boolean().optional(),
  /** Whether to email budget alerts */
  email_budget_alerts: z.boolean().optional(),
  /** IANA timezone for quiet hours (e.g., 'America/New_York') */
  quiet_hours_timezone: z.string().nullable(),
  /**
   * Smart notification priority threshold (1-5). Added in migration 005.
   * Only notifications with priority <= this value are sent.
   * 1=urgent only, 3=medium (default), 5=all.
   */
  priority_threshold: z.number().default(3),
  /**
   * Custom priority rules as JSON array. Added in migration 005.
   * Reserved for future use with advanced filtering logic.
   */
  priority_rules: z.any().default([]),
  /** ISO timestamp when preferences were created */
  created_at: z.string(),
  /** ISO timestamp when preferences were last updated */
  updated_at: z.string(),
});

/** Inferred TypeScript type for validated notification preferences. */
export type ValidatedNotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

// ============================================================================
// Device Token Schema
// ============================================================================

/**
 * Validates a row from the Supabase `device_tokens` table.
 *
 * Device tokens represent push notification endpoints (APNs/FCM) registered
 * by the mobile app. Each device registers its token on app launch and
 * removes it on logout.
 */
export const DeviceTokenSchema = z.object({
  /** Primary key (UUID) */
  id: z.string(),
  /** Owner of the device token (UUID) */
  user_id: z.string(),
  /** The push notification token string (Expo push token or native token) */
  token: z.string(),
  /** Platform identifier ('ios' | 'android' | 'web') */
  platform: z.string(),
  /** ISO timestamp when the token was registered */
  created_at: z.string(),
  /** Human-readable device name */
  device_name: z.string().nullable().optional(),
  /** App version that registered the token */
  app_version: z.string().nullable().optional(),
  /** ISO timestamp when the token was last used for a push notification */
  last_used_at: z.string().nullable().optional(),
});

/** Inferred TypeScript type for a validated device token row. */
export type ValidatedDeviceToken = z.infer<typeof DeviceTokenSchema>;

// ============================================================================
// Subscription Schema
// ============================================================================

/**
 * Validates the minimal subscription row shape used by fetchUserTier().
 * Only the `tier` column is selected in that query.
 */
export const SubscriptionTierRowSchema = z.object({
  /** The user's subscription tier. Uses z.string() for forward-compatibility with new tiers. */
  tier: z.string(),
});

/** Inferred TypeScript type for a validated subscription tier row. */
export type ValidatedSubscriptionTierRow = z.infer<typeof SubscriptionTierRowSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate an array of items against a Zod schema, returning only valid items.
 *
 * Invalid items are silently dropped. In __DEV__ mode, each invalid item is
 * logged to the console with its index and validation errors so developers
 * can identify schema drift early.
 *
 * WHY: This function exists because Supabase returns untyped data and we need
 * a non-crashing validation layer. Dropping invalid rows is preferable to
 * crashing the app or showing corrupted data to the user.
 *
 * @param schema - The Zod schema to validate each item against
 * @param data - The raw array of items from Supabase (may be null/undefined)
 * @param label - A human-readable label for dev logging (e.g., "sessions", "cost_records")
 * @returns An array containing only the items that passed validation
 *
 * @example
 * const rawRows = await supabase.from('sessions').select('*');
 * const validSessions = safeParseArray(SessionSchema, rawRows.data, 'sessions');
 */
export function safeParseArray<T>(
  schema: z.ZodType<T>,
  data: unknown[] | null | undefined,
  label: string,
): T[] {
  if (!data || !Array.isArray(data)) {
    return [];
  }

  const validItems: T[] = [];

  for (let i = 0; i < data.length; i++) {
    const result = schema.safeParse(data[i]);

    if (result.success) {
      validItems.push(result.data);
    } else if (__DEV__) {
      console.warn(
        `[Zod] Invalid ${label} at index ${i}:`,
        result.error.issues,
      );
    }
  }

  return validItems;
}

/**
 * Validate a single item against a Zod schema, returning the validated data or null.
 *
 * In __DEV__ mode, validation failures are logged to the console with the
 * full error details. In production, failures return null silently.
 *
 * @param schema - The Zod schema to validate against
 * @param data - The raw item from Supabase (may be null/undefined)
 * @param label - A human-readable label for dev logging (e.g., "session", "budget_alert")
 * @returns The validated item, or null if validation failed
 *
 * @example
 * const raw = await supabase.from('budget_alerts').select('*').eq('id', alertId).single();
 * const alert = safeParseSingle(BudgetAlertSchema, raw.data, 'budget_alert');
 * if (!alert) return; // validation failed
 */
export function safeParseSingle<T>(
  schema: z.ZodType<T>,
  data: unknown | null | undefined,
  label: string,
): T | null {
  if (data == null) {
    return null;
  }

  const result = schema.safeParse(data);

  if (result.success) {
    return result.data;
  }

  if (__DEV__) {
    console.warn(`[Zod] Invalid ${label}:`, result.error.issues);
  }

  return null;
}
