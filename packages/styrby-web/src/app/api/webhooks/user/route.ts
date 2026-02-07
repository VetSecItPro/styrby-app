/**
 * User Webhooks API Route
 *
 * Provides CRUD operations for user webhook configurations. Each endpoint
 * authenticates via Supabase Auth, validates input with Zod, and enforces
 * tier-based limits on webhook creation (Free: 0, Pro: 3, Power: 10).
 *
 * GET    /api/webhooks/user - List user's webhooks with delivery stats
 * POST   /api/webhooks/user - Create a new webhook
 * PATCH  /api/webhooks/user - Update an existing webhook
 * DELETE /api/webhooks/user - Delete a webhook
 *
 * @rateLimit 30 requests per minute for POST, PATCH, DELETE
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
 * Valid webhook event types matching the database enum.
 * WHY: Must mirror the Postgres `webhook_event` enum exactly.
 */
const WebhookEventEnum = z.enum([
  'session.started',
  'session.completed',
  'budget.exceeded',
  'permission.requested',
]);

/**
 * Schema for creating a new webhook.
 * WHY: Validates all fields before insertion to prevent malformed data
 * from reaching Supabase and to give users clear error messages.
 */
/**
 * Validates that a URL is not targeting internal/private networks.
 *
 * WHY (FIX-027 + FIX-042): Webhook URLs must point to public HTTPS endpoints.
 * Without this check, an attacker could register a webhook targeting
 * localhost, cloud metadata services (169.254.169.254), or RFC 1918
 * private IPs to perform SSRF attacks against our infrastructure.
 *
 * @param url - The URL to validate
 * @returns True if the URL is safe for external requests
 */
function isSafeWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // FIX-042: Must be HTTPS in production
    if (parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.toLowerCase();

    // Block localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      return false;
    }

    // Block cloud metadata services
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return false;
    }

    // Block RFC 1918 private IPs
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return false;                    // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
      if (a === 192 && b === 168) return false;      // 192.168.0.0/16
      if (a === 169 && b === 254) return false;      // Link-local
    }

    // Block IPv6-mapped IPv4 private addresses
    if (hostname.startsWith('::ffff:')) return false;

    return true;
  } catch {
    return false;
  }
}

const CreateWebhookSchema = z.object({
  name: z
    .string()
    .min(1, 'Webhook name is required')
    .max(100, 'Webhook name must be 100 characters or less'),
  url: z
    .string()
    .url('Invalid URL format')
    .refine(
      (url) => url.startsWith('https://'),
      'URL must use HTTPS'
    )
    .refine(
      (url) => url.length <= 2048,
      'URL must be 2048 characters or less'
    )
    .refine(
      (url) => isSafeWebhookUrl(url),
      'URL must not target internal or private networks'
    ),
  events: z
    .array(WebhookEventEnum)
    .min(1, 'At least one event is required')
    .max(4, 'Maximum 4 events allowed'),
});

/**
 * Schema for updating an existing webhook.
 * All fields except ID are optional for partial updates.
 */
const UpdateWebhookSchema = z.object({
  id: z.string().uuid('Invalid webhook ID'),
  name: z
    .string()
    .min(1, 'Webhook name is required')
    .max(100, 'Webhook name must be 100 characters or less')
    .optional(),
  url: z
    .string()
    .url('Invalid URL format')
    .refine(
      (url) => url.startsWith('https://'),
      'URL must use HTTPS'
    )
    .refine(
      (url) => url.length <= 2048,
      'URL must be 2048 characters or less'
    )
    .refine(
      (url) => isSafeWebhookUrl(url),
      'URL must not target internal or private networks'
    )
    .optional(),
  events: z
    .array(WebhookEventEnum)
    .min(1, 'At least one event is required')
    .max(4, 'Maximum 4 events allowed')
    .optional(),
  is_active: z.boolean().optional(),
});

/**
 * Schema for deleting a webhook.
 */
const DeleteWebhookSchema = z.object({
  id: z.string().uuid('Invalid webhook ID'),
});

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Resolves the user's subscription tier from Supabase.
 *
 * WHY: Webhook limits are tier-gated. Free users get 0 webhooks,
 * Pro gets 3, Power gets 10. We must check the subscription table
 * to determine the user's current tier before allowing creation.
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
// GET /api/webhooks/user
// ---------------------------------------------------------------------------

/**
 * GET /api/webhooks/user
 *
 * Lists all webhooks for the authenticated user, including delivery statistics.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @returns 200 {
 *   webhooks: Webhook[],
 *   tier: TierId,
 *   webhookLimit: number,
 *   webhookCount: number
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Failed to fetch webhooks' }
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

    // Fetch webhooks and subscription tier in parallel
    const [webhooksResult, tier] = await Promise.all([
      supabase
        .from('webhooks')
        .select(
          `
          id,
          name,
          url,
          events,
          is_active,
          last_success_at,
          last_failure_at,
          consecutive_failures,
          created_at,
          updated_at
        `
        )
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false }),
      getUserTier(supabase, user.id),
    ]);

    if (webhooksResult.error) {
      console.error('Failed to fetch webhooks:', webhooksResult.error.message);
      return NextResponse.json(
        { error: 'Failed to fetch webhooks' },
        { status: 500 }
      );
    }

    const webhooks = webhooksResult.data || [];
    const webhookLimit = TIERS[tier]?.limits.webhooks ?? 0;

    return NextResponse.json({
      webhooks,
      tier,
      webhookLimit,
      webhookCount: webhooks.length,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Webhooks GET error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to fetch webhooks' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/webhooks/user
// ---------------------------------------------------------------------------

/**
 * POST /api/webhooks/user
 *
 * Creates a new webhook. Enforces the user's tier limit on total webhooks.
 * Automatically generates a secure signing secret.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   name: string,
 *   url: string (https://...),
 *   events: ('session.started' | 'session.completed' | 'budget.exceeded' | 'permission.requested')[]
 * }
 *
 * @returns 201 { webhook: Webhook, secret: string }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: string } - Tier limit reached
 * @error 500 { error: 'Failed to create webhook' }
 */
