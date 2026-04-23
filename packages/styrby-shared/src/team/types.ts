/**
 * Team governance types (Phase 2.1).
 *
 * TypeScript + Zod mirrors of the `team_policies`, `approvals`,
 * `sessions_shared`, `exports`, `integrations`, and `billing_events`
 * tables defined in `supabase/migrations/021_team_governance.sql`.
 *
 * These types are the single shared truth for CLI, web, and mobile.
 * Import from `@styrby/shared` (barrel) or this module directly.
 *
 * WHY this lives in `@styrby/shared` rather than per-surface:
 *   - One team-governance domain, three UIs (CLI polls, web dashboards,
 *     mobile push-approvals). Any drift between surfaces would manifest
 *     as hard-to-debug cross-tenant bugs. Colocate the truth.
 *   - The migration is the schema contract; these types are its dual.
 *
 * @module team/types
 */

import { z } from 'zod';

// ============================================================================
// Role matrix
// ============================================================================

/**
 * Database-level team role as stored in `team_members.role` (migration 006).
 *
 * The physical column only knows three roles. "Approver" authority is
 * derived at runtime from {@link TeamPolicy.approverRole} rather than being
 * a separate row in `team_members`. See {@link PolicyRole} for the logical
 * extension used by the approval-chain evaluator.
 */
export type DbRole = 'owner' | 'admin' | 'member';

/**
 * Logical role used by the approval-chain engine.
 *
 * `approver` is a policy-scoped capability, not a stored column. A user
 * is an "approver" for a given approval request when:
 *   (a) they are owner/admin AND the policy's `approverRole` is
 *       'owner', 'admin', or 'any_admin', OR
 *   (b) the policy's `approverRole` is 'specific_user' and they are
 *       the named `approverUserId`.
 *
 * The helpers in {@link ./role-matrix} encode the (db-role, policy-role)
 * → permission mapping so every surface asks the same question.
 */
export type PolicyRole = 'owner' | 'admin' | 'approver' | 'member';

/** All four logical roles as a const array for exhaustive iteration in tests. */
export const ALL_POLICY_ROLES: readonly PolicyRole[] = [
  'owner',
  'admin',
  'approver',
  'member',
] as const;

/**
 * A single governance permission the role matrix decides.
 *
 * Keep this list tight — each new permission is a new policy surface
 * that every client must handle consistently.
 */
export type Permission =
  | 'invite'
  | 'revokeMember'
  | 'approve'
  | 'editPolicy'
  | 'manageBilling';

// ============================================================================
// team_policies
// ============================================================================

/** Allowed values for {@link TeamPolicy.ruleType}. Mirrors SQL CHECK constraint. */
export type PolicyRuleType =
  | 'cost_threshold'
  | 'agent_filter'
  | 'tool_allowlist'
  | 'time_window';

/** Allowed values for {@link TeamPolicy.action}. Mirrors SQL CHECK constraint. */
export type PolicyAction = 'block' | 'require_approval' | 'allow_with_audit';

/** Allowed values for {@link TeamPolicy.approverRole}. */
export type PolicyApproverRole =
  | 'owner'
  | 'admin'
  | 'any_admin'
  | 'specific_user';

/**
 * Zod schema for {@link TeamPolicy}. Shapes the row as returned from
 * PostgREST (snake_case) but the derived TS type uses camelCase via
 * the post-parse transform in callers. See the `TeamPolicy` interface
 * for the public-facing camelCase type.
 */
export const teamPolicySchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  ruleType: z.enum([
    'cost_threshold',
    'agent_filter',
    'tool_allowlist',
    'time_window',
  ]),
  threshold: z.number().nullable(),
  approverRole: z
    .enum(['owner', 'admin', 'any_admin', 'specific_user'])
    .nullable(),
  approverUserId: z.string().uuid().nullable(),
  agentFilter: z.array(z.string()),
  action: z.enum(['block', 'require_approval', 'allow_with_audit']),
  settings: z.record(z.unknown()),
  enabled: z.boolean(),
  priority: z.number().int(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** A team approval / blocking policy. Mirrors the `team_policies` row. */
export type TeamPolicy = z.infer<typeof teamPolicySchema>;

// ============================================================================
// approvals
// ============================================================================

/** Lifecycle states for a single approval request. */
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled';

/** Zod schema for {@link Approval}. */
export const approvalSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  policyId: z.string().uuid().nullable(),
  requesterUserId: z.string().uuid(),
  toolName: z.string().min(1),
  estimatedCostUsd: z.number().nullable(),
  requestPayload: z.record(z.unknown()),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  resolverUserId: z.string().uuid().nullable(),
  resolutionNote: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});

/** Per-tool-call governance event. Mirrors the `approvals` row. */
export type Approval = z.infer<typeof approvalSchema>;

// ============================================================================
// sessions_shared
// ============================================================================

/** Share-grant permission level. */
export type SharePermission = 'view' | 'comment' | 'collab';

/** Zod schema for {@link SessionShare}. */
export const sessionShareSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sharedWithUserId: z.string().uuid(),
  sharedByUserId: z.string().uuid(),
  permission: z.enum(['view', 'comment', 'collab']),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

