/**
 * Team Tier Types (Phase 2 — Styrby Team Governance)
 *
 * These types mirror the `teams` family of tables from migration 021
 * (`feat/db-021-team-governance`). All identifiers use camelCase so
 * TypeScript consumers never see the database snake_case.
 *
 * Every type has a corresponding Zod schema (`*Schema`) for runtime
 * validation of API responses and Realtime payloads (SEC-RELAY-002 pattern
 * established in relay/types.ts).
 *
 * WHY shared (not in web or mobile independently): tier-gating decisions and
 * invitation state machines must match exactly across surfaces. A single
 * source here prevents drift that could allow a user to accept an expired
 * invite on mobile while the web correctly blocks it.
 *
 * @module teams/types
 */

import { z } from 'zod';

// ============================================================================
// Runtime constant arrays (safe for import in any runtime)
// ============================================================================

/**
 * All role strings a TeamMember or TeamInvitation can hold.
 * Use this for Zod enums and runtime validation.
 */
export const TEAM_ROLES = ['owner', 'admin', 'member'] as const;

/**
 * All policy type strings a DbTeamPolicy can have.
 * Drives both DB values and UI label lookups.
 */
export const POLICY_TYPES = [
  'blocked_agents',
  'cost_cap',
  'working_hours',
  'require_approval',
] as const;

/**
 * All status strings for a TeamApprovalRequest lifecycle.
 */
export const DB_APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

/**
 * Tier identifiers that qualify as "team" tiers in the billing model.
 * Used internally by `isTeamTier()` in tiers/utils.ts.
 */
export const TEAM_TIER_IDS = ['team', 'business', 'enterprise'] as const;

// ============================================================================
// Derived union types
// ============================================================================

/** Role a member or invitee can hold within a team. */
export type TeamRole = (typeof TEAM_ROLES)[number];

/** Policy type identifier stored in the `team_policies` table. */
export type PolicyType = (typeof POLICY_TYPES)[number];

/** Lifecycle status for an approval request. */
export type DbApprovalStatus = (typeof DB_APPROVAL_STATUSES)[number];

/** Billing tier identifier for teams (superset of TierId's 'team'). */
export type TeamBillingTier = 'team' | 'business' | 'enterprise';

// ============================================================================
// Team
// ============================================================================

/**
 * Represents a team workspace in Styrby.
 *
 * A team owns seats and has at least one owner. The `slug` is the
 * URL-safe identifier used in routes (e.g. `/teams/acme-corp`).
 * `billingOrgId` links to the Polar organization so seat billing and
 * invoice management can be performed server-side.
 *
 * DB table: `teams` (migration 021)
 */
export interface Team {
  /** UUID primary key. */
  id: string;

  /** Human-readable team display name (e.g. "Acme Corp"). */
  name: string;

  /**
   * URL-safe slug derived from name at creation time.
   * Used in routes and Realtime channel suffixes.
   * Immutable after creation.
   */
  slug: string;

  /** UUID of the user who created the team. Always holds the 'owner' role. */
  ownerId: string;

  /** ISO-8601 creation timestamp. */
  createdAt: string;

  /** ISO-8601 last modification timestamp. */
  updatedAt: string;

  /**
   * Billing tier the team is subscribed to.
   * Controls per-seat limits, feature flags, and approval chains.
   */
  tier: TeamBillingTier;

  /**
   * Number of active paid seats on the current billing cycle.
   * Minimum is 3 for 'team', 10 for 'business'. See CLAUDE.md pricing.
   */
  seatCount: number;

  /**
   * Polar organization ID tied to this team's billing subscription.
   * Null until the owner completes checkout.
   */
  billingOrgId: string | null;
}

/**
 * Zod schema for {@link Team}. Use for API response validation.
 *
 * @example
 * ```ts
 * const team = TeamSchema.parse(await res.json());
 * ```
 */
export const TeamSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  ownerId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  tier: z.enum(TEAM_TIER_IDS),
  seatCount: z.number().int().min(1),
  billingOrgId: z.string().nullable(),
});

// ============================================================================
// TeamMember
// ============================================================================

/**
 * Represents a user's membership within a team.
 *
 * Membership is created when an invitation is accepted or when the team
 * owner directly adds a user. The `role` determines what actions are
 * permitted via RLS policies on the `team_*` tables.
 *
 * DB table: `team_members` (migration 021)
 */
export interface TeamMember {
  /** UUID primary key. */
  id: string;

  /** UUID of the parent team. FK to `teams.id`. */
  teamId: string;

  /** UUID of the Styrby user. FK to `auth.users.id`. */
  userId: string;

  /**
   * Role within the team.
   * - `owner`: full control including billing and deletion.
   * - `admin`: manage members and policies but not billing.
   * - `member`: read-only access to shared sessions; subject to policies.
   */
  role: TeamRole;

