/**
 * SessionsCard — Session count + recent session list sub-card.
 *
 * Purpose:
 *   Shows how active this user is: a count of sessions in the last 30 days
 *   plus the 5 most recent sessions (id, agent_type, started_at, cost, status).
 *   Helps ops gauge engagement and debug billing questions like "why is
 *   this user's cost so high this month?".
 *
 * Auth model:
 *   Rendered inside `UserDossier` which is gated by the admin layout.
 *   Uses `createAdminClient()` (service role) to bypass RLS on `sessions`.
 *   SOC 2 CC6.1.
 *
 * Query shape:
 *   - COUNT of sessions WHERE user_id = userId AND started_at >= 30 days ago
 *   - SELECT 5 most recent sessions (id, agent_type, started_at,
 *     token_cost_usd, status) ORDER BY started_at DESC LIMIT 5
 *
 * WHY independent Suspense fetch:
 *   Sessions queries can be slow on large tables (BRIN index on started_at).
 *   Suspense isolation means ProfileCard and SubscriptionCard render instantly
 *   while this card streams in separately. See UserDossier.tsx for the full
 *   Suspense parallelism rationale.
 *
 * WHY two queries instead of one:
 *   A COUNT + LIMIT 5 in a single query would require a CTE or subquery that's
 *   harder to read and no faster (Postgres would still scan both ranges). Two
 *   simple queries issued in parallel via Promise.all are cleaner and
 *   semantically clearer.
 *
 * @param userId - UUID of the user being viewed.
 */

import { createAdminClient } from '@/lib/supabase/server';
import { Terminal, AlertTriangle } from 'lucide-react';
import { fmtDateTime, fmtCost } from './formatters';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A recent session row for display. */
interface RecentSession {
  id: string;
  agent_type: string | null;
  started_at: string | null;
  token_cost_usd: number | null;
  status: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a status badge CSS class based on the session status string.
 *
 * @param status - Session status (e.g. 'active', 'ended', 'error')
 */
function statusBadgeClass(status: string | null): string {
  const map: Record<string, string> = {
    active: 'bg-green-500/10 text-green-400',
    ended: 'bg-zinc-700/50 text-zinc-400',
    error: 'bg-red-500/10 text-red-400',
    paused: 'bg-yellow-500/10 text-yellow-400',
  };
  return map[status ?? ''] ?? 'bg-zinc-700/50 text-zinc-400';
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Server Component: fetches and renders session summary for a user.
 *
 * @param userId - UUID of the user being viewed.
 */
export async function SessionsCard({ userId }: { userId: string }) {
  // WHY createAdminClient: sessions are user-scoped under RLS. The service-role
  // client allows the admin to read any user's sessions. SOC 2 CC6.1.
  const adminDb = createAdminClient();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // WHY Promise.all: count + recent list are independent queries. Running them
  // in parallel halves the latency vs. sequential awaits.
  const [countResult, recentResult] = await Promise.all([
    adminDb
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('started_at', thirtyDaysAgo),

    adminDb
      .from('sessions')
      .select('id, agent_type, started_at, token_cost_usd, status')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(5),
  ]);

  // WHY explicit error state: an admin must be able to distinguish "DB query
  // failed" from "user has no sessions" — the silent fallthrough to empty state
  // hides ops-critical failures. If either query errors we surface it immediately.
  // SOC 2 CC7.2.
  if (countResult.error || recentResult.error) {
    const err = countResult.error ?? recentResult.error;
    console.error('[SessionsCard] failed to load data', err);
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4" data-testid="sessions-card-error">
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Failed to load sessions. Check audit logs or DB health.</span>
        </div>
      </div>
    );
  }

  const sessionCount30d = countResult.count ?? 0;
  const recentSessions: RecentSession[] = (recentResult.data ?? []).map((row) => ({
    id: row.id,
    agent_type: row.agent_type,
    started_at: row.started_at,
    token_cost_usd: row.token_cost_usd,
    status: row.status,
  }));

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5" data-testid="sessions-card">
      {/* Card header */}
      <div className="mb-4 flex items-center gap-2">
        <Terminal className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Sessions</h2>
        <span className="ml-auto text-xs text-zinc-500">
          <span className="font-semibold text-zinc-100" data-testid="session-count-30d">
            {sessionCount30d}
          </span>{' '}
          in last 30 days
        </span>
      </div>

      {recentSessions.length > 0 ? (
        <table className="w-full text-xs" aria-label="Recent sessions for this user">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="pb-2 text-left font-medium text-zinc-400">Session ID</th>
              <th className="pb-2 text-left font-medium text-zinc-400">Agent</th>
              <th className="pb-2 text-left font-medium text-zinc-400">Started</th>
              <th className="pb-2 text-right font-medium text-zinc-400">Cost</th>
              <th className="pb-2 text-left font-medium text-zinc-400">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {recentSessions.map((s) => (
              <tr key={s.id} data-testid="session-row">
                <td className="py-2 font-mono text-zinc-500" title={s.id}>
                  {/* WHY truncate: UUIDs are 36 chars — showing all in a dense table
                      breaks layout. Last 8 chars identify the row adequately for ops. */}
                  {s.id.slice(-8)}
                </td>
                <td className="py-2 text-zinc-300">{s.agent_type ?? '—'}</td>
                <td className="py-2 text-zinc-500" title={s.started_at ?? ''}>
                  {fmtDateTime(s.started_at)}
                </td>
                <td className="py-2 text-right font-mono text-zinc-300">
                  {fmtCost(s.token_cost_usd)}
                </td>
                <td className="py-2">
                  <span
                    className={`inline-flex rounded-full px-1.5 py-0.5 text-xs font-medium ${statusBadgeClass(s.status)}`}
                    data-testid="session-status"
                  >
                    {s.status ?? 'unknown'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="no-sessions">
          No sessions found.
        </p>
      )}
    </div>
  );
}
