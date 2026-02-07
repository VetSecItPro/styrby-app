/**
 * Webhook Deliveries API Route
 *
 * Provides read access to webhook delivery logs for debugging and monitoring.
 *
 * GET /api/webhooks/user/deliveries - List deliveries for a webhook
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const GetDeliveriesSchema = z.object({
  webhookId: z.string().uuid('Invalid webhook ID'),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

// ---------------------------------------------------------------------------
// GET /api/webhooks/user/deliveries
// ---------------------------------------------------------------------------

/**
 * GET /api/webhooks/user/deliveries?webhookId={id}&limit={n}&offset={n}
 *
 * Lists delivery attempts for a specific webhook, ordered by most recent first.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @query webhookId - UUID of the webhook to get deliveries for
 * @query limit - Maximum number of deliveries to return (default: 50, max: 100)
 * @query offset - Number of deliveries to skip for pagination (default: 0)
 *
 * @returns 200 {
 *   deliveries: WebhookDelivery[],
 *   total: number,
 *   limit: number,
 *   offset: number
 * }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Access denied' }
 * @error 500 { error: 'Failed to fetch deliveries' }
 */
export async function GET(request: NextRequest) {
  // FIX-048: Add rate limiting to webhook deliveries endpoint
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.standard, 'webhook-deliveries');
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

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const parseResult = GetDeliveriesSchema.safeParse({
      webhookId: searchParams.get('webhookId'),
      limit: searchParams.get('limit'),
      offset: searchParams.get('offset'),
    });

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    const { webhookId, limit, offset } = parseResult.data;

    // Verify webhook belongs to user
    const { data: webhook, error: webhookError } = await supabase
      .from('webhooks')
      .select('id')
      .eq('id', webhookId)
      .eq('user_id', user.id)
      .single();

    if (webhookError || !webhook) {
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      );
    }

    // Fetch deliveries with count
    const [deliveriesResult, countResult] = await Promise.all([
      supabase
        .from('webhook_deliveries')
        .select(
          `
          id,
          event,
          payload,
          status,
          attempts,
          last_attempt_at,
          next_retry_at,
          response_status,
          response_body,
          error_message,
          duration_ms,
          created_at,
          completed_at
        `
        )
        .eq('webhook_id', webhookId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1),
      supabase
        .from('webhook_deliveries')
        .select('id', { count: 'exact', head: true })
        .eq('webhook_id', webhookId),
    ]);

    if (deliveriesResult.error) {
      console.error('Failed to fetch deliveries:', deliveriesResult.error.message);
      return NextResponse.json(
        { error: 'Failed to fetch deliveries' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      deliveries: deliveriesResult.data || [],
      total: countResult.count ?? 0,
      limit,
      offset,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Webhook deliveries GET error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to fetch deliveries' },
      { status: 500 }
    );
  }
}
