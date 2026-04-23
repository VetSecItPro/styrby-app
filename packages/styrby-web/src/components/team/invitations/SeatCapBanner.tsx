/**
 * SeatCapBanner Component
 *
 * Displays the current seat usage vs cap for a team.
 * Shows an upgrade CTA when the team is at or near the seat cap.
 *
 * WHY it accepts SeatCapResult from validateSeatCap() (not raw seat numbers):
 *   validateSeatCap() from @styrby/shared is the single source of truth for
 *   cap logic shared between this UI and the teams-invite edge function. By
 *   accepting the full result object we guarantee the banner reflects the same
 *   threshold, CTA URL, and null-cap handling as the gate — no duplicated logic.
 *
 * @module SeatCapBanner
 */

import type { SeatCapResult } from '@styrby/shared';
import { Users } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

/** Props for SeatCapBanner */
interface SeatCapBannerProps {
  /**
   * Result from validateSeatCap() in @styrby/shared.
   * Contains currentSeats, seatCap, overageInfo, and nullCapWarning.
   */
  seatCapResult: SeatCapResult;
  /** Team UUID for the fallback upgrade CTA URL (used when overageInfo is absent). */
  teamId: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Threshold at which the "near cap" warning banner shows.
 *
 * WHY 80%: Give admins time to add seats before the limit is hit.
 * At 80% utilization, they can pre-emptively purchase rather than scrambling.
 * Derived from seatCapResult.currentSeats / seatCapResult.seatCap to stay
 * consistent with validateSeatCap logic.
 */
const NEAR_CAP_THRESHOLD = 0.8;

// ============================================================================
// Component
// ============================================================================

/**
 * Displays seat usage and shows upgrade CTA when at/near the cap.
 *
 * States:
 *   - null cap (nullCapWarning=true): no banner (unlimited — Phase 2.6 not deployed)
 *   - < 80% used: neutral informational display
 *   - >= 80% used but not full: yellow warning with upgrade link
 *   - at cap (currentSeats >= seatCap): red banner with upgrade link
 *
 * @param props - SeatCapBannerProps
 */
export function SeatCapBanner({ seatCapResult, teamId }: SeatCapBannerProps) {
  const { currentSeats, seatCap, overageInfo, nullCapWarning } = seatCapResult;

  // WHY null cap = no banner:
  //   Teams without a cap are on unlimited plans (or Phase 2.6 not yet deployed).
  //   Showing "0/unlimited" is noise. We suppress the banner until a cap exists.
  //   nullCapWarning=true is the canonical signal from validateSeatCap for this state.
  if (seatCap === null || nullCapWarning) return null;

  const utilizationRatio = currentSeats / seatCap;
  const isAtCap = currentSeats >= seatCap;

  // WHY isNearCap uses the same ratio as validateSeatCap (currentSeats / seatCap >= 0.8):
  //   Deriving isNearCap from the shared result values ensures the UI threshold
  //   can never drift from the enforcement threshold.
  const isNearCap = !isAtCap && utilizationRatio >= NEAR_CAP_THRESHOLD;

  // WHY prefer overageInfo.upgradeCta from shared result over constructing our own:
  //   The shared function owns the CTA URL pattern. When Phase 2.6 changes the
  //   URL structure (e.g., includes a plan_id), the UI picks it up automatically.
  const upgradeCta = overageInfo?.upgradeCta ?? `/billing/add-seat?team=${teamId}`;

  // No banner when well under cap
  if (!isAtCap && !isNearCap) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-zinc-800/50 border border-zinc-700 text-sm text-zinc-400">
        <Users className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
        <span>{currentSeats} of {seatCap} seats used</span>
      </div>
    );
  }

  if (isAtCap) {
    return (
      <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-red-400 flex-shrink-0" aria-hidden="true" />
          <p className="text-sm text-red-300">
            <strong>{currentSeats}/{seatCap} seats used.</strong>{' '}
            Your team has reached its seat limit - new invites cannot be accepted.
          </p>
        </div>
        <a
          href={upgradeCta}
          className="flex-shrink-0 inline-block px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors"
        >
          Buy more seats
        </a>
      </div>
    );
  }

  // Near cap (>= 80%)
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-yellow-400 flex-shrink-0" aria-hidden="true" />
        <p className="text-sm text-yellow-300">
          <strong>{currentSeats}/{seatCap} seats used.</strong>{' '}
          You are approaching your seat limit.
        </p>
      </div>
      <a
        href={upgradeCta}
        className="flex-shrink-0 inline-block px-3 py-1.5 rounded-lg bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-300 text-sm font-medium transition-colors"
      >
        Buy more seats
      </a>
    </div>
  );
}
