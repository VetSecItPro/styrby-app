/**
 * TeamBudgetProjection
 *
 * Displays a team's MTD spend vs projected MTD vs seat-budget in a compact
 * summary card. Used at the top of the /dashboard/team/[teamId]/costs page.
 *
 * WHY a dedicated component (not inline in the page):
 *   Projection logic (progress bar %, tier-warning color thresholds) belongs
 *   in a component so it can be tested independently and reused on the main
 *   /dashboard/costs page's TeamCosts section in the future.
 *
 * WHY this is a server component (no 'use client'):
 *   All inputs are passed as props from the server page. There is no
 *   interactive state — the progress bar uses CSS only. Keeping it a server
 *   component avoids unnecessary client JS bundle growth.
 *
 * @module components/dashboard/team-costs/TeamBudgetProjection
 */

import { TrendingUp, TrendingDown, DollarSign } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Projection data returned by GET /api/teams/[id]/costs and passed through
 * the server page component to this display component.
 */
export interface TeamProjectionData {
  /** Human-readable team name */
  teamName: string;
  /** Billing tier identifier (e.g. 'team', 'business') */
  billingTier: string;
  /** Number of paid seats */
  activeSeats: number;
  /** Monthly budget in USD (activeSeats x per-seat price) */
  seatBudgetUsd: number;
  /** Actual MTD spend in USD */
  mtdSpendUsd: number;
  /** Linear MTD projection: (mtdSpend / daysElapsed) * daysInMonth */
  projectedMtdUsd: number;
  /** Calendar days elapsed so far this month */
  daysElapsed: number;
  /** Total calendar days in the current month */
  daysInMonth: number;
}

/** Props for {@link TeamBudgetProjection}. */
export interface TeamBudgetProjectionProps {
  /** Projection data from the API. Pass null to render a fallback. */
  projection: TeamProjectionData | null;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Computes the warning tier for the progress bar and text.
 *
 * WHY thresholds at 80% and 100%:
 *   - Below 80%: safe (green tone)
 *   - 80-100%: approaching limit (amber)
 *   - Over 100%: over budget (red)
 *
 * @param pct - Spend as percentage of budget (0-N)
 * @returns 'safe' | 'warn' | 'over'
 */
function budgetTier(pct: number): 'safe' | 'warn' | 'over' {
  if (pct >= 100) return 'over';
  if (pct >= 80) return 'warn';
  return 'safe';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the team MTD spend vs projected vs seat-budget projection card.
 *
 * @param props - TeamBudgetProjectionProps
 */
export function TeamBudgetProjection({ projection }: TeamBudgetProjectionProps) {
  if (!projection || projection.seatBudgetUsd <= 0) {
    // WHY null when no billing data: Teams without active_seats populated
    // (e.g. owner on legacy plan before Phase 2.6 webhook fires) would show
    // $0 budget. Hiding the card is cleaner than showing a misleading 0/0.
    return null;
  }

  const actualPct = (projection.mtdSpendUsd / projection.seatBudgetUsd) * 100;
  const projectedPct = (projection.projectedMtdUsd / projection.seatBudgetUsd) * 100;
  const tier = budgetTier(projectedPct);
  const isOnTrack = projectedPct < 100;

  const progressBarColor =
    tier === 'over' ? 'bg-destructive/80'
    : tier === 'warn' ? 'bg-amber-500/80'
    : 'bg-orange-500/70';

  const projectedTextColor =
    tier === 'over' ? 'text-destructive'
    : tier === 'warn' ? 'text-amber-500'
    : 'text-foreground';

  return (
    <section
      className="rounded-xl border border-border/60 bg-card/60 p-5"
      aria-label="Team budget projection"
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Monthly Budget</h2>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {isOnTrack ? (
            <TrendingDown className="h-3.5 w-3.5 text-green-500" aria-hidden="true" />
          ) : (
            <TrendingUp className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
          )}
          <span className={isOnTrack ? 'text-green-500' : 'text-destructive'}>
            {isOnTrack ? 'On track' : 'Over budget'}
          </span>
        </div>
      </div>

      {/* Spend metrics: MTD actual / projected / budget */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <p className="text-xs text-muted-foreground mb-0.5">MTD Spend</p>
          <p className="text-base font-bold text-foreground">
            ${projection.mtdSpendUsd.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-0.5">Projected</p>
          <p className={`text-base font-bold ${projectedTextColor}`}>
            ${projection.projectedMtdUsd.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-0.5">
            Budget ({projection.activeSeats} seats)
          </p>
          <p className="text-base font-bold text-foreground">
            ${projection.seatBudgetUsd.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Progress bar: actual spend vs budget */}
      <div className="space-y-1.5">
        <div
          className="h-2 w-full rounded-full bg-border/40 overflow-hidden"
          role="none"
        >
          <div
            className={`h-full rounded-full transition-all ${progressBarColor}`}
            style={{ width: `${Math.min(actualPct, 100).toFixed(1)}%` }}
            role="progressbar"
            aria-valuenow={actualPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="MTD spend as percentage of seat budget"
          />
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Day {projection.daysElapsed} of {projection.daysInMonth}
          </span>
          <span>
            {actualPct.toFixed(1)}% of budget used
          </span>
        </div>
      </div>

      {/* Overage warning */}
      {tier !== 'safe' && (
        <p className={`mt-3 text-xs ${tier === 'over' ? 'text-destructive' : 'text-amber-500'}`}>
          {tier === 'over'
            ? `Projected to exceed seat budget by $${(projection.projectedMtdUsd - projection.seatBudgetUsd).toFixed(2)} this month. Review usage or add seats.`
            : `Projected to use ${projectedPct.toFixed(0)}% of seat budget. Consider reviewing team usage.`
          }
        </p>
      )}
    </section>
  );
}
