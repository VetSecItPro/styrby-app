/**
 * Admin Audit Log Page — `/dashboard/admin/audit`
 *
 * @route GET /dashboard/admin/audit
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — returns 404 for non-site-admins (deny-by-obscurity).
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins to /dashboard.
 *   This page assumes both gates have already passed. SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component orchestrator for the paginated admin audit log viewer.
 *   Shows the last 200 admin_audit_log rows in batches of 50, with cursor-based
 *   pagination. Includes a "Verify chain integrity" client button that calls
 *   the verify endpoint and displays PASS/FAIL inline.
 *
 * WHY createAdminClient() for all DB queries:
 *   admin_audit_log has RLS policies that allow only site admins to SELECT.
 *   We use service role to bypass RLS — the layout and middleware gates above
 *   have already confirmed the caller is a site admin.
 *   SOC 2 CC6.1: admin client used only after the access gate has passed.
 *
 * WHY cursor pagination (not offset):
 *   admin_audit_log can grow to millions of rows over time. OFFSET-based
 *   pagination performs a full index scan up to the offset — O(n) cost that
 *   grows with time. Keyset (cursor) pagination via `WHERE id < :cursor` uses
 *   the primary key index directly — O(log n) regardless of table size.
 *   For an ops tool used during incidents, predictable low-latency matters.
 *
 * WHY batch-resolve actor/target emails (not inline joins):
 *   admin_audit_log stores UUIDs (actor_id, target_user_id). Supabase JS does
 *   not support arbitrary JOINs in the client library. Batched `.in()` queries
 *   on profiles resolve N unique UUIDs in O(1) queries, identical to the
 *   N+1-avoidance pattern used in RecentAuditCard.
 *
 * WHY `ORDER BY id DESC` not `ORDER BY created_at DESC`:
 *   id is a serial primary key — it is strictly monotonic and has a B-tree index
 *   by definition. created_at is also indexed (BRIN) but BRIN is approximate —
 *   for high-insert-rate tables, rows with adjacent created_at values may have
 *   non-adjacent BRINs. Using id DESC gives deterministic ordering with the
 *   tightest possible index scan.
 *
 * @module app/dashboard/admin/audit/page
 */

import { createAdminClient } from '@/lib/supabase/server';
import { resolveAdminEmails } from '@/lib/admin/resolveEmails';
import { AuditLogTable } from '@/components/admin/AuditLogTable';
import { VerifyChainButton } from '@/components/admin/VerifyChainButton';
import { ScrollText } from 'lucide-react';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Number of rows per page.
 *
 * WHY 50: Dense ops table — 50 rows fits in one viewport on a 1080p monitor
 * without excessive scrolling. 200 rows is the "last 200" spec bound, and
 * 50 rows/page gives 4 pages of history. Matches spec §5.2 T7.
 */
