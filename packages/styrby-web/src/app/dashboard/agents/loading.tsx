/**
 * Loading skeleton for the Agents page.
 *
 * WHY skeleton over spinner: A layout-matched skeleton prevents cumulative
 * layout shift (CLS) when the real content arrives, which directly impacts
 * the Lighthouse CLS score. The agent card grid shape matches the real
 * AgentsClient layout so the transition is seamless.
 */

import { Skeleton } from '@/components/ui/skeleton';

export default function AgentsLoading() {
  return (
    <div className="space-y-6 p-6" aria-busy="true" aria-label="Loading agents">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-28 mb-2" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-10 w-36 rounded-lg" />
      </div>

      {/* Agent cards grid - matches AgentsClient grid layout */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border/40 bg-card/60 p-5 space-y-4"
          >
            {/* Agent icon + name */}
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-lg flex-shrink-0" />
              <div>
                <Skeleton className="h-4 w-24 mb-1.5" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
            {/* Stats row */}
            <div className="flex gap-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-20" />
            </div>
            {/* Action button */}
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
