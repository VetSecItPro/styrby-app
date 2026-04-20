/**
 * Role → permission matrix (Phase 2.1).
 *
 * Single source of truth for "can role X do Y?" across CLI, web, and
 * mobile. Every governance UI MUST import from here instead of
 * re-deriving the check inline — otherwise a member screen on mobile
 * and admin screen on web can disagree about who can approve, which
 * is a SOC2 CC6 (Logical Access) defect.
 *
 * The matrix pairs with migration 021 RLS policies. RLS is the
 * enforcement boundary; this matrix is the *UI* contract that keeps
 * the frontends honest before they hit the server.
 *
 * @module team/role-matrix
 */

import type { Permission, PolicyRole } from './types.js';

/**
 * The full permission matrix.
 *
 * WHY frozen object + explicit listing rather than a boolean-returning
 * switch: freezing the literal makes it trivially testable (tests
 * assert directly on MATRIX[role][perm]) and trivially auditable by
 * humans. A switch hides the matrix in control flow.
 */
export const ROLE_PERMISSION_MATRIX: Readonly<
  Record<PolicyRole, Readonly<Record<Permission, boolean>>>
> = Object.freeze({
  owner: Object.freeze({
    invite: true,
    revokeMember: true,
    approve: true,
    editPolicy: true,
    manageBilling: true,
  }),
  admin: Object.freeze({
    invite: true,
    revokeMember: true,
    approve: true,
    editPolicy: true,
    manageBilling: false, // only owners touch billing
  }),
  approver: Object.freeze({
    // 'approver' is a policy-scoped capability: designated users can
    // approve, but they cannot manage team membership or policy.
    invite: false,
    revokeMember: false,
    approve: true,
    editPolicy: false,
    manageBilling: false,
  }),
  member: Object.freeze({
    invite: false,
    revokeMember: false,
    approve: false,
    editPolicy: false,
    manageBilling: false,
  }),
});

/**
 * Generic permission check. Prefer the named helpers below for
 * call-site readability.
 *
 * @param role - Role of the acting user
 * @param permission - Governance permission being checked
 * @returns `true` if the role grants the permission
 */
export function hasPermission(
  role: PolicyRole,
  permission: Permission,
): boolean {
  return ROLE_PERMISSION_MATRIX[role][permission];
}

/** Can this role invite new members to the team? */
export function canInvite(role: PolicyRole): boolean {
  return hasPermission(role, 'invite');
}

/** Can this role revoke another team member? */
export function canRevokeMember(role: PolicyRole): boolean {
  return hasPermission(role, 'revokeMember');
}

/** Can this role resolve a pending approval request? */
export function canApprove(role: PolicyRole): boolean {
  return hasPermission(role, 'approve');
}

/** Can this role edit / add / delete team policies? */
export function canEditPolicy(role: PolicyRole): boolean {
  return hasPermission(role, 'editPolicy');
}

/** Can this role manage subscription / billing / seats? */
export function canManageBilling(role: PolicyRole): boolean {
  return hasPermission(role, 'manageBilling');
}