  /**
   * UUID of the user who sent the invitation that created this membership.
   * Null for the founding owner (no invitation was needed).
   */
  invitedBy: string | null;

  /** ISO-8601 timestamp when the invitation was accepted / user was added. */
  joinedAt: string;
}

/**
 * Zod schema for {@link TeamMember}. Use for API response validation.
 */
export const TeamMemberSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(TEAM_ROLES),
  invitedBy: z.string().uuid().nullable(),
  joinedAt: z.string().datetime(),
});

// ============================================================================
// TeamInvitation
// ============================================================================

/**
 * Represents a pending invitation to join a team.
 *
 * Invitations are single-use and expire after 7 days. The `token` is a
 * cryptographically random value embedded in the invite link so only the
 * recipient can accept it. `acceptedAt` is set when the invite is consumed
 * and a TeamMember row is created.
 *
 * DB table: `team_invitations` (migration 021)
 */
export interface TeamInvitation {
  /** UUID primary key. */
  id: string;

  /** UUID of the team the invitee is being invited to. */
  teamId: string;

  /** Email address of the invitee (may not yet have a Styrby account). */
  email: string;

  /** Role that will be granted upon acceptance. */
  role: TeamRole;

  /** UUID of the team member who sent the invitation. */
  invitedBy: string;

  /**
   * Cryptographically random opaque token embedded in the invite URL.
   * Server validates this on acceptance. Never expose raw; treat as a secret.
   */
  token: string;

  /** ISO-8601 timestamp after which the invitation is no longer valid. */
  expiresAt: string;

  /**
   * ISO-8601 timestamp when the invitation was accepted and a membership was
   * created. Null until accepted; non-null tokens must not be reused.
   */
  acceptedAt: string | null;
}

/**
 * Zod schema for {@link TeamInvitation}. Use for API response validation.
 */
export const TeamInvitationSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(TEAM_ROLES),
  invitedBy: z.string().uuid(),
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
});

// ============================================================================
// DbTeamPolicy
// ============================================================================

/**
 * Represents an admin-configured governance rule for a team.
 *
 * Policies gate what team members can do. The `value` field is a
 * JSON blob whose shape depends on `policyType`:
 * - `blocked_agents`: `{ agents: AgentId[] }`
 * - `cost_cap`: `{ limitUsd: number, period: 'daily'|'monthly' }`
 * - `working_hours`: `{ start: "HH:MM", end: "HH:MM", tz: string }`
 * - `require_approval`: `{ agents: AgentId[], minApprovers: number }`
 *
 * DB table: `team_policies` (migration 021)
 */
export interface DbTeamPolicy {
  /** UUID primary key. */
  id: string;

  /** UUID of the parent team. */
  teamId: string;

  /**
   * Which governance rule this row enforces.
   * CLI and mobile enforce these locally; the edge function re-validates
   * server-side for auditability (SOC2 CC6.1).
   */
  policyType: PolicyType;

  /**
   * JSON configuration blob for the policy. Shape is policyType-specific.
   * Consumers must narrow the type after parsing.
   */
  value: unknown;

  /** ISO-8601 timestamp when this policy was activated. */
  enabledAt: string;
}

/**
 * Zod schema for {@link DbTeamPolicy}. Use for API response validation.
 *
 * WHY `value` is `z.unknown()`: the JSON blob is policyType-specific and
 * validated at the application layer where the type is narrowed. Keeping
 * this schema generic avoids duplicating policy-specific validation here.
 */
export const DbTeamPolicySchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  policyType: z.enum(POLICY_TYPES),
  value: z.unknown(),
  enabledAt: z.string().datetime(),
});

// ============================================================================
// TeamApprovalRequest
// ============================================================================

/**
 * Represents a command that requires team-admin approval before execution.
 *
 * When a `require_approval` policy is active, the CLI pauses before running
 * a matched command and creates this record. An admin must approve or reject
 * it (or it expires automatically after a configurable TTL). The approver's
 * identity is recorded for the audit log (SOC2 CC7.2).
 *
 * DB table: `team_approval_requests` (migration 021)
 */
export interface TeamApprovalRequest {
  /** UUID primary key. */
  id: string;

  /** UUID of the team whose policy triggered the request. */
  teamId: string;

  /** UUID of the team member whose CLI submitted the command. */
  requesterId: string;

  /**
   * UUID of the admin who resolved the request.
   * Null while status is 'pending' or 'expired' without an explicit actor.
   */
  approverId: string | null;

  /**
   * The exact command string the member attempted to run.
   * Stored verbatim for auditability; may contain file paths or arguments.
   */
  command: string;

  /** Current lifecycle stage of the approval request. */
  status: DbApprovalStatus;

  /** ISO-8601 timestamp when the request was submitted. */
  createdAt: string;

  /**
   * ISO-8601 timestamp when the request reached a terminal state
   * (approved, rejected, or expired). Null while pending.
   */
  resolvedAt: string | null;
}

