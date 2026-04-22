/**
 * Weekly Digest Email Cron
 *
 * POST /api/cron/weekly-digest
 *
 * Triggered by Vercel Cron (Sunday 23:00 UTC = 17:00 CT) or by the pg_cron
 * sentinel inserts in the notifications table. For each user who has
 * weekly_digest_email = TRUE, this route:
 *   1. Fetches the past week's session + cost data
 *   2. Renders and sends the weekly digest email via Resend
 *   3. Sends the Sunday summary push notification (respects quiet hours)
 *   4. Marks the notifications row as email_sent_at and push_sent_at
 *   5. Writes an audit_log entry per send (SOC2 CC7.2)
 *
 * WHY a Next.js route instead of a pure pg_cron function:
 * pg_cron cannot call Resend directly (no HTTP from inside Postgres).
 * The pg_cron job inserts a sentinel row at 23:00 UTC; this route renders
 * the React Email template and delivers via Resend. Separation keeps the
 * email rendering concern (React, Resend SDK) out of Postgres.
 *
 * @auth Required - CRON_SECRET header (Bearer token)
 * @rateLimit N/A - server-to-server only
 *
 * @body None — processes all pending weekly_digest notifications
 *
 * @returns 200 { success: true, sent: number, skipped: number, errors: number }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Weekly digest cron failed' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { sendWeeklyDigestEmail } from '@/lib/resend';
import { sendRetentionPush } from '@/lib/pushNotifications';
import crypto from 'crypto';

/**
 * Maximum users to process per cron invocation.
 * WHY: Prevents Vercel function timeout (max 300s). At ~50ms per user
 * (email + push), 200 users = ~10s. Scale with Vercel Cron concurrency
 * when user base grows.
 */
const BATCH_SIZE = 200;

/**
 * Threshold for "user has been active this week" — sessions in the past 7 days.
 * Users with zero activity get a re-engagement digest, not a cost summary.
 */
const ACTIVE_SESSION_THRESHOLD = 7; // days

export async function POST(request: NextRequest) {
  // Verify cron secret — timing-safe comparison (prevents timing oracle attacks)
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
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // Find pending weekly_digest notification rows (inserted by pg_cron sentinel)
    const { data: pendingRows, error: fetchError } = await supabase
      .from('notifications')
      .select('id, user_id, metadata')
      .eq('type', 'weekly_digest')
      .is('email_sent_at', null)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error('[weekly-digest] Failed to fetch pending rows:', fetchError.message);
      return NextResponse.json({ error: 'Weekly digest cron failed' }, { status: 500 });
    }

    if (!pendingRows || pendingRows.length === 0) {
      return NextResponse.json({ success: true, sent: 0, skipped: 0, errors: 0 });
    }

    // Process each pending notification in parallel (bounded concurrency)
    const results = await Promise.allSettled(
      pendingRows.map((row) =>
        processDigestForUser(supabase, row.id, row.user_id, row.metadata)
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value === 'sent') sent++;
        else skipped++;
      } else {
        errors++;
        console.error('[weekly-digest] User processing failed:', result.reason);
      }
    }

    return NextResponse.json({ success: true, sent, skipped, errors });
  } catch (error) {
    console.error('[weekly-digest] Cron failed:', error instanceof Error ? error.message : 'Unknown');
    return NextResponse.json({ error: 'Weekly digest cron failed' }, { status: 500 });
  }
}

/**
 * Process the weekly digest for a single user.
 *
 * @param supabase - Admin Supabase client
 * @param notificationId - The notifications table row to mark as sent
 * @param userId - User ID to build digest for
 * @param metadata - Notification metadata with period_start and period_end
 * @returns 'sent' if email was delivered, 'skipped' if user preferences prevent send
 */
