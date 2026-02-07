'use client';

import Link from 'next/link';

/**
 * Error boundary for the Budget Alerts page.
 *
 * Catches runtime errors in the budget alerts route and displays a
 * user-friendly error message with options to retry or navigate back.
 *
 * @param error - The error object thrown during rendering
 * @param reset - Function to re-render the route segment and attempt recovery
 */
export default function BudgetAlertsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center">
        <div className="mx-auto h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center mb-6">
          <svg
            className="h-8 w-8 text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-zinc-100 mb-2">
          Budget Alerts Error
        </h1>
        <p className="text-zinc-400 mb-6">
          Something went wrong loading your budget alerts.
        </p>

        {error.digest && (
          <p className="text-xs text-zinc-600 mb-6">Error ID: {error.digest}</p>
        )}

        {process.env.NODE_ENV === 'development' && error.message && (
          <div className="mb-6 p-3 rounded-lg bg-zinc-900 border border-zinc-800 text-left">
            <p className="text-xs text-zinc-500 mb-1">Dev only:</p>
            <pre className="text-xs text-red-400 whitespace-pre-wrap break-words">{error.message}</pre>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <button
            onClick={() => reset()}
            className="w-full rounded-lg bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
            aria-label="Try loading budget alerts again"
          >
            Try Again
          </button>
          <Link
            href="/dashboard/costs"
            className="w-full inline-block rounded-lg bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-100 hover:bg-zinc-700 transition-colors"
          >
            Back to Costs
          </Link>
        </div>
      </div>
    </div>
  );
}
