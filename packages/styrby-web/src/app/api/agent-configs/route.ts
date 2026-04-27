/**
 * Agent Configs API Route
 *
 * Provides creation and retrieval of per-user agent configurations.
 * Enforces the user's tier limit for maxAgents on POST.
 *
 * WHY this route exists (SEC-LOGIC-002): Agent configs were previously created
 * directly via the Supabase client in dashboard components. A free-tier user
 * could bypass the 1-agent limit by calling the Supabase API directly. This
 * route provides a server-authoritative creation path with hard server-side
 * quota enforcement.
 *
 * GET  /api/agent-configs - List all configs for the authenticated user
 * POST /api/agent-configs - Create a config (enforces maxAgents tier limit)
 *
 * Tier limits:
 * - Free:  1 agent
 * - Pro:   3 agents
 * - Power: 9 agents
 *
 * @rateLimit 30 requests per minute for POST
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkTierLimit } from '@/lib/tier-enforcement';
import { TIER_LIMITS } from '@styrby/shared';
import type { TierId } from '@/lib/polar';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Valid agent types matching the Postgres `agent_type` enum.
 * WHY: Must mirror the DB enum exactly to prevent insert errors.
 */
const AgentTypeSchema = z.enum(['claude', 'codex', 'gemini']);

/**
 * Schema for creating a new agent config.
 * Fields map directly to the agent_configs table columns.
 */
