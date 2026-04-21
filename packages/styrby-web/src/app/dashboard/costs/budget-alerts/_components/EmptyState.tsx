'use client';

/**
 * EmptyState — shown when the user has zero budget alerts.
 *
 * Two variants:
 * - alertLimit > 0: "Create your first alert" CTA
 * - alertLimit === 0: Upgrade-to-Pro CTA (Free tier has no alert quota)
 */

import Link from 'next/link';

interface EmptyStateProps {
  /** Maximum alerts allowed for the user's tier. */
  alertLimit: number;
  /** Invoked when the user clicks "Create Your First Alert". */
  onCreate: () => void;
}

/**
 * Renders the zero-alerts empty state with a tier-appropriate CTA.
 *
 * @param props - See {@link EmptyStateProps}.
 */
export function EmptyState({ alertLimit, onCreate }: EmptyStateProps) {
  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-16 text-center">
      <div className="mx-auto h-16 w-16 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
        <svg
          className="h-8 w-8 text-zinc-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
      </div>
      <h3 className="text-lg font-medium text-zinc-100 mb-2">No budget alerts</h3>
      {alertLimit > 0 ? (
        <>
          <p className="text-zinc-500 mb-6 max-w-sm mx-auto">
            Set up budget alerts to get notified when your AI spending reaches
            your thresholds.
          </p>
          <button
            onClick={onCreate}
            className="rounded-lg bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
            aria-label="Create your first budget alert"
          >
            Create Your First Alert
          </button>
        </>
      ) : (
        <>
          <p className="text-zinc-500 mb-6 max-w-sm mx-auto">
            Budget alerts help you control AI spending. Upgrade to Pro to
            create up to 3 budget alerts.
          </p>
          <Link
            href="/pricing"
            className="inline-block rounded-lg bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
          >
            Upgrade to Pro
          </Link>
        </>
      )}
    </div>
  );
}
