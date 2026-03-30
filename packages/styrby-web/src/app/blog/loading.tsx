/**
 * Loading skeleton for the Blog listing page.
 *
 * WHY skeleton: Blog articles are rendered client-side with useState for
 * category filtering. The skeleton matches the article card grid shape so
 * the layout is stable when content hydrates, avoiding CLS.
 */

import { Skeleton } from '@/components/ui/skeleton';

export default function BlogLoading() {
  return (
    <div className="mx-auto max-w-7xl px-6" aria-busy="true" aria-label="Loading blog">
      {/* Header */}
      <div className="mb-12">
        <Skeleton className="h-12 w-24 mb-4" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>

      {/* Category filter pills */}
      <div className="mb-8 flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-20 rounded-full" />
        ))}
      </div>

      {/* Article card grid — matches BlogPage 3-column grid */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border/50 bg-card/50 p-6 space-y-3"
          >
            {/* Category + read time row */}
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-4 w-16" />
            </div>
            {/* Title */}
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-4/5" />
            {/* Description */}
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            {/* Date */}
            <Skeleton className="h-3 w-28 mt-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
