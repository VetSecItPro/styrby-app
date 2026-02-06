'use client';

/**
 * Error boundary for the session detail page.
 *
 * Handles errors that occur during rendering or data fetching,
 * providing a user-friendly message and recovery options.
 */

import Link from 'next/link';

/**
 * Props for the error component.
 */
interface ErrorProps {
  /** The error that was thrown */
  error: Error & { digest?: string };
  /** Function to retry the failed operation */
  reset: () => void;
}

/**
 * Renders an error state with retry and navigation options.
 *
 * @param props - Error component props
 */
export default function SessionError({ error, reset }: ErrorProps) {
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col items-center justify-center bg-zinc-950 px-4">
      <div className="text-center max-w-md">
        {/* Error icon */}
        <div className="mx-auto h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center mb-6">
          <svg
            className="h-8 w-8 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        {/* Error message */}
        <h2 className="text-xl font-semibold text-zinc-100 mb-2">
          Failed to load session
        </h2>
        <p className="text-zinc-400 mb-6">
          {error.message || 'An unexpected error occurred while loading the session.'}
        </p>

        {/* Error digest for support */}
        {error.digest && (
          <p className="text-xs text-zinc-500 mb-6 font-mono">
            Error ID: {error.digest}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={reset}
            className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-orange-700 transition-colors focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-zinc-950"
          >
            Try again
          </button>

          <Link
            href="/sessions"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-6 py-2.5 text-sm font-medium text-zinc-100 hover:bg-zinc-700 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:ring-offset-zinc-950"
          >
            Back to sessions
          </Link>
        </div>
      </div>
    </div>
  );
}
