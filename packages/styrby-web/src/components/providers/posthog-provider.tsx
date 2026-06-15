'use client';

/**
 * PostHog analytics provider (Cluster B1).
 *
 * Initialises cookieless PostHog once on mount and captures a `$pageview` on
 * every App Router navigation. Renders nothing visible - it's a behavioural
 * wrapper mounted high in the tree.
 *
 * WHY a manual pageview tracker (not the SDK's autocapture): Next's App Router
 * does client-side navigation that the SDK's history-API hook double-counts
 * and mistimes. Subscribing to `usePathname` / `useSearchParams` gives one
 * accurate pageview per route change. `useSearchParams` requires a Suspense
 * boundary, so the tracker is isolated in its own Suspense-wrapped component.
 *
 * @module components/providers/posthog-provider
 */

import { Suspense, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { initAnalytics, capturePageview } from '@/lib/analytics/posthog';

/**
 * Fires one `$pageview` per route change. Isolated so the `useSearchParams`
 * Suspense requirement doesn't suspend the whole app.
 */
function PageviewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    const query = searchParams?.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    capturePageview(url);
  }, [pathname, searchParams]);

  return null;
}

/**
 * Mounts analytics. Wrap the app once (in the root layout). No-ops entirely
 * when no PostHog key is configured, so local dev without a key is unaffected.
 *
 * @param children - The app tree. Rendered unchanged.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initAnalytics();
  }, []);

  return (
    <>
      <Suspense fallback={null}>
        <PageviewTracker />
      </Suspense>
      {children}
    </>
  );
}
