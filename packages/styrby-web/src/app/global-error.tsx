'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * Global Error Boundary
 *
 * Catches unhandled errors at the root of the app - the last line of defense
 * before a blank screen. Renders its own HTML shell because the root layout
 * may itself have errored.
 *
 * WHY the inline HTML shell: Next.js replaces the entire document with this
 * component when a root-level error occurs, so we must provide <html> and
 * <body> tags ourselves. Tailwind classes still work because the stylesheet
 * is embedded in the page.
 *
 * WHY Sentry.captureException is called here:
 * global-error.tsx is the client-side last resort. By the time this component
 * renders, the error has already propagated past all nested error.tsx boundaries.
 * Capturing it here ensures root-level crashes appear in Sentry even when
 * Next.js cannot automatically instrument them (e.g., during RSC hydration).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    /**
     * Report the root-level error to Sentry.
     * WHY useEffect: Sentry is a browser SDK — it must run after hydration.
     * Calling captureException in render would fail during SSR and cause
     * a hydration mismatch.
     */
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen flex items-center justify-center">
        <div className="max-w-md mx-auto p-8 text-center">
          <div className="mx-auto h-16 w-16 rounded-full bg-orange-500/10 flex items-center justify-center mb-6">
            <span className="text-2xl font-bold text-orange-400">!</span>
          </div>
          <h1 className="text-2xl font-bold mb-4">Something went wrong</h1>
          <p className="text-zinc-400 mb-6">
            An unexpected error occurred. Please try again.
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
            <p className="mt-6 text-xs text-zinc-500">Error ID: {error.digest}</p>
          )}
        </div>
      </body>
    </html>
  );
}