/** Ad-hoc per-session share grant. Mirrors `sessions_shared`. */
export type SessionShare = z.infer<typeof sessionShareSchema>;

// ============================================================================
// exports (GDPR)
// ============================================================================

export type ExportFormat = 'json' | 'csv' | 'zip';
export type ExportScope = 'all' | 'sessions' | 'messages' | 'costs' | 'team';
export type ExportStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'expired';

/** Zod schema for {@link ExportRequest}. */
export const exportRequestSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  format: z.enum(['json', 'csv', 'zip']),
  scope: z.enum(['all', 'sessions', 'messages', 'costs', 'team']),
  status: z.enum(['pending', 'processing', 'ready', 'failed', 'expired']),
  errorMessage: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  downloadPath: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

/** GDPR export-request lifecycle. Mirrors the `exports` row. */
export type ExportRequest = z.infer<typeof exportRequestSchema>;

// ============================================================================
// integrations
// ============================================================================

export type IntegrationProvider =
  | 'slack'
  | 'github'
  | 'linear'
  | 'jira'
  | 'pagerduty'
  | 'webhook_generic';

export type IntegrationStatus = 'active' | 'paused' | 'error' | 'revoked';

/**
 * Zod schema for {@link Integration}.
 *
 * WHY `configEncrypted` is typed as opaque `string`:
 *   The column holds a base64-encoded libsodium secretbox. Decryption is
 *   a server-only concern — clients should never introspect it, and typing
 *   it as `unknown` would invite accidental leaks into logs/UIs.
 */
export const integrationSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  provider: z.enum([
    'slack',
    'github',
    'linear',
    'jira',
    'pagerduty',
    'webhook_generic',
  ]),
  displayName: z.string().nullable(),
  externalAccountId: z.string().nullable(),
  configEncrypted: z.string(),
  encryptionKeyId: z.string(),
  status: z.enum(['active', 'paused', 'error', 'revoked']),
  lastError: z.string().nullable(),
  installedBy: z.string().uuid().nullable(),
  installedAt: z.string(),
  updatedAt: z.string(),
});

/** Third-party integration credentials. Mirrors the `integrations` row. */
export type Integration = z.infer<typeof integrationSchema>;

// ============================================================================
// billing_events
// ============================================================================

/** Polar webhook billing event status. */
export type BillingEventStatus =
  | 'received'
  | 'processed'
  | 'failed'
  | 'skipped_duplicate';

/** Zod schema for {@link BillingEvent}. */
export const billingEventSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  subscriptionId: z.string().uuid().nullable(),
  eventType: z.string().min(1),
  amountUsd: z.number().nullable(),
  currency: z.string().nullable(),
  status: z.enum(['received', 'processed', 'failed', 'skipped_duplicate']),
  polarEventId: z.string().min(1),
  rawPayload: z.record(z.unknown()),
  processedAt: z.string().nullable(),
  createdAt: z.string(),
});

/** Polar webhook event log. Mirrors the `billing_events` row. */
export type BillingEvent = z.infer<typeof billingEventSchema>;

// ============================================================================
// Phase 2.2 — Invitation role mapping
// ============================================================================

/**
 * Roles accepted at invitation time (team_invitations.role CHECK) vs roles
 * allowed on team_members.role (CHECK). They differ: invitations allow
 * 'viewer' but team_members does not until Phase 2.3 migrates the CHECK.
 *
 * WHY we keep them different today: Phase 2.3 (Admin UI) will add 'viewer'
 * to team_members.role at the same time as it builds the UI surface that
 * makes viewer meaningful. Until then, viewer invitations MUST be stored as
 * 'member' at accept time.
 *
 * Unit B (/invite/[token] accept flow) MUST import this constant and apply
 * it before INSERT INTO team_members. Doing otherwise will trigger the
 * team_members.role CHECK constraint failure and surface as a cryptic 500.
 */
export const INVITE_ROLE_TO_MEMBER_ROLE = {
  admin: 'admin',
  member: 'member',
  viewer: 'member',
} as const satisfies Record<'admin' | 'member' | 'viewer', 'admin' | 'member'>;

export type InvitationRole = keyof typeof INVITE_ROLE_TO_MEMBER_ROLE;
export type MemberRole = typeof INVITE_ROLE_TO_MEMBER_ROLE[InvitationRole];

// ============================================================================
// Exit codes for the CLI policy engine
// ============================================================================

/**
 * CLI exit codes emitted by {@link ../../../../styrby-cli/src/approvals/policyEngine}.
 *
 * Kept in the shared module so docs, web dashboard, and CLI all agree.
 */
export const POLICY_ENGINE_EXIT_CODES = {
  APPROVED: 0,
  DENIED: 10,
  TIMEOUT: 124,
  CANCELLED: 130, // 128 + SIGINT (2)
} as const;

export type PolicyEngineExitCode =
  (typeof POLICY_ENGINE_EXIT_CODES)[keyof typeof POLICY_ENGINE_EXIT_CODES];
