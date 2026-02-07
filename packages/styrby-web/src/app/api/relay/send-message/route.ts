/**
 * POST /api/relay/send-message
 *
 * Inserts a user message into the session_messages table.
 * The CLI picks up new messages via Supabase Realtime subscription.
 *
 * @auth Required - Bearer token (Supabase Auth JWT via cookie)
 * @rateLimit 100 requests per minute (standard)
 *
 * @body {
 *   sessionId: string - The session to send the message to
 *   content: string - The message content
 * }
 *
 * @returns 200 { success: true }
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'FORBIDDEN', message: string }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

/**
 * Request body schema for message sending.
 *
 * WHY (FIX-004): Requires `content_encrypted` and `encryption_nonce` instead of
 * plaintext `content`. This enforces E2E encryption at the API boundary — the
 * web client must encrypt with the session's public key before sending.
 * Legacy plaintext `content` field is no longer accepted.
 */
const sendMessageSchema = z.object({
  sessionId: z.string().uuid('Invalid session ID'),
  content_encrypted: z.string().min(1, 'Encrypted content is required').max(200000, 'Message too long'),
  encryption_nonce: z.string().min(1, 'Encryption nonce is required').max(200, 'Invalid nonce'),
});

export async function POST(request: Request) {
  // Rate limit check - standard limit for relay messages
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.standard, 'relay-send');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    // Authenticate user
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

    // Parse and validate request body
    const body = await request.json();
    const parseResult = sendMessageSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: 'VALIDATION_ERROR',
          message: parseResult.error.errors[0].message,
        },
        { status: 400 }
      );
    }

    const { sessionId, content_encrypted, encryption_nonce } = parseResult.data;

    // Verify session exists and belongs to user
    // WHY (FIX-025): Explicit user_id filter instead of relying solely on RLS
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, status, user_id')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .single();

    if (sessionError || !session) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Session not found or access denied' },
        { status: 403 }
      );
    }

    // Check if session is active
    if (!['starting', 'running', 'idle', 'paused'].includes(session.status)) {
      return NextResponse.json(
        { error: 'VALIDATION_ERROR', message: 'Cannot send messages to an ended session' },
        { status: 400 }
      );
    }

    // FIX-034: Check for active hard_stop budget alerts before allowing message
    const { data: hardStopAlerts } = await supabase
      .from('budget_alerts')
      .select('id, threshold_usd, period')
      .eq('user_id', user.id)
      .eq('action', 'hard_stop')
      .eq('is_enabled', true)
      .limit(10);

    if (hardStopAlerts && hardStopAlerts.length > 0) {
      // Check if any hard_stop threshold is exceeded
      for (const alert of hardStopAlerts) {
        const periodStart = new Date();
        if (alert.period === 'daily') periodStart.setUTCHours(0, 0, 0, 0);
        else if (alert.period === 'weekly') {
          const day = periodStart.getUTCDay();
          periodStart.setUTCDate(periodStart.getUTCDate() - (day === 0 ? 6 : day - 1));
          periodStart.setUTCHours(0, 0, 0, 0);
        } else {
          periodStart.setUTCDate(1);
          periodStart.setUTCHours(0, 0, 0, 0);
        }

        const { data: costs } = await supabase
          .from('cost_records')
          .select('cost_usd')
          .eq('user_id', user.id)
          .gte('recorded_at', periodStart.toISOString())
          .limit(10000);

        const totalSpend = (costs || []).reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
        if (totalSpend >= Number(alert.threshold_usd)) {
          return NextResponse.json(
            { error: 'BUDGET_EXCEEDED', message: 'Budget hard stop limit reached. Disable the alert or increase the threshold to continue.' },
            { status: 403 }
          );
        }
      }
    }

    // FIX-008: Use atomic RPC function for insertion (advisory lock + ownership check)
    const { data: insertResult, error: insertError } = await supabase.rpc('insert_session_message', {
      p_session_id: sessionId,
      p_message_type: 'user_prompt',
      p_content_encrypted: content_encrypted,
      p_encryption_nonce: encryption_nonce,
      p_metadata: {
        source: 'web',
        timestamp: new Date().toISOString(),
      },
    });

    if (insertError) {
      const isDev = process.env.NODE_ENV === 'development';
      console.error('Failed to insert message:', isDev ? insertError : insertError.message);
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to send message' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, id: insertResult?.[0]?.id });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('Unexpected error in send-message:', isDev ? error : (error instanceof Error ? error.message : 'Unknown'));
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
