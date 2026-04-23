/**
 * Team Members Screen (Mobile) - Phase 2.3
 *
 * /team/members
 *
 * Mobile parity of the web /dashboard/team/[teamId]/members page.
 * Displays a compacted list of team members with role badge, join date,
 * last active, and cost MTD. Role change and member removal are available
 * to owners/admins via an action sheet.
 *
 * Navigation:
 *   - Deep-links back to the invitations screen (Phase 2.2)
 *   - Accessible from the Team tab
 *
 * WHY this is a standalone route (not embedded in the Team tab):
 *   The Team tab already handles the create-team / no-team states. Having
 *   members as a separate route allows deep-linking from push notifications
 *   (e.g. "New member joined your team") and keeps the team tab lightweight.
 *
 * Data source: useTeamManagement hook (existing, Phase 2.1).
 * Enrichment (last_active_at, cost_mtd_usd): fetched here via Supabase
 * because useTeamManagement returns the basic RPC member shape only.
 *
 * @module app/team/members
 */

import {
  View,
  Text,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Pressable,
  Alert,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTeamManagement } from '../../src/hooks/useTeamManagement';
import { supabase } from '../../src/lib/supabase';
import { getApiBaseUrl } from '../../src/lib/config';
import type { ValidatedTeamMember } from '../../src/lib/schemas';

// ============================================================================
// Types
// ============================================================================

/**
 * Member row enriched with last-active and cost MTD for the admin view.
 */
