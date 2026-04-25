/**
 * Budget Alerts API Route
 *
 * Provides CRUD operations for user budget alerts. Each endpoint authenticates
 * via Supabase Auth, validates input with Zod, and enforces tier-based limits
 * on alert creation (Free: 1, Pro: 3, Power: 5).
 *
 * GET    /api/budget-alerts - List user's budget alerts with current spend
 * POST   /api/budget-alerts - Create a new budget alert
 * PATCH  /api/budget-alerts - Update an existing budget alert
 * DELETE /api/budget-alerts - Delete a budget alert
 *
 * @rateLimit 30 requests per minute for POST, PATCH, DELETE
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type TierId } from '@/lib/polar';
import { resolveEffectiveTier, toLegacyTierId } from '@/lib/tier-enforcement';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Valid agent types matching the database enum.
 * WHY: Must mirror the Postgres `agent_type` enum exactly. NULL means "all agents".
 */
const AgentTypeEnum = z.enum(['claude', 'codex', 'gemini']);

/**
 * Valid alert actions matching the database CHECK constraint.
 * - notify: Send a notification only
 * - warn_and_slowdown: Notify and throttle agent activity
 * - hard_stop: Notify and prevent further agent usage
 */
const ActionEnum = z.enum(['notify', 'warn_and_slowdown', 'hard_stop']);

/**
 * Valid alert periods matching the database CHECK constraint.
 * Determines the time window for spend aggregation.
 */
const PeriodEnum = z.enum(['daily', 'weekly', 'monthly']);

/**
 * Valid alert types added in migration 023.
 *
 * WHY: Different billing models need different aggregation logic:
 *   cost_usd           → sum(cost_usd) for api-key rows (legacy / default)
 *   subscription_quota → MAX(subscription_fraction_used) for subscription rows
 *   credits            → sum(credits_consumed) for credit rows
 */
const AlertTypeEnum = z.enum(['cost_usd', 'subscription_quota', 'credits']);

/**
 * Schema for creating a new budget alert.
 *
 * WHY: Validates all fields before insertion to prevent malformed data
 * from reaching Supabase and to give users clear error messages.
 *
 * Alert-type cross-field validation:
 *   - subscription_quota requires threshold_quota_fraction in (0, 1]
 *   - credits requires threshold_credits > 0 (integer)
 *   - cost_usd requires threshold_usd > 0 (existing field)
 */
const CreateAlertSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Alert name is required')
      .max(100, 'Alert name must be 100 characters or less'),
    threshold_usd: z
      .number()
      .min(0, 'Threshold USD cannot be negative')
      .max(100_000, 'Threshold cannot exceed $100,000')
      .optional()
      .default(0),
    period: PeriodEnum,
    agent_type: AgentTypeEnum.nullable().optional().default(null),
    action: ActionEnum,
    notification_channels: z
      .array(z.enum(['push', 'in_app', 'email']))
      .min(1, 'At least one notification channel is required')
      .optional()
      .default(['push', 'in_app']),
    alert_type: AlertTypeEnum.optional().default('cost_usd'),
    threshold_quota_fraction: z
      .number()
      .gt(0, 'Quota fraction must be greater than 0')
      .lte(1, 'Quota fraction cannot exceed 1.0')
      .nullable()
      .optional()
      .default(null),
    threshold_credits: z
      .number()
      .int('Credit threshold must be an integer')
      .gt(0, 'Credit threshold must be greater than 0')
      .nullable()
      .optional()
      .default(null),
  })
  .superRefine((data, ctx) => {
    // WHY: Cross-field validation mirrors the DB CHECK constraints in migration 023.
    // Failing here returns a 400 before any DB round-trip.
    if (data.alert_type === 'cost_usd' && data.threshold_usd <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Threshold must be greater than $0 for cost_usd alerts',
        path: ['threshold_usd'],
      });
    }
    if (data.alert_type === 'subscription_quota' && !data.threshold_quota_fraction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'threshold_quota_fraction is required for subscription_quota alerts',
        path: ['threshold_quota_fraction'],
      });
    }
    if (data.alert_type === 'credits' && !data.threshold_credits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'threshold_credits is required for credits alerts',
        path: ['threshold_credits'],
      });
    }
    if (data.alert_type === 'cost_usd' && (data.threshold_quota_fraction || data.threshold_credits)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'threshold_quota_fraction and threshold_credits must be null for cost_usd alerts',
        path: ['alert_type'],
      });
    }
  });

