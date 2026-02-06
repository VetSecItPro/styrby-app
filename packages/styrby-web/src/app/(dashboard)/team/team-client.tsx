'use client';

/**
 * Team Management Client Component
 *
 * Handles all interactive team management features:
 * - Create team
 * - Team overview and settings
 * - Member list with role management
 * - Invite modal
 * - Remove member confirmation
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

interface User {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface Team {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

interface Member {
  id: string;
  user_id: string;
  role: string;
  display_name: string | null;
  email: string;
  avatar_url: string | null;
  joined_at: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
}

interface TeamClientProps {
  user: User;
  team: Team | null;
  members: Member[];
  pendingInvitations: Invitation[];
  currentUserRole: 'owner' | 'admin' | 'member' | null;
  teamLimit: number;
}

/**
 * Formats an ISO date string to a human-readable format.
 */
function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Returns initials from a name or email.
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

export function TeamClient({
  user,
  team,
  members,
  pendingInvitations,
  currentUserRole,
  teamLimit,
}: TeamClientProps) {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [teamDescription, setTeamDescription] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [isInviting, setIsInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const [memberToUpdateRole, setMemberToUpdateRole] = useState<Member | null>(null);
  const [newRole, setNewRole] = useState<'admin' | 'member'>('member');
  const [isUpdatingRole, setIsUpdatingRole] = useState(false);

  const isOwner = currentUserRole === 'owner';
  const isAdmin = currentUserRole === 'admin';
  const canManageMembers = isOwner || isAdmin;

  /**
   * Creates a new team.
   */
  async function handleCreateTeam(e: React.FormEvent) {
    e.preventDefault();
    setIsCreating(true);
    setCreateError(null);

    try {
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: teamName, description: teamDescription || undefined }),
      });

      const data = await res.json();

      if (!res.ok) {
        setCreateError(data.error || 'Failed to create team');
        setIsCreating(false);
        return;
      }

      // Refresh the page to show the new team
      router.refresh();
    } catch {
      setCreateError('An unexpected error occurred');
      setIsCreating(false);
    }
  }

  /**
   * Invites a new member to the team.
   */
  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!team) return;

    setIsInviting(true);
    setInviteError(null);

    try {
      const res = await fetch(`/api/teams/${team.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });

      const data = await res.json();

      if (!res.ok) {
        setInviteError(data.error || 'Failed to send invitation');
        setIsInviting(false);
        return;
      }

      // Close modal and refresh
      setShowInviteModal(false);
      setInviteEmail('');
      setInviteRole('member');
      router.refresh();
    } catch {
      setInviteError('An unexpected error occurred');
      setIsInviting(false);
    }
  }

  /**
   * Removes a member from the team.
   */
  async function handleRemoveMember() {
    if (!team || !memberToRemove) return;

    setIsRemoving(true);

    try {
      const res = await fetch(`/api/teams/${team.id}/members/${memberToRemove.user_id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to remove member');
        setIsRemoving(false);
        return;
      }

      setMemberToRemove(null);
      router.refresh();
    } catch {
      alert('An unexpected error occurred');
      setIsRemoving(false);
    }
  }

  /**
   * Updates a member's role.
   */
  async function handleUpdateRole() {
    if (!team || !memberToUpdateRole) return;

    setIsUpdatingRole(true);

    try {
      const res = await fetch(`/api/teams/${team.id}/members/${memberToUpdateRole.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to update role');
        setIsUpdatingRole(false);
        return;
      }

      setMemberToUpdateRole(null);
      router.refresh();
    } catch {
      alert('An unexpected error occurred');
      setIsUpdatingRole(false);
    }
  }

  // No team yet - show create form
  if (!team) {
    return (
      <div className="bg-zinc-900 rounded-2xl p-8">
        <div className="max-w-md mx-auto">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-orange-500"
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
            <h2 className="text-xl font-semibold text-zinc-100 mb-2">
              Create Your Team
            </h2>
            <p className="text-zinc-400">
              Get started by creating a team to collaborate with others.
            </p>
          </div>

          <form onSubmit={handleCreateTeam} className="space-y-4">
            <div>
              <label htmlFor="teamName" className="block text-sm font-medium text-zinc-300 mb-2">
                Team Name
              </label>
              <input
                id="teamName"
                type="text"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="e.g., Engineering Team"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                required
                maxLength={100}
              />
            </div>

            <div>
              <label htmlFor="teamDescription" className="block text-sm font-medium text-zinc-300 mb-2">
                Description <span className="text-zinc-500">(optional)</span>
              </label>
              <textarea
                id="teamDescription"
                value={teamDescription}
                onChange={(e) => setTeamDescription(e.target.value)}
                placeholder="What does your team work on?"
                rows={3}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent resize-none"
                maxLength={500}
              />
            </div>

            {createError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm text-red-400">
                {createError}
              </div>
            )}

            <button
              type="submit"
              disabled={isCreating || !teamName.trim()}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-500/50 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-semibold transition-colors"
            >
              {isCreating ? 'Creating...' : 'Create Team'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Has team - show team management
  const totalSlots = teamLimit;
  const usedSlots = members.length + pendingInvitations.length;
  const availableSlots = totalSlots - usedSlots;

  return (
    <div className="space-y-6">
      {/* Team Overview Card */}
      <div className="bg-zinc-900 rounded-2xl p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-orange-500/20 rounded-xl flex items-center justify-center">
              <span className="text-2xl font-bold text-orange-500">
                {team.name[0].toUpperCase()}
              </span>
            </div>
            <div>
              <h2 className="text-xl font-semibold text-zinc-100">{team.name}</h2>
              {team.description && (
                <p className="text-zinc-400 mt-1">{team.description}</p>
              )}
              <div className="flex items-center gap-4 mt-2 text-sm text-zinc-500">
                <span>{members.length} member{members.length !== 1 ? 's' : ''}</span>
                <span>Created {formatDate(team.created_at)}</span>
              </div>
            </div>
          </div>

          {canManageMembers && (
            <button
              onClick={() => setShowInviteModal(true)}
              disabled={availableSlots <= 0}
              className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:bg-zinc-700 disabled:text-zinc-400 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg font-medium transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Invite
            </button>
          )}
        </div>

        {/* Member limit indicator */}
        <div className="mt-4 pt-4 border-t border-zinc-800">
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Team capacity</span>
            <span className="text-zinc-300">
              {usedSlots} / {totalSlots} members
            </span>
          </div>
          <div className="mt-2 h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                usedSlots >= totalSlots ? 'bg-red-500' : 'bg-orange-500'
              }`}
              style={{ width: `${Math.min((usedSlots / totalSlots) * 100, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Members List */}
      <div className="bg-zinc-900 rounded-2xl">
        <div className="px-6 py-4 border-b border-zinc-800">
          <h3 className="font-semibold text-zinc-100">Members</h3>
        </div>

        <div className="divide-y divide-zinc-800">
          {members.map((member) => {
            const isCurrentUser = member.user_id === user.id;
            const canModify = isOwner && !isCurrentUser && member.role !== 'owner';
            const canRemove =
              (isOwner && !isCurrentUser) ||
              (isAdmin && member.role === 'member') ||
              isCurrentUser;

            return (
              <div key={member.id} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {member.avatar_url ? (
                    <Image
                      src={member.avatar_url}
                      alt={member.display_name || member.email}
                      width={40}
                      height={40}
                      className="rounded-full"
                    />
                  ) : (
                    <div className="w-10 h-10 bg-zinc-700 rounded-full flex items-center justify-center">
                      <span className="text-sm font-medium text-zinc-300">
                        {getInitials(member.display_name, member.email)}
                      </span>
                    </div>
                  )}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-100">
                        {member.display_name || member.email}
                      </span>
                      {isCurrentUser && (
                        <span className="text-xs text-zinc-500">(you)</span>
                      )}
                    </div>
                    <span className="text-sm text-zinc-400">{member.email}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {/* Role badge */}
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-medium ${
                      member.role === 'owner'
                        ? 'bg-orange-500/10 text-orange-400'
                        : member.role === 'admin'
                        ? 'bg-purple-500/10 text-purple-400'
                        : 'bg-zinc-700 text-zinc-400'
                    }`}
                  >
                    {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                  </span>

                  {/* Actions dropdown */}
                  {(canModify || canRemove) && (
                    <div className="relative group">
                      <button className="p-2 text-zinc-400 hover:text-zinc-100 rounded-lg hover:bg-zinc-800">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
                          />
                        </svg>
                      </button>
                      <div className="absolute right-0 mt-1 w-40 bg-zinc-800 rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                        {canModify && (
                          <button
                            onClick={() => {
                              setMemberToUpdateRole(member);
                              setNewRole(member.role === 'admin' ? 'member' : 'admin');
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700 first:rounded-t-lg"
                          >
                            Change role
                          </button>
                        )}
                        {canRemove && (
                          <button
                            onClick={() => setMemberToRemove(member)}
                            className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-zinc-700 last:rounded-b-lg"
                          >
                            {isCurrentUser ? 'Leave team' : 'Remove'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pending Invitations */}
      {pendingInvitations.length > 0 && canManageMembers && (
        <div className="bg-zinc-900 rounded-2xl">
          <div className="px-6 py-4 border-b border-zinc-800">
            <h3 className="font-semibold text-zinc-100">Pending Invitations</h3>
          </div>

          <div className="divide-y divide-zinc-800">
            {pendingInvitations.map((invite) => (
              <div key={invite.id} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-zinc-700 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                  <div>
                    <span className="font-medium text-zinc-100">{invite.email}</span>
                    <div className="text-sm text-zinc-500">
                      Expires {formatDate(invite.expires_at)}
                    </div>
                  </div>
                </div>

                <span
                  className={`px-3 py-1 rounded-full text-xs font-medium ${
                    invite.role === 'admin'
                      ? 'bg-purple-500/10 text-purple-400'
                      : 'bg-zinc-700 text-zinc-400'
                  }`}
                >
                  {invite.role.charAt(0).toUpperCase() + invite.role.slice(1)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Invite Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 rounded-2xl p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-zinc-100 mb-4">
              Invite Team Member
            </h3>

            <form onSubmit={handleInvite} className="space-y-4">
              <div>
                <label htmlFor="inviteEmail" className="block text-sm font-medium text-zinc-300 mb-2">
                  Email Address
                </label>
                <input
                  id="inviteEmail"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@company.com"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                  required
                />
              </div>

              <div>
                <label htmlFor="inviteRole" className="block text-sm font-medium text-zinc-300 mb-2">
                  Role
                </label>
                <select
                  id="inviteRole"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                >
                  <option value="member">Member - Can view team sessions</option>
                  <option value="admin">Admin - Can invite and manage members</option>
                </select>
              </div>

              {inviteError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm text-red-400">
                  {inviteError}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowInviteModal(false);
                    setInviteEmail('');
                    setInviteError(null);
                  }}
                  className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-4 py-3 rounded-lg font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isInviting || !inviteEmail.trim()}
                  className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-500/50 disabled:cursor-not-allowed text-white px-4 py-3 rounded-lg font-medium transition-colors"
                >
                  {isInviting ? 'Sending...' : 'Send Invite'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Remove Member Modal */}
      {memberToRemove && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 rounded-2xl p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-zinc-100 mb-2">
              {memberToRemove.user_id === user.id ? 'Leave Team?' : 'Remove Member?'}
            </h3>
            <p className="text-zinc-400 mb-6">
              {memberToRemove.user_id === user.id
                ? 'Are you sure you want to leave this team? You will lose access to team sessions.'
                : `Are you sure you want to remove ${memberToRemove.display_name || memberToRemove.email} from the team?`}
            </p>

            <div className="flex gap-3">
              <button
                onClick={() => setMemberToRemove(null)}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-4 py-3 rounded-lg font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRemoveMember}
                disabled={isRemoving}
                className="flex-1 bg-red-500 hover:bg-red-600 disabled:bg-red-500/50 text-white px-4 py-3 rounded-lg font-medium transition-colors"
              >
                {isRemoving
                  ? 'Removing...'
                  : memberToRemove.user_id === user.id
                  ? 'Leave'
                  : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Update Role Modal */}
      {memberToUpdateRole && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 rounded-2xl p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-zinc-100 mb-2">
              Change Role
            </h3>
            <p className="text-zinc-400 mb-4">
              Update the role for {memberToUpdateRole.display_name || memberToUpdateRole.email}
            </p>

            <div className="space-y-3 mb-6">
              <label className="flex items-center gap-3 p-3 bg-zinc-800 rounded-lg cursor-pointer">
                <input
                  type="radio"
                  name="role"
                  value="member"
                  checked={newRole === 'member'}
                  onChange={() => setNewRole('member')}
                  className="text-orange-500 focus:ring-orange-500"
                />
                <div>
                  <div className="font-medium text-zinc-100">Member</div>
                  <div className="text-sm text-zinc-400">Can view team sessions</div>
                </div>
              </label>
              <label className="flex items-center gap-3 p-3 bg-zinc-800 rounded-lg cursor-pointer">
                <input
                  type="radio"
                  name="role"
                  value="admin"
                  checked={newRole === 'admin'}
                  onChange={() => setNewRole('admin')}
                  className="text-orange-500 focus:ring-orange-500"
                />
                <div>
                  <div className="font-medium text-zinc-100">Admin</div>
                  <div className="text-sm text-zinc-400">Can invite and manage members</div>
                </div>
              </label>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setMemberToUpdateRole(null)}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-4 py-3 rounded-lg font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateRole}
                disabled={isUpdatingRole || newRole === memberToUpdateRole.role}
                className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-500/50 disabled:cursor-not-allowed text-white px-4 py-3 rounded-lg font-medium transition-colors"
              >
                {isUpdatingRole ? 'Updating...' : 'Update Role'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
