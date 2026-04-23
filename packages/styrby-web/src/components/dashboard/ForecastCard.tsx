'use client';

/**
 * ForecastCard — Predictive spend card for the web Cost Analytics dashboard.
 *
 * Shows:
 *   - "You're on track to spend $X by end of month" (green/amber/red)
 *   - "At current burn you'll hit your cap on <date>" (when cap applicable)
 *   - Accelerating burn indicator: "burn rate up X%" badge
 *   - 7d / 14d / 30d horizon forecasts
 *
 * WHY a separate card from RunRateCard:
 *   RunRateCard shows MTD actuals and the current run-rate projection.
 *   ForecastCard shows the EMA-blend forecast (Phase 3.4 math) which is
 *   meaningfully different: it weights recent acceleration, predicts a
 *   specific exhaustion date, and shows horizon forecasts.
 *   Both cards appear together on the Cost Analytics page — one for "how am I
 *   doing now" and one for "what will happen next."
 *
 * WHY 'use client':
 *   Forecast data is fetched client-side via SWR to stay fresh without a full
 *   server re-render. The forecast API response is user-specific (no shared
 *   cache). All math is done server-side in the API route.
 *
 * WHY TrendingUp / AlertTriangle icons:
 *   Project rules prohibit sparkle icons. TrendingUp communicates "upward
 *   trajectory"; AlertTriangle communicates urgency without a sparkle.
 *
 * @module components/dashboard/ForecastCard
 */

import { useEffect, useState } from 'react';
import { TrendingUp, AlertTriangle, TrendingDown } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

/**
 * Shape of the response from GET /api/costs/forecast.
 * Mirrors the CostForecast type from @styrby/shared plus tier context.
 */
