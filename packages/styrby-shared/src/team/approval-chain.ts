/**
 * Approval-chain evaluator (Phase 2.1).
 *
 * Pure function that decides whether a proposed tool call can auto-approve,
 * must wait for humans, or must be denied outright.
 *
 * Used in three places:
 *   1. CLI `policyEngine` — client-side pre-check, show "will require
 *      approval from X, Y, Z" UI before submitting.
 *   2. Supabase edge function `resolve-approval` — re-run server-side on
 *      every vote tally to decide the terminal status.
 *   3. Web / mobile admin UIs — preview what will happen for a given
 *      policy + roster.
 *
 * Keeping this pure (no I/O, no clock unless injected) means we can drop
 * it into all three surfaces without touching transport code.
 *
 * @module team/approval-chain
 */

import type { Approval, PolicyRole, TeamPolicy } from './types.js';

// ============================================================================
// Inputs & outputs
// ============================================================================

/**
 * A member of the team's current roster. We keep this minimal (id + role +
 * active flag) because the chain evaluator never needs profile data.
 */
export interface RosterMember {
  userId: string;
  role: PolicyRole;
  /**
   * `true` if the member is still active on the team. Revoked members stay
   * in roster snapshots so that historical decisions remain reproducible.
   */
  active: boolean;
}

/** Inputs to {@link evaluateApprovalChain}. */
export interface ApprovalChainInput {
  /**
   * The policy that flagged the tool call. When `null`, the caller is asking
   * "is there even a policy to evaluate?" — we return `auto-approved` so
   * the CLI can pass through without requiring humans.
   */
  policy: TeamPolicy | null;

  /**
   * All approval rows for this (session, tool) pair. Votes from revoked
   * approvers are filtered out by {@link evaluateApprovalChain}.
   */
  approvals: ReadonlyArray<Pick<Approval, 'status' | 'resolverUserId' | 'requesterUserId'>>;

  /** Current roster snapshot. */
  roster: ReadonlyArray<RosterMember>;

  /** User who requested the tool call. Used to block self-approval. */
  requesterUserId: string;
}

/** Terminal status returned from the evaluator. */
export type ApprovalChainStatus = 'auto-approved' | 'pending' | 'denied';

/** Result of {@link evaluateApprovalChain}. */
export interface ApprovalChainResult {
  status: ApprovalChainStatus;

  /**
   * Users currently eligible to approve. Empty when `status` is terminal
   * (auto-approved or denied).
   */
  requiredApprovers: string[];

  /** Human-readable rationale. Always present for terminal statuses. */
  reason?: string;
}

// ============================================================================
// Evaluator
// ============================================================================

/**
 * Pure, deterministic approval-chain evaluator.
 *
 * Decision tree:
 *   1. No policy                         → auto-approved
 *   2. Policy action 'allow_with_audit'  → auto-approved
 *   3. Policy action 'block'             → denied
 *   4. Any approval row `denied`         → denied (first denier wins)
 *   5. Any approval row `approved` by an active eligible approver → auto-approved
 *   6. No eligible approvers found       → pending, fail-safe reason
 *   7. Otherwise                         → pending with eligible approver list
 *
 * Edge cases handled (each has a WHY comment at the relevant branch):
 *   - Approver revoked mid-approval (inactive roster member).
 *   - Team downgraded (approver role no longer matches policy).
 *   - Zero approvers configured (fail-safe to pending — never auto-approve).
 *   - Self-approval (requester attempts to approve their own request).
 *
 * @param input - Policy, approvals, roster, requester.
 * @returns Terminal status + remaining required approvers.
 */
