'use client';

/**
 * UserSearchForm — client component for the admin user list page.
 *
 * Purpose:
 *   Renders a single search input and submit button that navigate to
 *   `/dashboard/admin?q=<query>&page=1`. The URL is the canonical state
 *   owner — the server page reads `q` from searchParams and performs the
 *   database query server-side, which means this component has zero client-side
 *   data fetching and adds no Supabase client bundle to the browser chunk.
 *
 * Auth model:
 *   This component is rendered only inside the admin layout
 *   (`/dashboard/admin/layout.tsx`), which gates access via `is_site_admin()`
 *   RPC. The form itself is purely presentational — no auth checks here.
 *   SOC 2 CC6.1: authorization is enforced at the layout boundary and
 *   middleware layer, not re-checked per component.
 *
 * WHY "use client":
 *   The form uses `useRouter` + `useSearchParams` to read the current query
 *   and submit without a full page reload. This is the minimal amount of
 *   client-side interactivity required; no heavy deps are added.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useRef } from 'react';
import { Search } from 'lucide-react';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface UserSearchFormProps {
  /** Current query string value to pre-fill the input */
  defaultValue?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Search input that navigates to `?q=<value>&page=1` on submit.
 *
 * WHY URL-driven: Server Components cannot hold search state in React state.
 * The URL is the single source of truth — bookmarkable, shareable, and
 * compatible with the Next.js App Router server rendering model.
 *
 * @param defaultValue - Pre-fills the input with the current `?q=` value
 *   so the user can edit an in-flight search without retyping.
 */
export function UserSearchForm({ defaultValue = '' }: UserSearchFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Handles form submit: reads the input value, builds new search params,
   * and pushes to the router. Always resets to page 1 on a new query.
   */
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = inputRef.current?.value.trim() ?? '';
    const params = new URLSearchParams(searchParams.toString());

    if (q) {
      params.set('q', q);
    } else {
      params.delete('q');
    }

    // Always reset to page 1 when the query changes — prevents showing page 3
    // of results after navigating back and submitting a new search.
    params.delete('page');

    const qs = params.toString();
    router.push(`/dashboard/admin${qs ? `?${qs}` : ''}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2" role="search" aria-label="Search users">
      <div className="relative flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="search"
          name="q"
          defaultValue={defaultValue}
          placeholder="Search by email..."
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
          aria-label="Email search query"
        />
      </div>
      <button
        type="submit"
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 active:bg-zinc-600"
      >
        Search
      </button>
    </form>
  );
}
