/**
 * Accept Invite Screen
 *
 * Dedicated screen for accepting or declining team invitations received via
 * deep link. The invitation token is passed as a query parameter and validated
 * against the `team_invitations` table on mount.
 *
 * Deep link format: styrby://team/accept-invite?token=<hex-token>
 *
 * Flow:
 * 1. Mount: validate the token against team_invitations (check status, expiry)
 * 2. Show invitation details: team name, inviter email, role
 * 3. Accept: update invitation status → 'accepted', upsert team_members row
 * 4. Decline: update invitation status → 'declined'
 * 5. Handle expired/invalid tokens with a clear error state
 */

import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { z } from 'zod';
import { supabase } from '../../src/lib/supabase';

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Schema for validating the team_invitations row returned from Supabase.
 *
 * WHY: Database rows are untyped from Supabase's client. Zod validates the
 * shape before we trust it for rendering or mutation. This prevents crashes
 * if the schema changes or the query returns unexpected data.
 */
const InvitationRowSchema = z.object({
  id: z.string().uuid(),
  team_id: z.string().uuid(),
  email: z.string().email(),
  invited_by: z.string().uuid(),
  role: z.enum(['admin', 'member']),
  status: z.enum(['pending', 'accepted', 'declined', 'expired']),
  expires_at: z.string().nullable(),
  token: z.string(),
  teams: z.object({
    name: z.string(),
  }).nullable(),
  invited_by_profile: z.object({
    display_name: z.string().nullable(),
    email: z.string().nullable(),
  }).nullable().optional(),
});

/** Validated invitation data shape */
type InvitationRow = z.infer<typeof InvitationRowSchema>;

// ============================================================================
// Types
// ============================================================================

/**
 * Screen state machine values.
 *
 * WHY a union instead of separate booleans: state machines are easier to reason
 * about and prevent impossible states (e.g. loading + error simultaneously).
 */
type ScreenState =
  | { status: 'loading' }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; invitation: InvitationRow }
  | { status: 'accepting' }
  | { status: 'declining' }
  | { status: 'accepted' }
  | { status: 'declined' }
  | { status: 'error'; message: string };

// ============================================================================
// Helpers
// ============================================================================

/**
 * Checks whether an invitation token has expired.
 *
 * WHY: The database stores expiry as an ISO timestamp string. We compare
 * against Date.now() to avoid server-side round trips for this check.
 * The server is the authoritative source, but this provides a fast UX
 * guard before the accept/decline mutation.
 *
 * @param expiresAt - ISO timestamp string or null (null = no expiry)
 * @returns true if the invitation has passed its expiry time
 */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

/**
 * Returns a human-readable role label for display.
 *
 * @param role - The invitation role
 * @returns Capitalized role label
 */
function formatRole(role: 'admin' | 'member'): string {
  return role === 'admin' ? 'Admin' : 'Member';
}

// ============================================================================
// Main Screen
// ============================================================================

/**
 * Accept Invite Screen
 *
 * Handles the full invitation acceptance flow including:
 * - Token validation on mount
 * - Invitation details display
 * - Accept / Decline actions with optimistic UI
 * - Success and error states
 *
 * @returns React element
 */