export function evaluateApprovalChain(
  input: ApprovalChainInput,
): ApprovalChainResult {
  const { policy, approvals, roster, requesterUserId } = input;

  // --- 1. No policy guarding this call. Pass through. -----------------------
  if (!policy) {
    return {
      status: 'auto-approved',
      requiredApprovers: [],
      reason: 'No matching policy — tool call auto-approved.',
    };
  }

  // --- 2/3. Policy action short-circuits. -----------------------------------
  if (policy.action === 'allow_with_audit') {
    return {
      status: 'auto-approved',
      requiredApprovers: [],
      reason: `Policy "${policy.name}" allows with audit only.`,
    };
  }

  if (policy.action === 'block') {
    return {
      status: 'denied',
      requiredApprovers: [],
      reason: `Policy "${policy.name}" blocks this tool call.`,
    };
  }

  // Past this point, action must be 'require_approval'.

  // Build the set of *currently eligible* approvers from the roster.
  // WHY this is computed from a fresh roster snapshot every call:
  //   an approver revoked after the policy was written must NOT be
  //   counted, even if their historical vote already exists in
  //   `approvals`. Security failure mode: granting a revoked user
  //   lingering authority is a CC6 violation.
  const eligibleApproverIds = roster
    .filter((m) => m.active && isEligibleApproverFor(m, policy))
    // WHY exclude the requester: prevent self-approval. Even an owner
    // who initiates a tool call must not be able to rubber-stamp their
    // own request (SOC2 CC6.3, separation of duties).
    .filter((m) => m.userId !== requesterUserId)
    .map((m) => m.userId);

  // --- 6. Zero approvers configured. Fail-safe. -----------------------------
  if (eligibleApproverIds.length === 0) {
    // WHY pending (not auto-approved) when no approvers exist:
    //   an admin misconfiguration MUST NOT silently bypass the control.
    //   The pending row forces a human to notice the dead-end and fix
    //   the policy or roster.
    return {
      status: 'pending',
      requiredApprovers: [],
      reason:
        `Policy "${policy.name}" requires approval, but no eligible approvers remain. ` +
        'An admin must re-configure the policy or add approvers.',
    };
  }

  // --- 4. First denial wins. ------------------------------------------------
  // WHY iterate `approvals` ordered by status priority, not chronologically:
  //   a single denial is decisive; any approval after a denial does not
  //   re-open the decision.
  const denialByEligible = approvals.find(
    (a) =>
      a.status === 'denied' &&
      a.resolverUserId !== null &&
      eligibleApproverIds.includes(a.resolverUserId),
  );
  if (denialByEligible) {
    return {
      status: 'denied',
      requiredApprovers: [],
      reason: `Request denied by ${denialByEligible.resolverUserId}.`,
    };
  }

  // --- 5. Single eligible approval is sufficient. ---------------------------
  // WHY single approval rather than M-of-N: migration 021 models policy
  //   `approverRole` as a single slot (owner | admin | any_admin |
  //    specific_user). Multi-signature chains are a Phase 3+ feature —
  //   capture them via N separate policies if needed in the interim.
  const approvalByEligible = approvals.find(
    (a) =>
      a.status === 'approved' &&
      a.resolverUserId !== null &&
      eligibleApproverIds.includes(a.resolverUserId),
  );
  if (approvalByEligible) {
    return {
      status: 'auto-approved',
      requiredApprovers: [],
      reason: `Approved by ${approvalByEligible.resolverUserId}.`,
    };
  }

  // --- 7. Still waiting. ----------------------------------------------------
  return {
    status: 'pending',
    requiredApprovers: eligibleApproverIds,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Decide whether a roster member is currently eligible to approve under
 * this policy. Encapsulates the policy's `approverRole` semantics so the
 * evaluator above reads cleanly.
 */
function isEligibleApproverFor(
  member: RosterMember,
  policy: TeamPolicy,
): boolean {
  const approverRole = policy.approverRole;

  // Default-fallback: if the policy did not specify an approver role,
  // require an owner or admin. Matches the behavior described in
  // migration 021 (admin-or-owner as the safe default).
  if (approverRole === null || approverRole === undefined) {
    return member.role === 'owner' || member.role === 'admin';
  }

  switch (approverRole) {
    case 'owner':
      return member.role === 'owner';
    case 'admin':
      return member.role === 'admin' || member.role === 'owner';
    case 'any_admin':
      return member.role === 'admin' || member.role === 'owner';
    case 'specific_user':
      // WHY the type-level fallback: if the DB returned 'specific_user'
      //   but the `approverUserId` column is NULL (bad data), we treat
      //   this as "no eligible approvers" — caller will see the
      //   misconfiguration-fail-safe branch above.
      return policy.approverUserId !== null && member.userId === policy.approverUserId;
  }
}
