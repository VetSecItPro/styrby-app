/**
 * Pure helpers for the Polar webhook health monitor.
 *
 * Extracted from `route.ts` because Next.js App Router rejects any named
 * export from a route.ts file other than HTTP verbs (GET/POST/etc).
 * Keeping helpers here preserves test importability + Next.js route
 * validation.
 */

/**
 * Identifier for which health signal tripped. Used as the throttle key
 * (one alert per signal per 24h, not one per route invocation).
 *
 * - `no_events_business_hours` — no webhook events in the last 4h while
 *   inside business-hour window (Polar typically fires several events/day
 *   during business hours; silence here means our endpoint or Polar is
 *   broken).
 * - `dedup_error_spike` — webhook-guard error rate > 5% over last 24h.
 *   Indicates either a malicious replay attempt OR Polar firing
 *   subscription_id values we don't recognize (data drift).
 * - `latest_event_24h_old` — most recent event > 24h regardless of time.
 *   Strongest signal: Polar is down or our endpoint has been broken for
 *   a full day. Fires day or night.
 */
export type HealthSignal =
  | 'no_events_business_hours'
  | 'dedup_error_spike'
  | 'latest_event_24h_old';

/**
 * Outcome of the health evaluation for a single signal.
 */
export interface SignalEvaluation {
  signal: HealthSignal;
  /** True if the signal indicates an unhealthy state. */
  tripped: boolean;
  /** Human-readable summary embedded in the email subject + audit metadata. */
  summary: string;
}

/**
 * Snapshot inputs for the health evaluator. The route fetches these from
 * Supabase + the system clock; the evaluator is pure for testability.
 */
export interface HealthInputs {
  /** Reference instant. Tests inject a fixed Date so business-hour math is deterministic. */
  now: Date;
  /** Most recent processed_at from polar_webhook_events. null if table empty. */
  latestEventAt: Date | null;
  /** Total polar_webhook_events rows processed in the last 24h. */
  eventCount24h: number;
  /** Webhook-guard audit_log rows in the last 24h (unknown_subscription + user_id_mismatch). */
  guardErrorCount24h: number;
}

/**
 * Business-hour window in Central Time. Polar webhook activity correlates
 * with operator activity (subscription mutations from the dashboard +
 * customer self-serve actions), so silence INSIDE this window is a stronger
 * signal than silence at 3 AM.
 *
 * 8 AM - 8 PM Central.
 */
const BUSINESS_HOUR_START_CENTRAL = 8;
const BUSINESS_HOUR_END_CENTRAL = 20;

/**
 * Threshold for "no events in business hours" signal. 4h chosen because
 * Polar fires several events per day even on a quiet site (subscription
 * state pings, scheduled renewals); 4h of silence during business hours
 * means something is broken.
 */
const NO_EVENTS_THRESHOLD_HOURS = 4;

/**
 * Threshold for "latest event 24h old" signal. Catches sustained outages
 * (Polar down or our handler down) regardless of time-of-day.
 */
const HARD_EVENT_THRESHOLD_HOURS = 24;

/**
 * Threshold (percentage of total) for the dedup error spike signal.
 * 5% chosen as the noise floor: rare unknown_subscription / user_id_mismatch
 * audits are normal during config changes; sustained > 5% indicates either
 * an attack OR a real data drift problem.
 */
const DEDUP_ERROR_RATE_PCT_THRESHOLD = 5;

/**
 * Returns the current hour-of-day in America/Chicago. Used to gate the
 * "no events in business hours" signal. Pure function (no env, no I/O).
 */
export function centralHourOfDay(now: Date): number {
  // toLocaleString with hour12:false gives a string like "23" for 11 PM
  // in the requested timezone; parse and return as 0-23.
  const hourStr = now.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    hour12: false,
  });
  // Some locales prepend zero: parse the leading number defensively.
  const parsed = Number.parseInt(hourStr, 10);
  if (!Number.isFinite(parsed)) return 0;
  // Edge case: en-US returns "24" for midnight in some Node builds; clamp to 0.
  return parsed % 24;
}

/**
 * Whether `now` falls inside the Central business-hour window (8 AM - 8 PM).
 */
export function isBusinessHourCentral(now: Date): boolean {
  const hour = centralHourOfDay(now);
  return hour >= BUSINESS_HOUR_START_CENTRAL && hour < BUSINESS_HOUR_END_CENTRAL;
}

/**
 * Compute hours between two timestamps. Negative if `then` is in the future.
 */
export function hoursSince(now: Date, then: Date): number {
  return (now.getTime() - then.getTime()) / (60 * 60 * 1000);
}

/**
 * Pure evaluator. Given current Polar webhook health inputs, returns one
 * `SignalEvaluation` per signal. The route handler decides which tripped
 * signals to alert on (and applies the per-signal throttle).
 *
 * @param inputs - Snapshot of webhook health state.
 * @returns Evaluations for all three signals, in fixed order.
 */
