'use client';

/**
 * MembersTable
 *
 * Renders the team members data table with role dropdown, remove action,
 * and cost MTD column.
 *
 * Actions are gated by the policyEngine role-matrix:
 *   - Only owners can promote/demote admins
 *   - Owners and admins can remove members (admins cannot remove other admins)
 *   - Nobody can remove the owner
 *   - Users cannot modify their own role
 *
 * WHY client component: role-change and remove are interactive mutations
 * that require useState (confirmation dialog) and fetch calls.
 *
 * @module components/team/members/MembersTable
 */

import { useState } from 'react';
import {
  Users,
  UserMinus,
  Edit,
  Shield,
} from 'lucide-react';
import {
  canRevokeMember,
  parseDbRole,
  TEAM_ADMIN_AUDIT_ACTIONS,
} from '@styrby/shared';
import type { TeamMemberAdminRow } from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

export interface MembersTableProps {
  /** Full list of team members with admin-view fields. */
  members: TeamMemberAdminRow[];
  /** The authenticated user's ID (to disable self-mutation controls). */
  currentUserId: string;
  /** The authenticated user's role (to gate action visibility). */
  currentUserRole: 'owner' | 'admin' | 'member';
  /** The team ID — used to construct API call URLs. */
  teamId: string;
  /** Called after a successful role change so the parent can refresh. */
  onRoleChanged: (userId: string, newRole: 'admin' | 'member') => void;
  /** Called after a successful member removal so the parent can refresh. */
  onMemberRemoved: (userId: string) => void;
}

// ============================================================================
// Helper: format date
// ============================================================================

/**
 * Formats an ISO date string as "MMM D, YYYY" for display.
 *
 * @param iso - ISO 8601 date string
 * @returns Human-readable date string
 *
 * @example
 * formatDate('2025-06-01T10:00:00Z'); // "Jun 1, 2025"
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Formats a nullable cost value as "$X.XX" or "-" if null.
 *
 * @param usd - Cost in USD, or null
 * @returns Formatted cost string
 */
function formatCost(usd: number | null): string {
  if (usd === null) return '-';
  return `$${usd.toFixed(2)}`;
}

// ============================================================================
// Role Badge
// ============================================================================

/**
 * Renders a coloured role chip.
 *
 * @param props.role - The member's role string
 * @returns Styled role badge span
 */
function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = {
    owner: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
    admin: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
    member: 'bg-zinc-700/50 text-zinc-400 border-zinc-600/30',
  };
  const cls = styles[role] ?? styles.member;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {role === 'owner' || role === 'admin' ? <Shield size={11} aria-hidden /> : null}
      {role.charAt(0).toUpperCase() + role.slice(1)}
    </span>
  );
}

// ============================================================================
// Confirm Remove Dialog
// ============================================================================

interface ConfirmRemoveDialogProps {
  member: TeamMemberAdminRow;
  onConfirm: () => void;
  onCancel: () => void;
  isRemoving: boolean;
}

/**
 * Inline confirmation dialog for member removal.
 * 2-step confirm pattern: prevents accidental destructive actions.
 *
 * @param props - Dialog props
 * @returns Confirmation card
 */
function ConfirmRemoveDialog({ member, onConfirm, onCancel, isRemoving }: ConfirmRemoveDialogProps) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-dialog-title"
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-sm w-full shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-red-500/10 rounded-full flex items-center justify-center flex-shrink-0">
            <UserMinus size={20} className="text-red-400" aria-hidden />
          </div>
          <div>
            <h2 id="remove-dialog-title" className="text-zinc-100 font-semibold">
              Remove member?
            </h2>
            <p className="text-zinc-400 text-sm mt-0.5">This action cannot be undone.</p>
          </div>
        </div>
        <p className="text-zinc-300 text-sm mb-6">
          <strong>{member.display_name ?? member.email}</strong> will lose access to this
          team immediately. Their sessions and cost history are preserved.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={isRemoving}
            className="flex-1 px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isRemoving}
            className="flex-1 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {isRemoving ? 'Removing...' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Team members data table with role management and member removal.
 *
 * All mutations go through the Next.js API routes which enforce RLS + role
 * checks server-side. The client-side permission gating here is a UX layer
 * only — it hides controls for actions the server would reject anyway.
 *
 * @param props - See {@link MembersTableProps}
 */
