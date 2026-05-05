/**
 * OpenRouter Credit-Monitor Cron
 *
 * GET /api/cron/openrouter-credit-monitor
 *
 * Polls the OpenRouter credits endpoint daily. If remaining balance falls
 * below `OPENROUTER_LOW_BALANCE_THRESHOLD` (USD, default 20), dispatches a
 * rich operator-facing email alert to `OPENROUTER_ALERT_EMAIL` (default
 * airborneshellback@gmail.com) via Resend so the LLM-backed features
 * (digest, on-demand summary) don't silently start failing on a $0
 * balance.
 *
 * Two upstream endpoints are called per tick:
 *   - GET /api/v1/credits  — lifetime totals (`total_credits`, `total_usage`)
 *   - GET /api/v1/auth/key — this-key cap + rolling windows
 *                            (`limit`, `limit_remaining`, `usage_daily`,
 *                            `usage_weekly`, `usage_monthly`)
 *
 * Both must succeed. The /credits endpoint is the historical balance
 * source; the /auth/key endpoint is what surfaces the per-key cap and
 * rolling spend windows that drive the projection numbers in the email.
 *
 * WHY a daily cron (not a per-request balance check): polling once a day
 * is enough lead time to top up before exhaustion (the daily LLM spend
 * is small), and avoids adding a synchronous OpenRouter round-trip to
 * every API call.
 *
 * WHY the schedule is 13 UTC (07:00 America/Chicago): runs BEFORE the
 * digest cron at 14 UTC, so a low-balance alert lands in the inbox
 * before the digest fires and either (a) drains the balance further or
 * (b) silently degrades.
 *
 * Throttle: only one `openrouter_low_balance_alert` audit_log row per
 * 24h. If a recent alert exists we skip the email (still records the
 * `openrouter_credit_check` row so the trail is complete).
 *
 * @auth Required - CRON_SECRET header (Bearer token)
 * @returns 200 { remaining, threshold, alerted, last_alert_at, cap, cap_pct_used }
 * @error 401 missing/wrong cron secret
 * @error 502 OpenRouter API failed (also writes a credit_check audit row)
 * @error 500 unexpected
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/resend';
import OpenRouterCreditAlertEmail from '@/emails/openrouter-credit-alert';

/**
 * Default low-balance threshold in USD if `OPENROUTER_LOW_BALANCE_THRESHOLD`
 * env var is unset. $20 = roughly two weeks of digest + summary spend at
 * current usage, giving comfortable lead time to top up.
 */
const DEFAULT_THRESHOLD_USD = 20;

/**
 * Default destination for low-balance alerts if `OPENROUTER_ALERT_EMAIL` env
 * var is unset. Maintainer's inbox.
 */
const DEFAULT_ALERT_EMAIL = 'airborneshellback@gmail.com';

/**
 * Throttle window for low-balance alerts. While the balance is below threshold
 * we still want a single ping per day, not one per cron tick (cron is daily,
 * but defensive against a future schedule change).
 */
const ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Human label for the OpenRouter API key being monitored. Embedded in the
 * email subject + footer so the operator knows which key is alerting (the
 * Styrby account has multiple).
 */
const KEY_LABEL = 'Styrby Production v2';

const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const OPENROUTER_AUTH_KEY_URL = 'https://openrouter.ai/api/v1/auth/key';

/**
 * Successful shape of GET /api/v1/credits.
 * Lifetime totals (USD), independent of the per-key cap.
 */
interface OpenRouterCreditsResponse {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
}

/**
 * Successful shape of GET /api/v1/auth/key.
 * `limit` + `limit_remaining` describe THIS key's cap; rolling windows
 * track this-key spend over their respective windows. All USD, all
 * nullable in OpenRouter's schema (e.g. uncapped keys).
 */
interface OpenRouterAuthKeyResponse {
  data?: {
    label?: string;
    limit?: number | null;
    limit_remaining?: number | null;
    usage?: number | null;
    usage_daily?: number | null;
    usage_weekly?: number | null;
    usage_monthly?: number | null;
    limit_reset?: string | null;
    expires_at?: string | null;
  };
}

