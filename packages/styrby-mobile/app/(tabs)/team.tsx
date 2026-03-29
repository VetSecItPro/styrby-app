/**
 * Team Screen
 *
 * Full team management screen with create, invite, role management, and
 * member removal. Uses the useTeamManagement hook for all data operations.
 *
 * States:
 * - Loading: spinner while fetching team data
 * - No team: "Create a Team" form with name and description inputs
 * - Has team: team info header, member list with management actions,
 *   pending invitations section, and "Invite Member" button
 *
 * Power tier only. Shows an upgrade prompt for Free/Pro users.
 * Tier gating is handled at the API level; this screen relies on the
 * hook returning null team for non-Power users.
 */

import {
  View,
  Text,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Pressable,
  TextInput,
  Alert,
  Linking,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTeamManagement } from '../../src/hooks/useTeamManagement';
import { supabase } from '../../src/lib/supabase';
import { SITE_URLS } from '../../src/lib/config';
import { SubscriptionTierRowSchema } from '../../src/lib/schemas';
import type { ValidatedTeamMember, ValidatedTeamInvitation } from '../../src/lib/schemas';
import type { SubscriptionTier } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Discriminated union for FlatList items.
 * Allows mixing headers, members, and invitations in a single list.
 */
type TeamListItem =
  | { type: 'header'; title: string }
  | { type: 'member'; data: ValidatedTeamMember }
  | { type: 'invitation'; data: ValidatedTeamInvitation }
  | { type: 'invite-button' };

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Returns initials from a name or email for avatar display.
 *
 * @param name - User's display name (may be null)
 * @param email - User's email address
 * @returns 1-2 character uppercase initials
 *
 * @example
 * getInitials('John Doe', 'john@example.com'); // "JD"
 * getInitials(null, 'john@example.com'); // "J"
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

// ============================================================================
// Role Badge Component
// ============================================================================

/**
 * Renders a colored badge for team member roles.
 *
 * @param props.role - The member's role (owner, admin, member)
 * @returns Colored badge view
 */
function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    owner: { bg: 'rgba(249, 115, 22, 0.1)', text: '#f97316' },
    admin: { bg: 'rgba(168, 85, 247, 0.1)', text: '#a855f7' },
    member: { bg: 'rgba(113, 113, 122, 0.1)', text: '#71717a' },
  };

  const { bg, text } = colors[role] || colors.member;

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
  /** The team member data */
  member: ValidatedTeamMember;
  /** Whether this member is the currently authenticated user */
  isCurrentUser: boolean;
  /** Whether the current user can manage this member (change role, remove) */
  canManage: boolean;
  /** Callback to change this member's role */
  onChangeRole: (memberId: string, currentRole: string) => void;
  /** Callback to remove this member */
  onRemove: (memberId: string, displayName: string) => void;
}

/**
 * Renders a single team member card with avatar, name, email, role,
 * and optional management actions (change role, remove).
 *
 * @param props - Component props
 * @returns Rendered member card
 */
function MemberCard({ member, isCurrentUser, canManage, onChangeRole, onRemove }: MemberCardProps) {
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

      {/* Management Actions */}
      {canManage && member.role !== 'owner' && !isCurrentUser && (
        <Pressable
          onPress={() => {
            Alert.alert(
              member.display_name || member.email,
              'Choose an action',
              [
                {
                  text: member.role === 'admin' ? 'Change to Member' : 'Change to Admin',
                  onPress: () => onChangeRole(member.member_id, member.role),
                },
                {
                  text: 'Remove from Team',
                  style: 'destructive',
                  onPress: () => onRemove(member.member_id, member.display_name || member.email),
                },
                { text: 'Cancel', style: 'cancel' },
              ],
            );
          }}
          className="ml-2 p-1.5"
          accessibilityRole="button"
          accessibilityLabel={`Manage ${member.display_name || member.email}`}
        >
          <Ionicons name="ellipsis-vertical" size={18} color="#71717a" />
        </Pressable>
      )}
    </View>
  );
}

// ============================================================================
// Pending Invitation Card Component
// ============================================================================

/**
 * Renders a pending invitation with email, role, and expiration countdown.
 *
 * @param props.invitation - The invitation data
 * @returns Rendered invitation card
 */
function InvitationCard({ invitation }: { invitation: ValidatedTeamInvitation }) {
  const expiresIn = new Date(invitation.expires_at).getTime() - Date.now();
  const daysUntilExpiry = Math.max(0, Math.ceil(expiresIn / (1000 * 60 * 60 * 24)));

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
          {daysUntilExpiry > 0
            ? `Expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}`
            : 'Expired'}
        </Text>
      </View>

      {/* Role + Status */}
      <RoleBadge role={invitation.role} />
      <View className="ml-2 px-2 py-0.5 rounded-full bg-yellow-500/10">
        <Text className="text-xs font-medium text-yellow-500">Pending</Text>
      </View>
    </View>
  );
}

