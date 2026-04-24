/**
 * AuditLogTable — Server Component rendering the paginated admin audit log.
 *
 * Purpose:
 *   Displays a dense, chronologically-descending table of admin_audit_log rows.
 *   Each row shows: id, action (color-coded badge), actor email (or UUID fallback),
 *   target email (or UUID fallback, or "—" for non-user-targeted actions), reason,
 *   and absolute timestamp.
 *
 * Auth model:
 *   Rendered only inside `/dashboard/admin/audit/page.tsx`, which is protected by:
 *   1. `src/middleware.ts` — non-site-admins receive 404 before the page renders.
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins to /dashboard.
 *   Data passed in via props was fetched by the parent Server Component using
 *   `createAdminClient()` (service role — bypasses RLS for cross-user audit data).
 *   This component is purely presentational.
 *   SOC 2 CC6.1: authorization enforced at layout/middleware, not per component.
 *   SOC 2 CC7.2: Audit log data rendered via React JSX text nodes — no HTML
 *   injection risk. Actor/target emails are user-supplied strings; React escapes them.
 *
 * WHY server component (no "use client"):
 *   No interactivity needed in the table itself — no state, no event handlers.
 *   Zero client JS for the table. Pagination uses plain Next.js <Link> components.
 *
 * @module components/admin/AuditLogTable
 */

import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single admin audit log row prepared for display.
 *
 * WHY actor_email / target_email instead of raw UUIDs:
 *   The audit log stores actor_id and target_user_id as UUIDs for referential
 *   integrity. The parent page resolves them to emails for display via a batched
 *   profiles lookup (N+1-safe). UUID fallback is retained here for the case where
 *   a profile row is missing (deleted account, bootstrap admin).
 */
export interface AuditLogRow {
  /** Audit log row primary key (ascending integer). */
  id: number;
  /** Action performed (e.g. 'override_tier', 'reset_password', 'toggle_consent'). */
  action: string;
  /**
   * Resolved email for the admin who performed the action.
   * Falls back to the raw actor_id UUID if the profile lookup misses.
   */
  actor_email: string;
  /**
   * Resolved email for the user targeted by the action.
   * null/undefined for non-user-targeted actions (e.g. system events).
   */
  target_email: string | null;
  /** Admin-supplied reason string captured at action time. */
  reason: string | null;
  /** ISO 8601 timestamp when the action was recorded. */
  created_at: string;
  /**
   * Target entity type for non-user-targeted actions (e.g. 'session', 'team').
   * null for user-targeted actions.
   */
  target_entity: string | null;
}