export async function POST(request: NextRequest) {
  // Rate limit check - 30 requests per minute (same as budget alerts)
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'webhooks');
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
    const parseResult = CreateWebhookSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Check tier limit
    const [tier, countResult] = await Promise.all([
      getUserTier(supabase, user.id),
      supabase
        .from('webhooks')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .is('deleted_at', null),
    ]);

    const webhookLimit = TIERS[tier]?.limits.webhooks ?? 0;
    const currentCount = countResult.count ?? 0;

    if (currentCount >= webhookLimit) {
      // WHY: Free users (limit 0) get a different message than paid users who
      // have hit their limit. This helps guide them toward the right action.
      if (webhookLimit === 0) {
        return NextResponse.json(
          { error: 'Webhooks are not available on the Free plan. Upgrade to Pro to create webhooks.' },
          { status: 403 }
        );
      }
      return NextResponse.json(
        { error: `You have reached your limit of ${webhookLimit} webhooks on the ${tier} plan. Upgrade to increase your limit.` },
        { status: 403 }
      );
    }

    // Insert the new webhook (secret is auto-generated by the database trigger)
    const { data: webhook, error: insertError } = await supabase
      .from('webhooks')
      .insert({
        user_id: user.id,
        name: parseResult.data.name,
        url: parseResult.data.url,
        events: parseResult.data.events,
      })
      .select('id, name, url, events, is_active, secret, created_at')
      .single();

    if (insertError) {
      console.error('Failed to create webhook:', insertError.message);
      return NextResponse.json(
        { error: 'Failed to create webhook' },
        { status: 500 }
      );
    }

    // WHY: Return the secret only on creation. After this, users cannot retrieve
    // it from the API - they must regenerate if lost. This follows security best
    // practices for handling signing secrets.
    const { secret, ...webhookWithoutSecret } = webhook;

    return NextResponse.json(
      { webhook: webhookWithoutSecret, secret },
      { status: 201 }
    );
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Webhooks POST error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to create webhook' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/webhooks/user
// ---------------------------------------------------------------------------

/**
 * PATCH /api/webhooks/user
 *
 * Updates an existing webhook. Supports partial updates (only the fields
 * provided will be changed).
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body {
 *   id: string (UUID),
 *   name?: string,
 *   url?: string,
 *   events?: string[],
 *   is_active?: boolean
 * }
 *
 * @returns 200 { webhook: Webhook }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 404 { error: 'Webhook not found' }
 * @error 500 { error: 'Failed to update webhook' }
 */
export async function PATCH(request: NextRequest) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'webhooks');
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

    const rawBody = await request.json();
    const parseResult = UpdateWebhookSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    const { id, ...updateFields } = parseResult.data;

    // Clean undefined fields
    const cleanedFields = Object.fromEntries(
      Object.entries(updateFields).filter(([, value]) => value !== undefined)
    );

    if (Object.keys(cleanedFields).length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400 }
      );
    }

    // RLS ensures the user can only update their own webhooks
    const { data: webhook, error: updateError } = await supabase
      .from('webhooks')
      .update(cleanedFields)
      .eq('id', id)
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .select('id, name, url, events, is_active, last_success_at, last_failure_at, consecutive_failures, created_at, updated_at')
      .single();

    if (updateError) {
      if (updateError.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Webhook not found' },
          { status: 404 }
        );
      }
      console.error('Failed to update webhook:', updateError.message);
      return NextResponse.json(
        { error: 'Failed to update webhook' },
        { status: 500 }
      );
    }

    return NextResponse.json({ webhook });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Webhooks PATCH error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to update webhook' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/webhooks/user
// ---------------------------------------------------------------------------

/**
 * DELETE /api/webhooks/user
 *
 * Soft-deletes a webhook by setting deleted_at timestamp.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body { id: string (UUID) }
 *
 * @returns 200 { success: true }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 404 { error: 'Webhook not found' }
 * @error 500 { error: 'Failed to delete webhook' }
 */
export async function DELETE(request: NextRequest) {
  // Rate limit check
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.budgetAlerts, 'webhooks');
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

    const rawBody = await request.json();
    const parseResult = DeleteWebhookSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Check if webhook exists
    const { data: existing } = await supabase
      .from('webhooks')
      .select('id')
      .eq('id', parseResult.data.id)
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .single();

    if (!existing) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      );
    }

    // Soft delete by setting deleted_at
    const { error: deleteError } = await supabase
      .from('webhooks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', parseResult.data.id)
      .eq('user_id', user.id);

    if (deleteError) {
      console.error('Failed to delete webhook:', deleteError.message);
      return NextResponse.json(
        { error: 'Failed to delete webhook' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Webhooks DELETE error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to delete webhook' },
      { status: 500 }
    );
  }
}
