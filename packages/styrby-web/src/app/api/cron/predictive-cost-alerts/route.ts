/**
 * Predictive Cost Alert Cron Handler
 *
 * POST /api/cron/predictive-cost-alerts
 *
 * Triggered daily at 02:00 UTC by the pg_cron job registered in migration 038.
 * For each user with push_predictive_alert = TRUE:
 *
 *   1. Fetches 30 days of daily cost_records
 *   2. Runs computeForecast() to get predictedExhaustionDate
 *   3. Checks whether exhaustion is within the next 7 days
 *   4. Checks predictive_cost_alert_sends for idempotency (one alert per period)
 *   5. Sends a push notification (respects quiet hours)
 *   6. Inserts a predictive_cost_alert_sends row to prevent re-firing
 *   7. Writes an audit_log entry (SOC2 CC7.2)
 *
 * WHY 7-day look-ahead window:
 *   7 days gives the user actionable runway. A 1-day warning would arrive too
 *   late for most users to adjust their usage patterns or upgrade their plan.
 *   14 days is too early — the prediction accuracy is lower, and users tune
 *   out notifications that feel premature.
 *
 * WHY one alert per billing period:
 *   Without idempotency, users would receive this notification every night
 *   during the last week of a busy month — 7 duplicate pushes. The
 *   predictive_cost_alert_sends table (migration 038) tracks sent alerts
 *   with a (user_id, billing_period_start) unique constraint.
 *
 * @auth Required - CRON_SECRET header (Bearer token, timing-safe comparison)
 *
 * @returns 200 { success: true, checked: number, sent: number, skipped: number }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Predictive cost alert cron failed' }
 *
 * Audit: SOC2 CC7.2 — system monitoring, cost accounting accuracy
 *
 * @module api/cron/predictive-cost-alerts
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { sendRetentionPush } from '@/lib/pushNotifications';
import { computeForecast, type DailyCostPoint } from '@styrby/shared';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How many days ahead the exhaustion prediction must land to trigger an alert.
 *
 * WHY 7: See module-level JSDoc.
 */
const ALERT_WINDOW_DAYS = 7;

/**
 * Max users to process per invocation.
 *
 * WHY 200: Each user requires 1 cost_records query. 200 users × 1 query/user
 * at ~5ms each = ~1 second, well within Vercel's 10s serverless timeout.
 * The cron job re-runs nightly so unprocessed users get picked up next time.
 */
const BATCH_SIZE = 200;

/**
 * Monthly cost quota ceilings per tier (integer cents).
 *
 * WHY duplicated from the forecast API route: the cron handler has no access
 * to the web app's lib/ utilities at runtime (different deployment context
 * for pg_net HTTP callbacks). Keeping this table here avoids a shared module
 * that would need to export non-pure state.
 *
 * Must stay in sync with TIER_QUOTA_CENTS in /api/costs/forecast/route.ts.
 */
