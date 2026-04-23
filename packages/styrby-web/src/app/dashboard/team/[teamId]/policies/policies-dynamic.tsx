'use client';

/**
 * Lazy-loaded wrapper for the PoliciesForm client component.
 *
 * WHY dynamic import:
 *   PoliciesForm uses useState, fetch, and lucide-react icons. Deferring its
 *   load via next/dynamic keeps the team sub-page bundle separate from the
 *   core dashboard chunk and contributes to the 700 KB ratchet target.
 *
 * @module dashboard/team/[teamId]/policies/policies-dynamic
 */

import dynamic from 'next/dynamic';
import type { PoliciesFormProps } from '@/components/team/policies';

/** Skeleton shown while the PoliciesForm JS is loading. */
function PoliciesFormSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading policies">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 bg-zinc-800 rounded w-40" />
          <div className="h-3 bg-zinc-800 rounded w-64" />
          <div className="h-10 bg-zinc-800 rounded-lg" />
        </div>
      ))}
      <div className="h-9 bg-zinc-800 rounded-lg w-32 mt-4" />
    </div>
  );
}

/**
 * Dynamically imported PoliciesForm with loading skeleton.
 */
export const PoliciesDynamic = dynamic<PoliciesFormProps>(
  () => import('@/components/team/policies').then((mod) => ({ default: mod.PoliciesForm })),
  { loading: () => <PoliciesFormSkeleton /> },
);