async function processDigestForUser(
  supabase: ReturnType<typeof createAdminClient>,
  notificationId: string,
  userId: string,
  metadata: Record<string, unknown>
): Promise<'sent' | 'skipped'> {
  // Fetch user profile + notification preferences
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select(`
      id,
      display_name,
      timezone,
      deleted_at
    `)
    .eq('id', userId)
    .single();

  if (profileError || !profile || profile.deleted_at) {
    // User deleted — mark notification as skipped by setting sent time
    await supabase
      .from('notifications')
      .update({ email_sent_at: new Date().toISOString() })
      .eq('id', notificationId);
    return 'skipped';
  }

  const { data: prefs, error: prefsError } = await supabase
    .from('notification_preferences')
    .select('weekly_digest_email, push_weekly_summary, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone, email_enabled')
    .eq('user_id', userId)
    .single();

  if (prefsError || !prefs) {
    // No prefs row — use defaults (all enabled)
  }

  // Respect email opt-out
  const emailEnabled = prefs?.email_enabled !== false && prefs?.weekly_digest_email !== false;

  // Fetch the user's email from auth
  const { data: { user: authUser }, error: authError } = await supabase.auth.admin.getUserById(userId);

  if (authError || !authUser?.email) {
    return 'skipped';
  }

  // Determine period
  const periodStart = metadata?.period_start
    ? new Date(metadata.period_start as string)
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const periodEnd = metadata?.period_end
    ? new Date(metadata.period_end as string)
    : new Date();

  // Fetch session stats for the week
  const { data: sessionStats, error: statsError } = await supabase
    .from('sessions')
    .select('id, agent_type, total_cost_usd, started_at, ended_at')
    .eq('user_id', userId)
    .gte('started_at', periodStart.toISOString())
    .lt('started_at', periodEnd.toISOString())
    .is('deleted_at', null)
    .not('status', 'eq', 'failed');

  if (statsError) {
    console.error(`[weekly-digest] Failed to fetch stats for user ${userId}:`, statsError.message);
    throw new Error(`Stats fetch failed: ${statsError.message}`);
  }

  const sessions = sessionStats ?? [];

  // Fetch last week's cost for comparison
  const prevPeriodStart = new Date(periodStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const { data: prevSessions } = await supabase
    .from('sessions')
    .select('total_cost_usd')
    .eq('user_id', userId)
    .gte('started_at', prevPeriodStart.toISOString())
    .lt('started_at', periodStart.toISOString())
    .is('deleted_at', null);

  const totalCostUsd = sessions.reduce((sum, s) => sum + (s.total_cost_usd ?? 0), 0);
  const prevCostUsd = (prevSessions ?? []).reduce((sum, s) => sum + (s.total_cost_usd ?? 0), 0);

  const costChange =
    prevCostUsd > 0
      ? Math.round(((totalCostUsd - prevCostUsd) / prevCostUsd) * 100)
      : 0;

  // Build per-agent stats
  const agentMap = new Map<string, { sessions: number; cost: number; tokens: number }>();
  for (const s of sessions) {
    const key = s.agent_type ?? 'unknown';
    const existing = agentMap.get(key) ?? { sessions: 0, cost: 0, tokens: 0 };
    agentMap.set(key, {
      sessions: existing.sessions + 1,
      cost: existing.cost + (s.total_cost_usd ?? 0),
      tokens: existing.tokens, // token data on session level if available
    });
  }

  const agentStats = Array.from(agentMap.entries())
    .sort(([, a], [, b]) => b.cost - a.cost)
    .slice(0, 3)
    .map(([name, stats]) => ({
      name,
      sessions: stats.sessions,
      cost: `$${stats.cost.toFixed(2)}`,
      tokens: stats.tokens > 0 ? `${(stats.tokens / 1000).toFixed(1)}k` : '-',
    }));

  const totalSessions = sessions.length;
  const formattedCost = `$${totalCostUsd.toFixed(2)}`;
  const weekOf = periodStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  let emailResult: { success: boolean } = { success: false };

  if (emailEnabled && authUser.email) {
    emailResult = await sendWeeklyDigestEmail({
      email: authUser.email,
      displayName: profile.display_name ?? undefined,
      weekOf,
      totalCost: formattedCost,
      totalSessions,
      // WHY: totalTokens was removed from WeeklyDigestEmailProps as the email
      // template does not render a token count (it focuses on cost and session
      // count, which are more meaningful to end users than raw token numbers).
      costChange,
      agentStats,
    });
  }

  // Send push (respecting quiet hours)
  let pushSent = false;
  if (prefs?.push_weekly_summary !== false) {
    const topAgent = agentStats[0]?.name ?? 'your agents';
    const pushBody =
      totalSessions > 0
        ? `This week: ${formattedCost} spent, ${totalSessions} session${totalSessions !== 1 ? 's' : ''}, top agent ${topAgent}`
        : 'No sessions this week - start coding with an AI agent!';

    pushSent = await sendRetentionPush({
      userId,
      type: 'weekly_summary_push',
      title: 'Your weekly Styrby summary',
      body: pushBody,
      data: { deepLink: '/dashboard', type: 'weekly_summary_push' },
      supabase,
      respectQuietHours: true,
    });
  }

  // Mark notification as sent
  const now = new Date().toISOString();
  await supabase
    .from('notifications')
    .update({
      email_sent_at: emailResult.success ? now : null,
      push_sent_at: pushSent ? now : null,
      title: `Your week: ${formattedCost}, ${totalSessions} sessions`,
      body:
        totalSessions > 0
          ? `${agentStats[0]?.name ?? 'AI coding'} was your top agent this week.`
          : 'No sessions this week.',
    })
    .eq('id', notificationId);

  // Audit log for SOC2 CC7.2 — communication to external parties logged
  if (emailResult.success || pushSent) {
    await supabase.from('audit_log').insert({
      user_id: userId,
      event: 'notification_sent',
      metadata: {
        channel: emailResult.success && pushSent ? 'email+push' : emailResult.success ? 'email' : 'push',
        template_id: 'weekly_digest',
        recipient: authUser.email,
        notification_id: notificationId,
        total_sessions: totalSessions,
        total_cost_usd: totalCostUsd,
      },
    });
  }

  return emailResult.success || pushSent ? 'sent' : 'skipped';
}
