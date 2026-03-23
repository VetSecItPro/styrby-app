/**
 * Invite Member Screen
 *
 * Allows team owners and admins to invite new members by email address.
 * The user selects a role (admin or member) and submits the invitation.
 * On success, navigates back to the team screen.
 *
 * This screen uses Supabase directly instead of useTeamManagement() to
 * avoid instantiating a duplicate hook that re-fetches all team data.
 * A role guard ensures only owners and admins can access this screen.
 */

import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { supabase } from '../../src/lib/supabase';

// ============================================================================
// Types
// ============================================================================

/** Valid roles that can be assigned to invited members. */
type InviteRole = 'admin' | 'member';

/** Authorization state for the current user. */
interface AuthState {
  /** Whether the auth check is still in progress */
  checking: boolean;
  /** Whether the user is authorized (owner or admin of a team) */
  authorized: boolean;
  /** The user's auth ID */
  userId: string | null;
  /** The user's team ID */
  teamId: string | null;
  /** The user's team name (for display) */
  teamName: string | null;
  /** Error message if auth check failed */
  errorMessage: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generates a cryptographically secure invitation token.
 *
 * WHY: Math.random() is not a CSPRNG and produces predictable tokens.
 * Invitation tokens grant team membership, so predictable tokens are
 * a privilege escalation vector. expo-crypto uses the platform's CSPRNG.
 *
 * @returns A 32-character hex string token
 */
function generateInviteToken(): string {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Main Screen
// ============================================================================

/**
 * Invite Member Screen
 *
 * Provides a form with:
 * 1. Role guard that checks owner/admin status before rendering
 * 2. Email input for the invitee's address
 * 3. Role picker to choose admin or member
 * 4. Send Invitation button with loading state
 * 5. Success/error feedback
 */
export default function InviteMemberScreen() {
  const router = useRouter();

  const [authState, setAuthState] = useState<AuthState>({
    checking: true,
    authorized: false,
    userId: null,
    teamId: null,
    teamName: null,
    errorMessage: null,
  });

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [isMutating, setIsMutating] = useState(false);
  const [success, setSuccess] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // --------------------------------------------------------------------------
  // [H3] Role Guard: verify the user is an owner or admin before rendering
  // --------------------------------------------------------------------------

  useEffect(() => {
    /**
     * Checks that the current user is authenticated and has an owner or
     * admin role on a team. Sets authState accordingly.
     */
    const checkAuthorization = async () => {
      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          setAuthState({
            checking: false,
            authorized: false,
            userId: null,
            teamId: null,
            teamName: null,
            errorMessage: 'You must be signed in to invite members.',
          });
          return;
        }

        // Check team membership and role
        const { data: membership, error: memberError } = await supabase
          .from('team_members')
          .select('team_id, role, teams(name)')
          .eq('user_id', user.id)
          .in('role', ['owner', 'admin'])
          .limit(1)
          .single();

        if (memberError || !membership) {
          setAuthState({
            checking: false,
            authorized: false,
            userId: user.id,
            teamId: null,
            teamName: null,
            errorMessage: 'You must be a team owner or admin to invite members.',
          });
          return;
        }

        // WHY: The teams join returns an object (single relation), extract the name safely.
        const teamName =
          membership.teams &&
          typeof membership.teams === 'object' &&
          'name' in membership.teams
            ? (membership.teams as { name: string }).name
            : 'your team';

        setAuthState({
          checking: false,
          authorized: true,
          userId: user.id,
          teamId: membership.team_id,
          teamName,
          errorMessage: null,
        });
      } catch (err) {
        setAuthState({
          checking: false,
          authorized: false,
          userId: null,
          teamId: null,
          teamName: null,
          errorMessage: 'Failed to verify permissions.',
        });
        if (__DEV__) {
          console.error('[InviteMemberScreen] Auth check failed:', err);
        }
      }
    };

    checkAuthorization();
  }, []);

  // --------------------------------------------------------------------------
  // Email validation
  // --------------------------------------------------------------------------