const PAGE_SIZE = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditPageProps {
  searchParams: Promise<{ cursor?: string }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses and validates a cursor string from the URL query param.
 *
 * WHY parseInt with NaN guard: the cursor is user-controlled (URL param).
 * A non-numeric or negative value must not reach the DB query.
 * Returning null falls back to "first page" behavior (no WHERE clause).
 *
 * @param raw - Raw cursor string from ?cursor= param
 * @returns Positive integer cursor, or null if absent/invalid
 */
// Invalid or out-of-range cursors (NaN, negative, huge integers beyond the
// bigserial PK range) silently collapse to "first page" since the WHERE clause
// `id < :cursor` naturally returns the most recent rows for any cursor larger
// than the max id. No error leak.
// WHY exported: allows unit tests to exercise this function directly without
// rendering the full async Server Component. Tests verify URL-injection safety.
export function parseCursor(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  // WHY isNaN + positive check: negative IDs are invalid in a serial PK table.
  // Coercing negative cursors to null is safe (returns first page) rather than
  // passing them to the DB where they'd return 0 rows (confusing).
  if (isNaN(n) || n <= 0) return null;
  return n;
}

// ─── Page Component ───────────────────────────────────────────────────────────

/**
 * Async Server Component orchestrator for the admin audit log page.
 *
 * Fetches up to PAGE_SIZE audit rows starting from the cursor, resolves
 * actor and target emails, then renders the table and pagination.
 *
 * @param searchParams - Next.js search params (async in Next.js 15+)
 */
export default async function AdminAuditPage({ searchParams }: AuditPageProps) {
  const { cursor: cursorRaw } = await searchParams;
  const cursor = parseCursor(cursorRaw);

  // WHY createAdminClient(): admin_audit_log is RLS-protected (site-admin only).
  // Service role bypasses RLS; layout + middleware have already verified admin access.
  const adminDb = createAdminClient();

  // ── Step 1: Fetch PAGE_SIZE audit rows from cursor ─────────────────────────

  // Build the cursor-paginated query.
  // WHY `lt('id', cursor)` not `lte`: using strict less-than avoids re-showing
  // the last row of the previous page on the next page. The cursor IS the last
  // id seen — we want rows *before* it, not including it.
  let query = adminDb
    .from('admin_audit_log')
    .select('id, action, actor_id, target_user_id, reason, created_at, target_entity')
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);

  if (cursor !== null) {
    query = query.lt('id', cursor);
  }

  const { data: auditRows, error: auditError } = await query;

  if (auditError) {
    // WHY log + graceful degradation: a DB error here should not crash the admin
    // console. We render an error card so ops can see the issue without a 500.
    // Sentry global handler captures the error. SOC 2 CC7.2.
    console.error('[AdminAuditPage] audit_log query error:', auditError.message);
    return (
      <div className="space-y-6" data-testid="audit-page-error">
        <h1 className="text-lg font-semibold text-zinc-100">Audit Log</h1>
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
          <p className="text-sm text-red-400">
            Failed to load audit log. Check server logs for details.
          </p>
        </div>
      </div>
    );
  }

  const rows = auditRows ?? [];

  // ── Step 2: Batch-resolve actor_id and target_user_id → emails ──────────────

  // Collect unique UUIDs that need email resolution.
  // WHY deduplicate: the same admin may appear as actor many times in 50 rows.
  // Collecting unique IDs reduces the profiles lookup from O(n) to O(unique actors).
  const uniqueActorIds = [...new Set(rows.map((r) => r.actor_id).filter(Boolean) as string[])];
  const uniqueTargetIds = [
    ...new Set(rows.map((r) => r.target_user_id).filter(Boolean) as string[]),
  ];
  const allUniqueIds = [...new Set([...uniqueActorIds, ...uniqueTargetIds])];

  let emailMap: Record<string, string> = {};

  if (allUniqueIds.length > 0) {
    // WHY resolveAdminEmails (not profiles.email): profiles has no email column.
    // auth.users.email is only reachable via the resolve_user_emails_for_admin
    // SECURITY DEFINER RPC (migration 043). See lib/admin/resolveEmails.ts.
    //
    // WHY single RPC call for combined actor+target IDs: fetching both actor
    // and target emails in one round-trip halves DB latency vs. two separate
    // queries. N+1-avoidance: one RPC resolves up to 100 unique UUIDs
    // (50 actors + 50 targets per page). SOC 2 CC6.1.
    emailMap = await resolveAdminEmails(adminDb, allUniqueIds);
  }

  // ── Step 3: Compose display rows ───────────────────────────────────────────

  const displayRows = rows.map((r) => ({
    id: r.id as number,
    action: r.action as string,
    // WHY UUID fallback: if the actor's profile is deleted or was never created
    // (e.g. bootstrap admin), show the UUID rather than '(unknown)'. The UUID
    // is still actionable for ops (can cross-reference auth.users). Spec §T7 UX.
    actor_email: emailMap[r.actor_id as string] ?? (r.actor_id as string) ?? '(unknown)',
    // WHY null for non-user-targeted: target_user_id is null for system events
    // or actions targeting non-user entities (e.g. session expiry).
    target_email: r.target_user_id
      ? (emailMap[r.target_user_id as string] ?? (r.target_user_id as string))
      : null,
    reason: (r.reason as string | null) ?? null,
    created_at: r.created_at as string,
    target_entity: (r.target_entity as string | null) ?? null,
  }));

  // ── Step 4: Compute next cursor ────────────────────────────────────────────

  // The next cursor is the id of the LAST row on this page (lowest id, since
  // we ORDER BY id DESC). Passing it as `?cursor=N` to the next page gives
  // `WHERE id < N` — the continuation of the keyset scan.
  //
  // WHY null when rows < PAGE_SIZE: fewer than 50 rows means this is the last
  // page. No "Next" link needed. Prevents a spurious empty page.
  const nextCursor: number | null =
    rows.length === PAGE_SIZE ? (rows[rows.length - 1].id as number) : null;

  // ── Step 5: Render ─────────────────────────────────────────────────────────

  return (
    <div className="space-y-6" data-testid="audit-page">
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-zinc-400" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-zinc-100">Audit Log</h1>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
            {rows.length} rows
          </span>
        </div>

        {/* Verify chain integrity — client island (interactive button + inline result) */}
        <VerifyChainButton />
      </div>

      {/* Audit log table with cursor pagination */}
      <AuditLogTable rows={displayRows} nextCursor={nextCursor} />
    </div>
  );
}
