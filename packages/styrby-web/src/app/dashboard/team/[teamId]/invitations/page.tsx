/**
 * Team Invitations Admin Page
 *
 * /dashboard/team/[teamId]/invitations
 *
 * Server Component that lists pending and recent invitations for a team.
 * Only accessible to team owners and admins (checked server-side).
 *
 * Orchestrator pattern: this page is thin. All UI sections are in components.
 * Max 400 lines per CLAUDE.md component-first architecture rule.
 *
 * @module dashboard/team/[teamId]/invitations/page
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  SeatCapBanner,
} from '@/components/team/invitations';
import type { InvitationRow } from '@/components/team/invitations';
// WHY dynamic wrappers: InvitationsList imports date-fns + lucide-react icons;
// InviteMemberButton/Modal add a further ~287 lines of client JS. The
// invitations admin surface is visited by at most a handful of team
// owners/admins. Deferring them keeps the shared dashboard chunk lean and
// reduces first-load JS for all users. Pattern from cost-charts-dynamic.tsx
// (Phase 1.6.13). Dynamic wrappers wrap both list and invite button.
import { InvitationsListDynamic, InviteButtonDynamic } from './invitations-dynamic';
import { validateSeatCap } from '@styrby/shared';
import type { SeatCapResult } from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

interface InvitationsPageProps {
  params: Promise<{ teamId: string }>;
}

/** Team row shape from Supabase (name only — seat fields fetched via validateSeatCap) */
interface TeamRow {
  id: string;
  name: string;
}

/** team_members row to verify caller role */
interface MembershipRow {
  role: 'owner' | 'admin' | 'member';
}

/** team_invitations row shape for the list */
interface InvitationDbRow {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string;
  team_id: string;
}

// ============================================================================
// Page Component
// ============================================================================

/**
 * Server Component for the team invitations admin page.
 *
 * Fetches:
 *   1. Caller's authentication and team membership
 *   2. Team seat cap data
 *   3. All invitations (pending + last 50 non-pending)
 *
 * Redirects to /dashboard if:
 *   - Caller is not authenticated
 *   - Caller is not a member of the team
 *   - Caller's role is 'member' (only owner/admin can manage invitations)
 *
 * @param props - Next.js page props with teamId param
 */
export default async function InvitationsPage({ params }: InvitationsPageProps) {
  const { teamId } = await params;
  const supabase = await createClient();

  // ── Step 1: Auth ───────────────────────────────────────────────────────────

  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  // ── Step 2: Verify caller is admin or owner ────────────────────────────────

  const { data: membership, error: memberError } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single() as { data: MembershipRow | null; error: unknown };

  if (memberError || !membership) {
    // Not a member of this team - redirect rather than 403 to avoid leaking team existence
    redirect('/dashboard');
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    // Members can't manage invitations
    redirect(`/dashboard/team/${teamId}`);
  }

  // ── Step 3: Fetch team name + seat cap data ───────────────────────────────

  // WHY two separate queries for team name vs. seat cap:
  //   validateSeatCap() from @styrby/shared owns the seat-cap logic (80% threshold,
  //   null-cap warning, overageInfo CTA). Using it here ensures the UI banner is
  //   consistent with the edge function's cap check and doesn't duplicate logic.
  //   We only need team.name separately for the page header.
  const { data: team } = await supabase
    .from('teams')
    .select('id, name')
    .eq('id', teamId)
    .single() as { data: TeamRow | null };

  if (!team) {
    redirect('/dashboard');
  }

  // WHY validateSeatCap from @styrby/shared (not raw .select('seat_cap, active_seats')):
  //   The shared function is the single source of truth for cap logic consumed by
  //   both this UI and the teams-invite edge function. Calling it here guarantees
  //   the banner reflects the same threshold (>=80%) and CTA URL as the gate.
  let seatCapResult: SeatCapResult;
  try {
    seatCapResult = await validateSeatCap(teamId, supabase);
  } catch {
    // WHY fail-open: a DB error reading seat_cap should not block the admin from
    // managing invitations. We render the banner with null cap (no banner shown).
    seatCapResult = { ok: true, currentSeats: 0, seatCap: null, nullCapWarning: true };
  }

  // ── Step 4: Fetch invitations ─────────────────────────────────────────────

  // WHY fetch all pending first, then recent non-pending:
  //   Admins primarily care about pending invitations that require action.
  //   Historical invitations (accepted/revoked) are shown for audit context.
  //   We fetch all pending (no limit) + last 50 non-pending.
  const [pendingResult, historyResult] = await Promise.all([
    supabase
      .from('team_invitations')
      .select('id, email, role, status, created_at, expires_at, team_id')
      .eq('team_id', teamId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),

    supabase
      .from('team_invitations')
      .select('id, email, role, status, created_at, expires_at, team_id')
      .eq('team_id', teamId)
      .neq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const pending = (pendingResult.data ?? []) as InvitationDbRow[];
  const history = (historyResult.data ?? []) as InvitationDbRow[];

  // Map DB rows to component-friendly shape
  // WHY map created_at -> invited_at: InvitationRow uses invited_at for clarity
  const allInvitations: InvitationRow[] = [...pending, ...history].map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role as InvitationRow['role'],
    status: row.status as InvitationRow['status'],
    invited_at: row.created_at,
    expires_at: row.expires_at,
    team_id: row.team_id,
  }));

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Team Invitations</h1>
          <p className="text-zinc-400 mt-1">
            Manage invitations for <strong className="text-zinc-200">{team.name}</strong>
          </p>
        </div>

        {/* InviteButtonDynamic: lazy-loads InviteMemberButton + Modal JS only when visited */}
        <InviteButtonDynamic teamId={teamId} />
      </div>

      {/* Seat cap banner */}
      <SeatCapBanner
        seatCapResult={seatCapResult}
        teamId={teamId}
      />

      {/* InvitationsListDynamic: lazy-loads list JS (date-fns + lucide-react) on demand */}
      <InvitationsListDynamic
        invitations={allInvitations}
        teamId={teamId}
      />
    </div>
  );
}
