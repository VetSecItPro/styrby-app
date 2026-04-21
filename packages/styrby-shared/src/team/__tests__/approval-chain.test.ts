/**
 * Tests for the approval-chain evaluator.
 *
 * Covers the happy path plus the edge cases called out in the module
 * docstring (revoked approver, downgraded team, zero approvers,
 * self-approval). Includes a determinism property test: for the same
 * input, the output is byte-identical every invocation.
 *
 * @module team/__tests__/approval-chain
 */

import { describe, it, expect } from 'vitest';
import { evaluateApprovalChain, type RosterMember } from '../approval-chain.js';
import type { Approval, TeamPolicy } from '../types.js';

const UUID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ISO = '2026-04-20T00:00:00.000Z';

/** Factory: policy requiring any admin approval. */
function policyRequireApproval(overrides: Partial<TeamPolicy> = {}): TeamPolicy {
  return {
    id: UUID(1),
    teamId: UUID(2),
    name: 'Require approval for Bash',
    description: null,
    ruleType: 'tool_allowlist',
    threshold: null,
    approverRole: 'any_admin',
    approverUserId: null,
    agentFilter: ['bash'],
    action: 'require_approval',
    settings: {},
    enabled: true,
    priority: 100,
    createdBy: UUID(3),
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function member(userId: string, role: RosterMember['role'], active = true): RosterMember {
  return { userId, role, active };
}

function approval(
  status: Approval['status'],
  resolverUserId: string | null,
  requesterUserId: string = UUID(100),
): Pick<Approval, 'status' | 'resolverUserId' | 'requesterUserId'> {
  return { status, resolverUserId, requesterUserId };
}

describe('evaluateApprovalChain — happy paths', () => {
  it('auto-approves when no policy applies', () => {
    const result = evaluateApprovalChain({
      policy: null,
      approvals: [],
      roster: [],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('auto-approved');
    expect(result.requiredApprovers).toEqual([]);
  });

  it('auto-approves when policy action is allow_with_audit', () => {
    const result = evaluateApprovalChain({
      policy: policyRequireApproval({ action: 'allow_with_audit' }),
      approvals: [],
      roster: [member(UUID(10), 'admin')],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('auto-approved');
  });

  it('denies when policy action is block', () => {
    const result = evaluateApprovalChain({
      policy: policyRequireApproval({ action: 'block' }),
      approvals: [],
      roster: [member(UUID(10), 'admin')],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('denied');
  });

  it('returns pending with the admin list when awaiting votes', () => {
    const result = evaluateApprovalChain({
      policy: policyRequireApproval(),
      approvals: [],
      roster: [
        member(UUID(10), 'owner'),
        member(UUID(11), 'admin'),
        member(UUID(12), 'member'),
      ],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('pending');
    expect(result.requiredApprovers.sort()).toEqual([UUID(10), UUID(11)].sort());
  });

  it('auto-approves once an eligible approver votes approved', () => {
    const result = evaluateApprovalChain({
      policy: policyRequireApproval(),
      approvals: [approval('approved', UUID(11))],
      roster: [member(UUID(11), 'admin')],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('auto-approved');
  });

  it('denies on first eligible denial', () => {
    const result = evaluateApprovalChain({
      policy: policyRequireApproval(),
      approvals: [
        approval('denied', UUID(11)),
        approval('approved', UUID(10)), // later approval should NOT override
      ],
      roster: [member(UUID(10), 'owner'), member(UUID(11), 'admin')],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('denied');
  });
});

describe('evaluateApprovalChain — edge cases', () => {
  it('ignores votes from a revoked (inactive) approver', () => {
    const result = evaluateApprovalChain({
      policy: policyRequireApproval(),
      approvals: [approval('approved', UUID(11))],
      roster: [member(UUID(11), 'admin', /* active */ false)],
      requesterUserId: UUID(100),
    });
    // Revoked approver's vote is disregarded, nobody else eligible →
    // fail-safe pending.
    expect(result.status).toBe('pending');
    expect(result.requiredApprovers).toEqual([]);
    expect(result.reason).toMatch(/no eligible approvers/i);
  });

  it('handles team downgrade: admin demoted to member no longer eligible', () => {
    // The once-admin 11 is now a member — their historical approval
    // does NOT satisfy the policy.
    const result = evaluateApprovalChain({
      policy: policyRequireApproval(),
      approvals: [approval('approved', UUID(11))],
      roster: [member(UUID(11), 'member')],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('pending');
    expect(result.requiredApprovers).toEqual([]);
  });

  it('fails safe to pending when zero approvers are configured', () => {
    const result = evaluateApprovalChain({
      policy: policyRequireApproval(),
      approvals: [],
      roster: [member(UUID(100), 'member')], // only the requester, and they are not an approver
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('pending');
    expect(result.requiredApprovers).toEqual([]);
    expect(result.reason).toMatch(/no eligible approvers/i);
  });

  it('disallows self-approval even for owners', () => {
    const ownerAndRequester = UUID(10);
    const result = evaluateApprovalChain({
      policy: policyRequireApproval(),
      approvals: [approval('approved', ownerAndRequester)],
      roster: [
        member(ownerAndRequester, 'owner'),
        member(UUID(11), 'admin'),
      ],
      requesterUserId: ownerAndRequester,
    });
    // Owner voted for their own request — filtered out. Admin 11 still
    // pending → result is pending with 11 as required.
    expect(result.status).toBe('pending');
    expect(result.requiredApprovers).toEqual([UUID(11)]);
  });

  it('honors specific_user approver role', () => {
    const specific = UUID(11);
    const result = evaluateApprovalChain({
      policy: policyRequireApproval({
        approverRole: 'specific_user',
        approverUserId: specific,
      }),
      approvals: [],
      roster: [
        member(UUID(10), 'owner'),
        member(specific, 'member'),
      ],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('pending');
    expect(result.requiredApprovers).toEqual([specific]);
  });

  it('treats specific_user policy with null approverUserId as misconfigured', () => {
    const result = evaluateApprovalChain({
      policy: policyRequireApproval({
        approverRole: 'specific_user',
        approverUserId: null,
      }),
      approvals: [],
      roster: [member(UUID(10), 'owner'), member(UUID(11), 'admin')],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('pending');
    expect(result.requiredApprovers).toEqual([]);
    expect(result.reason).toMatch(/no eligible approvers/i);
  });

  it('falls back to admin-or-owner when approverRole is null', () => {
    const result = evaluateApprovalChain({
      policy: policyRequireApproval({ approverRole: null }),
      approvals: [],
      roster: [
        member(UUID(10), 'owner'),
        member(UUID(11), 'admin'),
        member(UUID(12), 'member'),
      ],
      requesterUserId: UUID(100),
    });
    expect(result.status).toBe('pending');
    expect(result.requiredApprovers.sort()).toEqual([UUID(10), UUID(11)].sort());
  });
});

describe('evaluateApprovalChain — determinism', () => {
  it('returns byte-identical output for the same input across many invocations', () => {
    // Simple property-style test: same input → same output, 100 iterations.
    const input = {
      policy: policyRequireApproval(),
      approvals: [approval('approved', UUID(11))],
      roster: [member(UUID(10), 'owner'), member(UUID(11), 'admin')],
      requesterUserId: UUID(100),
    };
    const first = JSON.stringify(evaluateApprovalChain(input));
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(evaluateApprovalChain(input))).toBe(first);
    }
  });
});
