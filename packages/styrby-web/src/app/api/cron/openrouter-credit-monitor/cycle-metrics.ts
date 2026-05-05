/**
 * Pure cycle-math + timestamp helpers for the OpenRouter credit monitor.
 *
 * Extracted from `route.ts` because Next.js App Router rejects any named
 * export from a route.ts file other than HTTP verbs (GET/POST/etc).
 * Keeping these helpers here preserves test importability + Next.js
 * route validation.
 */

/**
 * Numbers used by both the route response and the email template. Computed
 * once in `computeCycleMetrics` for testability + single source of truth.
 */
export interface CycleMetrics {
  capUsd: number;
  remainingUsd: number;
  usedThisCycleUsd: number;
  capPctUsed: number;
  daysIntoCycle: number;
  daysRemainingInCycle: number;
  dailyBurnUsd: number;
  projectedEndOfCycleUsd: number;
  projectedOverageUsd: number;
  nextResetIso: string;
  nextResetLabel: string;
}

/**
 * Pure cycle-math helper. Exported for unit-testability.
 *
 * @param now - Reference instant (UTC). Tests inject a fixed Date so the
 *   day-into-cycle / days-remaining numbers are deterministic.
 * @param capUsd - Per-key monthly cap (USD). 0 means uncapped.
 * @param remainingUsd - Cap minus this-cycle usage.
 * @param usageMonthlyUsd - This-cycle usage rolled up by OpenRouter.
 */
export function computeCycleMetrics(
  now: Date,
  capUsd: number,
  remainingUsd: number,
  usageMonthlyUsd: number
): CycleMetrics {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const daysIntoCycle = Math.max(dayOfMonth, 1);
  const daysRemainingInCycle = Math.max(daysInMonth - dayOfMonth, 0);

  const usedThisCycleUsd = Math.max(capUsd - remainingUsd, 0);
  const capPctUsed = capUsd > 0 ? (usedThisCycleUsd / capUsd) * 100 : 0;

  const dailyBurnUsd = usageMonthlyUsd / daysIntoCycle;
  const projectedEndOfCycleUsd = dailyBurnUsd * daysInMonth;
  const projectedOverageUsd =
    capUsd > 0 ? Math.max(projectedEndOfCycleUsd - capUsd, 0) : 0;

  const nextReset = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
  const nextResetIso = nextReset.toISOString();
  const nextResetLabel = nextReset.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return {
    capUsd,
    remainingUsd,
    usedThisCycleUsd,
    capPctUsed,
    daysIntoCycle,
    daysRemainingInCycle,
    dailyBurnUsd,
    projectedEndOfCycleUsd,
    projectedOverageUsd,
    nextResetIso,
    nextResetLabel,
  };
}

/**
 * Render the now-instant in Central Time (project standard for human
 * timestamps, per CLAUDE.md "Time Zone Rules").
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
