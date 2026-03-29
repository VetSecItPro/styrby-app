/**
 * Prompt Templates API Route
 *
 * Provides tier-gated creation and listing of user-owned prompt templates.
 * All operations require Supabase Auth.
 *
 * GET  /api/templates - List user templates with tier info
 * POST /api/templates - Create a new template (tier-limited)
 *
 * Tier limits:
 * - Free:  3 templates
 * - Pro:   20 templates
 * - Power: unlimited (-1)
 *
 * @rateLimit 30 requests per minute for POST
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TIERS, type TierId } from '@/lib/polar';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Schema for creating a new prompt template.
 * WHY: Mirrors the context_templates table schema. Variables is a JSON array
 * of variable names that are substituted at agent invocation time.
 */
const CreateTemplateSchema = z.object({
  name: z
    .string()
    .min(1, 'Template name is required')
    .max(100, 'Template name must be 100 characters or less'),
  description: z
    .string()
    .max(500, 'Description must be 500 characters or less')
    .optional(),
  content: z
    .string()
    .min(1, 'Template content is required')
    .max(50_000, 'Template content must be 50,000 characters or less'),
  variables: z.array(z.string().max(100)).max(50).optional().default([]),
  isDefault: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Resolves the user's subscription tier from Supabase.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - The authenticated user's ID
 * @returns The user's tier ID (defaults to 'free' if no subscription found)
 */
async function getUserTier(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<TierId> {
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  return (subscription?.tier as TierId) || 'free';
}

// ---------------------------------------------------------------------------
// GET /api/templates
// ---------------------------------------------------------------------------

/**
 * GET /api/templates
 *
 * Lists all user-owned prompt templates (excludes system templates).
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 {
 *   templates: ContextTemplate[],
 *   tier: TierId,
 *   templateLimit: number,
 *   templateCount: number
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Failed to fetch templates' }
 */
export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [templatesResult, tier] = await Promise.all([
      // WHY: Filter by user_id to exclude system templates (is_system = true,
      // user_id = null). Users own their templates; system templates are global.
      supabase
        .from('context_templates')
        .select('id, name, description, content, variables, is_default, created_at, updated_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(200),
      getUserTier(supabase, user.id),
    ]);

    if (templatesResult.error) {
      console.error('Failed to fetch templates:', templatesResult.error.message);
      return NextResponse.json(
        { error: 'Failed to fetch templates' },
        { status: 500 }
      );
    }

    const templates = templatesResult.data || [];
    const templateLimit = TIERS[tier]?.limits.promptTemplates ?? 3;

    return NextResponse.json(
      {
        templates,
        tier,
        // WHY: -1 means unlimited (Power tier). Expose so the UI can render
        // the correct usage counter and hide the upgrade prompt for Power users.
        templateLimit,
        templateCount: templates.length,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Templates GET error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to fetch templates' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/templates
// ---------------------------------------------------------------------------

/**
 * POST /api/templates
 *
 * Creates a new user-owned prompt template. Enforces tier-based limits:
 * - Free:  3 templates
 * - Pro:   20 templates
 * - Power: unlimited (-1)
 *
 * WHY server-side enforcement: The templates client currently writes directly
 * to Supabase. This endpoint provides a server-authoritative path that enforces
 * limits before insertion, used by the CLI and any future API consumers.
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 30 requests per minute
 *
 * @body {
 *   name: string,
 *   description?: string,
 *   content: string,
 *   variables?: string[],
 *   isDefault?: boolean
 * }
 *
 * @returns 201 { template: ContextTemplate }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Tier limit reached
 * @error 500 { error: 'Failed to create template' }
 */
export async function POST(request: NextRequest) {
  // Rate limit check - 30 requests per minute
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.budgetAlerts, 'templates');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
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

    // Parse and validate request body
    const rawBody = await request.json();
    const parseResult = CreateTemplateSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Check tier limit - run tier lookup and existing count in parallel
    const [tier, countResult] = await Promise.all([
      getUserTier(supabase, user.id),
      supabase
        .from('context_templates')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id),
    ]);

    const templateLimit = TIERS[tier]?.limits.promptTemplates ?? 3;
    const currentCount = countResult.count ?? 0;

    // WHY: -1 represents unlimited (Power tier). Only enforce when positive.
    if (templateLimit !== -1 && currentCount >= templateLimit) {
      return NextResponse.json(
        {
          error: tier === 'free'
            ? `You have reached your limit of ${templateLimit} prompt templates on the Free plan. Upgrade to Pro for 20 templates.`
            : `You have reached your limit of ${templateLimit} prompt templates on the ${tier} plan. Upgrade to Power for unlimited templates.`,
        },
        { status: 403 }
      );
    }

    const { data: template, error: insertError } = await supabase
      .from('context_templates')
      .insert({
        user_id: user.id,
        name: parseResult.data.name,
        description: parseResult.data.description ?? null,
        content: parseResult.data.content,
        variables: parseResult.data.variables,
        is_default: parseResult.data.isDefault,
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create template:', insertError.message);
      return NextResponse.json(
        { error: 'Failed to create template' },
        { status: 500 }
      );
    }

    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Templates POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to create template' },
      { status: 500 }
    );
  }
}
