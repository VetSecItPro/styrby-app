/**
 * TierUpgradeWarning — web tier-cap warning banner.
 *
 * Rendered on the Cost Analytics page when the user's projected MTD spend
 * is >= 80% of their tier's monthly cap. Provides ROI copy and an upgrade CTA.
 *
 * WHY: An upgrade prompt at 80% cap converts better than waiting until 100%
 * (the user is still in a positive frame of mind, not blocked). Framing the
 * upgrade as "keep your agents running" rather than "avoid extra charges" is
 * more persuasive.
 *
 * @module components/dashboard/TierUpgradeWarning
 */

import Link from 'next/link';
import type { RunRateProjection } from '@styrby/shared';
import { capColorBand } from '@styrby/shared';

// ============================================================================
// Props
// ============================================================================

/**
 * Props for {@link TierUpgradeWarning}.
 */
export interface TierUpgradeWarningProps {
  /** Run-rate projection containing tier cap data. */
  projection: RunRateProjection;
  /** Human-readable tier name shown in the warning copy ("Free", "Pro"). */
  tierLabel: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a warning banner when the user is at amber or red tier-cap status.
 * Returns null when the tier has no cap or the user is safely below 60% of cap.
 *
 * @param props - See {@link TierUpgradeWarningProps}
 * @returns Warning banner or null
 *
 * @example
 * <TierUpgradeWarning projection={projection} tierLabel="Free" />
 */
export function TierUpgradeWarning({
  projection,
  tierLabel,
}: TierUpgradeWarningProps) {
  const { tierCapFractionUsed, tierCapUsd, projectedMonthUsd } = projection;

  if (
    tierCapFractionUsed === null ||
    tierCapUsd === null ||
    capColorBand(tierCapFractionUsed) === 'green'
  ) {
    return null;
  }

  const isOverCap = tierCapFractionUsed >= 1;
  const pct = Math.round(tierCapFractionUsed * 100);

  return (
    <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
      {/* Icon */}
      <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
        <svg
          className="w-4 h-4 text-amber-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.962-.833-2.732 0L3.072 16.5c-.77.833.192 2.5 1.732 2.5z"
          />
        </svg>
      </div>

      {/* Copy */}
      <div className="flex-1">
        <p className="text-sm font-semibold text-amber-300">
          {isOverCap
            ? `${tierLabel} cap reached`
            : `Approaching ${tierLabel} cap (${pct}%)`}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          {isOverCap
            ? `You have exceeded the $${tierCapUsd} monthly cap on the ${tierLabel} plan. Upgrade to Power to keep your agents running without interruption.`
            : `At this rate you will hit the $${tierCapUsd} cap${
                projectedMonthUsd !== null
                  ? ` - projected end-of-month: $${projectedMonthUsd.toFixed(2)}`
                  : ''
              }. Upgrade to Power for unlimited spend.`}
        </p>
      </div>

      {/* CTA */}
      <Link
        href="/pricing"
        className="shrink-0 inline-flex items-center rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-400 transition-colors"
      >
        Upgrade
      </Link>
    </div>
  );
}
