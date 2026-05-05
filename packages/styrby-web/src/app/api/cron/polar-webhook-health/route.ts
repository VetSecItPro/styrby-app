/**
 * Polar Webhook Health Monitor Cron
 *
 * GET /api/cron/polar-webhook-health
 *
 * Hourly cron that inspects the polar_webhook_events table and recent
 * webhook-guard audit_log rows to detect three failure modes:
 *
 *   1. NO EVENTS in last 4h during business hours (8 AM - 8 PM Central) —
 *      Polar typically fires several events per day; silence inside the
 *      operator-active window means our endpoint or Polar is broken.
 *   2. DEDUP ERROR RATE > 5% over last 24h — measured from
 *      polar_webhook_unknown_subscription + polar_webhook_user_id_mismatch
 *      audit rows divided by total events processed. Sustained spike
 *      indicates either malicious replay attempts OR config drift.
 *   3. LATEST EVENT > 24h OLD — time-of-day independent hard threshold.
 *      Strongest "Polar down or our endpoint broken" signal.
 *
 * WHY hourly (not per-request): a per-request liveness check on every API
 * call would add SQL round-trips; once-per-hour is enough lead time to
 * page operator before customers notice billing drift.
 *
 * WHY this exists at all: the polar webhook handler is the source of
 * truth for subscription state changes. If webhooks silently stop firing
 * (Polar incident, our endpoint 5xx-ing, signing-key drift), tier and
 * seat counts diverge from reality and customers either get billed
 * incorrectly OR get free access. Either way we find out from a support
 * ticket — too late. This cron catches it within one hour.
 *
 * Throttle: one alert per signal per 24h (audit_log query). Tripped
 * signals share alert timestamps so a sustained outage emits exactly one
 * alert per signal per day, not 24.
 *
 * @auth Required - CRON_SECRET header (Bearer token)
 * @returns 200 { latest_event_at, event_count_24h, guard_error_count_24h,
 *                signals: [{signal, tripped, summary, alerted}] }
 * @error 401 missing/wrong cron secret
 * @error 500 Supabase query failure
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/resend';
import PolarWebhookHealthAlertEmail from '@/emails/polar-webhook-health-alert';
import {
  evaluateHealth,
  formatHours,
  formatCentralTimestamp,
  suspectedCause,
  type HealthSignal,
} from './lib';

/**
 * Default destination for health alerts if `POLAR_WEBHOOK_ALERT_EMAIL` is
 * unset. Maintainer's inbox.
 */
const DEFAULT_ALERT_EMAIL = 'airborneshellback@gmail.com';

/**
 * Throttle window for alerts. One alert per signal per 24h.
 */
const ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * 24h lookback window in milliseconds. Used for both event count + guard
 * error rate windows.
 */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Webhook-guard audit_action values that count toward the dedup error
 * rate signal. Sourced from migration 076.
 */
const GUARD_ERROR_ACTIONS = [
  'polar_webhook_unknown_subscription',
  'polar_webhook_user_id_mismatch',
];

/**
 * Human labels for the three signals. Used in the email subject + body.
 */
const SIGNAL_LABELS: Record<HealthSignal, string> = {
  no_events_business_hours: 'No webhook events in 4h during business hours',
  dedup_error_spike: 'Dedup / guard-error rate spike (> 5% over 24h)',
  latest_event_24h_old: 'Latest webhook event > 24h old',
};

/**
 * Subject-line short tag per signal.
 */