import {
  computeCycleMetrics,
  formatCentralTimestamp,
  type CycleMetrics,
} from './cycle-metrics';

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

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('[openrouter-credit-monitor] OPENROUTER_API_KEY not set');
    return NextResponse.json(
      { error: 'OPENROUTER_API_KEY not configured' },
      { status: 500 }
    );
  }

  const threshold = parseThreshold(
    process.env.OPENROUTER_LOW_BALANCE_THRESHOLD,
    DEFAULT_THRESHOLD_USD
  );
  const alertEmail = process.env.OPENROUTER_ALERT_EMAIL ?? DEFAULT_ALERT_EMAIL;

  const supabase = createAdminClient();

  // ---- Hit BOTH OpenRouter endpoints in parallel ----
  // The two reads are independent; serializing them would double latency
  // on a path that already crosses the public internet.
  let creditsBody: OpenRouterCreditsResponse;
  let authKeyBody: OpenRouterAuthKeyResponse;
  try {
    const [creditsRes, authKeyRes] = await Promise.all([
      fetch(OPENROUTER_CREDITS_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        // WHY no-store: this is a server-side fresh-fetch on a cron tick;
        // a cached value would defeat the entire purpose of monitoring.
        cache: 'no-store',
      }),
      fetch(OPENROUTER_AUTH_KEY_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }),
    ]);

    if (!creditsRes.ok || !authKeyRes.ok) {
      const failing = !creditsRes.ok ? creditsRes : authKeyRes;
      const which = !creditsRes.ok ? 'credits' : 'auth/key';
      const text = await failing.text().catch(() => '');
      console.error(
        '[openrouter-credit-monitor] OpenRouter API failed:',
        which,
        failing.status,
        text
      );
      await supabase.from('audit_log').insert({
        action: 'openrouter_credit_check',
        metadata: {
          ok: false,
          endpoint: which,
          status: failing.status,
          error: text.slice(0, 500),
        },
      });
      return NextResponse.json(
        { error: 'OpenRouter API failed', endpoint: which, status: failing.status },
        { status: 502 }
      );
    }

    creditsBody = (await creditsRes.json()) as OpenRouterCreditsResponse;
    authKeyBody = (await authKeyRes.json()) as OpenRouterAuthKeyResponse;
  } catch (err) {
    console.error('[openrouter-credit-monitor] fetch threw:', err);
    await supabase.from('audit_log').insert({
      action: 'openrouter_credit_check',
      metadata: { ok: false, error: (err as Error).message },
    });
    return NextResponse.json(
      { error: 'OpenRouter API failed' },
      { status: 502 }
    );
  }

  // ---- Resolve numbers ----
  // /credits gives lifetime; /auth/key gives the cap + rolling windows.
  // The ALERT decision and the email body both use the per-key cap data
  // (that's the constraint that actually breaks features).
  const lifetimeCredits = Number(creditsBody.data?.total_credits ?? 0);
  const lifetimeUsage = Number(creditsBody.data?.total_usage ?? 0);
  const lifetimeRemaining = lifetimeCredits - lifetimeUsage;

  // `limit` may be null (uncapped key). When null, fall back to lifetime
  // remaining for the threshold check (best effort) and skip projections.
  const cap = numOrNull(authKeyBody.data?.limit);
  const limitRemaining = numOrNull(authKeyBody.data?.limit_remaining);
  const usageMonthly = Number(authKeyBody.data?.usage_monthly ?? 0);
  const usageWeekly = Number(authKeyBody.data?.usage_weekly ?? 0);
  const usageDaily = Number(authKeyBody.data?.usage_daily ?? 0);

  // The number that drives "should we alert" — prefer the key cap's
  // remaining (what features actually have available), fall back to
  // lifetime remaining for uncapped keys.
  const remaining = limitRemaining ?? lifetimeRemaining;

  const now = new Date();
  const metrics = computeCycleMetrics(
    now,
    cap ?? 0,
    limitRemaining ?? lifetimeRemaining,
    usageMonthly
  );

  // ---- Decide whether to alert ----
  let alerted = false;
  let lastAlertAt: string | null = null;

  if (remaining < threshold) {
    // Throttle check: did we already alert in the last 24h?
    // We query audit_log directly (single source of truth) to avoid a new
    // dedicated table for what is effectively a 1-row state.
    const since = new Date(Date.now() - ALERT_THROTTLE_MS).toISOString();
    const { data: recent } = await supabase
      .from('audit_log')
      .select('created_at')
      .eq('action', 'openrouter_low_balance_alert')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1);

    if (recent && recent.length > 0) {
      lastAlertAt = (recent[0] as { created_at: string }).created_at;
    } else {
      // ---- Build the rich operator alert ----
      const subject = `[Styrby OpenRouter] ${formatUsd(remaining)} remaining (${metrics.capPctUsed.toFixed(0)}% of ${formatUsd(metrics.capUsd)}/mo cap used) - ${metrics.daysRemainingInCycle} days left in cycle`;
      const sendResult = await sendEmail({
        to: alertEmail,
        subject,
        react: OpenRouterCreditAlertEmail({
          capUsd: metrics.capUsd,
          remainingUsd: remaining,
          usedThisCycleUsd: metrics.usedThisCycleUsd,
          capPctUsed: metrics.capPctUsed,
          dailyBurnUsd: metrics.dailyBurnUsd,
          projectedEndOfCycleUsd: metrics.projectedEndOfCycleUsd,
          projectedOverageUsd: metrics.projectedOverageUsd,
          daysRemainingInCycle: metrics.daysRemainingInCycle,
          daysIntoCycle: metrics.daysIntoCycle,
          nextResetLabel: metrics.nextResetLabel,
          usageDailyUsd: usageDaily,
          usageWeeklyUsd: usageWeekly,
          usageMonthlyUsd: usageMonthly,
          keyLabel: KEY_LABEL,
          thresholdUsd: threshold,
          generatedAtIso: now.toISOString(),
          generatedAtCentralLabel: formatCentralTimestamp(now),
        }),
      });

      if (sendResult.success) {
        alerted = true;
        lastAlertAt = new Date().toISOString();
        await supabase.from('audit_log').insert({
          action: 'openrouter_low_balance_alert',
          metadata: {
            remaining,
            threshold,
            cap: metrics.capUsd,
            cap_pct_used: Number(metrics.capPctUsed.toFixed(2)),
            daily_burn: Number(metrics.dailyBurnUsd.toFixed(4)),
            projected_end_of_cycle: Number(metrics.projectedEndOfCycleUsd.toFixed(2)),
            projected_overage: Number(metrics.projectedOverageUsd.toFixed(2)),
            alert_email: alertEmail,
            key_label: KEY_LABEL,
          },
        });
      } else {
        console.error(
          '[openrouter-credit-monitor] sendEmail failed:',
          sendResult.error
        );
      }
    }
  }

  // ---- Always record the credit_check tick ----
  await supabase.from('audit_log').insert({
    action: 'openrouter_credit_check',
    metadata: {
      ok: true,
      remaining,
      threshold,
      alerted,
      cap: metrics.capUsd,
      cap_pct_used: Number(metrics.capPctUsed.toFixed(2)),
      usage_monthly: usageMonthly,
      usage_weekly: usageWeekly,
      usage_daily: usageDaily,
    },
  });

  return NextResponse.json({
    remaining,
    threshold,
    alerted,
    last_alert_at: lastAlertAt,
    cap: metrics.capUsd,
    cap_pct_used: Number(metrics.capPctUsed.toFixed(2)),
    daily_burn: Number(metrics.dailyBurnUsd.toFixed(4)),
    projected_end_of_cycle: Number(metrics.projectedEndOfCycleUsd.toFixed(2)),
    projected_overage: Number(metrics.projectedOverageUsd.toFixed(2)),
    days_remaining_in_cycle: metrics.daysRemainingInCycle,
    next_reset: metrics.nextResetIso,
  });
}

/**
 * Parse the threshold env var. Falls back to the default on missing/invalid
 * input so a typo can't silently disable monitoring.
 */
function parseThreshold(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Coerce an OpenRouter nullable-number field into `number | null`.
 * Treats `undefined`, `null`, and non-finite values uniformly as null so
 * downstream `??` short-circuits work as expected.
 */
function numOrNull(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
