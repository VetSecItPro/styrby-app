/**
 * Team SSO Settings API
 *
 * Manages Google SSO domain configuration and require_sso enforcement for a team.
 *
 * GET  /api/teams/[id]/sso      - Fetch current SSO settings (admin/owner only)
 * PUT  /api/teams/[id]/sso      - Set/update sso_domain and require_sso
 * DELETE /api/teams/[id]/sso    - Clear sso_domain (disables auto-enroll)
 *
 * Security-critical:
 *   - Only team owners may set/clear sso_domain or toggle require_sso
 *   - sso_domain is normalized to lowercase before storage
 *   - Domain uniqueness is enforced at DB level (unique partial index)
 *   - Every change is written to audit_log
 *   - Cross-team enumeration prevented: only the calling team's domain is returned
 *
 * @module app/api/teams/[id]/sso
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex for a valid SSO domain.
 * WHY: Must be lowercase, valid hostname format, no protocol, no trailing dot.
 * This matches the DB-level CHECK constraint so validation is consistent.
 */
const SSO_DOMAIN_REGEX =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

// ---------------------------------------------------------------------------
// Validation Schemas
// ---------------------------------------------------------------------------

/**
 * Schema for PUT /api/teams/[id]/sso body.
 */
const SsoUpdateSchema = z.object({
  /** The Google Workspace domain for auto-enroll (e.g. "example.com"). */
  sso_domain: z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .refine((v) => SSO_DOMAIN_REGEX.test(v) && v.length <= 255, {
      message:
        'sso_domain must be a valid lowercase domain name (e.g. "example.com"), max 255 characters',
    })
    .optional(),
  /**
   * When true, password / magic-link auth is rejected for this team's members.
   * Only owners can set this. Defaults unchanged if omitted.
   */
  require_sso: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Result type for the owner verification helper.
 * WHY union type: Distinguishes between "not authenticated" (401) and
 * "authenticated but not owner" (403), allowing the caller to return
 * the correct HTTP status code.
 */
type OwnerCheckResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Verifies the caller is authenticated and an owner of the specified team.
 *
 * WHY owner-only (not admin): SSO settings affect the entire team's auth
 * surface. Allowing admins to change require_sso could lock out the owner.
 * Only the owner bears the accountability for this change.
 *
 * @param supabase - Authenticated Supabase server client
 * @param teamId - UUID of the team
 * @returns OwnerCheckResult with ok=true and userId, or ok=false with status
 */
async function verifyTeamOwner(
  supabase: Awaited<ReturnType<typeof createClient>>,
  teamId: string,
): Promise<OwnerCheckResult> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  // Check team membership role
  const { data: member } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!member || member.role !== 'owner') {
    return { ok: false, status: 403, error: 'Forbidden - only the team owner can change SSO settings' };
  }

  return { ok: true, userId: user.id };
}

/**
 * Validates that `teamId` is a well-formed UUID to prevent injection via URL param.
 *
 * @param id - Raw string from URL param
 * @returns true if valid UUID v4 format
 */
function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ---------------------------------------------------------------------------
// GET /api/teams/[id]/sso
// ---------------------------------------------------------------------------