const SIGNAL_SHORT_TAG: Record<HealthSignal, string> = {
  no_events_business_hours: 'no recent events',
  dedup_error_spike: 'guard-error spike',
  latest_event_24h_old: 'latest event > 24h old',
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

  const alertEmail =
    process.env.POLAR_WEBHOOK_ALERT_EMAIL ?? DEFAULT_ALERT_EMAIL;
  const supabase = createAdminClient();
  const now = new Date();
  const since24h = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS).toISOString();

  // ---- Pull all health inputs in parallel ----
  // The four queries are independent; serializing would multiply latency.
  const [latestRes, countRes, guardRes, recentTypesRes] = await Promise.all([
    // Latest event timestamp.
    supabase
      .from('polar_webhook_events')
      .select('processed_at')
      .order('processed_at', { ascending: false })
      .limit(1),
    // Total events in last 24h. head:true + count:exact returns count only.
    supabase
      .from('polar_webhook_events')
      .select('event_id', { count: 'exact', head: true })
      .gte('processed_at', since24h),
    // Guard-error audit rows in last 24h. Same head:true pattern.
    supabase
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .in('action', GUARD_ERROR_ACTIONS)
      .gte('created_at', since24h),
    // Top recent event types — fetch the last 10 rows and dedupe in memory.
    // WHY in-memory: Postgres doesn't have a clean "top-N distinct ordered
    // by recency" without a window function or subquery, and this is one
    // ops query per hour; the simplicity wins.
    supabase
      .from('polar_webhook_events')
      .select('event_type')
      .order('processed_at', { ascending: false })
      .limit(10),
  ]);

  // Any of the count/list queries failing is a real ops problem — write a
  // health_check audit row noting the failure and return 500 so the cron
  // dashboard surfaces it.
  if (latestRes.error || countRes.error || guardRes.error || recentTypesRes.error) {
    const errors = {
      latest: latestRes.error?.message,
      count: countRes.error?.message,
      guard: guardRes.error?.message,
      recent: recentTypesRes.error?.message,
    };
    console.error('[polar-webhook-health] supabase query failed:', errors);
    await supabase.from('audit_log').insert({
      action: 'polar_webhook_health_check',
      metadata: { ok: false, errors },
    });
    return NextResponse.json(
      { error: 'Supabase query failed', errors },
      { status: 500 }
    );
  }

  const latestEventAt =
    latestRes.data && latestRes.data.length > 0
      ? new Date((latestRes.data[0] as { processed_at: string }).processed_at)
      : null;
  const eventCount24h = countRes.count ?? 0;
  const guardErrorCount24h = guardRes.count ?? 0;
  const recentEventTypesRaw = (recentTypesRes.data ?? []) as Array<{
    event_type: string;
  }>;
  const recentEventTypes = Array.from(
    new Set(recentEventTypesRaw.map((r) => r.event_type))
  ).slice(0, 3);

  // ---- Evaluate signals (pure) ----
  const evaluations = evaluateHealth({
    now,
    latestEventAt,
    eventCount24h,
    guardErrorCount24h,
  });

  // ---- For each tripped signal: throttle check + alert dispatch ----
  const sinceThrottle = new Date(
    Date.now() - ALERT_THROTTLE_MS
  ).toISOString();
  const alertResults: Array<{
    signal: HealthSignal;
    tripped: boolean;
    summary: string;
    alerted: boolean;
    last_alert_at: string | null;
  }> = [];

  for (const evaluation of evaluations) {
    if (!evaluation.tripped) {
      alertResults.push({
        signal: evaluation.signal,
        tripped: false,
        summary: evaluation.summary,
        alerted: false,
        last_alert_at: null,
      });
      continue;
    }

    // Throttle: was an alert for THIS signal sent in the last 24h?
    // We tag throttle rows by metadata.signal so different signals don't
    // throttle each other.
    const { data: recent } = await supabase
      .from('audit_log')
      .select('created_at, metadata')
      .eq('action', 'polar_webhook_health_alert')
      .gte('created_at', sinceThrottle)
      .order('created_at', { ascending: false })
      .limit(20);

    const lastAlertAt = (recent ?? []).find(
      (r) =>
        ((r as { metadata?: { signal?: string } }).metadata?.signal ?? '') ===
        evaluation.signal
    ) as { created_at: string } | undefined;

    if (lastAlertAt) {
      alertResults.push({
        signal: evaluation.signal,
        tripped: true,
        summary: evaluation.summary,
        alerted: false,
        last_alert_at: lastAlertAt.created_at,
      });
      continue;
    }

    // Build + dispatch the alert email.
    const signalLabel = SIGNAL_LABELS[evaluation.signal];
    const shortTag = SIGNAL_SHORT_TAG[evaluation.signal];
    const hoursSinceLatest =
      latestEventAt === null
        ? Infinity
        : (now.getTime() - latestEventAt.getTime()) / (60 * 60 * 1000);
    const hoursSinceLatestLabel = formatHours(hoursSinceLatest);
    const guardErrorRatePct =
      eventCount24h > 0 ? (guardErrorCount24h / eventCount24h) * 100 : 0;
    const latestEventLabel =
      latestEventAt === null ? 'never' : formatCentralTimestamp(latestEventAt);

    const subject = `[Styrby Polar webhook] ${shortTag} - last event ${hoursSinceLatestLabel} ago`;
    const sendResult = await sendEmail({
      to: alertEmail,
      subject,
      react: PolarWebhookHealthAlertEmail({
        signal: evaluation.signal,
        signalLabel,
        latestEventLabel,
        hoursSinceLatestLabel,
        eventCount24h,
        guardErrorRatePct,
        guardErrorCount24h,
        recentEventTypes,
        signalSummaries: evaluations.map((e) => ({
          label: SIGNAL_LABELS[e.signal],
          detail: e.summary,
          tripped: e.tripped,
        })),
        suspectedCause: suspectedCause(evaluations, {
          now,
          latestEventAt,
          eventCount24h,
          guardErrorCount24h,
        }),
        generatedAtIso: now.toISOString(),
        generatedAtCentralLabel: formatCentralTimestamp(now),
      }),
    });

    let alerted = false;
    let alertedAt: string | null = null;
    if (sendResult.success) {
      alerted = true;
      alertedAt = new Date().toISOString();
      await supabase.from('audit_log').insert({
        action: 'polar_webhook_health_alert',
        metadata: {
          signal: evaluation.signal,
          summary: evaluation.summary,
          latest_event_at: latestEventAt?.toISOString() ?? null,
          event_count_24h: eventCount24h,
          guard_error_count_24h: guardErrorCount24h,
          guard_error_rate_pct: Number(guardErrorRatePct.toFixed(2)),
          alert_email: alertEmail,
        },
      });
    } else {
      console.error(
        '[polar-webhook-health] sendEmail failed:',
        sendResult.error
      );
    }

    alertResults.push({
      signal: evaluation.signal,
      tripped: true,
      summary: evaluation.summary,
      alerted,
      last_alert_at: alertedAt,
    });
  }

  // ---- Always record the health_check tick (even if nothing tripped) ----
  await supabase.from('audit_log').insert({
    action: 'polar_webhook_health_check',
    metadata: {
      ok: true,
      latest_event_at: latestEventAt?.toISOString() ?? null,
      event_count_24h: eventCount24h,
      guard_error_count_24h: guardErrorCount24h,
      tripped_signals: alertResults.filter((r) => r.tripped).map((r) => r.signal),
      alerted_signals: alertResults.filter((r) => r.alerted).map((r) => r.signal),
    },
  });

  return NextResponse.json({
    latest_event_at: latestEventAt?.toISOString() ?? null,
    event_count_24h: eventCount24h,
    guard_error_count_24h: guardErrorCount24h,
    recent_event_types: recentEventTypes,
    signals: alertResults,
  });
}
