'use client';

/**
 * Lazy-loaded wrapper for CostCharts.
 *
 * WHY dynamic import: Recharts is a large library (~250 kB gzipped). CostCharts
 * is only shown to Power-tier users and is never visible above the fold. Deferring
 * its load avoids penalising all users with a heavier initial bundle and improves
 * LCP on the costs page for Free/Pro users who see the upgrade card instead.
 *
 * WHY ssr: false: Recharts uses browser-only APIs (ResizeObserver, canvas
 * measurement). Disabling SSR prevents hydration mismatches and ensures the
 * loading skeleton is shown on the server instead of blank content.
 */

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

/** Skeleton that matches the CostCharts layout to prevent layout shift. */
function CostChartsSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading charts">
      {/* Area chart skeleton */}
      <div>
        <Skeleton className="h-5 w-32 mb-4" />
        <div className="rounded-xl border border-border/40 bg-card/60 p-4">
          <div className="flex items-end gap-1" style={{ height: 300 }}>
            {[35, 52, 28, 65, 45, 72, 38, 55, 30, 68, 42, 75, 33, 58, 48, 62, 40, 70, 25, 50].map(
              (h, i) => (
                <Skeleton key={i} className="flex-1 rounded-t-sm" style={{ height: `${h}%` }} />
              )
            )}
          </div>
        </div>
      </div>

      {/* Two-column skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <Skeleton className="h-5 w-44 mb-4" />
          <div className="rounded-xl border border-border/40 bg-card/60 p-4">
            <Skeleton className="h-[300px] w-full rounded-lg" />
          </div>
        </div>
        <div>
          <Skeleton className="h-5 w-32 mb-4" />
          <div className="rounded-xl border border-border/40 bg-card/60 p-4 flex items-center justify-center" style={{ height: 348 }}>
            <Skeleton className="h-48 w-48 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Dynamically imported CostCharts — Recharts bundle is only fetched when this
 * component is rendered (i.e. the user is on the Power tier).
 */
export const CostChartsDynamic = dynamic(
  () => import('./cost-charts').then((mod) => ({ default: mod.CostCharts })),
  {
    loading: () => <CostChartsSkeleton />,
    ssr: false,
  }
);
