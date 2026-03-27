'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Client-side time range selector for the costs page.
 *
 * WHY this is a separate client component: The costs page is a server component
 * for performance (SSR with streaming). The `<select>` element needs an onChange
 * handler, which requires client-side JavaScript. Extracting it into a tiny client
 * component keeps the parent server-rendered while enabling interactivity.
 *
 * Uses URL searchParams (`?days=7`) so the server component can read the selected
 * range and adjust its query accordingly. This also makes the time range bookmarkable.
 *
 * @param props.currentDays - The currently selected number of days (default 30)
 */
export function TimeRangeSelect({ currentDays }: { currentDays: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const params = new URLSearchParams(searchParams.toString());
      const value = e.target.value;

      if (value === '30') {
        params.delete('days');
      } else {
        params.set('days', value);
      }

      const query = params.toString();
      router.push(`/dashboard/costs${query ? `?${query}` : ''}`);
    },
    [router, searchParams]
  );

  return (
    <select
      value={currentDays}
      onChange={handleChange}
      className="w-full rounded-lg border border-border/60 bg-secondary/60 px-4 py-2 text-sm text-foreground focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 md:w-auto"
      aria-label="Select time range for cost analytics"
    >
      <option value="7">Last 7 days</option>
      <option value="30">Last 30 days</option>
      <option value="90">Last 90 days</option>
    </select>
  );
}
