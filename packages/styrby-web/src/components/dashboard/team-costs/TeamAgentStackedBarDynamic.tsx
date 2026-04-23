'use client';

/**
 * Lazy-loaded wrapper for TeamAgentStackedBar.
 *
 * WHY dynamic import: Recharts (~250 kB gzipped) is deferred to keep the
 * initial team-cost page shell fast. The bar chart is below the fold on
 * most screens, so deferring it does not impact LCP.
 *
 * WHY ssr: false: Recharts uses browser-only APIs (ResizeObserver, canvas
 * measurement). SSR=false avoids hydration mismatches — the skeleton is shown
 * on the server, the real chart loads client-side.
 *
 * @module components/dashboard/team-costs/TeamAgentStackedBarDynamic
 */

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

/** Skeleton matching the chart layout to prevent cumulative layout shift. */
function ChartSkeleton() {
  return (
    <div className="rounded-xl border border-border/40 bg-card/60 p-4" aria-busy="true" aria-label="Loading team cost chart">
      <div className="flex items-end gap-1" style={{ height: 280 }}>
        {[40, 60, 35, 75, 50, 65, 45, 70, 30, 55, 48, 68, 38, 72].map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-t-sm" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}

/**
 * Dynamically imported TeamAgentStackedBar.
 * Props match TeamAgentStackedBarProps from TeamAgentStackedBar.tsx.
 */
export const TeamAgentStackedBarDynamic = dynamic(
  () => import('./TeamAgentStackedBar').then((mod) => ({ default: mod.TeamAgentStackedBar })),
  {
    loading: () => <ChartSkeleton />,
    ssr: false,
  }
);
