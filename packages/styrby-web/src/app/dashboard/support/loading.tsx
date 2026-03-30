/**
 * Loading skeleton for the Support Tickets page.
 *
 * WHY skeleton over spinner: A layout-matched skeleton prevents cumulative
 * layout shift (CLS) when the real content arrives. The ticket row shape
 * mirrors the SupportListClient layout for a seamless transition.
 */

import { Skeleton } from '@/components/ui/skeleton';

export default function SupportLoading() {
  return (
    <div className="space-y-6 p-6" aria-busy="true" aria-label="Loading support tickets">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-40 mb-2" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-10 w-32 rounded-lg" />
      </div>

      {/* Ticket list */}
      <div className="rounded-xl border border-border/40 bg-card/60 divide-y divide-border/20">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-4 px-5 py-4">
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-3 w-full max-w-md" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-8 w-8 rounded-md flex-shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
