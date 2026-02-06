/**
 * GET /api/v1/sessions/[id]/messages
 *
 * Lists messages for a session.
 * Note: Message content is E2E encrypted and returned as-is.
 * Decryption must happen client-side with the appropriate key.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @rateLimit 100 requests per minute per key
 *
 * Query Parameters:
 * - limit: Number of messages to return (default: 50, max: 200)
 * - offset: Number of messages to skip (default: 0)
 * - type: Filter by message type (optional)
 *
 * @returns 200 {
 *   messages: SessionMessage[],
 *   pagination: { total: number, limit: number, offset: number, hasMore: boolean }
 * }
 *
 * @error 404 { error: 'Session not found' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { withApiAuth, addRateLimitHeaders, type ApiAuthContext } from '@/middleware/api-auth';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query Schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  type: z
    .enum([
      'user_prompt',
      'agent_response',
      'agent_thinking',
      'permission_request',
      'permission_response',
      'tool_use',
      'tool_result',
      'error',
      'system',
    ])
    .optional(),
});

// ---------------------------------------------------------------------------
// Supabase Admin Client
// ---------------------------------------------------------------------------

function createApiAdminClient() {
  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {},
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(
  request: NextRequest,
  context: ApiAuthContext
): Promise<NextResponse> {
  const { userId, keyId } = context;

  // Extract session ID from URL
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  // URL is /api/v1/sessions/[id]/messages, so session ID is at index -2
  const sessionId = segments[segments.length - 2];

  if (!sessionId || sessionId.length !== 36) {
    return NextResponse.json(
      { error: 'Invalid session ID' },
      { status: 400 }
    );
  }

  // Parse query parameters
  const rawQuery = {
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
    type: url.searchParams.get('type') ?? undefined,
  };

  const parseResult = QuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors.map((e) => e.message).join(', ') },
      { status: 400 }
    );
  }

  const { limit, offset, type } = parseResult.data;

  const supabase = createApiAdminClient();

  // First, verify the session belongs to the user
  const { data: session } = await supabase
    .from('sessions')
    .select('id')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .single();

  if (!session) {
    return NextResponse.json(
      { error: 'Session not found' },
      { status: 404 }
    );
  }

  // Build query for messages
  let query = supabase
    .from('session_messages')
    .select(
      `
      id,
      sequence_number,
      parent_message_id,
      message_type,
      content_encrypted,
      encryption_nonce,
      risk_level,
      permission_granted,
      tool_name,
      duration_ms,
      input_tokens,
      output_tokens,
      cache_tokens,
      metadata,
      created_at
    `,
      { count: 'exact' }
    )
    .eq('session_id', sessionId);

  // Apply type filter
  if (type) {
    query = query.eq('message_type', type);
  }

  // Apply pagination and ordering
  query = query
    .order('sequence_number', { ascending: true })
    .range(offset, offset + limit - 1);

  const { data: messages, count, error } = await query;

  if (error) {
    console.error('Failed to fetch messages:', error.message);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }

  const total = count ?? 0;
  const hasMore = offset + limit < total;

  const response = NextResponse.json({
    messages: messages || [],
    pagination: {
      total,
      limit,
      offset,
      hasMore,
    },
  });

  return addRateLimitHeaders(response, keyId);
}

export const GET = withApiAuth(handler);
