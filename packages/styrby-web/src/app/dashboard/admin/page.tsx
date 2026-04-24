/**
 * Admin User List Page — `/dashboard/admin`
 *
 * @route GET /dashboard/admin
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — returns 404 for non-site-admins (deny-by-obscurity)
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins to /dashboard
 *   This page assumes both gates have already passed. SOC 2 CC6.1.
 *
 * Purpose:
 *   Allows a site admin to search for users by email (case-insensitive) and
 *   navigate to a user's full dossier at `/dashboard/admin/users/[userId]`.
 *   Pagination is URL-driven: `?q=<query>&page=<n>` — no client state needed.
 *
 * WHY Server Component:
 *   All data fetching happens server-side (Postgres query), so there is no need
 *   for a client-side Supabase call. The only client component on this page is
 *   `UserSearchForm`, which needs `useRouter`/`useSearchParams` for form submit
 *   without a full page reload. Everything else is server-rendered, keeping the
 *   client bundle impact near zero.
 *
 * WHY createAdminClient() for the DB query:
 *   The admin is querying OTHER users' `profiles` rows. If we used the
 *   user-scoped `createClient()`, Postgres RLS would filter the results to only
 *   rows matching `auth.uid()` — effectively returning only the admin's own row.
 *   The service-role client bypasses RLS so the admin can see all matching users.
 *   This is intentional and correct for an admin surface.
 *   SOC 2 CC6.1: the admin client is used only after the layout gate confirms
 *   the caller is a site admin — never exposed to ordinary users.
 *
 * Query design:
 *   - ILIKE '%query%' — case-insensitive substring match on email.
 *   - A trigram index on `profiles.email` already exists (migration 003/004/005
 *     range) — no new index is added in T4 per spec instructions.
 *   - JOIN to `subscriptions` for live tier data.
 *   - LIMIT 20 OFFSET (page-1)*20 — avoids a COUNT(*) scan for total rows;
 *     "no next page" is inferred from receiving fewer than 20 rows.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowLeft, Users } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/server';
import { UserSearchForm } from '@/components/admin/UserSearchForm';
import { UserListTable, type AdminUserRow } from '@/components/admin/UserListTable';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Escapes ILIKE metacharacters so a search string is treated as a literal.
 *
 * WHY: Without escaping, a query like "%" matches all rows (full-table scan),
 * which is both a cost-risk (unbounded result) and a data enumeration vector.
 * Even though the admin is a trusted actor, defense-in-depth matters here.
 * Supabase PostgREST passes the escape character to Postgres ILIKE correctly
 * when the `\` escape prefix is used. See quality review T4 #1.
 *
 * Characters escaped: `%` (any-string wildcard), `_` (single-char wildcard),
 * and `\` (the escape character itself).
 *
 * @param s - Raw search string from user input
 * @returns String safe to embed inside `%...%` ILIKE pattern
 */
function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminPageProps {
  searchParams: Promise<{
    q?: string;
    page?: string;
  }>;
}

// ─── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetches a page of users whose email matches the given query.
 *
 * @param query - Raw string from `?q=`. Empty string returns no results
 *   (we require a query to avoid listing all users, which would be expensive).
 * @param page - 1-indexed page number; defaults to 1.
 * @returns An array of up to 20 `AdminUserRow` objects.
 *
 * WHY createAdminClient() here (service role):
 *   Querying other users' rows requires bypassing RLS. The admin gate
 *   (layout + middleware) has already confirmed the caller is a site admin
 *   before this function is ever invoked. NIST SP 800-53 AC-3 / SOC 2 CC6.1.
 *
 * WHY no total count:
 *   A COUNT(*) on the full profiles table (potentially millions of rows) is
 *   expensive and slow. We infer "last page" by checking if fewer than 20 rows
 *   were returned, which is exact and O(0) extra cost.
 */
async function fetchAdminUsers(query: string, page: number): Promise<AdminUserRow[]> {
  if (!query.trim()) {
    // WHY: Require at least some search string. Returning all users by default
    // is expensive and likely unintentional. Admin must opt-in by typing.
    return [];
  }

  // WHY createAdminClient (service role): RLS on profiles table filters rows to
  // auth.uid(). The user-scoped client would only return the admin's own row.
  // Service role bypasses RLS so we can query any user's profile.
  const adminDb = createAdminClient();

  const PAGE_SIZE = 20;
  const offset = (page - 1) * PAGE_SIZE;

  // WHY ILIKE with % wildcards: case-insensitive substring match so admins can
  // search by partial email (e.g. "gmail" finds all Gmail users, "alice" finds
  // alice@example.com). The trigram GIN index on profiles.email (migration
  // 003/004/005 range) makes this fast even on large tables.
  const { data, error } = await adminDb
    .from('profiles')
    .select(
      `
      id,
      email,
      created_at,
      subscriptions!left (
        tier,
        override_source
      )
    `
    )
    .ilike('email', `%${escapeIlike(query.trim())}%`)
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (error) {
    // WHY log, don't throw: an admin query error should surface as an empty
    // result with a visible error state, not a 500 that reveals internals.
    // The admin can retry. Sentry captures the error via the global handler.
    console.error('[admin/page] fetchAdminUsers error:', error.message);
    return [];
  }

  // Flatten the subscriptions join (left join returns array or null).
  return (data ?? []).map((row) => {
    const sub = Array.isArray(row.subscriptions)
      ? row.subscriptions[0]
      : row.subscriptions;

    return {
      id: row.id,
      email: row.email ?? '',
      created_at: row.created_at ?? '',
      tier: sub?.tier ?? null,
      override_source: sub?.override_source ?? null,
    };
  });
}

// ─── Page Component ───────────────────────────────────────────────────────────

/**
 * Admin user search + list page.
 *
 * URL is the single state owner:
 *   - `?q=<email fragment>` — search query
 *   - `?page=<n>` — 1-indexed page number (omitted for page 1)
 *
 * The UserSearchForm (client component) submits to the same URL, which triggers
 * a server re-render with the new searchParams. No client state, no useEffect,
 * no client-side Supabase calls.
 *
 * @param searchParams - Next.js App Router search params (async in Next 15+)
 */
export default async function AdminUsersPage({ searchParams }: AdminPageProps) {
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);

  const rows = await fetchAdminUsers(query, page);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="mb-4 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="h-6 w-6 text-zinc-400" aria-hidden="true" />
            <div>
              <h1 className="text-2xl font-bold text-foreground">Users</h1>
              <p className="mt-0.5 text-sm text-zinc-400">Search by email to find a user</p>
            </div>
          </div>

          {/* Quick nav to other admin sections */}
          <div className="flex gap-2">
            <Link
              href="/dashboard/admin/support"
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
            >
              Support
            </Link>
            <Link
              href="/dashboard/admin/audit"
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
            >
              Audit log
            </Link>
          </div>
        </div>
      </div>

      {/* Search form — wrapped in Suspense because it uses useSearchParams */}
      <div className="mb-6" data-testid="search-form-container">
        <Suspense
          fallback={
            <div className="h-10 animate-pulse rounded-lg bg-zinc-800" aria-hidden="true" />
          }
        >
          <UserSearchForm defaultValue={query} />
        </Suspense>
      </div>

      {/* Results */}
      <UserListTable rows={rows} query={query} page={page} />
    </div>
  );
}
