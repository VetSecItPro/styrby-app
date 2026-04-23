/**
 * Team Members Admin Page
 *
 * /dashboard/team/[teamId]/members
 *
 * Server Component that fetches all team members with admin-view fields
 * (email, role, join date, last active, cost MTD) and renders the
 * MembersTable client component.
 *
 * Orchestrator pattern: page is a thin server shell. All interactive
 * mutations (role change, remove) live in the MembersTable client component.
 * Page file stays well under the 400-line limit.
 *
 * WHY last_active_at via subquery on sessions:
 *   There is no dedicated last_active_at column on team_members. We compute
 *   it as MAX(sessions.started_at) per member so the value is always fresh.
 *   A dedicated materialized view is a Phase 2.5 optimization.
 *
 * WHY cost_mtd_usd via direct query:
 *   We sum cost_records.cost_usd for the current calendar month. The
 *   mv_daily_cost_summary materialized view aggregates by day, not month,
 *   and is not scoped per-team. Direct sum is simpler for now.
 *
 * @module dashboard/team/[teamId]/members/page
 */

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { MembersDynamic } from './members-dynamic';
import type { TeamMemberAdminRow } from '@styrby/shared';
import { parseDbRole } from '@styrby/shared';

// ============================================================================
// Metadata
// ============================================================================

export const metadata: Metadata = {
  title: 'Team Members | Styrby',
  description: 'Manage team members, roles, and access for your Styrby team.',
};

// ============================================================================
// Types
// ============================================================================

interface MembersPageProps {
  params: Promise<{ teamId: string }>;
}

/** get_team_members RPC row shape */
interface TeamMemberRpcRow {
  member_id: string;
  user_id: string;
  role: string;
  display_name: string | null;
  email: string;
  avatar_url: string | null;
  joined_at: string;
}

/** sessions table row for last-active lookup */
interface SessionLastActiveRow {
  user_id: string;
  started_at: string;
}

/** cost_records aggregate row */
interface CostMtdRow {
  user_id: string;
  cost_usd: number;
}

// ============================================================================
// Page Component
// ============================================================================

/**
 * Team members admin page — server component.
 *
 * Fetches membership + last-active + cost MTD data in parallel, then passes
 * the enriched member rows to the MembersTable client component.
 *
 * Access control:
 *   - Must be authenticated
 *   - Must be a member of the team (RLS enforces this for data queries)
 *   - Non-members are redirected to /dashboard
 *
 * @param props - Page props (teamId from URL params)
 */
export default async function MembersPage({ params }: MembersPageProps) {
  const { teamId } = await params;
  const supabase = await createClient();

  // ── Auth ──────────────────────────────────────────────────────────────────

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    redirect('/login');
  }

  // ── Verify membership ─────────────────────────────────────────────────────

  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    redirect('/dashboard');
  }

  const callerRole = parseDbRole(membership.role);

  // ── Team name ─────────────────────────────────────────────────────────────

  const { data: team } = await supabase
    .from('teams')
    .select('id, name')
    .eq('id', teamId)
    .single();

  if (!team) {
    redirect('/dashboard');
  }

  // ── Fetch members + enrichment in parallel ────────────────────────────────

  // WHY parallel: member list, last-active, and cost queries are independent.
  // Serial fetches would triple the server-render latency.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [membersResult, sessionsResult, costsResult] = await Promise.all([
    // Core member list via the get_team_members RPC (already exists, returns emails)
    supabase.rpc('get_team_members', { p_team_id: teamId }),

    // Most recent session per user for the team
    supabase
      .from('sessions')
      .select('user_id, started_at')
      .eq('team_id', teamId)
      .order('started_at', { ascending: false }),

    // Cost MTD: sum cost_usd per user for the current month
    supabase
      .from('cost_records')
      .select('user_id, cost_usd')
      .eq('team_id', teamId)
      .gte('recorded_at', monthStart),
  ]);

  const rpcMembers = (membersResult.data ?? []) as TeamMemberRpcRow[];
  const sessions = (sessionsResult.data ?? []) as SessionLastActiveRow[];
  const costRows = (costsResult.data ?? []) as CostMtdRow[];

  // ── Build lookup maps ─────────────────────────────────────────────────────

  /** Latest session timestamp per user_id */
  const lastActiveByUser: Record<string, string> = {};
  for (const s of sessions) {
    if (!lastActiveByUser[s.user_id]) {
      lastActiveByUser[s.user_id] = s.started_at;
    }
  }

  /** Total cost MTD per user_id */
  const costByUser: Record<string, number> = {};
  for (const c of costRows) {
    costByUser[c.user_id] = (costByUser[c.user_id] ?? 0) + Number(c.cost_usd);
  }

  // ── Merge into admin view ─────────────────────────────────────────────────

  const members: TeamMemberAdminRow[] = rpcMembers.map((m) => ({
    member_id: m.member_id,
    user_id: m.user_id,
    role: parseDbRole(m.role),
    display_name: m.display_name,
    email: m.email,
    avatar_url: m.avatar_url ?? null,
    joined_at: m.joined_at,
    last_active_at: lastActiveByUser[m.user_id] ?? null,
    cost_mtd_usd: costByUser[m.user_id] !== undefined
      ? Math.round(costByUser[m.user_id] * 100) / 100
      : null,
  }));

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-zinc-500 text-sm mb-1">
            <Link
              href={`/dashboard/team/${teamId}/invitations`}
              className="hover:text-zinc-300 transition-colors"
            >
              Invitations
            </Link>
            <span>/</span>
            <span className="text-zinc-300">Members</span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Team Members</h1>
          <p className="text-zinc-400 mt-1">
            {members.length} member{members.length !== 1 ? 's' : ''} in{' '}
            <strong className="text-zinc-200">{team.name}</strong>
          </p>
        </div>

        <Link
          href={`/dashboard/team/${teamId}/invitations`}
          className="inline-flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Invite member
        </Link>
      </div>

      {/* Members table — dynamically imported to reduce first-load bundle */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <MembersDynamic
          initialMembers={members}
          currentUserId={user.id}
          currentUserRole={callerRole}
          teamId={teamId}
        />
      </div>
    </div>
  );
}
