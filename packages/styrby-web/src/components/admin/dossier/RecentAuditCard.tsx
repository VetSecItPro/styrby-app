/**
 * RecentAuditCard — Last N admin_audit_log rows targeting this user.
 *
 * Purpose:
 *   Shows the most recent admin actions taken against this user (last 10 rows).
 *   Each row surfaces: action, actor email, reason, and timestamp. This gives
 *   ops immediate context on what has been done to this account — e.g. "who
 *   set this manual override and why" or "was a password reset sent recently?".
 *
 * Auth model:
 *   Rendered inside `UserDossier` which is gated by the admin layout.
 *   Uses `createAdminClient()` (service role) to:
 *   1. Read admin_audit_log rows (site-admin-only table under RLS).
 *   2. Resolve actor_id → email by querying profiles for each unique actor.
 *   SOC 2 CC6.1.
 *
 * Query shape:
 *   `admin_audit_log` WHERE target_user_id = userId ORDER BY id DESC LIMIT 10
 *   Then a secondary query to resolve actor_id → profile.email for display.
 *
 * WHY secondary actor-email lookup:
 *   admin_audit_log stores actor_id (UUID) for referential integrity and to
 *   avoid email denormalization drift. We resolve emails in a second query
 *   (batched, not N+1) by collecting the unique actor IDs from the 10 rows and
 *   issuing a single IN(...) query against profiles.
 *
 * WHY independent Suspense fetch:
 *   Audit log + actor email resolution can be slower than the profile or
 *   subscription queries (BRIN index on created_at, actor join). Streaming this
 *   card independently means the fast cards (ProfileCard, SubscriptionCard)
 *   appear immediately. See UserDossier.tsx for the full Suspense rationale.
 *
 * @param userId - UUID of the user being viewed.
 */

import { createAdminClient } from '@/lib/supabase/server';
import { ScrollText, AlertTriangle } from 'lucide-react';
import { fmtDateTime } from './formatters';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single audit log row prepared for display. */
interface AuditRow {
  id: number;
  action: string;
  actor_email: string;
  reason: string;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a badge CSS class based on the action string.
 *
 * @param action - Audit log action string (e.g. 'override_tier', 'reset_password')
 */
function actionBadgeClass(action: string): string {
  if (action.startsWith('override')) return 'bg-orange-500/10 text-orange-400';
  if (action === 'reset_password') return 'bg-blue-500/10 text-blue-400';
  if (action.includes('consent')) return 'bg-purple-500/10 text-purple-400';
  if (action.includes('expired')) return 'bg-zinc-700/50 text-zinc-500';
  return 'bg-zinc-700/50 text-zinc-400';
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Server Component: fetches and renders the recent admin audit log for a user.
 *
 * @param userId - UUID of the user being viewed.
 */
export async function RecentAuditCard({ userId }: { userId: string }) {
  // WHY createAdminClient: admin_audit_log has an RLS policy that only allows
  // site admins to SELECT. We use service role so the query works without
  // requiring the calling request to prove site-admin status at the DB layer
  // again (the layout gate already did that). SOC 2 CC6.1.
  const adminDb = createAdminClient();

  // Step 1: Fetch the 10 most recent audit rows targeting this user.
  const { data: auditRows, error: auditError } = await adminDb
    .from('admin_audit_log')
    .select('id, action, actor_id, reason, created_at')
    .eq('target_user_id', userId)
    .order('id', { ascending: false })
    .limit(10);

  if (auditError) {
    // WHY explicit error state: an admin must be able to distinguish "DB query
    // failed" from "no audit entries for this user". Silent fallthrough to an
    // empty table hides ops-critical failures. SOC 2 CC7.2.
    console.error('[RecentAuditCard] failed to load data', auditError);
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4" data-testid="recent-audit-card-error">
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Failed to load audit log. Check audit logs or DB health.</span>
        </div>
      </div>
    );
  }

  const rows = auditRows ?? [];

  // Step 2: Batch-resolve actor emails.
  // WHY batch (not N+1): collecting unique actor IDs from up to 10 rows and
  // issuing a single IN(...) query is O(1) extra queries regardless of how many
  // rows are returned. An N+1 would issue up to 10 individual profile lookups,
  // 10x the round-trips. This is the standard "batch resolver" pattern.
  const uniqueActorIds = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))];

  let actorEmailMap: Record<string, string> = {};

  if (uniqueActorIds.length > 0) {
    const { data: actorProfiles, error: actorError } = await adminDb
      .from('profiles')
      .select('id, email')
      .in('id', uniqueActorIds as string[]);

    if (actorError) {
      console.error('[RecentAuditCard] actor profile lookup error:', actorError.message);
    }

    actorEmailMap = Object.fromEntries(
      (actorProfiles ?? []).map((p) => [p.id, p.email ?? p.id])
    );
  }

  // Step 3: Compose display rows.
  const displayRows: AuditRow[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor_email: actorEmailMap[r.actor_id] ?? r.actor_id ?? '(unknown)',
    reason: r.reason ?? '',
    created_at: r.created_at,
  }));

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5" data-testid="recent-audit-card">
      {/* Card header */}
      <div className="mb-4 flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Recent Admin Actions
        </h2>
        <span className="ml-auto text-xs text-zinc-400">{displayRows.length} row{displayRows.length !== 1 ? 's' : ''}</span>
      </div>

      {displayRows.length > 0 ? (
        <table className="w-full text-xs" aria-label="Recent admin audit log for this user">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="pb-2 text-left font-medium text-zinc-400">Action</th>
              <th className="pb-2 text-left font-medium text-zinc-400">Actor</th>
              <th className="pb-2 text-left font-medium text-zinc-400">Reason</th>
              <th className="pb-2 text-left font-medium text-zinc-400">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {displayRows.map((row) => (
              <tr key={row.id} data-testid="audit-row">
                <td className="py-2">
                  <span
                    className={`inline-flex rounded-full px-1.5 py-0.5 font-mono text-xs font-medium ${actionBadgeClass(row.action)}`}
                    data-testid="audit-action"
                  >
                    {row.action}
                  </span>
                </td>
                <td className="py-2 font-mono text-zinc-400" data-testid="audit-actor">
                  {/* WHY JSX text: actor email is user-supplied data; React escapes it.
                      No dangerouslySetInnerHTML — safe by default. */}
                  {row.actor_email}
                </td>
                <td
                  className="max-w-[180px] truncate py-2 text-zinc-500"
                  title={row.reason}
                  data-testid="audit-reason"
                >
                  {row.reason || '—'}
                </td>
                <td className="py-2 text-zinc-400" title={row.created_at}>
                  {fmtDateTime(row.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="no-audit-rows">
          No admin actions recorded for this user.
        </p>
      )}
    </div>
  );
}
