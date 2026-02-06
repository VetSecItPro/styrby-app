/**
 * Team Screen
 *
 * Read-only view of the user's team members and pending invitations.
 * Team management is done via the web dashboard.
 *
 * Power tier only - shows upgrade prompt for Free/Pro users.
 */

import {
  View,
  Text,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Linking,
  Pressable,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/lib/supabase';

// ============================================================================
// Types
// ============================================================================

interface TeamMember {
  member_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  display_name: string | null;
  email: string;
  avatar_url: string | null;
  joined_at: string;
}

interface PendingInvitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
  created_at: string;
  expires_at: string;
}

interface Team {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
}

/**
 * Discriminated union for FlatList items.
 */
type TeamListItem =
  | { type: 'header'; title: string }
  | { type: 'member'; data: TeamMember }
  | { type: 'invitation'; data: PendingInvitation };

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Returns initials from a name or email.
 *
 * @param name - User's display name (may be null)
 * @param email - User's email address
 * @returns 1-2 character initials
 */
function getInitials(name: string | null, email: string): string {
  if (name) {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return email[0].toUpperCase();
}

/**
 * Formats an ISO date string to relative time.
 *
 * @param isoDate - ISO 8601 date string
 * @returns Relative time string (e.g., "2 days ago", "Joined Jan 15")
 */
function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// ============================================================================
// Role Badge Component
// ============================================================================

/**
 * Renders a colored badge for team member roles.
 *
 * @param role - The member's role (owner, admin, member)
 */
function RoleBadge({ role }: { role: 'owner' | 'admin' | 'member' }) {
  const colors = {
    owner: { bg: 'rgba(249, 115, 22, 0.1)', text: '#f97316' },
    admin: { bg: 'rgba(168, 85, 247, 0.1)', text: '#a855f7' },
    member: { bg: 'rgba(113, 113, 122, 0.1)', text: '#71717a' },
  };

  const { bg, text } = colors[role];

  return (
    <View className="px-2 py-0.5 rounded-full" style={{ backgroundColor: bg }}>
      <Text className="text-xs font-medium" style={{ color: text }}>
        {role.charAt(0).toUpperCase() + role.slice(1)}
      </Text>
    </View>
  );
}

// ============================================================================
// Member Card Component
// ============================================================================

interface MemberCardProps {
  member: TeamMember;
  isCurrentUser: boolean;
}

/**
 * Renders a single team member card with avatar, name, email, and role.
 *
 * @param member - The team member data
 * @param isCurrentUser - Whether this member is the current user
 */
function MemberCard({ member, isCurrentUser }: MemberCardProps) {
  return (
    <View className="flex-row items-center px-4 py-3 border-b border-zinc-800/50">
      {/* Avatar */}
      <View className="w-10 h-10 rounded-full bg-zinc-700 items-center justify-center mr-3">
        <Text className="text-sm font-medium text-zinc-300">
          {getInitials(member.display_name, member.email)}
        </Text>
      </View>

      {/* Info */}
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-white font-medium" numberOfLines={1}>
            {member.display_name || member.email}
          </Text>
          {isCurrentUser && (
            <Text className="text-zinc-500 text-xs ml-2">(you)</Text>
          )}
        </View>
        <Text className="text-zinc-400 text-sm" numberOfLines={1}>
          {member.email}
        </Text>
      </View>

      {/* Role Badge */}
      <RoleBadge role={member.role} />
    </View>
  );
}

// ============================================================================
// Pending Invitation Card Component
// ============================================================================

interface InvitationCardProps {
  invitation: PendingInvitation;
}

/**
 * Renders a pending invitation with email and expiration date.
 *
 * @param invitation - The invitation data
 */
function InvitationCard({ invitation }: InvitationCardProps) {
  const expiresIn = new Date(invitation.expires_at).getTime() - Date.now();
  const daysUntilExpiry = Math.ceil(expiresIn / (1000 * 60 * 60 * 24));

  return (
    <View className="flex-row items-center px-4 py-3 border-b border-zinc-800/50">
      {/* Icon */}
      <View className="w-10 h-10 rounded-full bg-zinc-700 items-center justify-center mr-3">
        <Ionicons name="mail-outline" size={20} color="#71717a" />
      </View>

      {/* Info */}
      <View className="flex-1">
        <Text className="text-white font-medium" numberOfLines={1}>
          {invitation.email}
        </Text>
        <Text className="text-zinc-500 text-sm">
          Expires in {daysUntilExpiry} day{daysUntilExpiry !== 1 ? 's' : ''}
        </Text>
      </View>

      {/* Status Badge */}
      <View className="px-2 py-0.5 rounded-full bg-yellow-500/10">
        <Text className="text-xs font-medium text-yellow-500">Pending</Text>
      </View>
    </View>
  );
}

// ============================================================================
// Main Screen
// ============================================================================

export default function TeamScreen() {
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPowerTier, setIsPowerTier] = useState(false);
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitation[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<'owner' | 'admin' | 'member' | null>(null);

  /**
   * Fetches team data from Supabase.
   */
  const fetchTeamData = useCallback(async () => {
    try {
      // Use the pre-configured supabase instance from lib/supabase

      // Get current user
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        setError('Please log in to view team');
        setIsLoading(false);
        return;
      }

      setCurrentUserId(user.id);

      // Check subscription tier
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('tier')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .single();

      const tier = subscription?.tier || 'free';
      setIsPowerTier(tier === 'power');

      if (tier !== 'power') {
        setIsLoading(false);
        return;
      }

      // Fetch user's teams
      const { data: teamsData, error: teamsError } = await supabase.rpc('get_user_teams');

      if (teamsError) {
        throw teamsError;
      }

      if (!teamsData || teamsData.length === 0) {
        // No team yet
        setTeam(null);
        setMembers([]);
        setPendingInvitations([]);
        setIsLoading(false);
        return;
      }

      // Get first team details
      const primaryTeam = teamsData[0];
      setCurrentUserRole(primaryTeam.role);

      // Fetch full team details
      const { data: teamData, error: teamError } = await supabase
        .from('teams')
        .select('*')
        .eq('id', primaryTeam.team_id)
        .single();

      if (teamError) {
        throw teamError;
      }

      setTeam(teamData);

      // Fetch members
      const { data: membersData, error: membersError } = await supabase.rpc(
        'get_team_members',
        { p_team_id: primaryTeam.team_id }
      );

      if (membersError) {
        throw membersError;
      }

      setMembers(membersData || []);

      // Fetch pending invitations (only for owner/admin)
      if (primaryTeam.role === 'owner' || primaryTeam.role === 'admin') {
        const { data: invitesData } = await supabase
          .from('team_invitations')
          .select('id, email, role, created_at, expires_at')
          .eq('team_id', primaryTeam.team_id)
          .eq('status', 'pending')
          .order('created_at', { ascending: false });

        setPendingInvitations(invitesData || []);
      }

      setError(null);
    } catch (err) {
      console.error('Failed to fetch team data:', err);
      setError('Failed to load team data');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchTeamData();
  }, [fetchTeamData]);

  /**
   * Pull-to-refresh handler.
   */
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    fetchTeamData();
  }, [fetchTeamData]);

  /**
   * Opens the web dashboard for team management.
   */
  const openWebDashboard = () => {
    Linking.openURL('https://www.styrbyapp.com/team');
  };

  // ---- Loading State ----
  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading team...</Text>
      </View>
    );
  }

  // ---- Error State ----
  if (error) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="text-white text-lg font-semibold mt-4">
          Failed to Load Team
        </Text>
        <Text className="text-zinc-500 text-center mt-2">{error}</Text>
        <Pressable
          onPress={fetchTeamData}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Retry loading team"
        >
          <Text className="text-white font-semibold">Try Again</Text>
        </Pressable>
      </View>
    );
  }

  // ---- Upgrade Prompt (Non-Power Tier) ----
  if (!isPowerTier) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <View className="w-20 h-20 bg-orange-500/10 rounded-full items-center justify-center mb-6">
          <Ionicons name="people" size={40} color="#f97316" />
        </View>

        <Text className="text-white text-2xl font-bold text-center mb-2">
          Team Collaboration
        </Text>

        <Text className="text-zinc-400 text-center mb-6">
          Share sessions and collaborate with your team members.
        </Text>

        <View className="bg-background-secondary rounded-xl p-4 w-full mb-6">
          <Text className="text-zinc-300 font-medium mb-3">
            Team features include:
          </Text>
          {[
            'Up to 5 team members',
            'Shared session visibility',
            'Team cost tracking',
            'Role-based permissions',
          ].map((feature) => (
            <View key={feature} className="flex-row items-center mb-2">
              <Ionicons name="checkmark-circle" size={18} color="#22c55e" />
              <Text className="text-zinc-400 ml-2">{feature}</Text>
            </View>
          ))}
        </View>

        <Pressable
          onPress={() => Linking.openURL('https://www.styrbyapp.com/pricing')}
          className="bg-brand px-8 py-3 rounded-xl active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Upgrade to Power plan"
        >
          <Text className="text-white font-semibold">Upgrade to Power</Text>
        </Pressable>
      </View>
    );
  }

  // ---- No Team Yet ----
  if (!team) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <View className="w-16 h-16 bg-orange-500/10 rounded-full items-center justify-center mb-4">
          <Ionicons name="people-outline" size={32} color="#f97316" />
        </View>

        <Text className="text-white text-xl font-semibold text-center mb-2">
          No Team Yet
        </Text>

        <Text className="text-zinc-400 text-center mb-6">
          Create a team on the web dashboard to start collaborating.
        </Text>

        <Pressable
          onPress={openWebDashboard}
          className="bg-brand px-6 py-3 rounded-xl active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Open web dashboard"
        >
          <Text className="text-white font-semibold">Create Team on Web</Text>
        </Pressable>
      </View>
    );
  }

  // ---- Team View ----
  const canManageMembers = currentUserRole === 'owner' || currentUserRole === 'admin';

  return (
    <View className="flex-1 bg-background">
      {/* Team Header */}
      <View className="px-4 py-4 border-b border-zinc-800">
        <View className="flex-row items-center">
          <View className="w-12 h-12 bg-orange-500/20 rounded-xl items-center justify-center mr-3">
            <Text className="text-xl font-bold text-orange-500">
              {team.name[0].toUpperCase()}
            </Text>
          </View>
          <View className="flex-1">
            <Text className="text-white text-lg font-semibold">{team.name}</Text>
            {team.description && (
              <Text className="text-zinc-400 text-sm" numberOfLines={1}>
                {team.description}
              </Text>
            )}
          </View>
          <Pressable
            onPress={openWebDashboard}
            className="p-2 bg-zinc-800 rounded-lg"
            accessibilityRole="button"
            accessibilityLabel="Manage team on web"
          >
            <Ionicons name="open-outline" size={20} color="#71717a" />
          </Pressable>
        </View>

        <View className="flex-row items-center mt-3">
          <Text className="text-zinc-500 text-sm">
            {members.length} member{members.length !== 1 ? 's' : ''}
          </Text>
          {pendingInvitations.length > 0 && (
            <Text className="text-zinc-500 text-sm ml-3">
              {pendingInvitations.length} pending
            </Text>
          )}
        </View>
      </View>

      <FlatList<TeamListItem>
        data={[
          { type: 'header', title: 'Members' } as TeamListItem,
          ...members.map((m): TeamListItem => ({ type: 'member', data: m })),
          ...(canManageMembers && pendingInvitations.length > 0
            ? [
                { type: 'header', title: 'Pending Invitations' } as TeamListItem,
                ...pendingInvitations.map((i): TeamListItem => ({ type: 'invitation', data: i })),
              ]
            : []),
        ]}
        keyExtractor={(item, index) => {
          if (item.type === 'header') return `header-${item.title}`;
          if (item.type === 'member') return (item.data as TeamMember).member_id;
          return (item.data as PendingInvitation).id;
        }}
        renderItem={({ item }) => {
          if (item.type === 'header') {
            return (
              <View className="px-4 py-2 bg-background">
                <Text className="text-zinc-400 text-sm font-medium">
                  {item.title}
                </Text>
              </View>
            );
          }
          if (item.type === 'member') {
            return (
              <MemberCard
                member={item.data as TeamMember}
                isCurrentUser={(item.data as TeamMember).user_id === currentUserId}
              />
            );
          }
          return <InvitationCard invitation={item.data as PendingInvitation} />;
        }}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#f97316"
            colors={['#f97316']}
          />
        }
        ListFooterComponent={
          <View className="px-4 py-6">
            <Text className="text-zinc-500 text-center text-sm">
              To manage team members, use the web dashboard.
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
