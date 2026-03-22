'use client';

/**
 * Client-side refresh button for the offline fallback page.
 *
 * WHY: Separated into its own client component so the parent offline page
 * can remain a server component. This minimizes the client JS bundle that
 * the service worker needs to precache for the offline fallback.
 *
 * @returns A button that reloads the current page when clicked
 */
export function RefreshButton() {
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="inline-flex items-center justify-center rounded-md border border-input bg-background px-6 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      Try Again
    </button>
  );
}