export function MembersTable({
  members,
  currentUserId,
  currentUserRole,
  teamId,
  onRoleChanged,
  onMemberRemoved,
}: MembersTableProps) {
  const [confirmRemove, setConfirmRemove] = useState<TeamMemberAdminRow | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [changingRoleFor, setChangingRoleFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ── Can current user change this member's role? ──────────────────────────
  /**
   * Determines if the current user can change the target member's role.
   *
   * WHY: Role changes are restricted to:
   *   - Owners can change any non-owner role
   *   - Admins CANNOT change other admins or owner (prevents privilege escalation)
   *   - Nobody can change their own role (UX guard, server also enforces)
   *
   * @param target - The target member
   * @returns True if the current user can change the target's role
   */
  function canChangeRole(target: TeamMemberAdminRow): boolean {
    if (target.user_id === currentUserId) return false;
    if (target.role === 'owner') return false;
    if (currentUserRole === 'owner') return true;
    // Admins cannot change other admins (prevent privilege escalation)
    if (currentUserRole === 'admin' && target.role === 'member') return true;
    return false;
  }

  /**
   * Determines if the current user can remove the target member.
   * Delegates to the shared role-matrix's canRevokeMember helper.
   *
   * @param target - The target member
   * @returns True if the current user can remove the target
   */
  function canRemove(target: TeamMemberAdminRow): boolean {
    if (target.role === 'owner') return false;
    return canRevokeMember(parseDbRole(currentUserRole));
  }

  // ── Role change handler ──────────────────────────────────────────────────

  /**
   * Sends a PATCH to /api/teams/[id]/members/[userId] to change the role.
   * Writes audit_log on the server side.
   *
   * @param member - The member whose role to change
   * @param newRole - The new role to assign
   */
  async function handleRoleChange(member: TeamMemberAdminRow, newRole: 'admin' | 'member') {
    setChangingRoleFor(member.user_id);
    setActionError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setActionError(data.error ?? 'Failed to update role');
        return;
      }
      onRoleChanged(member.user_id, newRole);
    } catch {
      setActionError('Network error - please try again');
    } finally {
      setChangingRoleFor(null);
    }
  }

  // ── Remove handler ───────────────────────────────────────────────────────

  /**
   * Executes the member removal after the 2-step confirm dialog.
   * The server also writes audit_log (action: team.member.removed).
   */
  async function handleConfirmRemove() {
    if (!confirmRemove) return;
    setIsRemoving(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/members/${confirmRemove.user_id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setActionError(data.error ?? 'Failed to remove member');
        setConfirmRemove(null);
        return;
      }
      onMemberRemoved(confirmRemove.user_id);
      setConfirmRemove(null);
    } catch {
      setActionError('Network error - please try again');
      setConfirmRemove(null);
    } finally {
      setIsRemoving(false);
    }
  }

  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Users size={40} className="text-zinc-400 mb-3" aria-hidden />
        <p className="text-zinc-400 font-medium">No members yet</p>
        <p className="text-zinc-500 text-sm mt-1">
          Invite your first team member from the Invitations panel.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Action error banner */}
      {actionError && (
        <div
          className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm"
          role="alert"
        >
          {actionError}
          <button
            className="ml-3 underline hover:no-underline text-red-300"
            onClick={() => setActionError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Desktop table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="text-left text-zinc-400 font-medium py-3 px-4">Member</th>
              <th className="text-left text-zinc-400 font-medium py-3 px-4">Role</th>
              <th className="text-left text-zinc-400 font-medium py-3 px-4 hidden md:table-cell">Joined</th>
              <th className="text-left text-zinc-400 font-medium py-3 px-4 hidden lg:table-cell">Last Active</th>
              <th className="text-right text-zinc-400 font-medium py-3 px-4 hidden lg:table-cell">Cost MTD</th>
              <th className="text-right text-zinc-400 font-medium py-3 px-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isSelf = member.user_id === currentUserId;
              const isChangingRole = changingRoleFor === member.user_id;

              return (
                <tr
                  key={member.member_id}
                  className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors"
                >
                  {/* Member identity */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center flex-shrink-0">
                        <span className="text-xs font-medium text-zinc-300">
                          {(member.display_name ?? member.email)[0].toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <div className="text-zinc-200 font-medium flex items-center gap-1.5">
                          {member.display_name ?? member.email}
                          {isSelf && <span className="text-zinc-500 text-xs">(you)</span>}
                        </div>
                        {member.display_name && (
                          <div className="text-zinc-500 text-xs">{member.email}</div>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Role — dropdown for editable roles */}
                  <td className="py-3 px-4">
                    {canChangeRole(member) ? (
                      <select
                        value={member.role}
                        disabled={isChangingRole}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === 'admin' || val === 'member') {
                            void handleRoleChange(member, val);
                          }
                        }}
                        className="bg-zinc-800 border border-zinc-700 rounded-md text-zinc-300 text-xs px-2 py-1 pr-7 focus:outline-none focus:ring-1 focus:ring-orange-500 cursor-pointer disabled:opacity-50"
                        aria-label={`Change role for ${member.display_name ?? member.email}`}
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </select>
                    ) : (
                      <RoleBadge role={member.role} />
                    )}
                    {isChangingRole && (
                      <span className="text-zinc-500 text-xs ml-2">Saving...</span>
                    )}
                  </td>

                  {/* Joined date */}
                  <td className="py-3 px-4 text-zinc-400 hidden md:table-cell">
                    {formatDate(member.joined_at)}
                  </td>

                  {/* Last active */}
                  <td className="py-3 px-4 text-zinc-400 hidden lg:table-cell">
                    {member.last_active_at ? formatDate(member.last_active_at) : '-'}
                  </td>

                  {/* Cost MTD */}
                  <td className="py-3 px-4 text-right text-zinc-300 font-mono text-xs hidden lg:table-cell">
                    {formatCost(member.cost_mtd_usd)}
                  </td>

                  {/* Actions */}
                  <td className="py-3 px-4 text-right">
                    {canRemove(member) && (
                      <button
                        onClick={() => setConfirmRemove(member)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                        aria-label={`Remove ${member.display_name ?? member.email} from team`}
                      >
                        <UserMinus size={14} aria-hidden />
                        Remove
                      </button>
                    )}
                    {canChangeRole(member) && (
                      <Edit
                        size={14}
                        className="inline text-zinc-400 ml-1"
                        aria-label="Role editable via dropdown"
                        aria-hidden
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 2-step confirm dialog */}
      {confirmRemove && (
        <ConfirmRemoveDialog
          member={confirmRemove}
          onConfirm={() => void handleConfirmRemove()}
          onCancel={() => setConfirmRemove(null)}
          isRemoving={isRemoving}
        />
      )}
    </>
  );
}
