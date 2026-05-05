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
import {
  processUser,
  ELIGIBLE_TIERS,
  BATCH_SIZE,
  type Period,
} from './process-user';

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

