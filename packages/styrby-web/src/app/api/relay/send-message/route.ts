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
 */
const sendMessageSchema = z.object({
  sessionId: z.string().uuid('Invalid session ID'),
  content: z.string().min(1, 'Message cannot be empty').max(100000, 'Message too long'),
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

    const { sessionId, content } = parseResult.data;

    // Verify session exists and belongs to user (RLS will enforce this)
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('id, status')
      .eq('id', sessionId)
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

    // Get the next sequence number
    const { data: lastMessage } = await supabase
      .from('session_messages')
      .select('sequence_number')
      .eq('session_id', sessionId)
      .order('sequence_number', { ascending: false })
      .limit(1)
      .single();

    const nextSequence = (lastMessage?.sequence_number ?? 0) + 1;

    // Insert the message
    // WHY: We store content in content_encrypted for E2E encryption support.
    // In production, the client would encrypt before sending.
    const { error: insertError } = await supabase.from('session_messages').insert({
      session_id: sessionId,
      sequence_number: nextSequence,
      message_type: 'user_prompt',
      content_encrypted: content,
      metadata: {
        source: 'web',
        timestamp: new Date().toISOString(),
      },
    });

    if (insertError) {
      console.error('Failed to insert message:', insertError);
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to send message' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Unexpected error in send-message:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
