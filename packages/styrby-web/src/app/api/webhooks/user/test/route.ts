/**
 * Webhook Test API Route
 *
 * Sends a test event to a user's webhook to verify it's working correctly.
 *
 * POST /api/webhooks/user/test - Send test event
 *
 * @rateLimit 10 requests per minute (sensitive operation)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const TestWebhookSchema = z.object({
  id: z.string().uuid('Invalid webhook ID'),
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/user/test
// ---------------------------------------------------------------------------

/**
 * POST /api/webhooks/user/test
 *
 * Sends a test event to the specified webhook. Creates a delivery record
 * with a 'test.ping' event that can be used to verify the webhook endpoint
 * is receiving and processing events correctly.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @body { id: string (UUID) }
 *
 * @returns 200 { success: true, deliveryId: string, message: string }
 *
 * @error 400 { error: string } - Validation failure
 * @error 401 { error: 'Unauthorized' }
 * @error 404 { error: 'Webhook not found' }
 * @error 500 { error: 'Failed to send test event' }
 */
export async function POST(request: NextRequest) {
  // Rate limit check - 10 requests per minute (sensitive)
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.sensitive, 'webhook-test');
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
    const parseResult = TestWebhookSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.errors.map((e) => e.message).join(', ') },
        { status: 400 }
      );
    }

    // Verify webhook exists and belongs to user
    const { data: webhook, error: fetchError } = await supabase
      .from('webhooks')
      .select('id, name, url, secret, is_active')
      .eq('id', parseResult.data.id)
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .single();

    if (fetchError || !webhook) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      );
    }

    if (!webhook.is_active) {
      return NextResponse.json(
        { error: 'Webhook is disabled. Enable it before testing.' },
        { status: 400 }
      );
    }

    // Create test payload
    const testPayload = {
      event: 'test.ping',
      timestamp: new Date().toISOString(),
      data: {
        webhook_id: webhook.id,
        webhook_name: webhook.name,
        message: 'This is a test event from Styrby. If you receive this, your webhook is working correctly!',
        test_timestamp: new Date().toISOString(),
      },
    };

    // Create a delivery record
    // WHY: We use 'session.started' as the event type since our enum doesn't have 'test.ping'
    // The payload clearly indicates this is a test event
    const { data: delivery, error: insertError } = await supabase
      .from('webhook_deliveries')
      .insert({
        webhook_id: webhook.id,
        event: 'session.started', // Use a valid enum value
        payload: testPayload,
        status: 'pending',
      })
      .select('id')
      .single();

    if (insertError || !delivery) {
      console.error('Failed to create test delivery:', insertError?.message);
      return NextResponse.json(
        { error: 'Failed to create test event' },
        { status: 500 }
      );
    }

    // Trigger the delivery immediately by calling the Edge Function
    // In production, this would be done via Supabase Edge Function invoke
    // For now, we'll let the cron job pick it up, or the user can check the delivery log

    // WHY: We could invoke the Edge Function directly here, but that would require
    // the SUPABASE_SERVICE_ROLE_KEY in the Next.js app, which we want to avoid.
    // Instead, we create the delivery record and let the scheduled function handle it.

    return NextResponse.json({
      success: true,
      deliveryId: delivery.id,
      message: 'Test event queued. Check the delivery log for results.',
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Webhook test error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Failed to send test event' },
      { status: 500 }
    );
  }
}