/**
 * Schema for updating an existing budget alert.
 * All fields are optional so users can update only what changed.
 */
const UpdateAlertSchema = z.object({
  id: z.string().uuid('Invalid alert ID'),
  name: z
    .string()
    .min(1, 'Alert name is required')
    .max(100, 'Alert name must be 100 characters or less')
    .optional(),
  threshold_usd: z
    .number()
    .min(0, 'Threshold USD cannot be negative')
    .max(100_000, 'Threshold cannot exceed $100,000')
    .optional(),
  period: PeriodEnum.optional(),
  agent_type: AgentTypeEnum.nullable().optional(),
  action: ActionEnum.optional(),
  notification_channels: z
    .array(z.enum(['push', 'in_app', 'email']))
    .min(1, 'At least one notification channel is required')
    .optional(),
  is_enabled: z.boolean().optional(),
  alert_type: AlertTypeEnum.optional(),
  threshold_quota_fraction: z
    .number()
    .gt(0, 'Quota fraction must be greater than 0')
    .lte(1, 'Quota fraction cannot exceed 1.0')
    .nullable()
    .optional(),
  threshold_credits: z
    .number()
    .int('Credit threshold must be an integer')
    .gt(0, 'Credit threshold must be greater than 0')
    .nullable()
    .optional(),
});

/**
 * Schema for deleting a budget alert. Requires only the alert ID.
 */
const DeleteAlertSchema = z.object({
  id: z.string().uuid('Invalid alert ID'),
});

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Calculates the start date for a given budget period.
 *
 * WHY: Budget alerts track spending within rolling time windows.
 * - daily: resets at midnight UTC today
 * - weekly: resets at midnight UTC on the most recent Monday
 * - monthly: resets at midnight UTC on the 1st of the current month
 *
 * @param period - The budget period (daily, weekly, monthly)
 * @returns ISO 8601 date string for the start of the period
 */
function getPeriodStartDate(period: 'daily' | 'weekly' | 'monthly'): string {
  const now = new Date();

  switch (period) {
    case 'daily': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return start.toISOString();
    }
    case 'weekly': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      // WHY: getUTCDay() returns 0 for Sunday, 1 for Monday, etc.
      // We want Monday as the start of the week, so we subtract (day - 1),
      // handling Sunday (0) as day 7.
      const day = start.getUTCDay();
      const diff = day === 0 ? 6 : day - 1;
      start.setUTCDate(start.getUTCDate() - diff);
      return start.toISOString();
    }
    case 'monthly': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return start.toISOString();
    }
  }
}

/**
 * Resolves the user's subscription tier from Supabase.
 *
 * WHY: Budget alert limits are tier-gated. Free users get 0 alerts,
 * Pro gets 3, Power gets 10. We must check the subscription table
 * to determine the user's current tier before allowing creation.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - The authenticated user's ID
 * @returns The user's tier ID (defaults to 'free' if no subscription found)
 */
