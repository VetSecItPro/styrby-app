/**
 * GET /api/v1/machines
 *
 * Lists machines (CLI instances) for the authenticated user.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @rateLimit 100 requests per minute per key
 *
 * Query Parameters:
 * - online_only: Filter to only online machines (default: false)
 *
 * @returns 200 {
 *   machines: Array<{
 *     id: string,
 *     name: string,
 *     platform: string,
 *     platformVersion: string,
 *     architecture: string,
 *     hostname: string,
 *     cliVersion: string,
 *     isOnline: boolean,
 *     lastSeenAt: string,
 *     createdAt: string
 *   }>,
 *   count: number
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
  online_only: z.enum(['true', 'false']).default('false'),
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

  // Parse query parameters
  const url = new URL(request.url);
  const rawQuery = {
    online_only: url.searchParams.get('online_only') ?? undefined,
  };

  const parseResult = QuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors.map((e) => e.message).join(', ') },
      { status: 400 }
    );
  }

  const { online_only } = parseResult.data;
  const onlineOnly = online_only === 'true';

  const supabase = createApiAdminClient();

  // Build query
  let query = supabase
    .from('machines')
    .select(
      `
      id,
      name,
      platform,
      platform_version,
      architecture,
      hostname,
      cli_version,
      is_online,
      last_seen_at,
      created_at
    `
    )
    .eq('user_id', userId)
    .eq('is_enabled', true)
    .is('deleted_at', null);

  // Apply online filter
  if (onlineOnly) {
    query = query.eq('is_online', true);
  }

  // Order by last seen
  query = query.order('last_seen_at', { ascending: false, nullsFirst: false });

  const { data: machines, error } = await query;

  if (error) {
    console.error('Failed to fetch machines:', error.message);
    return NextResponse.json(
      { error: 'Failed to fetch machines' },
      { status: 500 }
    );
  }

  // Transform to camelCase for API response
  const transformedMachines = (machines || []).map((m) => ({
    id: m.id,
    name: m.name,
    platform: m.platform,
    platformVersion: m.platform_version,
    architecture: m.architecture,
    hostname: m.hostname,
    cliVersion: m.cli_version,
    isOnline: m.is_online,
    lastSeenAt: m.last_seen_at,
    createdAt: m.created_at,
  }));

  const response = NextResponse.json({
    machines: transformedMachines,
    count: transformedMachines.length,
  });

  return addRateLimitHeaders(response, keyId);
}

export const GET = withApiAuth(handler);
