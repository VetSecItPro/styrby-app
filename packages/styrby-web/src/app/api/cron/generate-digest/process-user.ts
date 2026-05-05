/**
 * Per-user digest processing helpers.
 *
 * Extracted from `route.ts` because Next.js App Router rejects any
 * named export from a route.ts file other than HTTP verbs (GET/POST/etc).
 * Keeping these helpers in a sibling module preserves test importability
 * + Next.js route validation.
 */

import type { createAdminClient } from '@/lib/supabase/server';
import { sendDigestEmail } from '@/lib/resend';
import { generateDigestContent } from '@/lib/digest/generate';

export type Period = 'daily' | 'weekly';

/** Tiers eligible for each period. Daily = Growth only; Weekly = Pro + Growth. */
export const ELIGIBLE_TIERS: Record<Period, string[]> = {
  daily: ['growth'],
  weekly: ['pro', 'growth'],
};

/**
 * Maximum users processed per cron invocation. Caps Vercel function
 * runtime, at ~1s/user (LLM call dominates) this gives ~5 min headroom.
 */
export const BATCH_SIZE = 200;

export interface ProcessArgs {
  supabase: ReturnType<typeof createAdminClient>;
  userId: string;
  period: Period;
  periodStart: Date;
  periodEnd: Date;
}

export interface ProcessResult {
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

  if (!sessions || sessions.length === 0) {
    return { generated: false, emailed: false, reason: 'no_sessions' };
  }

  const content = await generateDigestContent({ period, sessions });

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
 * Format a human label for the digest period. Example: "week of May 4".
 */
export function formatPeriodLabel(period: Period, _start: Date, end: Date): string {
  const monthDay = end.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return period === 'weekly' ? `week of ${monthDay}` : monthDay;
}
