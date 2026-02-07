/**
 * POST /api/relay/permission-response
 *
 * Records the user's response to a permission request.
 * Inserts a permission_response message and updates the original request.
 * The CLI picks up the response via Supabase Realtime subscription.
 *
 * @auth Required - Bearer token (Supabase Auth JWT via cookie)
 * @rateLimit 100 requests per minute (standard)
 *
 * @body {
 *   sessionId: string - The session containing the permission request
 *   requestId: string - The ID of the permission_request message
 *   approved: boolean - Whether the user approved the action
 * }
 *
 * @returns 200 { success: true }
 *
 * @error 400 { error: 'VALIDATION_ERROR', message: string }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'FORBIDDEN', message: string }
 * @error 404 { error: 'NOT_FOUND', message: string }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

/**
 * Request body schema for permission response.
 */
const permissionResponseSchema = z.object({
  sessionId: z.string().uuid('Invalid session ID'),
  requestId: z.string().uuid('Invalid request ID'),
  approved: z.boolean(),
});

export async function POST(request: Request) {
  // Rate limit check - standard limit for relay messages
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.standard, 'relay-permission');
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
    const parseResult = permissionResponseSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: 'VALIDATION_ERROR',
          message: parseResult.error.errors[0].message,
        },
        { status: 400 }
      );
    }

    const { sessionId, requestId, approved } = parseResult.data;

    // Verify session exists and belongs to user
    // WHY (FIX-026): Explicit user_id filter instead of relying solely on RLS
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
        { error: 'VALIDATION_ERROR', message: 'Cannot respond to permissions in an ended session' },
        { status: 400 }
      );
    }

    // Verify the permission request exists and belongs to this session
    const { data: permissionRequest, error: requestError } = await supabase
      .from('session_messages')
      .select('id, message_type, permission_granted, metadata')
      .eq('id', requestId)
      .eq('session_id', sessionId)
      .single();

    if (requestError || !permissionRequest) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Permission request not found' },
        { status: 404 }
      );
    }

    // Verify it's actually a permission request
    if (permissionRequest.message_type !== 'permission_request') {
      return NextResponse.json(
        { error: 'VALIDATION_ERROR', message: 'Message is not a permission request' },
        { status: 400 }
      );
    }

    // Check if already responded
    if (permissionRequest.permission_granted !== null) {
      return NextResponse.json(
        { error: 'VALIDATION_ERROR', message: 'Permission request already responded to' },
        { status: 400 }
      );
    }

    // FIX-036: Merge with existing metadata instead of replacing
    // WHY: The permission_request message may already have metadata from the CLI
    // (e.g., tool name, command, risk level). Replacing it loses that context.
    const existingMetadata = (permissionRequest as { metadata?: Record<string, unknown> }).metadata || {};
    const mergedMetadata = {
      ...existingMetadata,
      responded_at: new Date().toISOString(),
      response_source: 'web',
    };

    // Update the permission request message
    const { error: updateError } = await supabase
      .from('session_messages')
      .update({
        permission_granted: approved,
        metadata: mergedMetadata,
      })
      .eq('id', requestId);

    if (updateError) {
      const isDev = process.env.NODE_ENV === 'development';
      console.error('Failed to update permission request:', isDev ? updateError : updateError.message);
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to record response' },
        { status: 500 }
      );
    }

    // FIX-008: Use atomic RPC function for insertion (advisory lock + ownership check)
    // WHY: Permission responses are server-generated audit messages, so we use
    // null encryption_nonce to indicate they are not E2E encrypted.
    const { error: insertError } = await supabase.rpc('insert_session_message', {
      p_session_id: sessionId,
      p_message_type: 'permission_response',
      p_content_encrypted: approved ? 'Permission granted' : 'Permission denied',
      p_parent_message_id: requestId,
      p_permission_granted: approved,
      p_metadata: {
        request_id: requestId,
        source: 'web',
        timestamp: new Date().toISOString(),
      },
    });

    if (insertError) {
      const isDev = process.env.NODE_ENV === 'development';
      console.error('Failed to insert permission response:', isDev ? insertError : insertError.message);
      // The update already succeeded, so we don't roll back
      // The CLI can still pick up the permission_granted field update
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('Unexpected error in permission-response:', isDev ? error : (error instanceof Error ? error.message : 'Unknown'));
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}