const CreateAgentConfigSchema = z.object({
  agentType: AgentTypeSchema,
  isEnabled: z.boolean().optional().default(true),
  defaultModel: z.string().max(100).optional(),
  /** Temperature between 0.0 and 2.0, matching the DB CHECK constraint. */
  temperature: z.number().min(0).max(2).optional(),
  customSystemPrompt: z.string().max(50_000).optional(),
  autoApproveLowRisk: z.boolean().optional().default(false),
  /** Tool/path patterns to auto-approve. Max 50 entries. */
  autoApprovePatterns: z.array(z.string().max(200)).max(50).optional().default([]),
  /** Tools that are never allowed for this agent. Max 50 entries. */
  blockedTools: z.array(z.string().max(200)).max(50).optional().default([]),
  maxTokensPerRequest: z.number().int().positive().optional(),
  maxCostPerSessionUsd: z.number().positive().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/agent-configs
// ---------------------------------------------------------------------------

/**
 * GET /api/agent-configs
 *
 * Lists all agent configurations for the authenticated user.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 {
 *   configs: AgentConfig[],
 *   tier: string,
 *   maxAgents: number,
 *   configCount: number
 * }
 *
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */
export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      );
    }

    const { data: configs, error: fetchError } = await supabase
      .from('agent_configs')
      .select(
        `id, agent_type, is_enabled, default_model, temperature, custom_system_prompt,
         auto_approve_low_risk, auto_approve_patterns, blocked_tools,
         max_tokens_per_request, max_cost_per_session_usd, created_at, updated_at`
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (fetchError) {
      console.error('[agent-configs/route] GET fetch error:', fetchError.message);
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to fetch agent configs' },
        { status: 500 }
      );
    }

    // Resolve the user's tier to surface the maxAgents limit alongside the
    // data, so the UI can render the correct usage bar in one round-trip.
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single();

    // WHY post-Phase 5: TierId narrowed to 'free' | 'pro' | 'growth'.
    const knownTiers: TierId[] = ['free', 'pro', 'growth'];
    const resolvedTier = (
      knownTiers.includes(subscription?.tier as TierId)
        ? subscription?.tier
        : 'free'
    ) as TierId;

    // WHY TIER_LIMITS not TIERS: TIERS (from polar.ts) tracks billing plan config.
    // TIER_LIMITS (from @styrby/shared) is the enforcement source of truth for
    // maxAgents. We expose what we actually enforce, not the billing plan copy.
    const maxAgents = TIER_LIMITS[resolvedTier as keyof typeof TIER_LIMITS]?.maxAgents ?? 1;

    return NextResponse.json(
      {
        configs: configs ?? [],
        tier: resolvedTier,
        configCount: configs?.length ?? 0,
        maxAgents,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      '[agent-configs/route] Unexpected GET error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown'
    );
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/agent-configs
// ---------------------------------------------------------------------------

/**
 * POST /api/agent-configs
 *
 * Creates a new agent configuration. Enforces the user's tier limit for
 * maxAgents (SEC-LOGIC-002) before writing to the database.
 *
 * WHY upsert-via-conflict: The agent_configs table has a UNIQUE constraint on
 * (user_id, agent_type). If the user calls this endpoint for an agent they
 * already have a config for, we return 409 with a clear message instead of
 * silently overwriting settings. Use PATCH for updates.
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 30 requests per minute
 *
 * @body {
 *   agentType: 'claude' | 'codex' | 'gemini',
 *   isEnabled?: boolean,
 *   defaultModel?: string,
 *   temperature?: number,
 *   customSystemPrompt?: string,
 *   autoApproveLowRisk?: boolean,
 *   autoApprovePatterns?: string[],
 *   blockedTools?: string[],
 *   maxTokensPerRequest?: number,
 *   maxCostPerSessionUsd?: number
 * }
 *
 * @returns 201 { config: AgentConfig }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'TIER_LIMIT_EXCEEDED', limit: number, current: number, tier: string, upgradeUrl: string }
 * @error 409 { error: 'CONFLICT', message: string } - Config already exists for this agent
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */
export async function POST(request: NextRequest) {
  // Rate limit before auth or DB work.
  const { allowed: rateLimitAllowed, retryAfter } = await rateLimit(
    request,
    RATE_LIMITS.budgetAlerts, // 30 req/min
    'agent-configs-create'
  );
  if (!rateLimitAllowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      );
    }

    // Parse and validate the request body.
    const rawBody = await request.json();
    const parseResult = CreateAgentConfigSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    const {
      agentType,
      isEnabled,
      defaultModel,
      temperature,
      customSystemPrompt,
      autoApproveLowRisk,
      autoApprovePatterns,
      blockedTools,
      maxTokensPerRequest,
      maxCostPerSessionUsd,
    } = parseResult.data;

    // Enforce the tier's agent limit (SEC-LOGIC-002).
    // WHY before the duplicate check: if the user is at their limit AND already
    // has a config for this agent type, we want the 403 (limit) not a 409
    // (conflict). The conflict only applies when they're under the limit.
    const tierCheck = await checkTierLimit(user.id, 'maxAgents', supabase);

    if (!tierCheck.allowed) {
      return NextResponse.json(
        {
          error: 'TIER_LIMIT_EXCEEDED',
          limit: tierCheck.limit,
          current: tierCheck.current,
          tier: tierCheck.tier,
          upgradeUrl: tierCheck.upgradeUrl,
        },
        { status: 403 }
      );
    }

    // Create the config. The UNIQUE(user_id, agent_type) constraint will reject
    // duplicates with a Postgres unique violation error (code '23505').
    const { data: config, error: insertError } = await supabase
      .from('agent_configs')
      .insert({
        user_id: user.id,
        agent_type: agentType,
        is_enabled: isEnabled,
        default_model: defaultModel ?? null,
        temperature: temperature ?? null,
        custom_system_prompt: customSystemPrompt ?? null,
        auto_approve_low_risk: autoApproveLowRisk,
        auto_approve_patterns: autoApprovePatterns,
        blocked_tools: blockedTools,
        max_tokens_per_request: maxTokensPerRequest ?? null,
        max_cost_per_session_usd: maxCostPerSessionUsd ?? null,
      })
      .select()
      .single();

    if (insertError) {
      // WHY check for code '23505': Supabase wraps Postgres errors. A unique
      // violation means the user already has a config for this agent type.
      if (insertError.code === '23505') {
        return NextResponse.json(
          {
            error: 'CONFLICT',
            message: `A configuration for agent '${agentType}' already exists. Use PATCH to update it.`,
          },
          { status: 409 }
        );
      }

      const isDev = process.env.NODE_ENV === 'development';
      console.error(
        '[agent-configs/route] Failed to create config:',
        isDev ? insertError : insertError.message
      );
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to create agent config' },
        { status: 500 }
      );
    }

    return NextResponse.json({ config }, { status: 201 });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      '[agent-configs/route] Unexpected POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown'
    );
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
