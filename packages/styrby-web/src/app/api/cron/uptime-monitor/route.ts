/**
 * Uptime Monitor Cron
 *
 * GET /api/cron/uptime-monitor
 *
 * Self-hosted replacement for BetterStack/Checkly. Pings a configurable
 * URL set every 5 minutes (Vercel Cron), tracks per-URL failure runs in
 * the `uptime_alerts` table, and emails alerts on TWO consecutive
 * failures + a recovery email on the failure->success transition.
 *
 * Why self-hosted: 90% of paid uptime SaaS value is "ping URL, alert on
 * N consecutive failures, alert on recovery". That's ~200 LOC on a stack
 * (Vercel cron + Resend) we already pay for. Zero recurring cost, same
 * audit trail as every other ops cron in this repo.
 *
 * Failure rules:
 *   - 1 failure on a URL: record but DO NOT alert (transient blip).
 *   - 2 consecutive failures: ALERT email + audit 'uptime_alert'.
 *   - Throttle: max one alert per URL per 1h during sustained outage.
 *   - Recovery (failed->ok transition while alert_sent_at is set):
 *     RECOVERY email + audit 'uptime_recovery'.
 *
 * Storage:
 *   - audit_log row per tick per URL (action='uptime_check', for forensic
 *     "was prod actually down at HH:MM" queries).
 *   - uptime_alerts row per URL (current state + counters).
 *
 * @auth Required - CRON_SECRET header (Bearer token), timing-safe compare.
 * @returns 200 { results: PingResult[], alerts_sent, recoveries_sent }
 * @error 401 missing/wrong cron secret
 * @error 500 unexpected (state writes still attempted)
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/resend';
import UptimeAlertEmail from '@/emails/uptime-alert';
import UptimeRecoveryEmail from '@/emails/uptime-recovery';
import {
  DEFAULT_UPTIME_ALERT_EMAIL,
  decideAction,
  formatDuration,
  parseUrlList,
  pingUrl,
  type PingResult,
  type UptimeAlertRow,
} from './lib';

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

  const urls = parseUrlList(process.env.UPTIME_CHECK_URLS);
  const alertEmail = process.env.UPTIME_ALERT_EMAIL ?? DEFAULT_UPTIME_ALERT_EMAIL;
  const supabase = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  // ---- Fan-out: ping all URLs in parallel ----
  // Promise.allSettled (not Promise.all) so a thrown ping doesn't sink
  // the whole batch; pingUrl already swallows exceptions internally but
  // belt-and-braces is cheap.
  const settled = await Promise.allSettled(urls.map((u) => pingUrl(u)));
  const results: PingResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          url: urls[i],
          ok: false,
          status: null,
          duration_ms: 0,
          error: 'ping promise rejected',
          health_body: null,
        }
  );

  // ---- Load prior state for all URLs in one round trip ----
  const { data: priorRows } = await supabase
    .from('uptime_alerts')
    .select('*')
    .in('url', urls);
  const priorByUrl = new Map<string, UptimeAlertRow>();
  for (const row of (priorRows ?? []) as UptimeAlertRow[]) {
    priorByUrl.set(row.url, row);
  }

  let alertsSent = 0;
  let recoveriesSent = 0;

  // ---- Per-URL: decide, email, write state, audit ----
  for (const ping of results) {
    const prior = priorByUrl.get(ping.url) ?? null;
    const decision = decideAction(ping, prior, now);

    let didAlert = false;
    let didRecover = false;

    if (decision.action === 'alert') {
      const subject = `[Styrby Uptime] DOWN: ${ping.url} returning ${ping.status ?? 'no response'} (${decision.nextConsecutiveFailures} consecutive failures)`;
      const sendResult = await sendEmail({
        to: alertEmail,
        subject,
        react: UptimeAlertEmail({
          url: ping.url,
          statusCode: ping.status,
          errorMessage: ping.error,
          consecutiveFailures: decision.nextConsecutiveFailures,
          lastSuccessAt: prior?.last_success_at ?? null,
          lastFailureAt: nowIso,
          responseTimeMs: ping.duration_ms,
          healthBody: ping.health_body,
          generatedAtIso: nowIso,
        }),
      });
      if (sendResult.success) {
        didAlert = true;
        alertsSent += 1;
        await supabase.from('audit_log').insert({
          action: 'uptime_alert',
          metadata: {
            url: ping.url,
            status: ping.status,
            error: ping.error,
            consecutive_failures: decision.nextConsecutiveFailures,
            response_time_ms: ping.duration_ms,
            alert_email: alertEmail,
            health_body: ping.health_body,
          },
        });
      } else {
        console.error(
          '[uptime-monitor] alert email failed for',
          ping.url,
          sendResult.error
        );
      }
    } else if (decision.action === 'recover') {
      // Outage duration: alert_sent_at -> now. Falls back to last_failure_at
      // if alert_sent_at is somehow missing (defensive).
      const downSinceMs = prior?.alert_sent_at
        ? new Date(prior.alert_sent_at).getTime()
        : prior?.last_failure_at
          ? new Date(prior.last_failure_at).getTime()
          : now.getTime();
      const durationMs = now.getTime() - downSinceMs;
      const subject = `[Styrby Uptime] RECOVERED: ${ping.url} back to ${ping.status ?? 200} after ${formatDuration(durationMs)}`;
      const sendResult = await sendEmail({
        to: alertEmail,
        subject,
        react: UptimeRecoveryEmail({
          url: ping.url,
          statusCode: ping.status ?? 200,
          downForLabel: formatDuration(durationMs),
          downSinceIso: new Date(downSinceMs).toISOString(),
          recoveredAtIso: nowIso,
          responseTimeMs: ping.duration_ms,
        }),
      });
      if (sendResult.success) {
        didRecover = true;
        recoveriesSent += 1;
        await supabase.from('audit_log').insert({
          action: 'uptime_recovery',
          metadata: {
            url: ping.url,
            status: ping.status,
            down_for_ms: durationMs,
            down_for_label: formatDuration(durationMs),
            response_time_ms: ping.duration_ms,
          },
        });
      } else {
        console.error(
          '[uptime-monitor] recovery email failed for',
          ping.url,
          sendResult.error
        );
      }
    }

    // ---- Always upsert state ----
    // WHY upsert: first-ever tick on a new URL has no prior row. Writing
    // unconditionally also makes the cron self-healing if a prior row
    // was deleted out-of-band.
    const nextRow: UptimeAlertRow = {
      url: ping.url,
      last_success_at: ping.ok ? nowIso : (prior?.last_success_at ?? null),
      last_failure_at: ping.ok ? (prior?.last_failure_at ?? null) : nowIso,
      // Stamp alert_sent_at on ANY threshold breach we tried to alert
      // for, even if Resend failed — otherwise a Resend outage would
      // re-trigger every tick.
      alert_sent_at: didAlert
        ? nowIso
        : decision.action === 'alert'
          ? nowIso
          : (prior?.alert_sent_at ?? null),
      recovery_sent_at: didRecover
        ? nowIso
        : ping.ok
          ? null // healthy = clear so the next outage can alert again
          : (prior?.recovery_sent_at ?? null),
      consecutive_failures: decision.nextConsecutiveFailures,
      last_status_code: ping.status,
      last_error: ping.error,
    };

    await supabase.from('uptime_alerts').upsert(
      { ...nextRow, updated_at: nowIso },
      { onConflict: 'url' }
    );

    // Per-tick audit row. Append-only forensic trail; lightweight enough
    // (3 URLs × 12 ticks/hr × 24h = 864/day) that retention isn't a
    // concern.
    await supabase.from('audit_log').insert({
      action: 'uptime_check',
      metadata: {
        url: ping.url,
        ok: ping.ok,
        status: ping.status,
        error: ping.error,
        response_time_ms: ping.duration_ms,
        consecutive_failures: decision.nextConsecutiveFailures,
        action_taken: decision.action,
      },
    });
  }

  return NextResponse.json({
    results,
    alerts_sent: alertsSent,
    recoveries_sent: recoveriesSent,
    checked_at: nowIso,
  });
}