/**
 * Zod schema for {@link TeamApprovalRequest}. Use for API response validation.
 */
export const TeamApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  requesterId: z.string().uuid(),
  approverId: z.string().uuid().nullable(),
  command: z.string().min(1),
  status: z.enum(DB_APPROVAL_STATUSES),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});

// ============================================================================
// TeamSharedSession
// ============================================================================

/**
 * Represents a session that a team member has shared with their team.
 *
 * `visibility` controls who within the team can view the session transcript:
 * - `'team'`: all team members
 * - `'public_in_team'`: any team member, and discoverable in the shared feed
 *
 * The underlying session data lives in the `sessions` table. This record
 * is the sharing join that grants read access to team members who would
 * otherwise be blocked by per-user RLS.
 *
 * DB table: `shared_sessions` (migration 021)
 */
export interface TeamSharedSession {
  /** UUID primary key. */
  id: string;

  /** UUID of the team this session is shared with. */
  teamId: string;

  /** UUID of the session being shared. FK to `sessions.id`. */
  sessionId: string;

  /** UUID of the team member who performed the share action. */
  sharedByUserId: string;

  /** Access scope for the shared session. */
  visibility: 'team' | 'public_in_team';

  /** ISO-8601 timestamp when the session was shared. */
  createdAt: string;
}

/**
 * Zod schema for {@link TeamSharedSession}. Use for API response validation.
 */
export const SharedSessionSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  sessionId: z.string().uuid(),
  sharedByUserId: z.string().uuid(),
  visibility: z.enum(['team', 'public_in_team']),
  createdAt: z.string().datetime(),
});

// ============================================================================
// TeamExport
// ============================================================================

/**
 * Represents a data-export request for a team's session and cost history.
 *
 * Admins can request CSV or JSON exports for compliance reporting. The
 * export is generated asynchronously; `status` transitions from 'pending'
 * to 'ready' (download URL set) or 'failed'. Download URLs expire after
 * `expiresAt` and should never be stored long-term by the client.
 *
 * DB table: `team_exports` (migration 021)
 */
export interface TeamExport {
  /** UUID primary key. */
  id: string;

  /** UUID of the team whose data is being exported. */
  teamId: string;

  /** UUID of the admin who triggered the export. */
  requesterId: string;

  /** File format for the exported data. */
  format: 'csv' | 'json';

  /**
   * Processing status.
   * - `'pending'`: queued, not yet generated.
   * - `'processing'`: generation in progress.
   * - `'ready'`: `downloadUrl` is populated and valid until `expiresAt`.
   * - `'failed'`: generation failed; requestor should retry.
   */
  status: 'pending' | 'processing' | 'ready' | 'failed';

  /**
   * Pre-signed Supabase Storage URL for downloading the export.
   * Null until status transitions to 'ready'.
   */
  downloadUrl: string | null;

  /**
   * ISO-8601 timestamp after which the download URL is no longer valid.
   * Null until status transitions to 'ready'.
   */
  expiresAt: string | null;
}

/**
 * Zod schema for {@link TeamExport}. Use for API response validation.
 */
export const TeamExportSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  requesterId: z.string().uuid(),
  format: z.enum(['csv', 'json']),
  status: z.enum(['pending', 'processing', 'ready', 'failed']),
  downloadUrl: z.string().url().nullable(),
  expiresAt: z.string().datetime().nullable(),
});

// ============================================================================
// TeamBillingEvent
// ============================================================================

/**
 * Represents a billing lifecycle event for a team subscription.
 *
 * These records are created by the Polar webhook handler when subscription
 * state changes (e.g. seat added, invoice paid, subscription cancelled).
 * The `amountUsd` is stored in integer cents to avoid floating-point drift
 * in aggregations (SOC2 A1.2 availability: correct financial records).
 *
 * DB table: `team_billing_events` (migration 021)
 */
export interface TeamBillingEvent {
  /** UUID primary key. */
  id: string;

  /** UUID of the team this event belongs to. */
  teamId: string;

  /**
   * Polar-specific event type string (e.g. 'subscription.created',
   * 'invoice.paid', 'seat.added', 'subscription.cancelled').
   */
  eventType: string;

  /**
   * Polar's own event identifier for idempotency and deduplication.
   * The webhook handler must skip events with a known `polarEventId`.
   */
  polarEventId: string;

  /**
   * Amount in USD cents associated with the event.
   * May be 0 for non-monetary events (e.g. seat assignment).
   */
  amountUsd: number;

  /** ISO-8601 timestamp from Polar's event payload (source of truth). */
  occurredAt: string;
}

/**
 * Zod schema for {@link TeamBillingEvent}. Use for API response validation.
 */
export const TeamBillingEventSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  eventType: z.string().min(1),
  polarEventId: z.string().min(1),
  amountUsd: z.number().int().min(0),
  occurredAt: z.string().datetime(),
});
