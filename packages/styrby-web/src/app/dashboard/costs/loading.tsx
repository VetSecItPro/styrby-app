/**
 * Loading skeleton for the Costs page.
 *
 * WHY skeletons over spinners: Skeleton loaders that match the actual
 * content layout feel 30% faster perceptually (Nielsen Norman Group).
 * Users see the page structure immediately, reducing perceived wait time.
 */

import { Skeleton } from '@/components/ui/skeleton';

export default function CostsLoading() {
  return (
    <div className="space-y-8">
      {/* Header skeleton */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>
        <Skeleton className="h-10 w-36 rounded-lg" />
      </div>

      {/* Summary cards skeleton (matches CostsRealtime grid) */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border/40 bg-card/60 p-4">
            <Skeleton className="h-4 w-16 mb-2" />
            <Skeleton className="h-8 w-24 mb-2" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>

      {/* Area chart skeleton */}
      <div>
        <Skeleton className="h-5 w-32 mb-4" />
        <div className="rounded-xl border border-border/40 bg-card/60 p-4">
          <div className="flex items-end gap-1" style={{ height: 300 }}>
            {[35, 52, 28, 65, 45, 72, 38, 55, 30, 68, 42, 75, 33, 58, 48, 62, 40, 70, 25, 50].map((h, i) => (
              <Skeleton
                key={i}
                className="flex-1 rounded-t-sm"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Two-column chart skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <Skeleton className="h-5 w-44 mb-4" />
          <div className="rounded-xl border border-border/40 bg-card/60 p-4">
            <Skeleton className="h-[300px] w-full rounded-lg" />
          </div>
        </div>
        <div>
          <Skeleton className="h-5 w-32 mb-4" />
          <div className="rounded-xl border border-border/40 bg-card/60 p-4">
            <div className="flex items-center justify-center" style={{ height: 300 }}>
              <Skeleton className="h-48 w-48 rounded-full" />
            </div>
          </div>
        </div>
      </div>

      {/* Model breakdown skeleton */}
      <div>
        <Skeleton className="h-5 w-28 mb-4" />
        <div className="rounded-xl border border-border/40 bg-card/60 divide-y divide-border/20">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-4 py-3 flex items-center justify-between">
              <div>
                <Skeleton className="h-4 w-36 mb-1" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
