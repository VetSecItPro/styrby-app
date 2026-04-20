/**
 * Tests for the role → permission matrix.
 *
 * Exhaustively walks every (role × permission) pair so any accidental
 * matrix edit that drops or flips a bit fails loudly.
 *
 * @module team/__tests__/role-matrix
 */

import { describe, it, expect } from 'vitest';
import {
  canApprove,
  canEditPolicy,
  canInvite,
  canManageBilling,
  canRevokeMember,
  hasPermission,
  ROLE_PERMISSION_MATRIX,
} from '../role-matrix.js';
import { ALL_POLICY_ROLES, type Permission, type PolicyRole } from '../types.js';

const EXPECTED: Record<PolicyRole, Record<Permission, boolean>> = {
  owner: {
    invite: true,
    revokeMember: true,
    approve: true,
    editPolicy: true,
    manageBilling: true,
  },
  admin: {
    invite: true,
    revokeMember: true,
    approve: true,
    editPolicy: true,
    manageBilling: false,
  },
  approver: {
    invite: false,
    revokeMember: false,
    approve: true,
    editPolicy: false,
    manageBilling: false,
  },
  member: {
    invite: false,
    revokeMember: false,
    approve: false,
    editPolicy: false,
    manageBilling: false,
  },
};

describe('ROLE_PERMISSION_MATRIX', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(ROLE_PERMISSION_MATRIX)).toBe(true);
    for (const role of ALL_POLICY_ROLES) {
      expect(Object.isFrozen(ROLE_PERMISSION_MATRIX[role])).toBe(true);
    }
  });

  it('matches the expected 4×5 truth table', () => {
    for (const role of ALL_POLICY_ROLES) {
      for (const perm of Object.keys(EXPECTED.owner) as Permission[]) {
        expect(
          hasPermission(role, perm),
          `role=${role}, perm=${perm}`,
        ).toBe(EXPECTED[role][perm]);
      }
    }
  });
});

describe('named helpers', () => {
  it('canInvite matches matrix', () => {
    for (const role of ALL_POLICY_ROLES) {
      expect(canInvite(role)).toBe(EXPECTED[role].invite);
    }
  });

  it('canRevokeMember matches matrix', () => {
    for (const role of ALL_POLICY_ROLES) {
      expect(canRevokeMember(role)).toBe(EXPECTED[role].revokeMember);
    }
  });

  it('canApprove matches matrix', () => {
    for (const role of ALL_POLICY_ROLES) {
      expect(canApprove(role)).toBe(EXPECTED[role].approve);
    }
  });

  it('canEditPolicy matches matrix', () => {
    for (const role of ALL_POLICY_ROLES) {
      expect(canEditPolicy(role)).toBe(EXPECTED[role].editPolicy);
    }
  });

  it('canManageBilling matches matrix', () => {
    for (const role of ALL_POLICY_ROLES) {
      expect(canManageBilling(role)).toBe(EXPECTED[role].manageBilling);
    }
  });
});