  /**
   * Validates the email format before sending.
   *
   * @param emailToCheck - The email string to validate
   * @returns True if the email appears valid
   */
  const isValidEmail = (emailToCheck: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailToCheck.trim());
  };

  // --------------------------------------------------------------------------
  // [H2] Invite submission using Supabase directly (no duplicate hook)
  // --------------------------------------------------------------------------

  /**
   * Handles the invitation submission.
   * Validates input, inserts directly into team_invitations, and shows feedback.
   */
  const handleSubmit = useCallback(async () => {
    setLocalError(null);
    setSuccess(false);

    const trimmedEmail = email.trim().toLowerCase();

    if (!trimmedEmail) {
      setLocalError('Please enter an email address.');
      return;
    }

    if (!isValidEmail(trimmedEmail)) {
      setLocalError('Please enter a valid email address.');
      return;
    }

    if (!authState.teamId || !authState.userId) {
      setLocalError('Unable to send invitation. Please go back and try again.');
      return;
    }

    setIsMutating(true);

    try {
      const token = generateInviteToken();

      const { error: insertError } = await supabase
        .from('team_invitations')
        .insert({
          team_id: authState.teamId,
          email: trimmedEmail,
          invited_by: authState.userId,
          role,
          token,
          status: 'pending',
        });

      if (insertError) {
        // Handle unique constraint violation (already invited)
        if (insertError.code === '23505') {
          setLocalError('This email has already been invited to the team.');
          return;
        }
        throw new Error(insertError.message);
      }

      setSuccess(true);
      setEmail('');
      // Navigate back after a brief delay so the user sees the success message
      setTimeout(() => {
        router.back();
      }, 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send invitation';
      setLocalError(message);
      if (__DEV__) {
        console.error('[InviteMemberScreen] Error inviting member:', err);
      }
    } finally {
      setIsMutating(false);
    }
  }, [email, role, authState.teamId, authState.userId, router]);

  // --------------------------------------------------------------------------
  // Loading state while checking authorization
  // --------------------------------------------------------------------------

  if (authState.checking) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator color="#f97316" size="large" />
        <Text className="text-zinc-400 mt-4">Checking permissions...</Text>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Unauthorized state
  // --------------------------------------------------------------------------

  if (!authState.authorized) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="shield-outline" size={48} color="#ef4444" />
        <Text className="text-zinc-300 text-center mt-4 text-base font-medium">
          Unauthorized
        </Text>
        <Text className="text-zinc-400 text-center mt-2">
          {authState.errorMessage || 'You do not have permission to invite members.'}
        </Text>
        <Pressable
          onPress={() => router.back()}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text className="text-white font-semibold">Go Back</Text>
        </Pressable>
      </View>
    );
  }

  // --------------------------------------------------------------------------
  // Authorized: render invite form
  // --------------------------------------------------------------------------

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <View className="flex-1 px-6 pt-8">
        {/* Header */}
        <View className="items-center mb-8">
          <View className="w-14 h-14 bg-orange-500/10 rounded-full items-center justify-center mb-3">
            <Ionicons name="person-add" size={28} color="#f97316" />
          </View>
          <Text className="text-white text-xl font-semibold">Invite Member</Text>
          <Text className="text-zinc-400 text-center mt-1">
            Send an invitation to join {authState.teamName}
          </Text>
        </View>

        {/* Email Input */}
        <View className="mb-4">
          <Text className="text-zinc-400 text-sm mb-1.5">Email Address</Text>
          <TextInput
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              setLocalError(null);
              setSuccess(false);
            }}
            placeholder="colleague@company.com"
            placeholderTextColor="#52525b"
            className="bg-background-secondary text-white rounded-xl px-4 py-3 text-base"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            editable={!isMutating}
            accessibilityLabel="Invitee email address"
          />
        </View>

        {/* Role Picker */}
        <View className="mb-6">
          <Text className="text-zinc-400 text-sm mb-1.5">Role</Text>
          <View className="flex-row gap-3">
            {/* Member Button */}
            <Pressable
              onPress={() => setRole('member')}
              className={`flex-1 rounded-xl py-3 px-4 border ${
                role === 'member'
                  ? 'border-brand bg-brand/10'
                  : 'border-zinc-800 bg-background-secondary'
              }`}
              accessibilityRole="button"
              accessibilityLabel="Set role to member"
              accessibilityState={{ selected: role === 'member' }}
            >
              <View className="flex-row items-center mb-1">
                <Ionicons
                  name="person"
                  size={16}
                  color={role === 'member' ? '#f97316' : '#71717a'}
                />
                <Text
                  className={`font-medium ml-1.5 ${
                    role === 'member' ? 'text-brand' : 'text-zinc-400'
                  }`}
                >
                  Member
                </Text>
              </View>
              <Text className="text-zinc-500 text-xs">
                View team sessions
              </Text>
            </Pressable>

            {/* Admin Button */}
            <Pressable
              onPress={() => setRole('admin')}
              className={`flex-1 rounded-xl py-3 px-4 border ${
                role === 'admin'
                  ? 'border-purple-500 bg-purple-500/10'
                  : 'border-zinc-800 bg-background-secondary'
              }`}
              accessibilityRole="button"
              accessibilityLabel="Set role to admin"
              accessibilityState={{ selected: role === 'admin' }}
            >
              <View className="flex-row items-center mb-1">
                <Ionicons
                  name="shield"
                  size={16}
                  color={role === 'admin' ? '#a855f7' : '#71717a'}
                />
                <Text
                  className={`font-medium ml-1.5 ${
                    role === 'admin' ? 'text-purple-400' : 'text-zinc-400'
                  }`}
                >
                  Admin
                </Text>
              </View>
              <Text className="text-zinc-500 text-xs">
                Manage members
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Error Message */}
        {localError && !success && (
          <View className="bg-red-500/10 rounded-lg px-3 py-2 mb-4">
            <Text className="text-red-400 text-sm">{localError}</Text>
          </View>
        )}

        {/* Success Message */}
        {success && (
          <View className="bg-green-500/10 rounded-lg px-3 py-2 mb-4 flex-row items-center">
            <Ionicons name="checkmark-circle" size={18} color="#22c55e" />
            <Text className="text-green-400 text-sm ml-2">
              Invitation sent successfully
            </Text>
          </View>
        )}

        {/* Submit Button */}
        <Pressable
          onPress={handleSubmit}
          disabled={isMutating || !email.trim() || success}
          className={`py-3 rounded-xl items-center ${
            isMutating || !email.trim() || success
              ? 'bg-zinc-700'
              : 'bg-brand active:opacity-80'
          }`}
          accessibilityRole="button"
          accessibilityLabel="Send invitation"
          accessibilityState={{ disabled: isMutating || !email.trim() || success }}
        >
          {isMutating ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <Text className="text-white font-semibold">Send Invitation</Text>
          )}
        </Pressable>

        {/* Cancel Link */}
        <Pressable
          onPress={() => router.back()}
          className="items-center mt-4 py-2"
          accessibilityRole="button"
          accessibilityLabel="Cancel and go back"
        >
          <Text className="text-zinc-500 text-sm">Cancel</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
