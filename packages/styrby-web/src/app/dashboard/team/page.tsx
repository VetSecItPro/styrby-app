import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { TeamClient } from './team-client';
import { TIERS, type TierId } from '@/lib/polar';

/**
 * Team Management Page
 *
 * Server component that fetches team data, subscription tier, and renders
 * the team management UI. Delegates all interactive functionality to the
 * TeamClient client component.
 *
 * Power tier gate: Shows upgrade prompt for Free/Pro users.
 */
export default async function TeamPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // Fetch subscription to determine tier
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier, status')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .single();

  const tier = (subscription?.tier as TierId) || 'free';
  const isPowerTier = tier === 'power';

  // If not Power tier, show upgrade prompt
  if (!isPowerTier) {
    return (
      <div className="min-h-screen bg-zinc-950">
        {/* Header */}
        <header className="border-b border-zinc-800 bg-zinc-900/50">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex h-16 items-center justify-between">
              <div className="flex items-center gap-4">
                <Link href="/dashboard" className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                    <span className="text-lg font-bold text-white">S</span>
                  </div>
                  <span className="font-semibold text-zinc-100">Styrby</span>
                </Link>
              </div>

              <nav className="flex items-center gap-6">
                <Link
                  href="/dashboard"
                  className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  Dashboard
                </Link>
                <Link
                  href="/dashboard/sessions"
                  className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  Sessions
                </Link>
                <Link
                  href="/dashboard/costs"
                  className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  Costs
                </Link>
                <Link href="/dashboard/team" className="text-sm font-medium text-orange-500">
                  Team
                </Link>
                <Link
                  href="/dashboard/settings"
                  className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  Settings
                </Link>
              </nav>

              <div className="flex items-center gap-4">
                <span className="text-sm text-zinc-400">{user.email}</span>
              </div>
            </div>
          </div>
        </header>

        {/* Upgrade prompt */}
        <main className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-16">
          <div className="text-center">
            <div className="w-20 h-20 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg
                className="w-10 h-10 text-orange-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
            </div>

            <h1 className="text-3xl font-bold text-zinc-100 mb-4">
              Team Collaboration
            </h1>

            <p className="text-lg text-zinc-400 mb-8 max-w-md mx-auto">
              Share sessions, collaborate on projects, and track costs together
              with your team.
            </p>

            <div className="bg-zinc-900 rounded-2xl p-8 text-left mb-8">
              <h2 className="text-lg font-semibold text-zinc-100 mb-4">
                Team features include:
              </h2>
              <ul className="space-y-3">
                {[
                  'Up to 5 team members',
                  'Shared session visibility',
                  'Team cost tracking',
                  'Role-based permissions (Owner, Admin, Member)',
                  'Email invitations',
                ].map((feature) => (
                  <li key={feature} className="flex items-center gap-3 text-zinc-300">
                    <svg
                      className="w-5 h-5 text-green-500 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/pricing"
                className="inline-flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Upgrade to Power
              </Link>
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-8 py-3 rounded-lg font-semibold transition-colors"
              >
                Back to Dashboard
              </Link>
            </div>

            <p className="mt-6 text-sm text-zinc-500">
              Power plan: ${TIERS.power.price.monthly}/month or ${TIERS.power.price.annual}/year
            </p>
          </div>
        </main>
      </div>
    );
  }

  // Fetch user's teams
  const { data: teamsData } = await supabase.rpc('get_user_teams');

  // Get first team or null
  const primaryTeam = teamsData?.[0] || null;

  // If user has a team, fetch full details
  let teamDetails = null;
  let members: Array<{
    id: string;
    user_id: string;
    role: string;
    display_name: string | null;
    email: string;
    avatar_url: string | null;
    joined_at: string;
  }> = [];
  let pendingInvitations: Array<{
    id: string;
    email: string;
    role: string;
    created_at: string;
    expires_at: string;
  }> = [];

  if (primaryTeam) {
    // Fetch full team details
    const { data: team } = await supabase
      .from('teams')
      .select('*')
      .eq('id', primaryTeam.team_id)
      .single();

    teamDetails = team;

    // Fetch members
    const { data: membersData } = await supabase.rpc('get_team_members', {
      p_team_id: primaryTeam.team_id,
    });

    members = (membersData || []).map((m: {
      member_id: string;
      user_id: string;
      role: string;
      display_name: string | null;
      email: string;
      avatar_url: string | null;
      joined_at: string;
    }) => ({
      id: m.member_id,
      user_id: m.user_id,
      role: m.role,
      display_name: m.display_name,
      email: m.email,
      avatar_url: m.avatar_url,
      joined_at: m.joined_at,
    }));

    // Fetch pending invitations (only if owner/admin)
    const currentUserRole = primaryTeam.role;
    if (currentUserRole === 'owner' || currentUserRole === 'admin') {
      const { data: invites } = await supabase
        .from('team_invitations')
        .select('id, email, role, created_at, expires_at')
        .eq('team_id', primaryTeam.team_id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      pendingInvitations = invites || [];
    }
  }

  // Get user's profile for display
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, avatar_url')
    .eq('id', user.id)
    .single();

  const teamLimit = TIERS.power.limits.teamMembers;

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
                  <span className="text-lg font-bold text-white">S</span>
                </div>
                <span className="font-semibold text-zinc-100">Styrby</span>
              </Link>
            </div>

            <nav className="flex items-center gap-6">
              <Link
                href="/dashboard"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Dashboard
              </Link>
              <Link
                href="/dashboard/sessions"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Sessions
              </Link>
              <Link
                href="/dashboard/costs"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Costs
              </Link>
              <Link href="/dashboard/team" className="text-sm font-medium text-orange-500">
                Team
              </Link>
              <Link
                href="/dashboard/settings"
                className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                Settings
              </Link>
            </nav>

            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">{user.email}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-zinc-100 mb-8">Team</h1>

        <TeamClient
          user={{
            id: user.id,
            email: user.email || '',
            displayName: profile?.display_name || null,
            avatarUrl: profile?.avatar_url || null,
          }}
          team={teamDetails}
          members={members}
          pendingInvitations={pendingInvitations}
          currentUserRole={primaryTeam?.role || null}
          teamLimit={teamLimit}
        />
      </main>
    </div>
  );
}