export default function AcceptInviteScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [state, setState] = useState<ScreenState>({ status: 'loading' });

  // --------------------------------------------------------------------------
  // Mount: validate invitation token
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!token) {
      setState({ status: 'invalid', reason: 'No invitation token provided.' });
      return;
    }

    validateToken(token);
  }, [token]);

  /**
   * Validates the invitation token against the team_invitations table.
   *
   * WHY: We query by token (unique index) and check:
   * 1. Row exists → token is valid
   * 2. status === 'pending' → not already acted on
   * 3. expires_at → not expired
   *
   * @param inviteToken - The raw token string from the URL
   */
  const validateToken = async (inviteToken: string) => {
    try {
      // WHY: We join teams to get the team name and attempt to join profiles
      // for the inviter's display name. The invite form only records user IDs.
      const { data, error } = await supabase
        .from('team_invitations')
        .select(`
          id,
          team_id,
          email,
          invited_by,
          role,
          status,
          expires_at,
          token,
          teams (
            name
          )
        `)
        .eq('token', inviteToken)
        .single();

      if (error || !data) {
        setState({ status: 'invalid', reason: 'This invitation link is invalid or has been revoked.' });
        return;
      }

      // Validate the row shape with Zod
      const parseResult = InvitationRowSchema.safeParse(data);
      if (!parseResult.success) {
        if (__DEV__) {
          console.error('[AcceptInvite] Invalid invitation shape:', parseResult.error.issues);
        }
        setState({ status: 'invalid', reason: 'This invitation has an unexpected format.' });
        return;
      }

      const invitation = parseResult.data;

      // Check if already acted on
      if (invitation.status === 'accepted') {
        setState({ status: 'invalid', reason: 'This invitation has already been accepted.' });
        return;
      }

      if (invitation.status === 'declined') {
        setState({ status: 'invalid', reason: 'This invitation has already been declined.' });
        return;
      }

      if (invitation.status === 'expired' || isExpired(invitation.expires_at)) {
        setState({ status: 'invalid', reason: 'This invitation has expired. Please ask the team admin to send a new invitation.' });
        return;
      }

      setState({ status: 'ready', invitation });
    } catch (err) {
      if (__DEV__) {
        console.error('[AcceptInvite] Token validation error:', err);
      }
      setState({ status: 'error', message: 'Failed to load invitation. Please check your connection and try again.' });
    }
  };

  // --------------------------------------------------------------------------
  // Accept Handler
  // --------------------------------------------------------------------------

  /**
   * Accepts the invitation by:
   * 1. Updating team_invitations.status → 'accepted'
   * 2. Upserting a team_members row with the current user
   *
   * WHY upsert: The user may already have a membership row from a previous
   * invitation. Upsert avoids a unique constraint error while keeping the
   * role current.
   *
   * @param invitation - The validated invitation to accept
   */
  const handleAccept = useCallback(async (invitation: InvitationRow) => {
    setState({ status: 'accepting' });

    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();

      if (userError || !user) {
        setState({ status: 'error', message: 'You must be signed in to accept this invitation.' });
        return;
      }

      // Update invitation status first
      const { error: updateError } = await supabase
        .from('team_invitations')
        .update({ status: 'accepted' })
        .eq('id', invitation.id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      // Add user to team members
      // WHY upsert with onConflict: prevents a duplicate row error if the
      // user was previously removed and re-invited.
      const { error: memberError } = await supabase
        .from('team_members')
        .upsert(
          {
            team_id: invitation.team_id,
            user_id: user.id,
            role: invitation.role,
          },
          { onConflict: 'team_id,user_id' }
        );

      if (memberError) {
        throw new Error(memberError.message);
      }

      setState({ status: 'accepted' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to accept invitation. Please try again.';
      setState({ status: 'error', message });
      if (__DEV__) {
        console.error('[AcceptInvite] Accept error:', err);
      }
    }
  }, []);

  // --------------------------------------------------------------------------
  // Decline Handler
  // --------------------------------------------------------------------------

  /**
   * Declines the invitation by updating team_invitations.status → 'declined'.
   *
   * @param invitation - The validated invitation to decline
   */
  const handleDecline = useCallback(async (invitation: InvitationRow) => {
    setState({ status: 'declining' });

    try {
      const { error } = await supabase
        .from('team_invitations')
        .update({ status: 'declined' })
        .eq('id', invitation.id);

      if (error) {
        throw new Error(error.message);
      }

      setState({ status: 'declined' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to decline invitation. Please try again.';
      setState({ status: 'error', message });
      if (__DEV__) {
        console.error('[AcceptInvite] Decline error:', err);
      }
    }
  }, []);

  // --------------------------------------------------------------------------
  // Render: Loading
  // --------------------------------------------------------------------------

  if (state.status === 'loading') {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-400 mt-4">Validating invitation...</Text>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Invalid / Expired token
  // --------------------------------------------------------------------------

  if (state.status === 'invalid') {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <View className="w-16 h-16 rounded-full bg-red-500/10 items-center justify-center mb-4">
          <Ionicons name="close-circle-outline" size={36} color="#ef4444" />
        </View>
        <Text className="text-white text-xl font-semibold mb-2 text-center">
          Invalid Invitation
        </Text>
        <Text className="text-zinc-400 text-center mb-8">
          {state.reason}
        </Text>
        <Pressable
          onPress={() => router.replace('/(tabs)/')}
          className="bg-brand px-6 py-3 rounded-xl active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Go to dashboard"
        >
          <Text className="text-white font-semibold">Go to Dashboard</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Error
  // --------------------------------------------------------------------------

  if (state.status === 'error') {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <View className="w-16 h-16 rounded-full bg-red-500/10 items-center justify-center mb-4">
          <Ionicons name="warning-outline" size={36} color="#ef4444" />
        </View>
        <Text className="text-white text-xl font-semibold mb-2 text-center">
          Something Went Wrong
        </Text>
        <Text className="text-zinc-400 text-center mb-8">
          {state.message}
        </Text>
        <Pressable
          onPress={() => router.replace('/(tabs)/')}
          className="bg-brand px-6 py-3 rounded-xl active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Go to dashboard"
        >
          <Text className="text-white font-semibold">Go to Dashboard</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Accepted
  // --------------------------------------------------------------------------

  if (state.status === 'accepted') {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <View className="w-16 h-16 rounded-full bg-green-500/10 items-center justify-center mb-4">
          <Ionicons name="checkmark-circle" size={36} color="#22c55e" />
        </View>
        <Text className="text-white text-xl font-semibold mb-2 text-center">
          Welcome to the Team!
        </Text>
        <Text className="text-zinc-400 text-center mb-8">
          You have successfully joined the team.
        </Text>
        <Pressable
          onPress={() => router.replace('/(tabs)/team')}
          className="bg-brand px-6 py-3 rounded-xl active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="View team"
        >
          <Text className="text-white font-semibold">View Team</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Declined
  // --------------------------------------------------------------------------

  if (state.status === 'declined') {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <View className="w-16 h-16 rounded-full bg-zinc-700/50 items-center justify-center mb-4">
          <Ionicons name="close-circle-outline" size={36} color="#71717a" />
        </View>
        <Text className="text-white text-xl font-semibold mb-2 text-center">
          Invitation Declined
        </Text>
        <Text className="text-zinc-400 text-center mb-8">
          You have declined the team invitation.
        </Text>
        <Pressable
          onPress={() => router.replace('/(tabs)/')}
          className="bg-brand px-6 py-3 rounded-xl active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Go to dashboard"
        >
          <Text className="text-white font-semibold">Go to Dashboard</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Ready (show invitation details)
  // --------------------------------------------------------------------------

  const { invitation } = state;
  const teamName = invitation.teams?.name ?? 'Unknown Team';
  const isActing = state.status === 'accepting' || state.status === 'declining';

  return (
    <View className="flex-1 bg-background px-6 justify-center">
      {/* Header */}
      <View className="items-center mb-8">
        <View className="w-16 h-16 rounded-full bg-orange-500/10 items-center justify-center mb-4">
          <Ionicons name="people" size={32} color="#f97316" />
        </View>
        <Text className="text-white text-2xl font-bold text-center mb-1">
          Team Invitation
        </Text>
        <Text className="text-zinc-400 text-center">
          You have been invited to join a team
        </Text>
      </View>

      {/* Invitation Details Card */}
      <View className="bg-background-secondary rounded-2xl p-5 border border-zinc-800 mb-8">
        {/* Team Name */}
        <View className="flex-row items-center mb-4 pb-4 border-b border-zinc-800">
          <View className="w-10 h-10 rounded-xl bg-orange-500/10 items-center justify-center mr-3">
            <Ionicons name="people" size={20} color="#f97316" />
          </View>
          <View>
            <Text className="text-zinc-400 text-xs mb-0.5">Team</Text>
            <Text className="text-white font-semibold text-base">{teamName}</Text>
          </View>
        </View>

        {/* Role */}
        <View className="flex-row items-center mb-4 pb-4 border-b border-zinc-800">
          <View className="w-10 h-10 rounded-xl bg-purple-500/10 items-center justify-center mr-3">
            <Ionicons
              name={invitation.role === 'admin' ? 'shield' : 'person'}
              size={20}
              color={invitation.role === 'admin' ? '#a855f7' : '#71717a'}
            />
          </View>
          <View>
            <Text className="text-zinc-400 text-xs mb-0.5">Role</Text>
            <Text className="text-white font-semibold text-base">{formatRole(invitation.role)}</Text>
          </View>
        </View>

        {/* Invited email */}
        <View className="flex-row items-center">
          <View className="w-10 h-10 rounded-xl bg-blue-500/10 items-center justify-center mr-3">
            <Ionicons name="mail" size={20} color="#3b82f6" />
          </View>
          <View className="flex-1">
            <Text className="text-zinc-400 text-xs mb-0.5">Invited to</Text>
            <Text className="text-white font-semibold text-base" numberOfLines={1}>
              {invitation.email}
            </Text>
          </View>
        </View>
      </View>

      {/* Action Buttons */}
      <View className="gap-3">
        {/* Accept Button */}
        <Pressable
          onPress={() => handleAccept(invitation)}
          disabled={isActing}
          className={`py-4 rounded-xl items-center ${
            isActing ? 'bg-zinc-700' : 'bg-brand active:opacity-80'
          }`}
          accessibilityRole="button"
          accessibilityLabel="Accept team invitation"
          accessibilityState={{ disabled: isActing }}
        >
          {state.status === 'accepting' ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <View className="flex-row items-center">
              <Ionicons name="checkmark" size={20} color="white" />
              <Text className="text-white font-semibold text-base ml-2">Accept Invitation</Text>
            </View>
          )}
        </Pressable>

        {/* Decline Button */}
        <Pressable
          onPress={() => handleDecline(invitation)}
          disabled={isActing}
          className={`py-4 rounded-xl items-center border ${
            isActing
              ? 'border-zinc-700 bg-transparent'
              : 'border-red-500/30 bg-transparent active:bg-red-500/10'
          }`}
          accessibilityRole="button"
          accessibilityLabel="Decline team invitation"
          accessibilityState={{ disabled: isActing }}
        >
          {state.status === 'declining' ? (
            <ActivityIndicator color="#ef4444" size="small" />
          ) : (
            <Text className={`font-semibold text-base ${isActing ? 'text-zinc-600' : 'text-red-400'}`}>
              Decline
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
