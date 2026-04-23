/**
 * Admin UI types for Phase 2.3 — Team Admin UI (web + mobile parity).
 *
 * These types are the contract between:
 *   - `/api/teams/[id]/members` (PATCH/DELETE)
 *   - `/api/teams/[id]/policies` (GET/PATCH)
 *   - `/api/admin/founder-team-metrics` (GET)
 *   - Web dashboard: `/dashboard/team/[teamId]/members` and `../policies`
 *   - Mobile: `/team/members` and `/team/policies`
 *
 * WHY in @styrby/shared:
 *   Web and mobile must show identical data with identical validation. Any
 *   divergence between surfaces is a UX defect and a SOC2 CC6 (Logical Access)
 *   audit risk. Colocating shapes here enforces parity at the type level.
 *
 * @module team/admin-types
 */

import { z } from 'zod';
import type { DbRole } from './types.js';

// ============================================================================
// Team Member Admin View
// ============================================================================

/**
 * A team member as seen by an admin — includes cost MTD and last-active
 * timestamp that plain members cannot see.
 *
 * WHY cost_mtd_usd is nullable: members without sessions in the current month
 * return null rather than 0 to distinguish "no sessions" from "$0 cost sessions".
 */
export const TeamMemberAdminRowSchema = z.object({
  /** team_members.id (UUID) */
  member_id: z.string().uuid(),
  /** auth.users.id */
  user_id: z.string().uuid(),
  /** Role in the team */
  role: z.enum(['owner', 'admin', 'member']),
  /** Display name from profiles, nullable */
  display_name: z.string().nullable(),
  /** Email from auth.users */
  email: z.string().email(),
  /** Avatar URL from profiles */
  avatar_url: z.string().url().nullable(),
  /** ISO timestamp — when the member joined */
  joined_at: z.string(),
  /** ISO timestamp — most recent session start, nullable if no sessions */
  last_active_at: z.string().nullable(),
  /** Month-to-date cost in USD, nullable if no sessions this month */
  cost_mtd_usd: z.number().nullable(),
});

/** Admin view of a team member. */
export type TeamMemberAdminRow = z.infer<typeof TeamMemberAdminRowSchema>;

// ============================================================================
// Team Policy Admin View
// ============================================================================

/**
 * Editable fields of a team's top-level policy settings.
 *
 * WHY auto_approve_rules is string[] not a complex object:
 *   The rules are stored as jsonb in team_policies but the admin UI only
 *   exposes the tool-name strings (allowlist) to keep the form manageable.
 *   Full rule-type/threshold editing lives in a future Phase (2.4 approval chain).
 */
export const TeamPolicySettingsSchema = z.object({
  /**
   * List of tool names that are auto-approved without requiring human review.
   * Empty array means no tools are auto-approved.
   */
  auto_approve_rules: z.array(z.string().min(1).max(100)).max(200),
  /**
   * List of tool names that are blocked outright. Takes precedence over
   * auto_approve_rules for the same tool name.
   */
  blocked_tools: z.array(z.string().min(1).max(100)).max(200),
  /**
   * Monthly budget per seat in USD (0 = unlimited).
   * WHY nullable: null means no budget limit is set (unlimited).
   */
  budget_per_seat_usd: z.number().min(0).max(100_000).nullable(),
});

/** Editable team policy settings. */
export type TeamPolicySettings = z.infer<typeof TeamPolicySettingsSchema>;

/**
 * Validation schema for the PATCH /api/teams/[id]/policies request body.
 * All fields are optional — callers send only what they want to change.
 */
export const PatchTeamPolicyBodySchema = TeamPolicySettingsSchema.partial();

/** Partial policy update body. */
export type PatchTeamPolicyBody = z.infer<typeof PatchTeamPolicyBodySchema>;

// ============================================================================
// Founder Team Metrics
// ============================================================================

/**
 * Per-team summary in the founder dashboard Teams card.
 */
export const FounderTeamSummarySchema = z.object({
  /** teams.id */
  team_id: z.string().uuid(),
  /** teams.name */
  team_name: z.string(),
  /** Number of active members */
  member_count: z.number().int().nonnegative(),
  /** Subscription tier of the team owner */
  owner_tier: z.string(),
  /** Whether this team has had any member churn in the last 30 days */
  had_churn_30d: z.boolean(),
  /** ISO timestamp of team creation */
  created_at: z.string(),
});

/** Per-team summary. */
export type FounderTeamSummary = z.infer<typeof FounderTeamSummarySchema>;

/**
 * Aggregate team metrics for the founder dashboard.
 */
export const FounderTeamMetricsSchema = z.object({
  /** Total number of teams in the system */
  team_count: z.number().int().nonnegative(),
  /** Average member count across all teams */
  avg_team_size: z.number(),
  /**
   * Number of teams that lost at least one member in the last 30 days.
   * WHY rolling 30d: matches the solo churn-rate window in founder-metrics so
   * the founder can compare team vs. individual churn in the same period.
   */
  churned_teams_30d: z.number().int().nonnegative(),
  /**
   * Fraction of teams that had churn in the last 30d (0-1).
   * Null when there are no teams.
   */
  churn_rate_per_team_30d: z.number().nullable(),
  /** Breakdown of individual teams */
  teams: z.array(FounderTeamSummarySchema),
  /** ISO timestamp when this payload was computed */
  computed_at: z.string(),
});

/** Founder-facing team aggregate metrics. */
export type FounderTeamMetrics = z.infer<typeof FounderTeamMetricsSchema>;

// ============================================================================
// Role-change request
// ============================================================================

/**
 * Body schema for PATCH /api/teams/[id]/members/[userId].
 *
 * WHY no 'owner' in the enum: ownership transfer is a deliberate, separate
 * multi-step operation that this endpoint does not handle.
 *
 * Re-exported from admin-types rather than duplicating in the route file.
 */
export const PatchMemberRoleBodySchema = z.object({
  role: z.enum(['admin', 'member'], {
    errorMap: () => ({ message: 'Role must be "admin" or "member"' }),
  }),
});

/** Role-change request body. */
export type PatchMemberRoleBody = z.infer<typeof PatchMemberRoleBodySchema>;

// ============================================================================
// Audit log entry (lightweight, for this module)
// ============================================================================

/**
 * Action types recorded when team admins mutate policy or membership.
 *
 * WHY: Audit entries are written to the `audit_log` table by every mutating
 * route. Centralising the action-string constants prevents typos that would
 * break log-query dashboards.
 */
export const TEAM_ADMIN_AUDIT_ACTIONS = {
  MEMBER_ROLE_CHANGED: 'team.member.role_changed',
  MEMBER_REMOVED: 'team.member.removed',
  POLICY_UPDATED: 'team.policy.updated',
} as const;

/** Union of team admin audit action strings. */
export type TeamAdminAuditAction =
  (typeof TEAM_ADMIN_AUDIT_ACTIONS)[keyof typeof TEAM_ADMIN_AUDIT_ACTIONS];

// ============================================================================
// Helper: map DB role string to PolicyRole
// ============================================================================

/**
 * Narrows a raw DB role string to {@link DbRole}.
 *
 * Returns 'member' as a safe default for any unrecognised value so
 * UI components never crash on an unexpected role from the database.
 *
 * @param raw - Raw string from team_members.role
 * @returns Validated DbRole
 *
 * @example
 * parseDbRole('owner'); // 'owner'
 * parseDbRole('unknown'); // 'member'
 */
export function parseDbRole(raw: string | null | undefined): DbRole {
  if (raw === 'owner' || raw === 'admin' || raw === 'member') return raw;
  return 'member';
}