export interface AuditLogTableProps {
  rows: AuditLogRow[];
  /** Cursor value for the "Next" page link (last id on this page). null = last page. */
  nextCursor: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns Tailwind CSS classes for the action badge based on the action string.
 *
 * WHY color coding:
 *   Ops needs to rapidly scan a high-volume audit log. Color coding by action
 *   category enables instant pattern recognition (e.g. "lots of orange = manual
 *   overrides happening") without reading each row. Matches the RecentAuditCard
 *   color scheme for visual consistency across the admin console.
 *
 * @param action - Audit log action string
 * @returns Tailwind CSS class string for the badge
 */
function actionBadgeClass(action: string): string {
  if (action.startsWith('override')) return 'bg-orange-500/10 text-orange-400';
  if (action === 'reset_password') return 'bg-blue-500/10 text-blue-400';
  if (action.includes('consent')) return 'bg-purple-500/10 text-purple-400';
  if (action.includes('expired')) return 'bg-zinc-700/50 text-zinc-500';
  return 'bg-zinc-700/50 text-zinc-400';
}

/**
 * Formats an ISO 8601 timestamp as a human-readable absolute date-time string.
 *
 * WHY absolute (not relative): The audit log is an ops/compliance tool. Relative
 * times ("3 hours ago") become ambiguous in historical reviews and audit exports.
 * Absolute timestamps are unambiguous and audit-ready. SOC 2 CC7.2.
 *
 * @param iso - ISO 8601 timestamp string
 * @returns Formatted string, "—" for null/empty, "Unknown" for unparseable
 */
function fmtAuditTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Paginated admin audit log table (server-rendered, no JS on the client).
 *
 * Pagination approach (spec §5.2 T7):
 *   - Cursor-based (keyset pagination) by primary key id DESC.
 *   - "Next" link passes `?cursor=<last-id-on-page>`.
 *   - "Prev" is browser back (keyset pagination is forward-only by design).
 *   - If nextCursor is null, this is the last page — no "Next" link is shown.
 *
 * @param rows      - Up to 50 audit rows from the cursor-paginated query.
 * @param nextCursor - Lowest id on this page, passed as cursor for the next page.
 *                     null when there are no more pages.
 */
export function AuditLogTable({ rows, nextCursor }: AuditLogTableProps) {
  // ── Empty state ──────────────────────────────────────────────────────────

  if (rows.length === 0) {
    return (
      <div className="py-16 text-center" data-testid="audit-log-empty">
        <p className="text-sm text-zinc-500">No admin audit log entries found.</p>
      </div>
    );
  }

  // ── Results table ────────────────────────────────────────────────────────

  return (
    <div data-testid="audit-log-table">
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        {/* WHY aria-label: screen readers need context to announce the table purpose.
            Without it, assistive tech announces "table" with no further context.
            Consistent with UserListTable and RecentAuditCard patterns. */}
        <table className="w-full text-sm" aria-label="Admin audit log">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50">
              <th className="px-4 py-3 text-left font-medium text-zinc-400">ID</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-400">Action</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-400">Actor</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-400">Target</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-400">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-400">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.map((row) => (
              <tr
                key={row.id}
                className="transition-colors hover:bg-zinc-800/50"
                data-testid="audit-log-row"
              >
                {/* ID column — monotonically increasing, useful for range queries */}
                <td className="px-4 py-3 font-mono text-xs text-zinc-500">{row.id}</td>

                {/* Action badge */}
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 font-mono text-xs font-medium ${actionBadgeClass(row.action)}`}
                    data-testid="audit-action-badge"
                  >
                    {/* WHY JSX text: action is from DB enum — no HTML injection risk.
                        React escapes string children regardless. */}
                    {row.action}
                  </span>
                </td>

                {/* Actor email — falls back to UUID if profile is missing */}
                <td className="px-4 py-3" data-testid="audit-actor">
                  {/* WHY font-mono: email/UUID are monospace by convention in ops
                      tools — makes column alignment readable at a glance. */}
                  <span className="font-mono text-xs text-zinc-300">
                    {/* WHY JSX text node: actor_email is user-supplied data.
                        React escapes it — safe by construction. No dangerouslySetInnerHTML.
                        SOC 2 CC7.2: audit data rendered without HTML injection risk. */}
                    {row.actor_email}
                  </span>
                </td>

                {/* Target email — shows "—" for system/non-user-targeted actions */}
                <td className="px-4 py-3" data-testid="audit-target">
                  <span className="font-mono text-xs text-zinc-300">
                    {/* WHY JSX text node: same rationale as actor_email above. */}
                    {row.target_email ?? (row.target_entity ?? '—')}
                  </span>
                </td>

                {/* Reason — truncated with full text in title tooltip */}
                <td
                  className="max-w-[200px] truncate px-4 py-3 text-xs text-zinc-400"
                  title={row.reason ?? undefined}
                  data-testid="audit-reason"
                >
                  {row.reason || '—'}
                </td>

                {/* Absolute timestamp */}
                <td
                  className="whitespace-nowrap px-4 py-3 text-xs text-zinc-400"
                  title={row.created_at}
                >
                  {fmtAuditTime(row.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination controls */}
      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-zinc-500">
          {rows.length} row{rows.length !== 1 ? 's' : ''} on this page
        </p>

        <div className="flex gap-2">
          {/* WHY no "Previous" link: cursor-based pagination is forward-only.
              Browser back button navigates to the prior cursor correctly
              because each page is a distinct URL (?cursor=N). This is the
              standard keyset pagination UX for high-volume ops tables. */}

          {/* Next page — shown when more rows exist (nextCursor is non-null) */}
          {nextCursor !== null && (
            <Link
              href={`/dashboard/admin/audit?cursor=${nextCursor}`}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
              data-testid="audit-next-page-link"
            >
              Next
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
