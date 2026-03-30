/**
 * Loading skeleton for the Team Management page.
 *
 * WHY skeleton over spinner: A layout-matched skeleton prevents cumulative
 * layout shift (CLS) when the real content arrives, which directly impacts
 * Lighthouse CLS score. Users also perceive structured skeletons as ~30%
 * faster than a blank spinner (Nielsen Norman Group).
 */

import { Skeleton } from '@/components/ui/skeleton';

export default function TeamLoading() {
  return (
    <div className="space-y-6 p-6" aria-busy="true" aria-label="Loading team">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-32 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-10 w-32 rounded-lg" />
      </div>

      {/* Team member rows */}
      <div className="rounded-xl border border-border/40 bg-card/60 divide-y divide-border/20">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <Skeleton className="h-4 w-40 mb-1.5" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
