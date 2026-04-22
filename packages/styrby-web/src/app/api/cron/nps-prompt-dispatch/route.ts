/**
 * NPS Prompt Mobile Push Dispatch Cron
 *
 * POST /api/cron/nps-prompt-dispatch
 *
 * Triggered every 15 minutes by Vercel Cron. Picks up user_feedback_prompts
 * rows where:
 *   - due_at <= NOW()
 *   - dispatched_at IS NOT NULL (the pg_cron fn_dispatch_due_nps_prompts
 *     function already marked these as dispatched and created the in-app
 *     notification)
 *   - push_message_id IS NULL (mobile push not yet sent)
 *
 * WHY separate from fn_dispatch_due_nps_prompts:
 * pg_cron cannot call the Expo Push API (no outbound HTTP from Postgres).
 * fn_dispatch_due_nps_prompts inserts the in-app notification and marks
 * dispatched_at so the user sees the prompt in the feed even if this route
 * is temporarily down. This route handles the mobile push separately —
 * the two-step approach guarantees in-app delivery while best-effort for push.
 *
 * Each push sends:
 *   Title: "Quick question about Styrby" (7d) or "How is Styrby working for you?" (30d)
 *   Body: "How likely are you to recommend Styrby? 0-10 — takes 30 seconds."
 *   Deep link: /nps/<kind>?prompt_id=<uuid>
 *
 * @auth Required - CRON_SECRET header (Bearer token)
 * @schedule Every 15 min via Vercel Cron
 *
 * @returns 200 { success: true, found: number, sent: number, skipped: number }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'NPS prompt dispatch failed' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { sendRetentionPush } from '@/lib/pushNotifications';
import crypto from 'crypto';

/** Maximum prompts to process per run. Prevents long-running serverless executions. */
const BATCH_SIZE = 200;

/**
 * NPS prompt push copy keyed by prompt kind.
 *
 * WHY no em-dashes per CLAUDE.md: Use regular dashes or colons instead.
 * "Quick question" title avoids "survey" framing which reduces open rates.
 */
const NPS_PUSH_COPY: Record<string, { title: string; body: string }> = {
  nps_7d: {
    title: 'Quick question about Styrby',
    body: 'How likely are you to recommend Styrby to a friend? Tap to share your score - takes 30 seconds.',
  },
  nps_30d: {
    title: 'How is Styrby working for you?',
    body: 'One month in - how likely are you to recommend Styrby? Tap to rate.',
  },
};

export async function POST(request: NextRequest) {
  // Timing-safe cron secret verification.
  // WHY: timingSafeEqual prevents timing-based secret enumeration attacks.
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

  let found = 0;
  let sent = 0;
  let skipped = 0;

  try {
    // Fetch prompts that are:
    // - dispatched (in-app notification already inserted by pg_cron)
    // - no mobile push sent yet
    // - not dismissed
    const { data: prompts, error: fetchErr } = await supabase
      .from('user_feedback_prompts')
      .select('id, user_id, kind')
      .not('dispatched_at', 'is', null)
      .is('push_message_id', null)
      .is('dismissed_at', null)
      .order('due_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchErr) {
      console.error('[nps-prompt-dispatch] fetch error:', fetchErr);
      return NextResponse.json({ error: 'NPS prompt dispatch failed' }, { status: 500 });
    }

    found = prompts?.length ?? 0;

    for (const prompt of prompts ?? []) {
      const copy = NPS_PUSH_COPY[prompt.kind] ?? NPS_PUSH_COPY['nps_7d'];
      const deepLink = `/nps/${prompt.kind}?prompt_id=${prompt.id}`;

      // WHY: sendRetentionPush checks quiet hours, looks up all device tokens,
      // and handles stale token cleanup. We pass respectQuietHours=true because
      // NPS prompts are not time-sensitive.
      // WHY boolean return: sendRetentionPush returns true if any token received
      // the push, false if all suppressed (quiet hours, no tokens, etc.)
      const pushDelivered = await sendRetentionPush({
        userId: prompt.user_id,
        type: 'milestone',
        title: copy.title,
        body: copy.body,
        data: {
          deepLink,
          promptId: prompt.id,
          kind: prompt.kind,
          npsPrompt: true,
        },
        supabase,
        respectQuietHours: true,
      });

      if (pushDelivered) {
        // Record that the push was sent on the prompt row for idempotency
        await supabase
          .from('user_feedback_prompts')
          .update({ push_message_id: 'sent' })
          .eq('id', prompt.id);

        // Audit log: SOC2 CC7.2 - communication to external parties is logged
        await supabase.from('audit_log').insert({
          user_id: prompt.user_id,
          event_type: 'nps_push_sent',
          metadata: {
            prompt_id: prompt.id,
            kind: prompt.kind,
          },
        });

        sent++;
      } else {
        // No active push tokens or quiet hours active — not an error
        skipped++;
      }
    }

    return NextResponse.json({ success: true, found, sent, skipped });
  } catch (err) {
    console.error('[nps-prompt-dispatch] unexpected error:', err);
    return NextResponse.json({ error: 'NPS prompt dispatch failed' }, { status: 500 });
  }
}
