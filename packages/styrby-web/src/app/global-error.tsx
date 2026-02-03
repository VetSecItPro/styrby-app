'use client';

/**
 * Global Error Boundary
 *
 * Catches unhandled errors in the app and reports them to Sentry.
 * This is the last line of defense for errors in the application.
 */

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report the error to Sentry
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen flex items-center justify-center">
        <div className="max-w-md mx-auto p-8 text-center">
          <div className="text-6xl mb-4">!</div>
          <h1 className="text-2xl font-bold mb-4">Something went wrong</h1>
          <p className="text-zinc-400 mb-6">
            An unexpected error occurred. Our team has been notified and is working on a fix.
          </p>
          <div className="space-y-3">
            <button
              onClick={() => reset()}
              className="w-full px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg font-medium transition-colors"
            >
              Try again
            </button>
            <button
              onClick={() => (window.location.href = '/')}
              className="w-full px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-lg font-medium transition-colors"
            >
              Go to homepage
            </button>
          </div>
          {error.digest && (
            <p className="mt-6 text-xs text-zinc-600">Error ID: {error.digest}</p>
          )}
        </div>
      </body>
    </html>
  );
}
