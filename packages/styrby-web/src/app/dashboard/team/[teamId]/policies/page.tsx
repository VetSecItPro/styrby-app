/**
 * Team Policies Admin Page
 *
 * /dashboard/team/[teamId]/policies
 *
 * Server Component that fetches the team's current policy settings and renders
 * the PoliciesForm client component. The form allows owners/admins to edit
 * auto_approve_rules, blocked_tools, and budget_per_seat_usd.
 *
 * Access control:
 *   - Any team member can VIEW the current policies (transparency)
 *   - Only owners/admins can EDIT (the form hides save controls for members)
 *
 * Orchestrator pattern: this page is thin. All interactivity (form state,
 * save mutation) lives in PoliciesForm. Page stays under 400 lines.
 *
 * @module dashboard/team/[teamId]/policies/page
 */

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { PoliciesDynamic } from './policies-dynamic';
import type { TeamPolicySettings } from '@styrby/shared';
import { parseDbRole } from '@styrby/shared';

// ============================================================================
// Metadata
// ============================================================================

export const metadata: Metadata = {
  title: 'Team Policies | Styrby',
  description: 'Manage auto-approve rules, blocked tools, and budget limits for your Styrby team.',
};

// ============================================================================
// Types
// ============================================================================

interface PoliciesPageProps {
  params: Promise<{ teamId: string }>;
}

/** Team policies columns from DB */
interface TeamPoliciesDbRow {
  id: string;
  name: string;
  auto_approve_rules: unknown;
  blocked_tools: unknown;
  budget_per_seat_usd: number | null;
}

// ============================================================================
// Page Component
// ============================================================================

/**
 * Team policies admin page - server component.
 *
 * Fetches current policy settings and passes them to the form client component.
 * Determines whether the caller can edit (owner/admin) and passes the flag down.
 *
 * @param props - Page props (teamId from URL params)
 */
export default async function PoliciesPage({ params }: PoliciesPageProps) {
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
  const canEdit = callerRole === 'owner' || callerRole === 'admin';

  // ── Fetch team name + current policies ───────────────────────────────────

  const { data: team } = await supabase
    .from('teams')
    .select('id, name, auto_approve_rules, blocked_tools, budget_per_seat_usd')
    .eq('id', teamId)
    .single() as { data: TeamPoliciesDbRow | null };

  if (!team) {
    redirect('/dashboard');
  }

  // Normalise jsonb arrays from Supabase (may be null or non-array on fresh teams)
  const initial: TeamPolicySettings = {
    auto_approve_rules: Array.isArray(team.auto_approve_rules)
      ? (team.auto_approve_rules as string[])
      : [],
    blocked_tools: Array.isArray(team.blocked_tools)
      ? (team.blocked_tools as string[])
      : [],
    budget_per_seat_usd: team.budget_per_seat_usd ?? null,
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {/* Page header */}
      <div>
        <div className="flex items-center gap-2 text-zinc-500 text-sm mb-1">
          <Link
            href={`/dashboard/team/${teamId}/members`}
            className="hover:text-zinc-300 transition-colors"
          >
            Members
          </Link>
          <span>/</span>
          <span className="text-zinc-300">Policies</span>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100">Team Policies</h1>
        <p className="text-zinc-400 mt-1">
          Configure auto-approve rules, blocked tools, and budget limits for{' '}
          <strong className="text-zinc-200">{team.name}</strong>.
        </p>
      </div>

      {/* Policy form */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
        <PoliciesDynamic
          initial={initial}
          teamId={teamId}
          canEdit={canEdit}
        />
      </div>

      {/* Contextual guidance */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-5 text-sm text-zinc-400 space-y-2">
        <p className="font-medium text-zinc-300">How policies work</p>
        <ul className="list-disc list-inside space-y-1 text-xs">
          <li>
            <strong className="text-zinc-300">Auto-approve rules</strong> - tools on this list run
            without requiring human review in the CLI approval flow.
          </li>
          <li>
            <strong className="text-zinc-300">Blocked tools</strong> - tools on this list are
            rejected outright, even if they appear in auto-approve rules.
          </li>
          <li>
            <strong className="text-zinc-300">Budget per seat</strong> - members who exceed
            this monthly spend receive an alert; leave blank for no limit.
          </li>
          <li>
            Every policy change is recorded in the audit log with before/after values.
          </li>
        </ul>
      </div>
    </div>
  );
}
