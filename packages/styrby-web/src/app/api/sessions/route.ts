/**
 * POST /api/sessions
 *
 * Creates a new agent session for the authenticated user. Enforces the
 * user's tier limit for maxSessionsPerDay before writing to the database.
 *
 * WHY this route exists (SEC-LOGIC-002): Sessions were previously created
 * directly by the CLI via Supabase Realtime, which bypassed the TIER_LIMITS
 * enforced in the UI. This route provides a server-authoritative creation
 * path with hard server-side quota enforcement so direct API calls cannot
 * circumvent free-tier session caps.
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 30 requests per minute per user
 *
 * @body {
 *   machineId: string (UUID) - The registered machine starting this session
 *   agentType: 'claude' | 'codex' | 'gemini' - The AI agent to use
 *   model?: string - Optional model override (e.g. 'claude-sonnet-4')
 *   projectPath?: string - Working directory path on the machine
 *   title?: string - Human-readable session title
 *   gitBranch?: string - Current git branch, if in a repo
 *   gitRemoteUrl?: string - Git remote URL, if in a repo
 *   tags?: string[] - Optional session tags
 * }
 *
 * @returns 201 {
 *   session: {
 *     id: string,
 *     agent_type: string,
 *     status: string,
 *     started_at: string
 *   }
 * }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'TIER_LIMIT_EXCEEDED', limit: number, current: number, tier: string, upgradeUrl: string }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkTierLimit } from '@/lib/tier-enforcement';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { z } from 'zod';
// Phase 0.10 — unified API error envelope (OWASP ASVS V7.4 / consistent
// error contract for clients). Migrating routes incrementally; this is one
// of the representative routes.
import { apiError } from '@styrby/shared';

// ---------------------------------------------------------------------------
// Request Schema
// ---------------------------------------------------------------------------

/**
 * Valid agent types matching the Postgres `agent_type` enum.
 * WHY: Must mirror the DB enum exactly to prevent insert errors.
 */
const AgentTypeSchema = z.enum(['claude', 'codex', 'gemini']);

/**
 * Schema for creating a new session.
 * Only required fields are enforced; optional fields map to nullable columns.
 */
const CreateSessionSchema = z.object({
  machineId: z.string().uuid('machineId must be a valid UUID'),
  agentType: AgentTypeSchema,
  model: z.string().max(100).optional(),
  projectPath: z.string().max(500).optional(),
  title: z.string().max(200).optional(),
  gitBranch: z.string().max(200).optional(),
  gitRemoteUrl: z.string().url('gitRemoteUrl must be a valid URL').max(500).optional(),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/sessions
 *
 * Creates a new session after verifying:
 * 1. User is authenticated
 * 2. The machine belongs to the authenticated user
 * 3. The user has not exceeded their tier's maxSessionsPerDay limit
 */
export async function POST(request: NextRequest) {
  // Rate limit before any auth or DB work to protect the endpoint.
  const { allowed: rateLimitAllowed, retryAfter } = await rateLimit(
    request,
    RATE_LIMITS.budgetAlerts, // 30 req/min — same bucket as other mutation endpoints
    'sessions-create'
  );
  if (!rateLimitAllowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    // Authenticate the user.
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        apiError('UNAUTHORIZED', 'Authentication required'),
        { status: 401 }
      );
    }

    // Parse and validate the request body.
    const rawBody = await request.json();
    const parseResult = CreateSessionSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        apiError(
          'VALIDATION_FAILED',
          parseResult.error.errors.map((e) => e.message).join(', '),
          { issues: parseResult.error.errors.map((e) => ({ path: e.path, message: e.message })) },
        ),
        { status: 400 }
      );
    }

    const { machineId, agentType, model, projectPath, title, gitBranch, gitRemoteUrl, tags } =
      parseResult.data;

    // Verify the machine belongs to this user before creating a session on it.
    // WHY explicit ownership check (FIX-025 pattern): Don't rely solely on RLS
    // to catch cross-user machine references; a compromised or confused client
    // could pass a valid UUID for another user's machine.
    const { data: machine, error: machineError } = await supabase
      .from('machines')
      .select('id')
      .eq('id', machineId)
      .eq('user_id', user.id)
      .single();

    if (machineError || !machine) {
      return NextResponse.json(
        apiError('FORBIDDEN', 'Machine not found or access denied'),
        { status: 403 }
      );
    }

    // Enforce the tier's daily session limit (SEC-LOGIC-002).
    // WHY here, after ownership check: no point in counting sessions if the
    // machine reference is invalid. Fail fast on the cheaper checks first.
    const tierCheck = await checkTierLimit(user.id, 'maxSessionsPerDay', supabase);

    if (!tierCheck.allowed) {
      return NextResponse.json(
        apiError(
          'TIER_LIMIT_EXCEEDED',
          `Daily session limit reached for ${tierCheck.tier} tier`,
          {
            limit: tierCheck.limit,
            current: tierCheck.current,
            tier: tierCheck.tier,
            upgradeUrl: tierCheck.upgradeUrl,
          },
        ),
        { status: 403 }
      );
    }

    // All checks passed — create the session.
    const { data: session, error: insertError } = await supabase
      .from('sessions')
      .insert({
        user_id: user.id,
        machine_id: machineId,
        agent_type: agentType,
        model: model ?? null,
        project_path: projectPath ?? null,
        title: title ?? null,
        git_branch: gitBranch ?? null,
        git_remote_url: gitRemoteUrl ?? null,
        tags: tags,
        status: 'starting',
      })
      .select('id, agent_type, status, started_at')
      .single();

    if (insertError) {
      const isDev = process.env.NODE_ENV === 'development';
      console.error(
        '[sessions/route] Failed to create session:',
        isDev ? insertError : insertError.message
      );
      return NextResponse.json(
        apiError('INTERNAL_ERROR', 'Failed to create session'),
        { status: 500 }
      );
    }

    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      '[sessions/route] Unexpected error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown'
    );
    return NextResponse.json(
      apiError('INTERNAL_ERROR', 'An unexpected error occurred'),
      { status: 500 }
    );
  }
}