async function getUserTier(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<TierId> {
  // SEC-ADV-004: cross-read personal subscription + team memberships and
  // pick the higher-ranked tier. team-family results are collapsed to
  // 'power' for compatibility with the legacy TIERS table.
  const effective = await resolveEffectiveTier(supabase, userId);
  return toLegacyTierId(effective) as TierId;
}

// ---------------------------------------------------------------------------
// GET /api/budget-alerts
// ---------------------------------------------------------------------------

/**
 * GET /api/budget-alerts
 *
 * Lists all budget alerts for the authenticated user, enriched with
 * current spend data for each alert's period.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 {
 *   alerts: BudgetAlertWithSpend[],
 *   tier: TierId,
 *   alertLimit: number,
 *   alertCount: number
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Failed to fetch budget alerts' }
 */
export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch alerts and subscription tier in parallel
    const [alertsResult, tier] = await Promise.all([
      // FIX-056: Add .limit() to prevent unbounded queries
      // SEC-API-003: Use explicit column list instead of select('*') to avoid
      // accidentally exposing future columns added to the table.
      supabase
        .from('budget_alerts')
        // WHY explicit column list: avoids exposing future columns and makes
        // migration 023 columns explicit. alert_type, threshold_quota_fraction,
        // and threshold_credits added in migration 023.
        .select('id, user_id, name, threshold_usd, period, agent_type, action, notification_channels, is_enabled, last_triggered_at, created_at, updated_at, alert_type, threshold_quota_fraction, threshold_credits')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100),
      getUserTier(supabase, user.id),
    ]);

    if (alertsResult.error) {
      console.error('Failed to fetch budget alerts:', alertsResult.error.message);
      return NextResponse.json(
        { error: 'Failed to fetch budget alerts' },
        { status: 500 }
      );
    }

    const alerts = alertsResult.data || [];

    // WHY: Deduplicate spend queries by (alert_type, period, agent_type) to eliminate
    // the N+1 pattern. Each alert_type needs a different column from cost_records:
    //   cost_usd:           SUM(cost_usd) WHERE billing_model = 'api-key'
    //   subscription_quota: MAX(subscription_fraction_used) WHERE billing_model = 'subscription'
    //   credits:            SUM(credits_consumed) WHERE billing_model = 'credit'
    // Grouping by all three dimensions means users with alerts across multiple types
    // still only run O(unique keys) queries rather than O(alerts).
    type AlertTypeKey = 'cost_usd' | 'subscription_quota' | 'credits';
    const uniqueKeysMap = new Map<string, { alertType: AlertTypeKey; period: string; agentType: string | null }>();
    for (const a of alerts) {
      const alertType = (a.alert_type ?? 'cost_usd') as AlertTypeKey;
      const key = `${alertType}:${a.period}:${a.agent_type ?? 'null'}`;
      if (!uniqueKeysMap.has(key)) {
        uniqueKeysMap.set(key, { alertType, period: a.period, agentType: a.agent_type });
      }
    }

    const spendByKey: Record<string, number> = {};

    await Promise.all(
      Array.from(uniqueKeysMap.entries()).map(async ([key, { alertType, period, agentType }]) => {
        const periodStart = getPeriodStartDate(period as 'daily' | 'weekly' | 'monthly');

        if (alertType === 'cost_usd') {
          // WHY filter billing_model = 'api-key': subscription rows have cost_usd = $0
          // by construction (migration 022 constraint). Including them would make the
          // sum correct ($0 + api-key cost) but would also dilute the query and
          // silently produce incorrect results if the constraint is ever relaxed.
          let query = supabase
            .from('cost_records')
            .select('cost_usd')
            .eq('user_id', user.id)
            .eq('billing_model', 'api-key')
            .gte('recorded_at', periodStart)
            .limit(10_000);
          if (agentType) query = query.eq('agent_type', agentType);
          const { data } = await query;
          spendByKey[key] = (data || []).reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);

        } else if (alertType === 'subscription_quota') {
          // WHY MAX: subscription_fraction_used is a cumulative quota fraction (0–1).
          // The agent may report it at each session as the running total, so MAX
          // gives the high-water mark for the period.
          let query = supabase
            .from('cost_records')
            .select('subscription_fraction_used')
            .eq('user_id', user.id)
            .eq('billing_model', 'subscription')
            .gte('recorded_at', periodStart)
            .not('subscription_fraction_used', 'is', null)
            .limit(10_000);
          if (agentType) query = query.eq('agent_type', agentType);
          const { data } = await query;
          spendByKey[key] = data && data.length > 0
            ? Math.max(...data.map((r) => Number(r.subscription_fraction_used) || 0))
            : 0;

        } else {
          // credits: SUM(credits_consumed)
          let query = supabase
            .from('cost_records')
            .select('credits_consumed')
            .eq('user_id', user.id)
            .eq('billing_model', 'credit')
            .gte('recorded_at', periodStart)
            .not('credits_consumed', 'is', null)
            .limit(10_000);
          if (agentType) query = query.eq('agent_type', agentType);
          const { data } = await query;
          spendByKey[key] = (data || []).reduce((sum, r) => sum + (Number(r.credits_consumed) || 0), 0);
        }
      })
    );

    const alertsWithSpend = alerts.map((alert) => {
      const alertType = (alert.alert_type ?? 'cost_usd') as AlertTypeKey;
      const key = `${alertType}:${alert.period}:${alert.agent_type ?? 'null'}`;
      const currentSpend = spendByKey[key] ?? 0;

      // WHY per-type threshold: cost_usd uses threshold_usd, subscription_quota uses
      // threshold_quota_fraction (0–1 scale), credits uses threshold_credits.
      let threshold: number;
      if (alertType === 'subscription_quota') {
        threshold = Number(alert.threshold_quota_fraction) || 0;
      } else if (alertType === 'credits') {
        threshold = Number(alert.threshold_credits) || 0;
      } else {
        threshold = Number(alert.threshold_usd) || 0;
      }

      return {
        ...alert,
        current_spend_usd: currentSpend,
        percentage_used: threshold > 0 ? (currentSpend / threshold) * 100 : 0,
      };
    });

    const alertLimit = TIERS[tier]?.limits.budgetAlerts ?? 0;

    // WHY: no-store prevents CDN/proxy caching of user-specific alert data.
    // Budget alert spend calculations contain private financial data that must
    // never be served from a shared cache.
    return NextResponse.json(
      {
        alerts: alertsWithSpend,
        tier,
        alertLimit,
        alertCount: alerts.length,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Budget alerts GET error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to fetch budget alerts' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/budget-alerts
// ---------------------------------------------------------------------------

/**
 * POST /api/budget-alerts
 *
 * Creates a new budget alert. Enforces the user's tier limit on total alerts.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   name: string,
 *   threshold_usd?: number,
 *   period: 'daily' | 'weekly' | 'monthly',
 *   agent_type?: 'claude' | 'codex' | 'gemini' | null,
 *   action: 'notify' | 'warn_and_slowdown' | 'hard_stop',
 *   notification_channels?: ('push' | 'in_app' | 'email')[],
 *   alert_type?: 'cost_usd' | 'subscription_quota' | 'credits',
 *   threshold_quota_fraction?: number | null,  // required when alert_type='subscription_quota'
 *   threshold_credits?: number | null          // required when alert_type='credits'
 * }
 *
 * @returns 201 { alert: BudgetAlert }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Tier limit reached
 * @error 500 { error: 'Failed to create budget alert' }
 */
export async function POST(request: NextRequest) {
  // Rate limit check - 30 requests per minute
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.budgetAlerts, 'budget-alerts');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse and validate request body
    const rawBody = await request.json();
    const parseResult = CreateAlertSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Check tier limit
    const [tier, countResult] = await Promise.all([
      getUserTier(supabase, user.id),
      supabase
        .from('budget_alerts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id),
    ]);

    const alertLimit = TIERS[tier]?.limits.budgetAlerts ?? 0;
    const currentCount = countResult.count ?? 0;

    if (currentCount >= alertLimit) {
      // WHY: Free users (limit 1) get a different message than paid users who
      // have hit their limit. Free gets 1 alert; Pro gets 3; Power gets 5.
      // This message guides them toward the right upgrade action.
      if (tier === 'free') {
        return NextResponse.json(
          { error: 'You have reached your limit of 1 budget alert on the Free plan. Upgrade to Pro for 3 budget alerts.' },
          { status: 403 }
        );
      }
      return NextResponse.json(
        { error: `You have reached your limit of ${alertLimit} budget alerts on the ${tier} plan. Upgrade to increase your limit.` },
        { status: 403 }
      );
    }

    // Insert the new alert including migration 023 quota-awareness fields.
    const { data: alert, error: insertError } = await supabase
      .from('budget_alerts')
      .insert({
        user_id: user.id,
        name: parseResult.data.name,
        threshold_usd: parseResult.data.threshold_usd,
        period: parseResult.data.period,
        agent_type: parseResult.data.agent_type,
        action: parseResult.data.action,
        notification_channels: parseResult.data.notification_channels,
        // Migration 023 fields — default to cost_usd / null when not supplied.
        alert_type: parseResult.data.alert_type,
        threshold_quota_fraction: parseResult.data.threshold_quota_fraction,
        threshold_credits: parseResult.data.threshold_credits,
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create budget alert:', insertError.message);
      return NextResponse.json(
        { error: 'Failed to create budget alert' },
        { status: 500 }
      );
    }

    return NextResponse.json({ alert }, { status: 201 });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Budget alerts POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to create budget alert' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/budget-alerts
// ---------------------------------------------------------------------------

/**
 * PATCH /api/budget-alerts
 *
 * Updates an existing budget alert. Supports partial updates (only the fields
 * provided will be changed).
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   id: string (UUID),
 *   name?: string,
 *   threshold_usd?: number,
 *   period?: 'daily' | 'weekly' | 'monthly',
 *   agent_type?: 'claude' | 'codex' | 'gemini' | null,
 *   action?: 'notify' | 'warn_and_slowdown' | 'hard_stop',
 *   notification_channels?: ('push' | 'in_app' | 'email')[],
 *   is_enabled?: boolean
 * }
 *
 * @returns 200 { alert: BudgetAlert }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 404 { error: 'Budget alert not found' }
 * @error 500 { error: 'Failed to update budget alert' }
 */
export async function PATCH(request: NextRequest) {
  // Rate limit check - 30 requests per minute
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.budgetAlerts, 'budget-alerts');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await request.json();
    const parseResult = UpdateAlertSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    const { id, ...updateFields } = parseResult.data;

    // WHY: Only include fields that were actually provided in the request.
    // Zod's optional fields come through as undefined if not set, and we
    // don't want to overwrite existing values with undefined.
    const cleanedFields = Object.fromEntries(
      Object.entries(updateFields).filter(([, value]) => value !== undefined)
    );

    if (Object.keys(cleanedFields).length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400 }
      );
    }

    // RLS ensures the user can only update their own alerts
    const { data: alert, error: updateError } = await supabase
      .from('budget_alerts')
      .update(cleanedFields)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single();

    if (updateError) {
      // WHY: PGRST116 means no rows were returned, which with our RLS filter
      // means either the alert doesn't exist or it belongs to another user.
      if (updateError.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Budget alert not found' },
          { status: 404 }
        );
      }
      console.error('Failed to update budget alert:', updateError.message);
      return NextResponse.json(
        { error: 'Failed to update budget alert' },
        { status: 500 }
      );
    }

    return NextResponse.json({ alert });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Budget alerts PATCH error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to update budget alert' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/budget-alerts
// ---------------------------------------------------------------------------

/**
 * DELETE /api/budget-alerts
 *
 * Deletes a budget alert by ID. RLS ensures users can only delete their own.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body { id: string (UUID) }
 *
 * @returns 200 { success: true }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 404 { error: 'Budget alert not found' }
 * @error 500 { error: 'Failed to delete budget alert' }
 */
export async function DELETE(request: NextRequest) {
  // Rate limit check - 30 requests per minute
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.budgetAlerts, 'budget-alerts');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await request.json();
    const parseResult = DeleteAlertSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // WHY: We first check if the alert exists (via RLS) before deleting, so
    // we can return a 404 if it doesn't exist rather than a silent no-op.
    const { data: existing } = await supabase
      .from('budget_alerts')
      .select('id')
      .eq('id', parseResult.data.id)
      .eq('user_id', user.id)
      .single();

    if (!existing) {
      return NextResponse.json(
        { error: 'Budget alert not found' },
        { status: 404 }
      );
    }

    const { error: deleteError } = await supabase
      .from('budget_alerts')
      .delete()
      .eq('id', parseResult.data.id)
      .eq('user_id', user.id);

    if (deleteError) {
      console.error('Failed to delete budget alert:', deleteError.message);
      return NextResponse.json(
        { error: 'Failed to delete budget alert' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Budget alerts DELETE error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to delete budget alert' },
      { status: 500 }
    );
  }
}