/**
 * GET /api/teams/[id]/sso
 *
 * Returns current SSO settings for the specified team.
 * Restricted to team owners and admins.
 *
 * WHY admin-readable (not owner-only): Admins need visibility into SSO settings
 * to handle support escalations, but only owners can change them.
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @param params.id - Team UUID
 *
 * @returns 200 {
 *   sso_domain: string | null,
 *   require_sso: boolean,
 *   enrolled_count: number
 * }
 * @error 400 { error: 'Invalid team ID' }
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }
 * @error 404 { error: 'Team not found' }
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: teamId } = await params;

  if (!isValidUuid(teamId)) {
    return NextResponse.json({ error: 'Invalid team ID' }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check that caller is at least an admin of this team
    const { data: member } = await supabase
      .from('team_members')
      .select('role')
      .eq('team_id', teamId)
      .eq('user_id', user.id)
      .single();

    if (!member || !['owner', 'admin'].includes(member.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('sso_domain, require_sso')
      .eq('id', teamId)
      .single();

    if (teamError || !team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    // Count SSO-enrolled members (team members who joined via SSO)
    // WHY: Shown in admin UI to demonstrate SSO enrollment health
    const { count: enrolledCount } = await supabase
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'team_sso_enrolled')
      .contains('metadata', { team_id: teamId });

    return NextResponse.json({
      sso_domain: team.sso_domain ?? null,
      require_sso: team.require_sso ?? false,
      enrolled_count: enrolledCount ?? 0,
    });
  } catch (err) {
    console.error('[GET /api/teams/[id]/sso] error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to fetch SSO settings' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PUT /api/teams/[id]/sso
// ---------------------------------------------------------------------------

/**
 * PUT /api/teams/[id]/sso
 *
 * Sets or updates the SSO domain and/or require_sso flag for a team.
 * Only the team owner may call this endpoint.
 *
 * Security properties:
 *   - sso_domain is normalized (lowercase, trimmed) before storage
 *   - DB-level unique index prevents domain hijacking across teams
 *   - require_sso=true means password auth is rejected at the callback level
 *   - All changes are recorded in audit_log
 *
 * @auth Required - Supabase Auth JWT via cookie (must be team owner)
 * @rateLimit 10 requests per minute (shared with other team settings routes)
 * @param params.id - Team UUID
 *
 * @body {
 *   sso_domain?: string,    -- e.g. "example.com" (normalized to lowercase)
 *   require_sso?: boolean
 * }
 *
 * @returns 200 {
 *   sso_domain: string | null,
 *   require_sso: boolean
 * }
 * @error 400 { error: string } - Validation failure or domain conflict
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden - owner only' }
 * @error 409 { error: 'Domain already claimed by another team' }
 * @error 500 { error: 'Failed to update SSO settings' }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: teamId } = await params;

  if (!isValidUuid(teamId)) {
    return NextResponse.json({ error: 'Invalid team ID' }, { status: 400 });
  }

  // Rate limit: SSO changes are sensitive; tight limit prevents brute-force
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.budgetAlerts, `team-sso-${teamId}`);
  if (!allowed) {
    // WHY cast: rateLimitResponse returns Response (not NextResponse) but Next.js
    // route handlers accept both. The cast is safe - this pattern is used across all
    // API routes in the codebase.
    return rateLimitResponse(retryAfter!) as unknown as NextResponse;
  }

  try {
    const supabase = await createClient();
    const ownerCheck = await verifyTeamOwner(supabase, teamId);

    if (!ownerCheck.ok) {
      return NextResponse.json({ error: ownerCheck.error }, { status: ownerCheck.status });
    }

    const rawBody = await request.json();
    const parseResult = SsoUpdateSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 },
      );
    }

    const { sso_domain, require_sso } = parseResult.data;

    // Build the update object with only provided fields
    const updateFields: Record<string, unknown> = {};
    if (sso_domain !== undefined) updateFields.sso_domain = sso_domain;
    if (require_sso !== undefined) updateFields.require_sso = require_sso;

    if (Object.keys(updateFields).length === 0) {
      return NextResponse.json({ error: 'No fields provided to update' }, { status: 400 });
    }

    // Fetch current values for audit diff
    const { data: currentTeam } = await supabase
      .from('teams')
      .select('sso_domain, require_sso')
      .eq('id', teamId)
      .single();

    const { data: updatedTeam, error: updateError } = await supabase
      .from('teams')
      .update(updateFields)
      .eq('id', teamId)
      .select('sso_domain, require_sso')
      .single();

    if (updateError) {
      // Postgres unique constraint violation: domain already claimed by another team
      if (updateError.code === '23505') {
        return NextResponse.json(
          { error: 'That domain is already claimed by another team. Contact support if you believe this is an error.' },
          { status: 409 },
        );
      }
      // Check constraint violation (invalid domain format — shouldn't happen due to Zod, but belt-and-suspenders)
      if (updateError.code === '23514') {
        return NextResponse.json(
          { error: 'Invalid domain format. Use a valid domain like "example.com".' },
          { status: 400 },
        );
      }
      console.error('[PUT /api/teams/[id]/sso] update error:', updateError.message);
      return NextResponse.json({ error: 'Failed to update SSO settings' }, { status: 500 });
    }

    // Write audit log entries for each change (fire-and-forget, non-fatal)
    // WHY Promise.allSettled: audit failures must not prevent the response.
    // WHY cast to Promise<unknown>: PostgrestFilterBuilder is thenable but TypeScript
    // does not extend the Promise type; the cast is safe since we only need settlement.
    const auditInserts: Array<Promise<unknown>> = [];

    if (sso_domain !== undefined && currentTeam?.sso_domain !== sso_domain) {
      auditInserts.push(
        supabase.from('audit_log').insert({
          user_id: ownerCheck.userId,
          action: 'team_sso_domain_set',
          metadata: {
            team_id: teamId,
            previous_domain: currentTeam?.sso_domain ?? null,
            new_domain: sso_domain,
          },
        }) as unknown as Promise<unknown>,
      );
    }

    if (require_sso !== undefined && currentTeam?.require_sso !== require_sso) {
      auditInserts.push(
        supabase.from('audit_log').insert({
          user_id: ownerCheck.userId,
          action: 'team_require_sso_toggled',
          metadata: {
            team_id: teamId,
            previous_value: currentTeam?.require_sso ?? false,
            new_value: require_sso,
          },
        }) as unknown as Promise<unknown>,
      );
    }

    await Promise.allSettled(auditInserts);

    return NextResponse.json({
      sso_domain: updatedTeam?.sso_domain ?? null,
      require_sso: updatedTeam?.require_sso ?? false,
    });
  } catch (err) {
    console.error('[PUT /api/teams/[id]/sso] error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to update SSO settings' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/teams/[id]/sso
// ---------------------------------------------------------------------------

/**
 * DELETE /api/teams/[id]/sso
 *
 * Clears the team's SSO domain (disables auto-enroll and require_sso).
 * Only the team owner may call this endpoint.
 *
 * WHY also resets require_sso to false: Clearing the domain while leaving
 * require_sso=true would lock all members out of password auth with no
 * SSO provider configured, bricking the team. We reset both atomically.
 *
 * @auth Required - Supabase Auth JWT via cookie (must be team owner)
 * @param params.id - Team UUID
 *
 * @returns 200 { sso_domain: null, require_sso: false }
 * @error 400 { error: 'Invalid team ID' }
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden - owner only' }
 * @error 500 { error: 'Failed to clear SSO settings' }
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: teamId } = await params;

  if (!isValidUuid(teamId)) {
    return NextResponse.json({ error: 'Invalid team ID' }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const ownerCheck = await verifyTeamOwner(supabase, teamId);

    if (!ownerCheck.ok) {
      return NextResponse.json({ error: ownerCheck.error }, { status: ownerCheck.status });
    }

    // Fetch current values for audit diff
    const { data: currentTeam } = await supabase
      .from('teams')
      .select('sso_domain, require_sso')
      .eq('id', teamId)
      .single();

    const { error: updateError } = await supabase
      .from('teams')
      .update({ sso_domain: null, require_sso: false })
      .eq('id', teamId);

    if (updateError) {
      console.error('[DELETE /api/teams/[id]/sso] error:', updateError.message);
      return NextResponse.json({ error: 'Failed to clear SSO settings' }, { status: 500 });
    }

    // Audit log
    await supabase.from('audit_log').insert({
      user_id: ownerCheck.userId,
      action: 'team_sso_domain_cleared',
      metadata: {
        team_id: teamId,
        previous_domain: currentTeam?.sso_domain ?? null,
        previous_require_sso: currentTeam?.require_sso ?? false,
      },
    });

    return NextResponse.json({ sso_domain: null, require_sso: false });
  } catch (err) {
    console.error('[DELETE /api/teams/[id]/sso] error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to clear SSO settings' }, { status: 500 });
  }
}
