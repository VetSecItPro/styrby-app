/**
 * TeamsCard — Team memberships + roles sub-card for the admin dossier.
 *
 * Purpose:
 *   Shows all teams this user belongs to and their role within each team.
 *   Useful for ops when diagnosing billing, seat-count, or permission issues
 *   that involve team plans.
 *
 * Auth model:
 *   Rendered inside `UserDossier` which is gated by the admin layout.
 *   Uses `createAdminClient()` (service role) to bypass RLS on `team_members`
 *   and `teams`. SOC 2 CC6.1.
 *
 * Query shape:
 *   `team_members` WHERE user_id = userId, JOIN `teams` ON team_id:
 *   team name, role, joined_at.
 *
 * WHY independent Suspense fetch:
 *   TeamsCard streams independently — a slow audit query never delays the
 *   admin from seeing team membership. See UserDossier.tsx for the full
 *   Suspense parallelism rationale.
 *
 * @param userId - UUID of the user being viewed.
 */

import { createAdminClient } from '@/lib/supabase/server';
import { Users, AlertTriangle } from 'lucide-react';
import { fmtDate } from './formatters';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single membership row after the join. */
interface TeamMembership {
  team_id: string;
  team_name: string;
  role: string;
  joined_at: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a role badge CSS class based on the role string.
 *
 * @param role - Team role (e.g. 'owner', 'admin', 'member')
 */
function roleBadgeClass(role: string): string {
  const map: Record<string, string> = {
    owner: 'bg-amber-500/10 text-amber-400',
    admin: 'bg-blue-500/10 text-blue-400',
    member: 'bg-zinc-700/50 text-zinc-400',
  };
  return map[role] ?? 'bg-zinc-700/50 text-zinc-400';
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Server Component: fetches and renders team memberships for a user.
 *
 * @param userId - UUID of the user being viewed.
 */
export async function TeamsCard({ userId }: { userId: string }) {
  // WHY createAdminClient: team_members + teams are scoped by team ownership
  // under RLS — the admin's own session wouldn't return target user's rows.
  // Service role bypasses RLS. SOC 2 CC6.1.
  const adminDb = createAdminClient();

  const { data, error } = await adminDb
    .from('team_members')
    .select(
      `
      team_id,
      role,
      created_at,
      teams!inner (
        name
      )
    `
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    // WHY explicit error state: an admin must be able to distinguish "query failed"
    // from "user has no teams" — the silent fallthrough to an empty list hides
    // DB failures and is ops-dangerous. SOC 2 CC7.2.
    console.error('[TeamsCard] failed to load data', error);
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4" data-testid="teams-card-error">
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Failed to load team memberships. Check audit logs or DB health.</span>
        </div>
      </div>
    );
  }

  // Flatten the join result into a flat array for rendering.
  const memberships: TeamMembership[] = (data ?? []).map((row) => {
    // teams is returned as a single object (inner join) but PostgREST
    // types it as array. Safely coerce.
    const teamsJoin = Array.isArray(row.teams) ? row.teams[0] : row.teams;
    return {
      team_id: row.team_id,
      team_name: (teamsJoin as { name: string } | null)?.name ?? '(unknown)',
      role: row.role ?? 'member',
      joined_at: row.created_at ?? null,
    };
  });

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5" data-testid="teams-card">
      {/* Card header */}
      <div className="mb-4 flex items-center gap-2">
        <Users className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Teams</h2>
        <span className="ml-auto text-xs text-zinc-600">{memberships.length} team{memberships.length !== 1 ? 's' : ''}</span>
      </div>

      {memberships.length > 0 ? (
        <table className="w-full text-sm" aria-label="Team memberships for this user">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="pb-2 text-left text-xs font-medium text-zinc-400">Team</th>
              <th className="pb-2 text-left text-xs font-medium text-zinc-400">Role</th>
              <th className="pb-2 text-left text-xs font-medium text-zinc-400">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {memberships.map((m) => (
              <tr key={m.team_id} data-testid="team-row">
                <td className="py-2 text-zinc-100">
                  {/* WHY JSX text: team name is user-supplied data from Supabase.
                      React escapes it automatically — no XSS risk. */}
                  {m.team_name}
                </td>
                <td className="py-2">
                  <span
                    className={`inline-flex rounded-full px-1.5 py-0.5 text-xs font-medium ${roleBadgeClass(m.role)}`}
                    data-testid="team-role"
                  >
                    {m.role}
                  </span>
                </td>
                <td className="py-2 text-xs text-zinc-500" title={m.joined_at ?? ''}>
                  {fmtDate(m.joined_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="no-teams">
          Not a member of any teams.
        </p>
      )}
    </div>
  );
}