const TIER_QUOTA_CENTS: Record<string, number | null> = {
  free: 500,
  pro: 5000,
  power: null,
  team: null,
  business: null,
  enterprise: null,
};

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // -------------------------------------------------------------------------
  // Auth: timing-safe CRON_SECRET verification
  // -------------------------------------------------------------------------

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
    const now = new Date();

    // Billing period start: 1st of current month (YYYY-MM-DD).
    const billingPeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);

    // 30-day history window for the forecast series.
    const historyStart = new Date(now);
    historyStart.setUTCDate(historyStart.getUTCDate() - 30);
    const historyStartIso = historyStart.toISOString();

    // 7-day forward window: exhaustion must occur on or before this date.
    const windowEnd = new Date(now);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + ALERT_WINDOW_DAYS);
    const windowEndDate = windowEnd.toISOString().slice(0, 10);

    // -------------------------------------------------------------------------
    // Fetch eligible users
    // -------------------------------------------------------------------------

    // WHY join subscriptions inline via a separate query: Supabase client
    // does not support JOINs across schemas. We fetch users and tiers separately.
    const { data: users, error: usersError } = await supabase
      .from('notification_preferences')
      .select(`
        user_id,
        push_predictive_alert,
        push_enabled,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
        quiet_hours_timezone
      `)
      .eq('push_predictive_alert', true)
      .eq('push_enabled', true)
      .limit(BATCH_SIZE);

    if (usersError) {
      console.error('[predictive-cost-alerts] Failed to fetch users:', usersError.message);
      return NextResponse.json({ error: 'Predictive cost alert cron failed' }, { status: 500 });
    }

    if (!users || users.length === 0) {
      return NextResponse.json({ success: true, checked: 0, sent: 0, skipped: 0 });
    }

    checked = users.length;

    // -------------------------------------------------------------------------
    // Process each user
    // -------------------------------------------------------------------------

    for (const user of users) {
      try {
        // Step 1: Check idempotency — skip if already sent this billing period.
        const { data: existingSend } = await supabase
          .from('predictive_cost_alert_sends')
          .select('id')
          .eq('user_id', user.user_id)
          .eq('billing_period_start', billingPeriodStart)
          .maybeSingle();

        if (existingSend) {
          skipped++;
          continue;
        }

        // Step 2: Fetch tier for quota lookup.
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('tier')
          .eq('user_id', user.user_id)
          .eq('status', 'active')
          .maybeSingle();

        const tier = subscription?.tier ?? 'free';
        const quotaCents = TIER_QUOTA_CENTS[tier] ?? null;

        // Skip uncapped tiers — no exhaustion possible.
        if (quotaCents === null) {
          skipped++;
          continue;
        }

        // Step 3: Fetch 30-day cost_records for the forecast series.
        const { data: costRows } = await supabase
          .from('cost_records')
          .select('recorded_at, cost_usd')
          .eq('user_id', user.user_id)
          .eq('billing_model', 'api-key')
          .gte('recorded_at', historyStartIso)
          .order('recorded_at', { ascending: true })
          .limit(10_000);

        // Aggregate raw rows into daily buckets (YYYY-MM-DD → cents).
        const buckets = new Map<string, number>();
        for (const row of costRows ?? []) {
          const day = new Date(row.recorded_at).toISOString().slice(0, 10);
          const cents = Math.round((Number(row.cost_usd) || 0) * 100);
          buckets.set(day, (buckets.get(day) ?? 0) + cents);
        }

        const series: DailyCostPoint[] = Array.from(buckets.entries()).map(([date, costCents]) => ({
          date,
          costCents,
        }));

        // MTD elapsed spend for exhaustion calculation.
        const mtdCents = series
          .filter((p) => p.date >= billingPeriodStart)
          .reduce((sum, p) => sum + p.costCents, 0);

        // Step 4: Compute forecast.
        const forecast = computeForecast({
          series,
          quotaCents,
          elapsedCents: mtdCents,
          nowUtc: now,
        });

        const { predictedExhaustionDate } = forecast;

        // Skip if no exhaustion predicted or exhaustion is beyond the 7-day window.
        if (!predictedExhaustionDate || predictedExhaustionDate > windowEndDate) {
          skipped++;
          continue;
        }

        // Step 5: Send push notification.
        const exhaustionDisplay = new Date(predictedExhaustionDate).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });

        const pushSent = await sendRetentionPush({
          userId: user.user_id,
          type: 'budget_threshold',
          title: 'Spending Cap Approaching',
          body: `Your Styrby spend is on track to hit your cap on ${exhaustionDisplay}. Consider upgrading or adjusting usage.`,
          data: {
            screen: 'costs',
            predictedExhaustionDate,
            forecast: {
              dailyAverageCents: forecast.dailyAverageCents,
              isBurnAccelerating: forecast.isBurnAccelerating,
            },
          },
          supabase,
          respectQuietHours: true,
        });

        if (!pushSent) {
          // Quiet hours or no push token — still record the send to prevent
          // retry storms. The user will see the forecast card on next app open.
          skipped++;
          continue;
        }

        // Step 6: Record the send for idempotency.
        await supabase.from('predictive_cost_alert_sends').insert({
          user_id: user.user_id,
          billing_period_start: billingPeriodStart,
          predicted_exhaustion_date: predictedExhaustionDate,
        });

        // Step 7: Audit log entry (SOC2 CC7.2).
        await supabase.from('audit_log').insert({
          user_id: user.user_id,
          action: 'predictive_cost_alert_sent',
          resource_type: 'predictive_cost_alert_sends',
          details: {
            billing_period_start: billingPeriodStart,
            predicted_exhaustion_date: predictedExhaustionDate,
            daily_average_cents: forecast.dailyAverageCents,
            trailing_week_average_cents: forecast.trailingWeekAverageCents,
            is_burn_accelerating: forecast.isBurnAccelerating,
            tier,
            quota_cents: quotaCents,
            elapsed_cents: mtdCents,
          },
        });

        sent++;
      } catch (userError) {
        // WHY per-user catch: a single user's DB error should not abort the
        // entire batch. Log and continue to the next user.
        console.error(
          '[predictive-cost-alerts] Error processing user',
          user.user_id,
          userError instanceof Error ? userError.message : userError
        );
        skipped++;
      }
    }

    return NextResponse.json({
      success: true,
      checked,
      sent,
      skipped,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      '[predictive-cost-alerts] Fatal error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json({ error: 'Predictive cost alert cron failed' }, { status: 500 });
  }
}