export function evaluateHealth(inputs: HealthInputs): SignalEvaluation[] {
  const { now, latestEventAt, eventCount24h, guardErrorCount24h } = inputs;

  const hoursSinceLatest =
    latestEventAt === null ? Infinity : hoursSince(now, latestEventAt);

  // Signal 1: no events in last 4h, only fires inside business hours.
  // WHY business-hour gate: 4h of silence at 3 AM is normal; 4h of silence
  // at 2 PM Central is a strong "something is broken" signal.
  const inBusinessHours = isBusinessHourCentral(now);
  const noEventsTripped =
    inBusinessHours && hoursSinceLatest >= NO_EVENTS_THRESHOLD_HOURS;
  const noEventsSummary = noEventsTripped
    ? `no events in ${formatHours(hoursSinceLatest)} (during business hours)`
    : `last event ${formatHours(hoursSinceLatest)} ago, business hours: ${inBusinessHours}`;

  // Signal 2: dedup error rate spike. Compute as percentage of total events.
  // If there were no events at all in 24h, suppress this signal (the
  // no-events / 24h-old signals will fire instead — no need to double-alert).
  const dedupErrorRate =
    eventCount24h > 0 ? (guardErrorCount24h / eventCount24h) * 100 : 0;
  const dedupErrorTripped =
    eventCount24h > 0 && dedupErrorRate > DEDUP_ERROR_RATE_PCT_THRESHOLD;
  const dedupErrorSummary = dedupErrorTripped
    ? `${dedupErrorRate.toFixed(1)}% guard-error rate over last 24h (${guardErrorCount24h}/${eventCount24h})`
    : `${dedupErrorRate.toFixed(1)}% guard-error rate (${guardErrorCount24h}/${eventCount24h}) — under ${DEDUP_ERROR_RATE_PCT_THRESHOLD}% threshold`;

  // Signal 3: latest event > 24h. Time-of-day independent — strongest
  // signal that something is broken (Polar down or our endpoint down).
  const hardThresholdTripped = hoursSinceLatest >= HARD_EVENT_THRESHOLD_HOURS;
  const hardThresholdSummary = hardThresholdTripped
    ? `latest event ${formatHours(hoursSinceLatest)} ago — exceeds 24h hard threshold`
    : `latest event ${formatHours(hoursSinceLatest)} ago`;

  return [
    {
      signal: 'no_events_business_hours',
      tripped: noEventsTripped,
      summary: noEventsSummary,
    },
    {
      signal: 'dedup_error_spike',
      tripped: dedupErrorTripped,
      summary: dedupErrorSummary,
    },
    {
      signal: 'latest_event_24h_old',
      tripped: hardThresholdTripped,
      summary: hardThresholdSummary,
    },
  ];
}

/**
 * Format an hour count for human display ("3.4h" / "26.1h" / "never").
 * Used in subject lines and audit metadata.
 */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return 'never';
  if (hours < 1) {
    const minutes = Math.max(Math.round(hours * 60), 0);
    return `${minutes}m`;
  }
  return `${hours.toFixed(1)}h`;
}

/**
 * Render the now-instant in Central Time. Mirrors the helper in the
 * openrouter-credit-monitor for consistency in operator emails.
 */
export function formatCentralTimestamp(now: Date): string {
  return now.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * Heuristic guess at which side is broken, from the signal pattern. Embedded
 * in the alert email under "Suspected cause" so the operator has a starting
 * hypothesis without re-reading three dashboards.
 */
export function suspectedCause(
  evaluations: SignalEvaluation[],
  inputs: HealthInputs
): string {
  const trippedSignals = new Set(
    evaluations.filter((e) => e.tripped).map((e) => e.signal)
  );

  if (trippedSignals.has('latest_event_24h_old') && inputs.eventCount24h === 0) {
    return 'Polar likely down OR our /api/webhooks/polar endpoint returning non-2xx. Check Vercel function logs first; if the endpoint is healthy, check status.polar.sh.';
  }
  if (trippedSignals.has('no_events_business_hours') && inputs.eventCount24h > 0) {
    return 'Webhook delivery has stalled within the last few hours. Recent events exist, so Polar is reachable; check Vercel function logs for handler errors and the polar-webhook-secret env var for drift.';
  }
  if (trippedSignals.has('dedup_error_spike')) {
    return 'Elevated guard-error rate suggests either (a) a Polar config drift sending events for unknown subscription_ids, or (b) a metadata.userId mismatch from a recent product change. Check the polar_webhook_unknown_subscription audit rows in the last 24h.';
  }
  return 'Multiple signals tripped; investigate webhook delivery + handler errors together.';
}
