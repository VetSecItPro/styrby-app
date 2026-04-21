'use client';

/**
 * AlertsHeader — top bar of the Budget Alerts page.
 *
 * Shows tier usage ("3 / 5 alerts used (Pro plan)") and the right-side
 * action: either a "Create Alert" button (when under the limit) or an
 * upgrade CTA (when at the limit).
 *
 * WHY split out: The header has three mutually exclusive right-side
 * states (create / upgrade-from-free / upgrade-for-more). Co-locating
 * the branching here keeps the orchestrator focused on data flow.
 */

import Link from 'next/link';

interface AlertsHeaderProps {
  /** Current number of alerts the user has. */
  alertCount: number;
  /** Maximum alerts allowed for the user's tier. */
  alertLimit: number;
  /** Subscription tier label (e.g. "Free", "Pro"). */
  tier: string;
  /** Invoked when the user clicks "Create Alert". */
  onCreate: () => void;
}

/**
 * Renders the page header with usage stats and the primary CTA.
 *
 * @param props - See {@link AlertsHeaderProps}.
 */
export function AlertsHeader({
  alertCount,
  alertLimit,
  tier,
  onCreate,
}: AlertsHeaderProps) {
  const canCreateAlert = alertCount < alertLimit;

  return (
    <div className="flex items-center justify-between mb-6">
      <div>
        <p className="text-sm text-zinc-400">
          {alertCount} / {alertLimit} alerts used
          <span className="text-zinc-500 ml-2">({tier} plan)</span>
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/costs"
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          Back to Costs
        </Link>
        {canCreateAlert ? (
          <button
            onClick={onCreate}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors flex items-center gap-2"
            aria-label="Create a new budget alert"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Create Alert
          </button>
        ) : alertLimit === 0 ? (
          <Link
            href="/pricing"
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
          >
            Upgrade to Pro
          </Link>
        ) : (
          <Link
            href="/pricing"
            className="rounded-lg border border-orange-500/50 px-4 py-2 text-sm font-medium text-orange-400 hover:bg-orange-500/10 transition-colors"
          >
            Upgrade for More
          </Link>
        )}
      </div>
    </div>
  );
}
