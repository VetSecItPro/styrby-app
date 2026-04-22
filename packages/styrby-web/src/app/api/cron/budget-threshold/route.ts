/**
 * Budget Threshold Push Notification Cron
 *
 * POST /api/cron/budget-threshold
 *
 * Triggered hourly by Vercel Cron (5 minutes past the hour). For each user
 * whose projected MTD cost has crossed a configured threshold (default: 80%
 * of tier quota), this route:
 *   1. Computes the user's MTD spend from cost_records
 *   2. Compares against their tier's session/cost limit
 *   3. Checks budget_threshold_sends for idempotency (one push per threshold
 *      per billing period)
 *   4. Sends a push notification respecting quiet hours
 *   5. Writes a budget_threshold_sends row to prevent re-firing
 *   6. Writes an audit_log entry (SOC2 CC7.2)
 *
 * WHY one push per threshold per billing period:
 * Without idempotency, a user who hits 80% on the 5th of the month would
 * receive this notification every hour for the rest of the month (hundreds
 * of pushes). budget_threshold_sends prevents that with a unique constraint
 * on (user_id, threshold_pct, billing_period_start).
 *
 * @auth Required - CRON_SECRET header (Bearer token)
 *
 * @returns 200 { success: true, checked: number, sent: number, skipped: number }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Budget threshold cron failed' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { sendRetentionPush } from '@/lib/pushNotifications';
import crypto from 'crypto';

/**
 * Threshold percentage to alert at.
 * WHY 80%: gives the user enough runway to act before hitting 100%
 * (e.g. reduce session frequency, upgrade tier, or pause). 90% would
 * leave only 10% buffer — too late for most monthly cadences.
 */
const DEFAULT_THRESHOLD_PCT = 80;

/**
 * Tier quota limits (in USD) — must stay in sync with billing/tier-logic.ts.
 * WHY duplicate here: the cron route runs server-side without React context.
 * These are conservative caps; the upgrade screen shows tighter estimates.
 */
const TIER_MONTHLY_COST_CAP: Record<string, number> = {
  free: 10,      // $10 soft cap for free tier
  pro: 49,       // Power plan price as cost proxy
  power: 200,    // $200 generous cap for Power users
  team: 500,     // Team base price as proxy
  business: 1500,
  enterprise: 5000,
};

const BATCH_SIZE = 300;

export async function POST(request: NextRequest) {
  // Timing-safe cron secret verification
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (
    !cronSecret ||
    !provided ||
    provided.length !== cronSecret.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(cronSecret))
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  let checked = 0;
  let sent = 0;
  let skipped = 0;

  try {
    // Get billing period start (first of current month)
    const now = new Date();
    const billingPeriodStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD

    // Fetch all active users with push_budget_threshold enabled
    const { data: users, error: usersError } = await supabase
      .from('notification_preferences')
      .select(`
        user_id,
        push_budget_threshold,
        push_enabled,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
        quiet_hours_timezone
      `)
      .eq('push_budget_threshold', true)
      .eq('push_enabled', true)
      .limit(BATCH_SIZE);

    if (usersError) {
      console.error('[budget-threshold] Failed to fetch users:', usersError.message);
      return NextResponse.json({ error: 'Budget threshold cron failed' }, { status: 500 });
    }

    if (!users || users.length === 0) {
      return NextResponse.json({ success: true, checked: 0, sent: 0, skipped: 0 });
    }

    // Process users in parallel
    const results = await Promise.allSettled(
      users.map((u) =>
        checkAndNotifyUser({
          supabase,
          userId: u.user_id,
          billingPeriodStart,
          thresholdPct: DEFAULT_THRESHOLD_PCT,
        })
      )
    );

    for (const result of results) {
      checked++;
      if (result.status === 'fulfilled') {
        if (result.value === 'sent') sent++;
        else skipped++;
      } else {
        skipped++;
        console.error('[budget-threshold] User check failed:', result.reason);
      }
    }

    return NextResponse.json({ success: true, checked, sent, skipped });
  } catch (error) {
    console.error(
      '[budget-threshold] Cron failed:',
      error instanceof Error ? error.message : 'Unknown'
    );
    return NextResponse.json({ error: 'Budget threshold cron failed' }, { status: 500 });
  }
}

/**
 * Check a single user's MTD spend and send a threshold push if needed.
 *
 * @param params.supabase - Admin Supabase client
 * @param params.userId - User to check
 * @param params.billingPeriodStart - ISO date string for billing period start (YYYY-MM-DD)
 * @param params.thresholdPct - Percentage of tier cap to alert at (e.g. 80)
 * @returns 'sent' | 'skipped'
 */
async function checkAndNotifyUser({
  supabase,
  userId,
  billingPeriodStart,
  thresholdPct,
}: {
  supabase: ReturnType<typeof createAdminClient>;
  userId: string;
  billingPeriodStart: string;
  thresholdPct: number;
}): Promise<'sent' | 'skipped'> {
  // Check idempotency — already sent this threshold this billing period?
  const { data: existing } = await supabase
    .from('budget_threshold_sends')
    .select('id')
    .eq('user_id', userId)
    .eq('threshold_pct', thresholdPct)
    .eq('billing_period_start', billingPeriodStart)
    .maybeSingle();

  if (existing) return 'skipped';

  // Get user's subscription tier
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const tier = subscription?.tier ?? 'free';
  const monthlyCap = TIER_MONTHLY_COST_CAP[tier] ?? TIER_MONTHLY_COST_CAP.free;
  const thresholdUsd = (monthlyCap * thresholdPct) / 100;

  // Compute MTD spend
  const { data: costData, error: costError } = await supabase
    .from('cost_records')
    .select('cost_usd')
    .eq('user_id', userId)
    .gte('created_at', `${billingPeriodStart}T00:00:00.000Z`);

  if (costError) {
    throw new Error(`Cost fetch failed for user ${userId}: ${costError.message}`);
  }

  const mtdSpend = (costData ?? []).reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

  // Has the user crossed the threshold?
  if (mtdSpend < thresholdUsd) return 'skipped';

  const pctUsed = Math.round((mtdSpend / monthlyCap) * 100);

  // Send the push
  const pushSent = await sendRetentionPush({
    userId,
    type: 'budget_threshold',
    title: `You've used ${pctUsed}% of your monthly budget`,
    body: `$${mtdSpend.toFixed(2)} spent this month. Tap to review your costs.`,
    data: {
      deepLink: '/costs',
      type: 'budget_threshold',
      pct_used: pctUsed,
      mtd_spend: mtdSpend,
      tier,
    },
    supabase,
    respectQuietHours: true,
  });

  if (!pushSent) return 'skipped';

  // Record idempotency row
  await supabase.from('budget_threshold_sends').insert({
    user_id: userId,
    threshold_pct: thresholdPct,
    billing_period_start: billingPeriodStart,
  });

  // Audit log (SOC2 CC7.2)
  await supabase.from('audit_log').insert({
    user_id: userId,
    event: 'notification_sent',
    metadata: {
      channel: 'push',
      template_id: 'budget_threshold',
      threshold_pct: thresholdPct,
      mtd_spend_usd: mtdSpend,
      tier,
      billing_period_start: billingPeriodStart,
    },
  });

  return 'sent';
}
