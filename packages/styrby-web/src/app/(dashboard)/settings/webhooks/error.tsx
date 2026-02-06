'use client';

/**
 * Error boundary for the Webhooks settings page.
 *
 * Displays a user-friendly error message when the page fails to load,
 * with a retry button to attempt recovery.
 */

import { useEffect } from 'react';
import Link from 'next/link';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function WebhooksError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Log error to console in development
    console.error('Webhooks page error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center">
        {/* Error icon */}
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
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        <h1 className="text-xl font-semibold text-zinc-100 mb-2">
          Failed to Load Webhooks
        </h1>
        <p className="text-zinc-400 mb-6">
          Something went wrong while loading your webhooks. This could be a temporary
          issue. Please try again.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={reset}
            className="w-full sm:w-auto rounded-lg bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
          >
            Try Again
          </button>
          <Link
            href="/settings"
            className="w-full sm:w-auto rounded-lg border border-zinc-700 px-6 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors text-center"
          >
            Back to Settings
          </Link>
        </div>

        {/* Error details in development */}
        {process.env.NODE_ENV === 'development' && error.message && (
          <div className="mt-8 p-4 rounded-lg bg-zinc-900 border border-zinc-800 text-left">
            <p className="text-xs text-zinc-500 mb-2">Error details (development only):</p>
            <pre className="text-xs text-red-400 whitespace-pre-wrap break-words">
              {error.message}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
