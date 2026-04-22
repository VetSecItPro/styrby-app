'use client';

/**
 * RunRateCard — web cost projection card for the Cost Analytics dashboard.
 *
 * Displays:
 *   - Today's actual spend vs tier cap (color-coded progress bar)
 *   - Month-to-date actual vs projected end-of-month
 *   - Rolling 30-day daily average and days remaining
 *   - "X days until cap" warning label for amber/red bands
 *
 * Mirrors RunRateCard on mobile (parity per web_mobile_parity memory).
 *
 * WHY a client component: The progress bar width is derived from
 * tierCapFractionUsed (a runtime value) so it cannot be a static CSS class
 * in a server component. 'use client' is the minimal boundary needed.
 *
 * @module components/dashboard/RunRateCard
 */

import type { RunRateProjection } from '@styrby/shared';
import { capColorBand } from '@styrby/shared';

// ============================================================================
// Helpers
// ============================================================================

/** Returns a Tailwind background color class for a cap color band. */
function barBgClass(band: 'green' | 'amber' | 'red'): string {
  switch (band) {
    case 'green':
      return 'bg-green-500';
    case 'amber':
      return 'bg-amber-500';
    case 'red':
      return 'bg-red-500';
  }
}

/** Returns a Tailwind text color class for a cap color band. */
function bandTextClass(band: 'green' | 'amber' | 'red'): string {
  switch (band) {
    case 'green':
      return 'text-green-400';
    case 'amber':
      return 'text-amber-400';
    case 'red':
      return 'text-red-400';
  }
}

// ============================================================================
// Props
// ============================================================================

/**
 * Props for {@link RunRateCard}.
 */
export interface RunRateCardProps {
  /** Projection data calculated by calcRunRate() in the parent server component. */
  projection: RunRateProjection;
}

// ============================================================================
// Component
// ============================================================================

/**
 * RunRateCard renders the monthly cost projection panel for the web Cost Analytics page.
 *
 * @param props - See {@link RunRateCardProps}
 * @returns React element
 *
 * @example
 * <RunRateCard projection={projection} />
 */
export function RunRateCard({ projection }: RunRateCardProps) {
  const {
    todayActualUsd,
    mtdActualUsd,
    projectedMonthUsd,
    rollingDailyAvgUsd,
    daysRemainingInMonth,
    tierCapFractionUsed,
    tierCapUsd,
    daysUntilCapHit,
  } = projection;

  const hasCap = tierCapUsd !== null && tierCapFractionUsed !== null;
  const band = hasCap ? capColorBand(tierCapFractionUsed!) : 'green';
  const barWidthPct = hasCap ? Math.min(tierCapFractionUsed! * 100, 100) : 0;

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Monthly Run-Rate
        </h3>
        {hasCap && (
          <span className={`text-xs font-medium ${bandTextClass(band)}`}>
            {Math.round(tierCapFractionUsed! * 100)}% of ${tierCapUsd} cap
          </span>
        )}
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Today</p>
          <p className="text-lg font-semibold text-foreground">
            ${todayActualUsd.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">Month to date</p>
          <p className="text-lg font-semibold text-foreground">
            ${mtdActualUsd.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">Projected</p>
          <p className="text-lg font-semibold text-foreground">
            {projectedMonthUsd !== null ? `$${projectedMonthUsd.toFixed(2)}` : '-'}
          </p>
        </div>
      </div>

      {/* Progress bar (only when tier has a cap) */}
      {hasCap && (
        <div className="mb-3">
          <div className="h-1.5 bg-secondary/60 rounded-full overflow-hidden">
            <div
              className={`h-1.5 rounded-full transition-all duration-300 ${barBgClass(band)}`}
              style={{ width: `${barWidthPct}%` }}
              role="progressbar"
              aria-valuenow={Math.round(barWidthPct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${Math.round(barWidthPct)}% of monthly cap used`}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          ${rollingDailyAvgUsd.toFixed(3)}/day avg - {daysRemainingInMonth} days left
        </p>
        {hasCap && daysUntilCapHit !== null && band !== 'green' && (
          <p className={`text-xs font-medium ${bandTextClass(band)}`}>
            Cap in ~{Math.ceil(daysUntilCapHit)}d
          </p>
        )}
      </div>
    </div>
  );
}