// ============================================================================
// Upgrade Prompt Constants & Component
// ============================================================================

/**
 * Polar customer portal URL for subscription management.
 * WHY: Polar is the merchant of record. Upgrade flows go through Polar checkout.
 */
const POLAR_CUSTOMER_PORTAL_URL = 'https://polar.sh/styrby/portal';

/** Pricing page URL for users who want to learn more before upgrading. */
const PRICING_URL = SITE_URLS.pricing;

/**
 * Power plan price displayed in the upgrade prompt.
 * WHY: Sourced from the pricing page (llms.txt: "Power $49/mo").
 * If pricing changes, update this constant and the pricing page.
 */
const POWER_PLAN_PRICE = '$49/month';

/**
 * Feature list for the Power plan upgrade prompt.
 * WHY: These map to the actual Power tier capabilities as defined in the
 * subscriptions/tier system. Keeping them in a data array avoids duplication
 * if we ever render them in multiple places.
 */
const POWER_FEATURES = [
  'Up to 3 team members',
  'Shared session visibility',
  'Team cost tracking',
  'Role-based permissions',
  'Email invitations',
] as const;

/**
 * Upgrade prompt shown to Free and Pro users who navigate to the Team tab.
 * Team collaboration is a Power-tier-only feature.
 *
 * @param props.tier - The user's current subscription tier, shown for context
 * @returns Upgrade card with feature list and action buttons
 */
function UpgradePrompt({ tier }: { tier: SubscriptionTier }) {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}
    >
      <View className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800">
        {/* Icon */}
        <View className="items-center mb-4">
          <View className="w-16 h-16 bg-orange-500/10 rounded-full items-center justify-center">
            <Ionicons name="shield-checkmark" size={48} color="#f97316" />
          </View>
        </View>

        {/* Heading */}
        <Text className="text-white text-xl font-bold text-center mb-2">
          Upgrade to Power
        </Text>
        <Text className="text-zinc-400 text-center text-base mb-6">
          Team collaboration requires the Power plan
        </Text>

        {/* Feature List */}
        <View className="mb-6">
          {POWER_FEATURES.map((feature) => (
            <View key={feature} className="flex-row items-center gap-2 mb-3">
              <Ionicons name="checkmark-circle" size={20} color="#22c55e" />
              <Text className="text-zinc-300 text-base flex-1">{feature}</Text>
            </View>
          ))}
        </View>

        {/* Price */}
        <Text className="text-white text-2xl font-bold text-center mb-1">
          {POWER_PLAN_PRICE}
        </Text>
        <Text className="text-zinc-500 text-sm text-center mb-6">
          Currently on {tier.charAt(0).toUpperCase() + tier.slice(1)} plan
        </Text>

        {/* Upgrade Button */}
        <Pressable
          onPress={() => Linking.openURL(POLAR_CUSTOMER_PORTAL_URL)}
          className="bg-orange-500 rounded-xl py-3 items-center active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Upgrade to Power plan"
        >
          <Text className="text-white font-semibold text-base">Upgrade</Text>
        </Pressable>

        {/* Learn More Link */}
        <Pressable
          onPress={() => Linking.openURL(PRICING_URL)}
          className="mt-2 py-2"
          accessibilityRole="link"
          accessibilityLabel="Learn more about pricing"
        >
          <Text className="text-orange-400 text-sm text-center">Learn More</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

// ============================================================================
// Create Team Form Component
// ============================================================================

interface CreateTeamFormProps {
  /** Callback when the team is created */
  onCreate: (name: string, description?: string) => Promise<unknown>;
  /** Whether the creation is in progress */
  isCreating: boolean;
  /** Error message to display */
  error: string | null;
}

/**
 * Renders the team creation form with name and description inputs.
 * Shown when the user does not yet belong to any team.
 *
 * @param props - Component props
 * @returns Rendered create team form
 */
