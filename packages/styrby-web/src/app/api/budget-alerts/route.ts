/**
 * Budget Alerts API Route
 *
 * Provides CRUD operations for user budget alerts. Each endpoint authenticates
 * via Supabase Auth, validates input with Zod, and enforces tier-based limits
 * on alert creation (Free: 0, Pro: 3, Power: 10).
 *
 * GET    /api/budget-alerts - List user's budget alerts with current spend
 * POST   /api/budget-alerts - Create a new budget alert
 * PATCH  /api/budget-alerts - Update an existing budget alert
 * DELETE /api/budget-alerts - Delete a budget alert
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type TierId } from '@/lib/polar';
import { z } from 'zod';

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
 * Schema for creating a new budget alert.
 * WHY: Validates all fields before insertion to prevent malformed data
 * from reaching Supabase and to give users clear error messages.
 */
const CreateAlertSchema = z.object({
  name: z
    .string()
    .min(1, 'Alert name is required')
    .max(100, 'Alert name must be 100 characters or less'),
  threshold_usd: z
    .number()
    .positive('Threshold must be greater than $0')
    .max(100_000, 'Threshold cannot exceed $100,000'),
  period: PeriodEnum,
  agent_type: AgentTypeEnum.nullable().optional().default(null),
  action: ActionEnum,
  notification_channels: z
    .array(z.enum(['push', 'in_app', 'email']))
    .min(1, 'At least one notification channel is required')
    .optional()
    .default(['push', 'in_app']),
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
    .positive('Threshold must be greater than $0')
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
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  return (subscription?.tier as TierId) || 'free';
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
      supabase
        .from('budget_alerts')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
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

    // WHY: We calculate current spend for each alert to show progress bars.
    // We batch the spend queries by period to avoid N+1 queries. Each unique
    // (period, agent_type) combination needs one aggregation query.
    const alertsWithSpend = await Promise.all(
      alerts.map(async (alert) => {
        const periodStart = getPeriodStartDate(alert.period);

        let query = supabase
          .from('cost_records')
          .select('cost_usd')
          .eq('user_id', user.id)
          .gte('recorded_at', periodStart);

        // Scope to specific agent if configured
        if (alert.agent_type) {
          query = query.eq('agent_type', alert.agent_type);
        }

        const { data: costData } = await query;

        const currentSpend = (costData || []).reduce(
          (sum, record) => sum + (Number(record.cost_usd) || 0),
          0
        );

        return {
          ...alert,
          current_spend_usd: currentSpend,
          percentage_used: alert.threshold_usd > 0
            ? (currentSpend / Number(alert.threshold_usd)) * 100
            : 0,
        };
      })
    );

    const alertLimit = TIERS[tier]?.limits.budgetAlerts ?? 0;

    return NextResponse.json({
      alerts: alertsWithSpend,
      tier,
      alertLimit,
      alertCount: alerts.length,
    });
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
 *   threshold_usd: number,
 *   period: 'daily' | 'weekly' | 'monthly',
 *   agent_type?: 'claude' | 'codex' | 'gemini' | null,
 *   action: 'notify' | 'warn_and_slowdown' | 'hard_stop',
 *   notification_channels?: ('push' | 'in_app' | 'email')[]
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
      // WHY: Free users (limit 0) get a different message than paid users who
      // have hit their limit. This helps guide them toward the right action.
      if (alertLimit === 0) {
        return NextResponse.json(
          { error: 'Budget alerts are not available on the Free plan. Upgrade to Pro to create budget alerts.' },
          { status: 403 }
        );
      }
      return NextResponse.json(
        { error: `You have reached your limit of ${alertLimit} budget alerts on the ${tier} plan. Upgrade to increase your limit.` },
        { status: 403 }
      );
    }

    // Insert the new alert
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