interface EnrichedMember extends ValidatedTeamMember {
  /** ISO timestamp of most recent session, or null */
  last_active_at: string | null;
  /** Month-to-date cost in USD, or null if no sessions */
  cost_mtd_usd: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats an ISO date string as a short human-readable date.
 *
 * @param iso - ISO 8601 date string
 * @returns Formatted date string (e.g. "Jun 1, 2025") or "-" if null
 */
function fmtDate(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Formats a nullable USD cost as "$X.XX" or "-".
 *
 * @param usd - Cost in USD, or null
 * @returns Formatted cost string
 */
function fmtCost(usd: number | null): string {
  if (usd === null) return '-';
  return `$${usd.toFixed(2)}`;
}

/**
 * Returns initials from a name or email for the avatar.
 *
 * @param name - Display name (may be null)
 * @param email - Email address (fallback)
 * @returns 1-2 character uppercase initials
 */
function getInitials(name: string | null, email: string): string {
  if (name) {
    return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
  }
  return email[0].toUpperCase();
}

// ============================================================================
// Role Badge
// ============================================================================

/**
 * Renders a coloured role indicator pill.
 *
 * @param props.role - Member's role string
 * @returns Coloured badge view
 */
function RoleBadge({ role }: { role: string }) {
  const colours: Record<string, { bg: string; text: string }> = {
    owner: { bg: 'rgba(249, 115, 22, 0.12)', text: '#f97316' },
    admin: { bg: 'rgba(168, 85, 247, 0.12)', text: '#a855f7' },
    member: { bg: 'rgba(113, 113, 122, 0.12)', text: '#71717a' },
  };
  const { bg, text } = colours[role] ?? colours.member;

  return (
    <View className="px-2 py-0.5 rounded-full" style={{ backgroundColor: bg }}>
      <Text className="text-xs font-medium" style={{ color: text }}>
        {role.charAt(0).toUpperCase() + role.slice(1)}
      </Text>
    </View>
  );
}

// ============================================================================
// Member Row
// ============================================================================

interface MemberRowProps {
  /** The enriched member data */
  member: EnrichedMember;
  /** Whether this member is the current user */
  isSelf: boolean;
  /** Whether the current user can manage this member */
  canManage: boolean;
  /** Callback to change role */
  onChangeRole: (member: EnrichedMember) => void;
  /** Callback to remove */
  onRemove: (member: EnrichedMember) => void;
}

/**
 * Renders a single member row in the compact mobile list.
 *
 * @param props - See {@link MemberRowProps}
 */
function MemberRow({ member, isSelf, canManage, onChangeRole, onRemove }: MemberRowProps) {
  return (
    <View className="px-4 py-3 border-b border-zinc-800/50">
      <View className="flex-row items-center">
        {/* Avatar */}
        <View className="w-9 h-9 rounded-full bg-zinc-700 items-center justify-center mr-3 flex-shrink-0">
          <Text className="text-xs font-medium text-zinc-300">
            {getInitials(member.display_name, member.email)}
          </Text>
        </View>

        {/* Identity */}
        <View className="flex-1 min-w-0">
          <View className="flex-row items-center gap-1.5">
            <Text className="text-white font-medium text-sm flex-shrink" numberOfLines={1}>
              {member.display_name ?? member.email}
            </Text>
            {isSelf && (
              <Text className="text-zinc-500 text-xs flex-shrink-0">(you)</Text>
            )}
          </View>
          {member.display_name && (
            <Text className="text-zinc-500 text-xs" numberOfLines={1}>
              {member.email}
            </Text>
          )}
        </View>

        {/* Role */}
        <RoleBadge role={member.role} />

        {/* Actions menu */}
        {canManage && member.role !== 'owner' && !isSelf && (
          <Pressable
            onPress={() => {
              Alert.alert(
                member.display_name ?? member.email,
                'Choose an action',
                [
                  {
                    text: member.role === 'admin' ? 'Change to Member' : 'Change to Admin',
                    onPress: () => onChangeRole(member),
                  },
                  {
                    text: 'Remove from Team',
                    style: 'destructive',
                    onPress: () => onRemove(member),
                  },
                  { text: 'Cancel', style: 'cancel' },
                ],
              );
            }}
            className="ml-2 p-1.5"
            accessibilityRole="button"
            accessibilityLabel={`Manage ${member.display_name ?? member.email}`}
          >
            <Ionicons name="ellipsis-vertical" size={18} color="#71717a" />
          </Pressable>
        )}
      </View>

      {/* Metadata row */}
      <View className="flex-row gap-4 mt-1.5 ml-12">
        <Text className="text-zinc-600 text-xs">
          Joined {fmtDate(member.joined_at)}
        </Text>
        {member.last_active_at && (
          <Text className="text-zinc-600 text-xs">
            Active {fmtDate(member.last_active_at)}
          </Text>
        )}
        {member.cost_mtd_usd !== null && (
          <Text className="text-zinc-600 text-xs">
            {fmtCost(member.cost_mtd_usd)} MTD
          </Text>
        )}
      </View>
    </View>
  );
}

// ============================================================================
// Screen
// ============================================================================

/**
 * Team members screen.
 *
 * Loads team data via useTeamManagement, enriches each member with
 * last_active_at and cost_mtd_usd from direct Supabase queries, then
 * renders a FlatList with per-member action menus for owners/admins.
 *
 * Role changes and member removals call the web API routes (not direct Supabase)
 * so the server-side permission checks and audit_log writes are always executed.
 */
export default function TeamMembersScreen() {
  const router = useRouter();
  const {
    team,
    members,
    currentUserRole,
    isLoading,
    error: hookError,
    currentUserId,
    refresh,
  } = useTeamManagement();

  const [enrichedMembers, setEnrichedMembers] = useState<EnrichedMember[]>([]);
  const [isEnriching, setIsEnriching] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── Enrich members with last-active and cost MTD ──────────────────────────

  /**
   * Fetches last_active_at and cost_mtd_usd for each member and merges them
   * into the enrichedMembers state.
   *
   * WHY direct Supabase (not API route): enrichment is a read-only aggregation.
   * The user's own Supabase session is scoped to team data via RLS, so this is
   * safe to call client-side. Mutations (role change, remove) still go through
   * the API route.
   */
  const enrichMembers = useCallback(async () => {
    if (!team || members.length === 0) {
      setEnrichedMembers(members.map((m) => ({ ...m, last_active_at: null, cost_mtd_usd: null })));
      return;
    }

    setIsEnriching(true);
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const userIds = members.map((m) => m.user_id);

      const [sessionsResult, costsResult] = await Promise.all([
        supabase
          .from('sessions')
          .select('user_id, started_at')
          .eq('team_id', team.id)
          .in('user_id', userIds)
          .order('started_at', { ascending: false }),
        supabase
          .from('cost_records')
          .select('user_id, cost_usd')
          .eq('team_id', team.id)
          .in('user_id', userIds)
          .gte('recorded_at', monthStart),
      ]);

      // Build last-active lookup (sessions are ordered desc so first hit wins)
      const lastActiveByUser: Record<string, string> = {};
      for (const s of (sessionsResult.data ?? [])) {
        if (!lastActiveByUser[s.user_id as string]) {
          lastActiveByUser[s.user_id as string] = s.started_at as string;
        }
      }

      // Build cost MTD lookup
      const costByUser: Record<string, number> = {};
      for (const c of (costsResult.data ?? [])) {
        costByUser[c.user_id as string] =
          (costByUser[c.user_id as string] ?? 0) + Number(c.cost_usd);
      }

      setEnrichedMembers(
        members.map((m) => ({
          ...m,
          last_active_at: lastActiveByUser[m.user_id] ?? null,
          cost_mtd_usd:
            costByUser[m.user_id] !== undefined
              ? Math.round(costByUser[m.user_id] * 100) / 100
              : null,
        })),
      );
    } catch {
      // Fall back to unenriched on error (still shows member list)
      setEnrichedMembers(members.map((m) => ({ ...m, last_active_at: null, cost_mtd_usd: null })));
    } finally {
      setIsEnriching(false);
    }
  }, [team, members]);

  useEffect(() => {
    void enrichMembers();
  }, [enrichMembers]);

  // ── Refresh handler ───────────────────────────────────────────────────────

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refresh();
    setIsRefreshing(false);
  }, [refresh]);

  // ── Role change via API route ─────────────────────────────────────────────

  /**
   * Sends a PATCH to the web API to change a member's role.
   * The server writes audit_log on success.
   *
   * @param member - The member to change
   */
  const handleChangeRole = useCallback(
    async (member: EnrichedMember) => {
      if (!team) return;
      const newRole = member.role === 'admin' ? 'member' : 'admin';
      setActionError(null);

      try {
        const res = await fetch(
          `${getApiBaseUrl()}/api/teams/${team.id}/members/${member.user_id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: newRole }),
          },
        );

        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          setActionError(data.error ?? 'Failed to update role');
          return;
        }

        await refresh();
      } catch {
        setActionError('Network error - please try again');
      }
    },
    [team, refresh],
  );

  // ── Remove via API route ──────────────────────────────────────────────────

  /**
   * Prompts confirmation then sends a DELETE to remove a member.
   * The server writes audit_log on success.
   *
   * @param member - The member to remove
   */
  const handleRemove = useCallback(
    (member: EnrichedMember) => {
      if (!team) return;
      Alert.alert(
        'Remove member?',
        `${member.display_name ?? member.email} will lose access immediately.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              setActionError(null);
              try {
                const res = await fetch(
                  `${getApiBaseUrl()}/api/teams/${team.id}/members/${member.user_id}`,
                  { method: 'DELETE' },
                );
                if (!res.ok) {
                  const data = (await res.json()) as { error?: string };
                  setActionError(data.error ?? 'Failed to remove member');
                  return;
                }
                await refresh();
              } catch {
                setActionError('Network error - please try again');
              }
            },
          },
        ],
      );
    },
    [team, refresh],
  );

  // ── Permission check ──────────────────────────────────────────────────────

  /**
   * Determines if the current user can manage the target member.
   * Mirrors the web MembersTable canManageMember logic.
   *
   * @param member - The target member
   * @returns True if the current user can manage the target
   */
  function canManageMember(member: EnrichedMember): boolean {
    if (member.role === 'owner') return false;
    if (member.user_id === currentUserId) return false;
    if (currentUserRole === 'owner') return true;
    if (currentUserRole === 'admin' && member.role === 'member') return true;
    return false;
  }

  // ── Loading / error states ────────────────────────────────────────────────

  if (isLoading || isEnriching) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4 text-sm">Loading members...</Text>
      </View>
    );
  }

  if (!team) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="people-outline" size={48} color="#52525b" />
        <Text className="text-white text-lg font-semibold mt-4">No Team Found</Text>
        <Text className="text-zinc-500 text-center mt-2 text-sm">
          Create or join a team first.
        </Text>
        <Pressable
          onPress={() => router.back()}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text className="text-white font-semibold">Go back</Text>
        </Pressable>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-4 py-4 border-b border-zinc-800 flex-row items-center justify-between">
        <View>
          <Text className="text-white text-lg font-semibold">
            {team.name} - Members
          </Text>
          <Text className="text-zinc-500 text-sm">
            {enrichedMembers.length} member{enrichedMembers.length !== 1 ? 's' : ''}
          </Text>
        </View>

        {/* Link to Invitations panel (2.2) */}
        <Pressable
          onPress={() => router.push('/team/invitations' as never)}
          className="px-3 py-1.5 bg-orange-500/10 border border-orange-500/30 rounded-lg active:opacity-80"
          accessibilityRole="link"
          accessibilityLabel="Go to invitations"
        >
          <Text className="text-orange-400 text-xs font-medium">Invitations</Text>
        </Pressable>
      </View>

      {/* Action error banner */}
      {actionError && (
        <View className="mx-4 mt-2 bg-red-500/10 rounded-lg px-3 py-2">
          <Text className="text-red-400 text-sm">{actionError}</Text>
        </View>
      )}

      {hookError && (
        <View className="mx-4 mt-2 bg-red-500/10 rounded-lg px-3 py-2">
          <Text className="text-red-400 text-sm">{hookError}</Text>
        </View>
      )}

      {/* Members list */}
      <FlatList
        data={enrichedMembers}
        keyExtractor={(item) => item.member_id}
        renderItem={({ item }) => (
          <MemberRow
            member={item}
            isSelf={item.user_id === currentUserId}
            canManage={canManageMember(item)}
            onChangeRole={handleChangeRole}
            onRemove={handleRemove}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#f97316"
            colors={['#f97316']}
          />
        }
        ListEmptyComponent={
          <View className="items-center justify-center py-16">
            <Ionicons name="people-outline" size={40} color="#52525b" />
            <Text className="text-zinc-500 mt-4">No members yet</Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
      />
    </View>
  );
}
