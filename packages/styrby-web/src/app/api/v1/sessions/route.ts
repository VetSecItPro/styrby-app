/**
 * GET /api/v1/sessions
 *
 * Lists sessions for the authenticated API user.
 * Supports pagination, filtering by status and agent type.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @rateLimit 100 requests per minute per key
 *
 * Query Parameters:
 * - limit: Number of sessions to return (default: 20, max: 100)
 * - offset: Number of sessions to skip (default: 0)
 * - status: Filter by session status (optional)
 * - agent_type: Filter by agent type (optional)
 * - archived: Include archived sessions (default: false)
 *
 * @returns 200 {
 *   sessions: Session[],
 *   pagination: { total: number, limit: number, offset: number, hasMore: boolean }
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { withApiAuth, addRateLimitHeaders, type ApiAuthContext } from '@/middleware/api-auth';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query Schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['starting', 'running', 'idle', 'paused', 'stopped', 'error', 'expired']).optional(),
  agent_type: z.enum(['claude', 'codex', 'gemini']).optional(),
  archived: z.enum(['true', 'false']).default('false'),
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

async function handler(request: NextRequest, context: ApiAuthContext): Promise<NextResponse> {
  const { userId, keyId } = context;

  // Parse query parameters
  const url = new URL(request.url);
  const rawQuery = {
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    agent_type: url.searchParams.get('agent_type') ?? undefined,
    archived: url.searchParams.get('archived') ?? undefined,
  };

  const parseResult = QuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors.map((e) => e.message).join(', ') },
      { status: 400 }
    );
  }

  const { limit, offset, status, agent_type, archived } = parseResult.data;
  const includeArchived = archived === 'true';

  const supabase = createApiAdminClient();

  // Build query
  let query = supabase
    .from('sessions')
    .select(
      `
      id,
      agent_type,
      model,
      title,
      summary,
      project_path,
      git_branch,
      tags,
      is_archived,
      status,
      started_at,
      ended_at,
      last_activity_at,
      total_cost_usd,
      total_input_tokens,
      total_output_tokens,
      total_cache_tokens,
      message_count,
      created_at
    `,
      { count: 'exact' }
    )
    .eq('user_id', userId)
    .is('deleted_at', null);

  // Apply filters
  if (status) {
    query = query.eq('status', status);
  }
  if (agent_type) {
    query = query.eq('agent_type', agent_type);
  }
  if (!includeArchived) {
    query = query.eq('is_archived', false);
  }

  // Apply pagination
  query = query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const { data: sessions, count, error } = await query;

  if (error) {
    console.error('Failed to fetch sessions:', error.message);
    return NextResponse.json(
      { error: 'Failed to fetch sessions' },
      { status: 500 }
    );
  }

  const total = count ?? 0;
  const hasMore = offset + limit < total;

  const response = NextResponse.json({
    sessions: sessions || [],
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