function CreateTeamForm({ onCreate, isCreating, error }: CreateTeamFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  /**
   * Handles the form submission.
   */
  const handleSubmit = async () => {
    if (!name.trim()) return;
    await onCreate(name.trim(), description.trim() || undefined);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <View className="flex-1 items-center justify-center px-6">
        <View className="w-16 h-16 bg-orange-500/10 rounded-full items-center justify-center mb-4">
          <Ionicons name="people-outline" size={32} color="#f97316" />
        </View>

        <Text className="text-white text-xl font-semibold text-center mb-2">
          Create a Team
        </Text>

        <Text className="text-zinc-400 text-center mb-6">
          Start collaborating by creating a team. You can invite members after.
        </Text>

        {/* Name Input */}
        <View className="w-full mb-3">
          <Text className="text-zinc-400 text-sm mb-1.5">Team Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g., Engineering Team"
            placeholderTextColor="#52525b"
            className="bg-background-secondary text-white rounded-xl px-4 py-3 text-base"
            maxLength={100}
            autoCapitalize="words"
            returnKeyType="next"
            accessibilityLabel="Team name"
          />
        </View>

        {/* Description Input */}
        <View className="w-full mb-4">
          <Text className="text-zinc-400 text-sm mb-1.5">Description (optional)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What does this team work on?"
            placeholderTextColor="#52525b"
            className="bg-background-secondary text-white rounded-xl px-4 py-3 text-base"
            multiline
            numberOfLines={2}
            maxLength={500}
            accessibilityLabel="Team description"
          />
        </View>

        {/* Error */}
        {error && (
          <Text className="text-red-500 text-sm text-center mb-3">{error}</Text>
        )}

        {/* Submit Button */}
        <Pressable
          onPress={handleSubmit}
          disabled={isCreating || !name.trim()}
          className={`w-full py-3 rounded-xl items-center ${
            isCreating || !name.trim() ? 'bg-zinc-700' : 'bg-brand active:opacity-80'
          }`}
          accessibilityRole="button"
          accessibilityLabel="Create team"
          accessibilityState={{ disabled: isCreating || !name.trim() }}
        >
          {isCreating ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <Text className="text-white font-semibold">Create Team</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

// ============================================================================
// Main Screen
// ============================================================================

/**
 * Team management screen.
 *
 * Displays different content based on the user's team state:
 * - Loading: centered spinner
 * - Error: error message with retry button
 * - No team: create team form
 * - Has team: team header, member list with management actions,
 *   pending invitations, and invite button
 */
export default function TeamScreen() {
  const {
    team,
    currentUserRole,
    members,
    invitations,
    isLoading,
    isMutating,
    error,
    currentUserId,
    createTeam,
    updateMemberRole,
    removeMember,
    refresh,
  } = useTeamManagement();

  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);

  /**
   * The user's subscription tier, used to gate team features.
   * WHY: Team collaboration is Power-tier only. Free and Pro users see an
   * upgrade prompt instead of the create team form. We fetch the tier separately
   * because useTeamManagement does not expose it — tier gating is a UI concern.
   */
  const [subscriptionTier, setSubscriptionTier] = useState<SubscriptionTier | null>(null);

  /**
   * Whether the subscription tier is still loading.
   * WHY: Separate from the team hook's isLoading to avoid showing incorrect
   * UI (e.g., the create team form) before we know the user's tier.
   */
  const [isTierLoading, setIsTierLoading] = useState(true);

  /**
   * Fetches the user's subscription tier from the subscriptions table.
   * Defaults to 'free' if no subscription row exists.
   */
  useEffect(() => {
    const loadTier = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          setSubscriptionTier('free');
          setIsTierLoading(false);
          return;
        }

        const { data, error: subError } = await supabase
          .from('subscriptions')
          .select('tier')
          .eq('user_id', user.id)
          .single();

        if (!subError && data) {
          // WHY: Validate the tier value through Zod before casting to SubscriptionTier.
          // An unvalidated `data.tier as SubscriptionTier` would silently pass unknown
          // tier strings (e.g., from future DB migrations) into the UI, causing
          // incorrect conditional rendering or crashes in downstream switch statements.
          const parsed = SubscriptionTierRowSchema.safeParse(data);
          const tierStr = parsed.success ? parsed.data.tier : 'free';
          setSubscriptionTier(tierStr as SubscriptionTier);
        } else {
          setSubscriptionTier('free');
        }
      } catch {
        // Default to free on error — worst case they see the upgrade prompt
        setSubscriptionTier('free');
      } finally {
        setIsTierLoading(false);
      }
    };

    loadTier();
  }, []);

  /**
   * Handles pull-to-refresh.
   */
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refresh();
    setIsRefreshing(false);
  }, [refresh]);

  /**
   * Handles changing a member's role.
   * Toggles between 'admin' and 'member'.
   *
   * @param memberId - The team_members.id to update
   * @param currentRole - The member's current role
   */
  const handleChangeRole = useCallback(
    async (memberId: string, currentRole: string) => {
      const newRole = currentRole === 'admin' ? 'member' : 'admin';
      const success = await updateMemberRole(memberId, newRole as 'admin' | 'member');
      if (!success && __DEV__) {
        console.warn('[TeamScreen] Failed to update role for member:', memberId);
      }
    },
    [updateMemberRole],
  );

  /**
   * Handles removing a member with a confirmation dialog.
   *
   * @param memberId - The team_members.id to remove
   * @param displayName - Name or email shown in the confirmation dialog
   */
  const handleRemove = useCallback(
    (memberId: string, displayName: string) => {
      Alert.alert(
        'Remove Member',
        `Are you sure you want to remove ${displayName} from the team?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              await removeMember(memberId);
            },
          },
        ],
      );
    },
    [removeMember],
  );

  // ---- Loading State ----
  // WHY: Wait for both team data AND subscription tier before rendering.
  // Without tier info, we cannot decide whether to show the upgrade prompt
  // or the create team form.
  if (isLoading || isTierLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading team...</Text>
      </View>
    );
  }

  // ---- Error State (only when no team data at all) ----
  if (error && !team) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="text-white text-lg font-semibold mt-4">
          Failed to Load Team
        </Text>
        <Text className="text-zinc-500 text-center mt-2">{error}</Text>
        <Pressable
          onPress={refresh}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Retry loading team"
        >
          <Text className="text-white font-semibold">Try Again</Text>
        </Pressable>
      </View>
    );
  }

  // ---- No Team: Show Upgrade Prompt or Create Form ----
  if (!team) {
    // WHY: Team features are Power-tier only. Free and Pro users should see
    // an upgrade prompt explaining the feature and its benefits, rather than
    // a create team form that would fail at the API level anyway.
    const effectiveTier = subscriptionTier ?? 'free';
    if (effectiveTier === 'free' || effectiveTier === 'pro') {
      return <UpgradePrompt tier={effectiveTier} />;
    }

    return (
      <CreateTeamForm
        onCreate={createTeam}
        isCreating={isMutating}
        error={error}
      />
    );
  }

  // ---- Team View ----
  const canManageMembers = currentUserRole === 'owner' || currentUserRole === 'admin';

  // WHY: We determine what an admin can manage vs what an owner can manage.
  // Owners can manage anyone. Admins can manage members but not other admins.
  const canManageMember = (member: ValidatedTeamMember): boolean => {
    if (member.role === 'owner') return false;
    if (member.user_id === currentUserId) return false;
    if (currentUserRole === 'owner') return true;
    if (currentUserRole === 'admin' && member.role === 'member') return true;
    return false;
  };

  // Build the flat list data
  const listData: TeamListItem[] = [
    { type: 'header', title: 'Members' },
    ...members.map((m): TeamListItem => ({ type: 'member', data: m })),
  ];

  // Add invite button for owners/admins
  if (canManageMembers) {
    listData.push({ type: 'invite-button' });
  }

  // Add pending invitations section for owners/admins
  if (canManageMembers && invitations.length > 0) {
    listData.push({ type: 'header', title: 'Pending Invitations' });
    for (const inv of invitations) {
      listData.push({ type: 'invitation', data: inv });
    }
  }

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
        </View>

        <View className="flex-row items-center mt-3">
          <Text className="text-zinc-500 text-sm">
            {members.length} member{members.length !== 1 ? 's' : ''}
          </Text>
          {invitations.length > 0 && (
            <Text className="text-zinc-500 text-sm ml-3">
              {invitations.length} pending
            </Text>
          )}
        </View>
      </View>

      {/* Error Banner (inline for mutation errors) */}
      {error && (
        <View className="mx-4 mt-2 bg-red-500/10 rounded-lg px-3 py-2">
          <Text className="text-red-400 text-sm">{error}</Text>
        </View>
      )}

      <FlatList<TeamListItem>
        data={listData}
        keyExtractor={(item, index) => {
          if (item.type === 'header') return `header-${item.title}`;
          if (item.type === 'member') return item.data.member_id;
          if (item.type === 'invitation') return item.data.id;
          return `invite-button-${index}`;
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
                member={item.data}
                isCurrentUser={item.data.user_id === currentUserId}
                canManage={canManageMember(item.data)}
                onChangeRole={handleChangeRole}
                onRemove={handleRemove}
              />
            );
          }
          if (item.type === 'invitation') {
            return <InvitationCard invitation={item.data} />;
          }
          // Invite button
          return (
            <Pressable
              onPress={() => router.push('/team/invite')}
              className="mx-4 mt-3 bg-brand/10 border border-brand/30 rounded-xl py-3 flex-row items-center justify-center active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="Invite a team member"
            >
              <Ionicons name="person-add" size={18} color="#f97316" />
              <Text className="text-brand font-semibold ml-2">Invite Member</Text>
            </Pressable>
          );
        }}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#f97316"
            colors={['#f97316']}
          />
        }
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </View>
  );
}