interface ForecastPayload {
  dailyAverageCents: number;
  trailingWeekAverageCents: number;
  weightedForecastCents: {
    '7d': number;
    '14d': number;
    '30d': number;
  };
  predictedExhaustionDate: string | null;
  isBurnAccelerating: boolean;
  tier: string;
  quotaCents: number | null;
  elapsedCents: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats integer cents as a USD dollar string.
 *
 * @param cents - Integer cents (e.g. 4995 → "$49.95")
 * @returns Formatted USD string
 *
 * @example
 * fmtCents(4995); // "$49.95"
 * fmtCents(0);    // "$0.00"
 */
function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Returns the projected fraction of quota consumed at the 30d forecast.
 * Null if quota is uncapped.
 *
 * @param forecast30dCents - 30-day forward forecast in cents
 * @param elapsedCents - Already consumed in current period
 * @param quotaCents - Monthly cap in cents, or null
 */
function projectedFraction(
  forecast30dCents: number,
  elapsedCents: number,
  quotaCents: number | null
): number | null {
  if (quotaCents === null || quotaCents === 0) return null;
  return Math.min((elapsedCents + forecast30dCents) / quotaCents, 2);
}

/**
 * Returns the color band for a projected usage fraction.
 *
 * Thresholds:
 *   < 0.8 → 'green'
 *   < 1.0 → 'amber'
 *   >= 1.0 → 'red' (projected to exceed cap)
 *
 * WHY 80% not 60% (as in RunRateCard): The forecast card shows a future
 * projection, not current usage. A projection at 80% is worth noting but
 * not alarming; a projection at 100%+ is the primary call-to-action.
 *
 * @param fraction - Projected fraction (may exceed 1.0)
 */
function colorBand(fraction: number): 'green' | 'amber' | 'red' {
  if (fraction < 0.8) return 'green';
  if (fraction < 1.0) return 'amber';
  return 'red';
}

/** Tailwind text class for a color band */
function textClass(band: 'green' | 'amber' | 'red'): string {
  switch (band) {
    case 'green': return 'text-green-400';
    case 'amber': return 'text-amber-400';
    case 'red': return 'text-red-400';
  }
}

/** Tailwind border class for the card border when highlighted */
function borderClass(band: 'green' | 'amber' | 'red'): string {
  switch (band) {
    case 'green': return 'border-green-800/40';
    case 'amber': return 'border-amber-700/50';
    case 'red': return 'border-red-700/60';
  }
}

// ============================================================================
// ForecastCard
// ============================================================================

/**
 * ForecastCard renders the predictive spend panel on the Cost Analytics page.
 *
 * @returns React element — loading skeleton, error state, or forecast panel
 *
 * @example
 * <ForecastCard />
 */
export function ForecastCard() {
  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    // WHY fetch at mount with no SWR: avoids adding a swr dependency for a
    // single infrequently-used component. The forecast API is cheap (BRIN
    // indexed, 30-day window). Users rarely refresh this card.
    fetch('/api/costs/forecast')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ForecastPayload>;
      })
      .then(setForecast)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div
        className="rounded-xl border border-border/60 bg-card/60 p-5 animate-pulse"
        aria-label="Loading forecast"
      >
        <div className="h-4 w-32 bg-secondary/60 rounded mb-4" />
        <div className="h-6 w-48 bg-secondary/40 rounded mb-2" />
        <div className="h-4 w-64 bg-secondary/30 rounded" />
      </div>
    );
  }

  if (error || !forecast) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/60 p-5">
        <p className="text-sm text-muted-foreground">
          Forecast unavailable. Check back later.
        </p>
      </div>
    );
  }

  const {
    dailyAverageCents,
    trailingWeekAverageCents,
    weightedForecastCents,
    predictedExhaustionDate,
    isBurnAccelerating,
    quotaCents,
    elapsedCents,
  } = forecast;

  const projected30d = projectedFraction(
    weightedForecastCents['30d'],
    elapsedCents,
    quotaCents
  );
  const band = projected30d !== null ? colorBand(projected30d) : 'green';

  // Acceleration rate: how much faster is the recent week vs. 30-day avg?
  const accelPct =
    dailyAverageCents > 0
      ? Math.round(
          ((trailingWeekAverageCents - dailyAverageCents) / dailyAverageCents) * 100
        )
      : 0;

  // Format the exhaustion date for display.
  const exhaustionDisplay = predictedExhaustionDate
    ? new Date(predictedExhaustionDate).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : null;

  return (
    <div
      className={`rounded-xl border ${borderClass(band)} bg-card/60 p-5`}
      role="region"
      aria-label="Spend forecast"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Spend Forecast
        </h3>

        {/* Burn acceleration badge */}
        {isBurnAccelerating && accelPct > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400 bg-amber-950/40 rounded-full px-2 py-0.5">
            <TrendingUp className="w-3 h-3" aria-hidden="true" />
            burn rate up {accelPct}%
          </span>
        )}

        {/* Decelerating indicator (optional, shown when meaningfully lower) */}
        {!isBurnAccelerating && accelPct < -10 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400 bg-green-950/40 rounded-full px-2 py-0.5">
            <TrendingDown className="w-3 h-3" aria-hidden="true" />
            burn rate down {Math.abs(accelPct)}%
          </span>
        )}
      </div>

      {/* Primary message */}
      <div className="mb-4">
        {exhaustionDisplay && quotaCents !== null ? (
          // Cap exhaustion prediction — highest priority message.
          <div className="flex items-start gap-2">
            <AlertTriangle
              className={`w-4 h-4 mt-0.5 flex-shrink-0 ${textClass(band)}`}
              aria-hidden="true"
            />
            <p className={`text-sm font-medium ${textClass(band)}`}>
              At current burn you&apos;ll hit your cap on {exhaustionDisplay}.
            </p>
          </div>
        ) : (
          // No cap or exhaustion far out — show 30d projection optimistically.
          <p className="text-sm text-foreground">
            You&apos;re on track to spend{' '}
            <span className={`font-semibold ${textClass(band)}`}>
              {fmtCents(elapsedCents + weightedForecastCents['30d'])}
            </span>{' '}
            by end of month.
          </p>
        )}
      </div>

      {/* Horizon forecast grid */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {(['7d', '14d', '30d'] as const).map((horizon) => (
          <div key={horizon} className="text-center">
            <p className="text-xs text-muted-foreground mb-0.5">Next {horizon}</p>
            <p className="text-sm font-semibold text-foreground">
              {fmtCents(weightedForecastCents[horizon])}
            </p>
          </div>
        ))}
      </div>

      {/* Footer: daily averages */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          30d avg: {fmtCents(dailyAverageCents)}/day
        </span>
        <span>
          7d avg: {fmtCents(trailingWeekAverageCents)}/day
        </span>
      </div>
    </div>
  );
}
