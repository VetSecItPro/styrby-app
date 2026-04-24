/**
 * UserListTable — Server Component displaying paginated admin user search results.
 *
 * Purpose:
 *   Renders a dense table of matching users (email, tier, joined date, action link).
 *   Handles: populated results, empty state, and pagination controls.
 *
 * Auth model:
 *   Rendered only inside `/dashboard/admin/layout.tsx`, which gates access via
 *   `is_site_admin()` RPC before this component ever runs. Data passed in via
 *   props was fetched by the parent Server Component using `createAdminClient()`
 *   (service role — bypasses RLS). This component is purely presentational.
 *   SOC 2 CC6.1: authorization enforced at layout/middleware, not per component.
 *
 * WHY server component (no "use client"):
 *   This component only renders — no interactivity, no state, no event handlers.
 *   Keeping it a Server Component ensures zero client JS is added for the table
 *   itself. Pagination links are plain Next.js <Link> components that navigate
 *   to new server-rendered URLs.
 */

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single user row as returned by the admin search query.
 *
 * WHY `tier` from subscriptions join: The subscriptions table is the canonical
 * source of tier state (synced from Polar). We join it here to show the admin
 * the live tier, not a stale denormalized value from profiles.
 *
 * WHY `override_source` carried along: We display a small "manual" badge when
 * `override_source = 'manual'` so the admin has operational awareness that this
 * user's tier was hand-set and will NOT be overwritten by the next Polar webhook.
 * See migration 040 and spec §4 (Polar webhook tier-override honor).
 */
export interface AdminUserRow {
  id: string;
  email: string;
  created_at: string;
  tier: string | null;
  override_source: string | null;
}

export interface UserListTableProps {
  rows: AdminUserRow[];
  query: string;
  page: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a human-readable relative time string.
 *
 * @param dateStr - ISO 8601 date string
 * @returns Relative time (e.g. "3 days ago", "2 months ago")
 */
function getRelativeTime(dateStr: string): string {
  // WHY guard: created_at from Supabase is typically non-null, but defensive
  // handling prevents a NaN cascade if the field is empty or malformed.
  // An 'Unknown' fallback is safer than rendering "NaN days ago". T4 #4.
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return 'Unknown';

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return '1 day ago';
  if (diffDays < 30) return `${diffDays} days ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths === 1) return '1 month ago';
  if (diffMonths < 12) return `${diffMonths} months ago`;
  const diffYears = Math.floor(diffMonths / 12);
  return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`;
}

/**
 * Renders a tier badge with appropriate color coding.
 *
 * @param tier - The subscription tier string (e.g. 'free', 'power', 'team')
 * @param overrideSource - If 'manual', appends a "manual" badge for ops awareness
 */
function TierBadge({
  tier,
  overrideSource,
}: {
  tier: string | null;
  overrideSource: string | null;
}) {
  const tierLabel = tier ?? 'unknown';

  // WHY color map: at a glance, ops needs to distinguish paying vs free users.
  const colorMap: Record<string, string> = {
    free: 'bg-zinc-700/50 text-zinc-400',
    pro: 'bg-blue-500/10 text-blue-400',
    power: 'bg-amber-500/10 text-amber-400',
    team: 'bg-purple-500/10 text-purple-400',
    business: 'bg-green-500/10 text-green-400',
    enterprise: 'bg-red-500/10 text-red-400',
  };

  const badgeClass = colorMap[tierLabel] ?? 'bg-zinc-700/50 text-zinc-400';

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}
      >
        {tierLabel}
      </span>
      {overrideSource === 'manual' && (
        /* WHY: A manual override means the Polar webhook will NOT overwrite this
           tier (see spec §4). Surfacing it here prevents the admin from being
           confused by a tier that doesn't match Polar's subscription state. */
        <span className="inline-flex items-center rounded-full bg-orange-500/10 px-1.5 py-0.5 text-xs font-medium text-orange-400">
          manual
        </span>
      )}
    </span>
  );
}

// ─── Pagination helpers ───────────────────────────────────────────────────────

/**
 * Builds the URL for a given page number, preserving the current query param.
 *
 * @param query - The current search query
 * @param page - Target page number (1-indexed)
 */
function pageUrl(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return `/dashboard/admin${qs ? `?${qs}` : ''}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Paginated user results table (server-rendered, no JS on the client).
 *
 * Pagination approach (spec §):
 *   - No total count query (expensive on the profiles table at scale).
 *   - "Next page" is disabled/hidden when fewer than 20 rows are returned,
 *     because that means this is the last page.
 *   - URL params `?q=` and `?page=` are the canonical state.
 *
 * @param rows - Up to 20 user rows from the admin query
 * @param query - Current search query (used to build pagination URLs)
 * @param page - Current 1-indexed page number
 */
export function UserListTable({ rows, query, page }: UserListTableProps) {
  // WHY 20: spec mandates LIMIT 20 OFFSET N*20. If fewer than 20 rows came
  // back, this is definitionally the last page — no need for a total count.
  const isLastPage = rows.length < 20;

  // ── Empty state ──────────────────────────────────────────────────────────

  if (rows.length === 0) {
    return (
      <div className="py-16 text-center" data-testid="user-list-empty">
        <p className="text-sm text-zinc-500">
          {query
            // WHY truncate: an adversary (or accidental paste) could supply a very
            // long query string. Reflecting it verbatim risks layout break and a
            // vector for UI confusion. 60 chars is enough to be recognizable. T4 #3.
            ? `No users found matching "${query.length > 60 ? query.slice(0, 60) + '…' : query}".`
            : 'Enter an email to search for users.'}
        </p>
      </div>
    );
  }

  // ── Results table ────────────────────────────────────────────────────────

  return (
    <div data-testid="user-list-table">
      {/* Desktop table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        {/* WHY aria-label: screen readers need context to announce the table purpose.
            Without it, assistive tech announces "table" with no further context.
            T4 #2 accessibility fix. */}
        <table className="w-full text-sm" aria-label="User search results">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50">
              <th className="px-4 py-3 text-left font-medium text-zinc-400">Email</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-400">Tier</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-400">Joined</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-400">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.map((user) => (
              <tr
                key={user.id}
                className="transition-colors hover:bg-zinc-800/50"
                data-testid="user-row"
              >
                <td className="px-4 py-3">
                  <span className="font-mono text-sm text-zinc-100">{user.email}</span>
                </td>
                <td className="px-4 py-3">
                  <TierBadge tier={user.tier} overrideSource={user.override_source} />
                </td>
                <td className="px-4 py-3 text-xs text-zinc-500" title={user.created_at}>
                  {getRelativeTime(user.created_at)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/dashboard/admin/users/${user.id}`}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                    aria-label={`View dossier for ${user.email}`}
                  >
                    View
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination controls */}
      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-zinc-500">
          {rows.length} result{rows.length !== 1 ? 's' : ''} on this page
        </p>

        <div className="flex gap-2">
          {/* Previous page — only shown when we're past page 1 */}
          {page > 1 && (
            <Link
              href={pageUrl(query, page - 1)}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
              data-testid="prev-page-link"
            >
              Previous
            </Link>
          )}

          <span className="inline-flex items-center rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400">
            Page {page}
          </span>

          {/* Next page — hidden when fewer than 20 rows (last page) */}
          {!isLastPage && (
            <Link
              href={pageUrl(query, page + 1)}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
              data-testid="next-page-link"
            >
              Next
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
