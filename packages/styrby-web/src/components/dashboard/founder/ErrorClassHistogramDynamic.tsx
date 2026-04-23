'use client';

/**
 * Lazy-loaded wrapper for ErrorClassHistogram.
 *
 * WHY dynamic import: The histogram uses Recharts which is already in the
 * bundle for other founder dashboard charts. We still defer it because
 * it renders below the MrrCard / FunnelChart fold — deferring avoids
 * blocking those above-fold components.
 *
 * WHY ssr: false: Recharts depends on browser APIs (ResizeObserver).
 * SSR=false prevents hydration mismatch; the skeleton is shown on the server.
 *
 * @module components/dashboard/founder/ErrorClassHistogramDynamic
 */

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

/** Skeleton matching the histogram height to prevent layout shift. */
function HistogramSkeleton() {
  return (
    <div
      className="rounded-xl border border-border/40 bg-card/60 p-5"
      aria-busy="true"
      aria-label="Loading error class histogram"
    >
      <div className="flex items-center justify-between mb-4">
        <Skeleton className="h-4 w-52" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className="flex items-end gap-1" style={{ height: 220 }}>
        {[30, 55, 25, 70, 45, 60, 35, 50, 40, 65, 28, 48, 55, 42].map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-t-sm" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}

/**
 * Dynamically imported ErrorClassHistogram.
 * Props match ErrorClassHistogramProps from ErrorClassHistogram.tsx.
 */
export const ErrorClassHistogramDynamic = dynamic(
  () => import('./ErrorClassHistogram').then((mod) => ({ default: mod.ErrorClassHistogram })),
  {
    loading: () => <HistogramSkeleton />,
    ssr: false,
  }
);
