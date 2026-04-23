/**
 * Agent-Finished-While-Away Push Notification Cron
 *
 * POST /api/cron/agent-finished
 *
 * Triggered every 2 minutes by Vercel Cron. Detects sessions that:
 *   - Completed within the last 5 minutes
 *   - Belong to a user who has not been active on their phone for > 5 minutes
 *     (measured by device_tokens.last_used_at or profiles.last_active_at)
 *
 * Then sends a push: "Your [Agent] session finished. Tap to review."
 *
 * WHY 5-minute window for both away-detection and completion window:
 * This is the "killer feature" of Styrby — you walk away while Claude Code
 * runs a big refactor; when it finishes, your phone buzzes. If the user is
 * still actively watching (last_active_at < 5 min ago), the push is noise —
 * they can already see the terminal. Only notify when they're actually away.
 *
 * WHY Vercel Cron (every 2 min) rather than a Supabase trigger:
 * Supabase Edge Functions can be triggered by database changes, but push
 * delivery requires querying device_tokens, checking quiet hours, calling
 * the Expo/FCM/APNs send endpoint, and writing audit_log — all of which
 * exceed a simple DB trigger's purview. Cron keeps the logic centralized
 * and testable.
 *
 * @auth Required - CRON_SECRET header (Bearer token)
 *
 * @returns 200 { success: true, found: number, sent: number, skipped: number }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Agent-finished cron failed' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { sendRetentionPush } from '@/lib/pushNotifications';
import crypto from 'crypto';

/**
 * Session must have ended within this many minutes to be eligible.
 * WHY 5 min: prevents re-notifying on sessions that ended hours ago (which
 * would be covered by the weekly digest). The cron runs every 2 minutes
 * so no eligible session should be missed.
 */
const SESSION_ENDED_WINDOW_MINUTES = 5;

/**
 * User must have been away for this long before we send the push.
 * WHY 5 min: short enough to be timely; long enough to avoid buzzing someone
 * who is actively watching the terminal scroll.
 */
const USER_AWAY_THRESHOLD_MINUTES = 5;

/** Agent display names for push copy. */
const AGENT_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  aider: 'Aider',
  goose: 'Goose',
  amp: 'Amp',
  crush: 'Crush',
  kilo: 'Kilo',
  kiro: 'Kiro',
  droid: 'Droid',
};

const BATCH_SIZE = 100;

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
  let found = 0;
  let sent = 0;
  let skipped = 0;

  try {
    const now = new Date();
    const sessionEndedCutoff = new Date(
      now.getTime() - SESSION_ENDED_WINDOW_MINUTES * 60 * 1000
    ).toISOString();
    const userAwayCutoff = new Date(
      now.getTime() - USER_AWAY_THRESHOLD_MINUTES * 60 * 1000
    ).toISOString();

    // Find recently-ended sessions where the user is away
    // WHY LEFT JOIN on notification_preferences: if no prefs row exists,
    // treat as defaults (all enabled). COALESCE handles NULL columns.
    const { data: eligibleSessions, error: queryError } = await supabase
      .from('sessions')
      .select(`
        id,
        user_id,
        agent_type,
        ended_at,
        summary,
        profiles!inner (
          id,
          last_active_at,
          deleted_at
        )
      `)
      .eq('status', 'ended')
      .gte('ended_at', sessionEndedCutoff)
      .lte('ended_at', now.toISOString())
      .is('deleted_at', null)
      .limit(BATCH_SIZE);

    if (queryError) {
      console.error('[agent-finished] Session query failed:', queryError.message);
      return NextResponse.json({ error: 'Agent-finished cron failed' }, { status: 500 });
    }

    if (!eligibleSessions || eligibleSessions.length === 0) {
      return NextResponse.json({ success: true, found: 0, sent: 0, skipped: 0 });
    }

    const results = await Promise.allSettled(
      eligibleSessions.map(async (session) => {
        found++;

        // Type guard for profile join
        const profile = Array.isArray(session.profiles)
          ? session.profiles[0]
          : session.profiles;

        if (!profile || profile.deleted_at) {
          skipped++;
          return;
        }

        // Check if user is away
        const lastActive = profile.last_active_at
          ? new Date(profile.last_active_at)
          : new Date(0);
        const isAway = lastActive < new Date(userAwayCutoff);

        if (!isAway) {
          skipped++;
          return;
        }

        // Check notification preferences
        const { data: prefs } = await supabase
          .from('notification_preferences')
          .select('push_enabled, push_agent_finished, push_session_complete')
          .eq('user_id', session.user_id)
          .maybeSingle();

        // Respect push_agent_finished (new column) or legacy push_session_complete
        const pushEnabled =
          prefs?.push_enabled !== false &&
          (prefs?.push_agent_finished !== false || prefs?.push_session_complete !== false);

        if (!pushEnabled) {
          skipped++;
          return;
        }

        // Check for duplicate push (don't fire twice for same session)
        const { data: existing } = await supabase
          .from('notifications')
          .select('id')
          .eq('user_id', session.user_id)
          .eq('type', 'agent_finished')
          .contains('metadata', { session_id: session.id })
          .maybeSingle();

        if (existing) {
          skipped++;
          return;
        }

        const agentName =
          AGENT_DISPLAY_NAMES[session.agent_type ?? ''] ?? session.agent_type ?? 'Your agent';

        const summary = session.summary
          ? `: "${session.summary.slice(0, 60)}${session.summary.length > 60 ? '...' : ''}"`
          : '';

        const pushSent = await sendRetentionPush({
          userId: session.user_id,
          type: 'agent_finished',
          title: `${agentName} session finished`,
          body: `Your session just wrapped up${summary}. Tap to review.`,
          data: {
            deepLink: `/sessions/${session.id}`,
            type: 'agent_finished',
            session_id: session.id,
            agent_type: session.agent_type,
          },
          supabase,
          respectQuietHours: true,
        });

        if (!pushSent) {
          skipped++;
          return;
        }

        // Insert in-app notification for feed
        await supabase.from('notifications').insert({
          user_id: session.user_id,
          type: 'agent_finished',
          title: `${agentName} session finished`,
          body: `Your session wrapped up${summary}.`,
          deep_link: `/sessions/${session.id}`,
          metadata: {
            session_id: session.id,
            agent_type: session.agent_type,
            ended_at: session.ended_at,
          },
          push_sent_at: new Date().toISOString(),
        });

        // Audit log (SOC2 CC7.2)
        await supabase.from('audit_log').insert({
          user_id: session.user_id,
          event: 'notification_sent',
          metadata: {
            channel: 'push',
            template_id: 'agent_finished',
            session_id: session.id,
            agent_type: session.agent_type,
          },
        });

        sent++;
      })
    );

    // Tally any unhandled rejections
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[agent-finished] Session processing error:', r.reason);
        skipped++;
      }
    }

    return NextResponse.json({ success: true, found, sent, skipped });
  } catch (error) {
    console.error(
      '[agent-finished] Cron failed:',
      error instanceof Error ? error.message : 'Unknown'
    );
    return NextResponse.json({ error: 'Agent-finished cron failed' }, { status: 500 });
  }
}
