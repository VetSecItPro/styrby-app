/**
 * GET /api/v1/sessions/[id]
 *
 * Gets a single session by ID.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @rateLimit 100 requests per minute per key
 *
 * @returns 200 { session: Session }
 * @error 404 { error: 'Session not found' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { withApiAuthAndRateLimit, addRateLimitHeaders, type ApiAuthContext } from '@/middleware/api-auth';

// ---------------------------------------------------------------------------
// Supabase Admin Client
// ---------------------------------------------------------------------------

function createApiAdminClient() {
  return createServerClient(
    (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)!,
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
  const { userId, keyId, keyExpiresAt } = context;

  // Extract session ID from URL
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  const sessionId = segments[segments.length - 1];

  // A-014: Proper UUID format validation (not just length check)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    return NextResponse.json(
      { error: 'Invalid session ID' },
      { status: 400 }
    );
  }

  const supabase = createApiAdminClient();

  const { data: session, error } = await supabase
    .from('sessions')
    .select(
      `
      id,
      machine_id,
      agent_type,
      model,
      title,
      summary,
      project_path,
      git_branch,
      git_remote_url,
      tags,
      is_archived,
      status,
      error_code,
      error_message,
      started_at,
      ended_at,
      last_activity_at,
      total_cost_usd,
      total_input_tokens,
      total_output_tokens,
      total_cache_tokens,
      message_count,
      context_window_used,
      context_window_limit,
      created_at,
      updated_at
    `
    )
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }
    console.error('Failed to fetch session:', error.message);
    return NextResponse.json(
      { error: 'Failed to fetch session' },
      { status: 500 }
    );
  }

  const response = NextResponse.json({ session });
  return addRateLimitHeaders(response, keyId, keyExpiresAt);
}

export const GET = withApiAuthAndRateLimit(handler);
