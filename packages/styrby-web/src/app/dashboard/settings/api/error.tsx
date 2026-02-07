'use client';

/**
 * Error boundary for API Keys page.
 */

import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="text-center">
        <div className="mx-auto h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
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
        <h2 className="text-xl font-semibold text-zinc-100 mb-2">Something went wrong</h2>
        <p className="text-zinc-400 mb-6 max-w-sm mx-auto">
          Failed to load API keys. Please try again.
        </p>

        {process.env.NODE_ENV === 'development' && error.message && (
          <div className="mb-6 p-3 rounded-lg bg-zinc-900 border border-zinc-800 text-left max-w-sm mx-auto">
            <p className="text-xs text-zinc-500 mb-1">Dev only:</p>
            <pre className="text-xs text-red-400 whitespace-pre-wrap break-words">{error.message}</pre>
          </div>
        )}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
          >
            Try Again
          </button>
          <Link
            href="/dashboard/settings"
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            Back to Settings
          </Link>
        </div>
      </div>
    </div>
  );
}
