/**
 * Pure helpers for the uptime-monitor cron route.
 *
 * Kept in a sibling lib file so the route module exports only HTTP verbs,
 * which is the Next.js App Router contract. Helpers re-exported from
 * route.ts would cause the build to error with "is not a valid Route
 * export field".
 */

/**
 * Default URL set polled by the cron when UPTIME_CHECK_URLS is unset.
 * Keep this list small (currently 3) so a 5-minute cron tick comfortably
 * fits inside the per-check timeout budget even in the worst case.
 */
export const DEFAULT_UPTIME_URLS = [
  'https://www.styrbyapp.com',
  'https://www.styrbyapp.com/pricing',
  'https://www.styrbyapp.com/api/health',
];

/**
 * Default destination for uptime alerts when UPTIME_ALERT_EMAIL is unset.
 * Maintainer's inbox.
 */
export const DEFAULT_UPTIME_ALERT_EMAIL = 'airborneshellback@gmail.com';

/**
 * Number of consecutive failures required before we email an alert. Set
 * to 2 because a single failure is more often a transient blip (deploy
 * cold start, edge node hiccup, momentary network partition) than a real
 * outage. Two ticks at 5 minutes apart = ~5-10 minutes of confirmed
 * unavailability before the operator is paged, which is the right
 * tradeoff between false alarms and time-to-detect.
 */
export const FAILURE_THRESHOLD = 2;

/**
 * Throttle window for repeat alerts on the same URL. While a URL stays
 * down we still want at most one email per hour (avoids inbox storm
 * during a sustained outage). Recovery emails are NOT throttled — the
 * state transition is the value.
 */
export const ALERT_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Per-URL request timeout. Anything slower than this is "down" for our
 * purposes; a 10-second-slow page is already broken to a human user.
 */
export const PER_PING_TIMEOUT_MS = 10_000;

/**
 * Outcome of a single URL ping. The cron aggregates these and decides
 * whether to alert / recover based on the prior state in `uptime_alerts`.
 */
export interface PingResult {
  url: string;
  ok: boolean;
  status: number | null;
  duration_ms: number;
  /** Brief error string when ok=false (timeout, DNS, status text). */
  error: string | null;
  /**
   * Parsed JSON body when the URL is the health endpoint. Lets the alert
   * email surface WHICH dependency is down without a second round trip.
   */
  health_body: Record<string, unknown> | null;
}

/**
 * Persisted state row for a URL. Mirrors the columns in the
 * `uptime_alerts` migration; kept here for type safety in the route.
 */
export interface UptimeAlertRow {
  url: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  alert_sent_at: string | null;
  recovery_sent_at: string | null;
  consecutive_failures: number;
  last_status_code: number | null;
  last_error: string | null;
}

/**
 * Parse the UPTIME_CHECK_URLS CSV env var. Falls back to the default URL
 * set on missing/empty input so a typo can't silently disable
 * monitoring.
 */
export function parseUrlList(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_UPTIME_URLS;
  const parsed = raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u));
  return parsed.length > 0 ? parsed : DEFAULT_UPTIME_URLS;
}

/**
 * Ping a single URL with a timeout. Returns a PingResult — never throws.
 *
 * @param url - The URL to GET.
 * @param timeoutMs - Per-ping timeout ceiling.
 * @returns Structured ping result; ok=false on any error/timeout/non-2xx.
 */
export async function pingUrl(
  url: string,
  timeoutMs: number = PER_PING_TIMEOUT_MS
): Promise<PingResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'User-Agent': 'StyrbyUptimeMonitor/1.0' },
    });

    const duration_ms = Date.now() - started;
    let health_body: Record<string, unknown> | null = null;

    // Only the /api/health endpoint returns JSON we care about; reading
    // the body for landing pages would waste bytes.
    if (url.includes('/api/health')) {
      try {
        health_body = (await res.json()) as Record<string, unknown>;
      } catch {
        health_body = null;
      }
    }

    return {
      url,
      ok: res.ok,
      status: res.status,
      duration_ms,
      error: res.ok ? null : `HTTP ${res.status}`,
      health_body,
    };
  } catch (err) {
    const duration_ms = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = message.includes('abort') || message.includes('Abort');
    return {
      url,
      ok: false,
      status: null,
      duration_ms,
      error: isAbort ? `timeout after ${timeoutMs}ms` : message,
      health_body: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide what to do with a single ping given prior state. Returned action
 * directs the route on whether to send an email and which audit_action
 * to write.
 *
 *   - 'none': healthy or below failure threshold; just update state.
 *   - 'alert': cross failure threshold + outside throttle window; email +
 *              audit 'uptime_alert'.
 *   - 'recover': transitioned from alerted to healthy; email + audit
 *                'uptime_recovery'.
 */
export type Action = 'none' | 'alert' | 'recover';

export function decideAction(
  ping: PingResult,
  prior: UptimeAlertRow | null,
  now: Date,
  failureThreshold: number = FAILURE_THRESHOLD,
  throttleMs: number = ALERT_THROTTLE_MS
): { action: Action; nextConsecutiveFailures: number } {
  const priorFailures = prior?.consecutive_failures ?? 0;

  if (ping.ok) {
    // Healthy now. Recovery email iff we previously alerted AND haven't
    // already sent a recovery for this outage.
    const wasAlerting =
      prior?.alert_sent_at !== null &&
      prior?.alert_sent_at !== undefined &&
      // recovery_sent_at older than alert_sent_at = we owe a recovery
      (prior.recovery_sent_at === null ||
        new Date(prior.recovery_sent_at) < new Date(prior.alert_sent_at));
    return {
      action: wasAlerting ? 'recover' : 'none',
      nextConsecutiveFailures: 0,
    };
  }

  // Failed now.
  const nextFailures = priorFailures + 1;
  if (nextFailures < failureThreshold) {
    return { action: 'none', nextConsecutiveFailures: nextFailures };
  }

  // At/over threshold. Throttle: skip if we already alerted recently.
  if (prior?.alert_sent_at) {
    const since = now.getTime() - new Date(prior.alert_sent_at).getTime();
    if (since < throttleMs) {
      return { action: 'none', nextConsecutiveFailures: nextFailures };
    }
  }

  return { action: 'alert', nextConsecutiveFailures: nextFailures };
}

/**
 * Format a duration in ms as a short human label (e.g. "12m", "2h 14m").
 * Used in the alert email's "down for X" line.
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
