/**
 * Generate Digest Cron
 *
 * GET /api/cron/generate-digest?period=daily   (Growth users, runs every day)
 * GET /api/cron/generate-digest?period=weekly  (Pro + Growth users, runs Sundays)
 *
 * For each eligible user:
 *   1. Compute the period window (last 24h for daily, last 7d for weekly).
 *   2. Query their sessions in that window.
 *   3. If at least one session exists, ask OpenRouter (gpt-4o-mini) to
 *      generate a 2-3 sentence narrative digest.
 *   4. INSERT into digest_summaries (idempotent via UNIQUE constraint).
 *   5. Email the digest via Resend and stamp emailed_at.
 *
 * WHY GET (not POST): Vercel Cron only supports GET requests against the
 * configured path; the route still requires the CRON_SECRET bearer for
 * auth, so this is not a public endpoint.
 *
 * @auth Required - CRON_SECRET header (Bearer token)
 * @returns 200 { generated: number, emailed: number, errors: string[] }
 * @error 400 invalid period
 * @error 401 missing/wrong cron secret
 * @error 500 cron failure (unexpected)
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { sendDigestEmail } from '@/lib/resend';
import { generateDigestContent } from '@/lib/digest/generate';

/**
 * Maximum users processed per cron invocation. Caps Vercel function
 * runtime — at ~1s/user (LLM call dominates) this gives ~5 min headroom.
 */
const BATCH_SIZE = 200;

type Period = 'daily' | 'weekly';

/** Tiers eligible for each period. Daily = Growth only; Weekly = Pro + Growth. */
const ELIGIBLE_TIERS: Record<Period, string[]> = {
  daily: ['growth'],
  weekly: ['pro', 'growth'],
};

export async function GET(request: NextRequest) {
  // ---- Auth: timing-safe cron secret comparison ----
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

  // ---- Period selection ----
  const period = request.nextUrl.searchParams.get('period') as Period | null;
  if (period !== 'daily' && period !== 'weekly') {
    return NextResponse.json(
      { error: "Invalid period. Use ?period=daily or ?period=weekly." },
      { status: 400 }
    );
  }

  // Compute period window. Anchored to wall-clock UTC; for V1 we don't
  // adjust per-user timezone (project default is America/Chicago and the
  // cron schedule already targets 8am CT).
  const now = new Date();
  const periodStart = new Date(now);
  if (period === 'daily') {
    periodStart.setUTCDate(periodStart.getUTCDate() - 1);
  } else {
    periodStart.setUTCDate(periodStart.getUTCDate() - 7);
  }

  const supabase = createAdminClient();

  // ---- Fetch eligible users ----
  const { data: subs, error: subsError } = await supabase
    .from('subscriptions')
    .select('user_id, tier')
    .in('tier', ELIGIBLE_TIERS[period])
    .eq('status', 'active')
    .limit(BATCH_SIZE);

  if (subsError) {
    console.error('[generate-digest] Failed to fetch subscriptions:', subsError.message);
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 });
  }

  if (!subs || subs.length === 0) {
    return NextResponse.json({ generated: 0, emailed: 0, errors: [] });
  }

  // ---- Fan out per user (Promise.allSettled — one failure doesn't kill the run) ----
  const results = await Promise.allSettled(
    subs.map((s) =>
      processUser({
        supabase,
        userId: s.user_id as string,
        period,
        periodStart,
        periodEnd: now,
      })
    )
  );

  let generated = 0;
  let emailed = 0;
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.generated) generated++;
      if (r.value.emailed) emailed++;
    } else {
      errors.push(String(r.reason?.message ?? r.reason));
    }
  }

  return NextResponse.json({ generated, emailed, errors });
}

interface ProcessArgs {
  supabase: ReturnType<typeof createAdminClient>;
  userId: string;
  period: Period;
  periodStart: Date;
  periodEnd: Date;
}

interface ProcessResult {
  generated: boolean;
  emailed: boolean;
  reason?: string;
}

/**
 * Generate + persist + email a digest for a single user.
 * Returns granular flags so the orchestrator can tally counts.
 */
export async function processUser(args: ProcessArgs): Promise<ProcessResult> {
  const { supabase, userId, period, periodStart, periodEnd } = args;

  // Pull this user's sessions in the window.
  const { data: sessions, error: sessionsError } = await supabase
    .from('sessions')
    .select('id, title, agent_type, status, total_cost_usd, message_count, created_at')
    .eq('user_id', userId)
    .gte('created_at', periodStart.toISOString())
    .lte('created_at', periodEnd.toISOString())
    .order('created_at', { ascending: false })
    .limit(200);

  if (sessionsError) {
    return { generated: false, emailed: false, reason: sessionsError.message };
  }

  // Skip silent: no sessions = no spam.
  if (!sessions || sessions.length === 0) {
    return { generated: false, emailed: false, reason: 'no_sessions' };
  }

  // ---- LLM digest generation ----
  const content = await generateDigestContent({ period, sessions });

  // ---- Persist (idempotent on UNIQUE (user_id, period, period_start)) ----
  // ON CONFLICT DO NOTHING via upsert with ignoreDuplicates.
  const { error: insertError } = await supabase.from('digest_summaries').upsert(
    {
      user_id: userId,
      period,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      session_count: sessions.length,
      content,
    },
    { onConflict: 'user_id,period,period_start', ignoreDuplicates: true }
  );

  if (insertError) {
    return { generated: false, emailed: false, reason: insertError.message };
  }

  // ---- Email dispatch ----
  // Look up email — we use the admin auth API to keep the schema lean
  // (no need to denormalise email into subscriptions/profiles).
  const { data: userResp } = await supabase.auth.admin.getUserById(userId);
  const email = userResp?.user?.email;
  if (!email) {
    return { generated: true, emailed: false, reason: 'no_email' };
  }

  let emailed = false;
  try {
    const dateLabel = formatPeriodLabel(period, periodStart, periodEnd);
    await sendDigestEmail({
      email,
      period,
      dateLabel,
      sessionCount: sessions.length,
      content: content ?? '',
    });
    emailed = true;
    await supabase
      .from('digest_summaries')
      .update({ emailed_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('period', period)
      .eq('period_start', periodStart.toISOString());
  } catch (err) {
    return { generated: true, emailed: false, reason: (err as Error).message };
  }

  return { generated: true, emailed };
}

/**
 * Format a human label for the digest period (used in the email subject
 * and dashboard panel). Example: "week of May 4" or "May 4".
 */
function formatPeriodLabel(period: Period, start: Date, end: Date): string {
  const monthDay = end.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return period === 'weekly' ? `week of ${monthDay}` : monthDay;
}
