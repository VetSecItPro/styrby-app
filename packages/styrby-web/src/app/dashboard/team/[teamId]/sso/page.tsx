/**
 * Team SSO Settings Page (Server Component orchestrator)
 *
 * /dashboard/team/[teamId]/sso
 *
 * Allows team owners to:
 *   - Set a Google Workspace SSO domain for auto-enroll
 *   - Toggle require_sso (password auth rejection)
 *   - View enrolled member count and recent SSO audit events
 *
 * Access control:
 *   - Owners: full read+write
 *   - Admins: read-only view (see current settings, no save controls)
 *   - Members: redirected to team overview
 *
 * Orchestrator pattern: server component fetches data, renders SsoSettingsPanel
 * client component. Page stays under 400 lines.
 *
 * @module dashboard/team/[teamId]/sso/page
 */

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { SsoSettingsPanel } from './sso-settings-panel';

// ============================================================================
// Metadata
// ============================================================================

export const metadata: Metadata = {
  title: 'Team SSO Settings | Styrby',
  description: 'Configure Google SSO and domain auto-enroll for your Styrby team.',
};

// ============================================================================
// Types
// ============================================================================

interface SsoPageProps {
  params: Promise<{ teamId: string }>;
}

// ============================================================================
// Page Component
// ============================================================================

export default async function TeamSsoPage({ params }: SsoPageProps) {
  const { teamId } = await params;
  const supabase = await createClient();

  // Auth guard
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?redirect=/dashboard/team');
  }

  // Verify membership
  const { data: member } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!member) {
    redirect('/dashboard/team');
  }

  // Only owners and admins can view SSO settings
  if (!['owner', 'admin'].includes(member.role)) {
    redirect(`/dashboard/team/${teamId}`);
  }

  // Fetch current SSO settings
  const { data: team } = await supabase
    .from('teams')
    .select('id, name, sso_domain, require_sso')
    .eq('id', teamId)
    .single();

  if (!team) {
    redirect('/dashboard/team');
  }

  // Fetch enrolled count from audit_log
  // WHY from audit_log not team_members: members join via many paths (invites,
  // owner adds, SSO). We count SSO-specific audit rows to show the benefit of
  // the SSO feature specifically.
  const { count: enrolledCount } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'team_sso_enrolled')
    .contains('metadata', { team_id: teamId });

  // Fetch recent SSO audit events (last 20)
  const { data: recentEvents } = await supabase
    .from('audit_log')
    .select('id, action, metadata, created_at')
    .in('action', ['team_sso_enrolled', 'team_sso_domain_set', 'team_sso_domain_cleared', 'team_sso_rejected', 'team_require_sso_toggled'])
    .contains('metadata', { team_id: teamId })
    .order('created_at', { ascending: false })
    .limit(20);

  const isOwner = member.role === 'owner';

  return (
    <div className="container max-w-3xl py-8">
      {/* Breadcrumb */}
      <nav className="mb-6 flex items-center gap-2 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard/team" className="hover:text-foreground transition-colors">
          Teams
        </Link>
        <span>/</span>
        <Link href={`/dashboard/team/${teamId}`} className="hover:text-foreground transition-colors">
          {team.name}
        </Link>
        <span>/</span>
        <span className="text-foreground">SSO</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Google SSO Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure Google Workspace domain auto-enroll and authentication policies for your team.
        </p>
      </div>

      <SsoSettingsPanel
        teamId={teamId}
        teamName={team.name}
        ssoDomain={team.sso_domain ?? null}
        requireSso={team.require_sso ?? false}
        enrolledCount={enrolledCount ?? 0}
        recentEvents={recentEvents ?? []}
        isOwner={isOwner}
      />
    </div>
  );
}
